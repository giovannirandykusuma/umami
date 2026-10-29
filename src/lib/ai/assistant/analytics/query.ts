import { z } from 'zod';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { addDays, addHours, addMonths, startOfDay, startOfHour, startOfMonth } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { timezoneParam } from '@/lib/schema';
import { getAllowedUnits } from '@/lib/date';
import type { AssistantSeries } from '../protocol';
import { AnalyticsError, encodeFilters } from './filters';
import { saveResult, type ToolContext } from './results';

export type ApiRead = (path: string, query: Record<string, string | number>) => Promise<any>;
const range = z
  .object({
    websiteId: z.uuid(),
    startAt: z.number().int().nonnegative(),
    endAt: z.number().int().nonnegative(),
  })
  .refine(v => v.endAt >= v.startAt);
export const analyticsNames = [
  'analytics_schema',
  'find_people',
  'query_series',
  'query_breakdown',
  'query_totals',
];
export function normalizeBuckets(
  rows: { t: string; y: number }[],
  args: { startAt: number; endAt: number; timezone: string; unit: AssistantSeries['unit'] },
) {
  const { timezone, unit } = args;
  const floor = unit === 'hour' ? startOfHour : unit === 'month' ? startOfMonth : startOfDay;
  const add = unit === 'hour' ? addHours : unit === 'month' ? addMonths : addDays;
  const values = new Map<string, number>();
  for (const row of rows) {
    // PG date_trunc returns wall time cast as timestamptz (getDateSQL convention).
    const wall = row.t.replace(/Z$|[+-]\d\d:\d\d$/, '').slice(0, 19);
    const key = wall.padEnd(19, ':00');
    values.set(key, (values.get(key) || 0) + Number(row.y));
  }
  const buckets: AssistantSeries['buckets'] = [];
  let wall = floor(toZonedTime(new Date(args.startAt), timezone));
  const last = toZonedTime(new Date(args.endAt), timezone);
  while (wall <= last) {
    if (buckets.length >= 400)
      throw new AnalyticsError('result_too_large', 'Use a coarser unit: maximum 400 buckets');
    const instant = fromZonedTime(wall, timezone);
    const key = formatInTimeZone(instant, timezone, "yyyy-MM-dd'T'HH:mm:ss");
    buckets.push({
      t: formatInTimeZone(instant, timezone, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      y: values.get(key) || 0,
    });
    wall = add(wall, 1);
  }
  return buckets;
}
export async function queryAnalytics(name: string, args: any, context: ToolContext, read: ApiRead) {
  const parsed = range.safeParse(args);
  if (!parsed.success)
    throw new AnalyticsError(
      'invalid_arguments',
      'Expected websiteId and an inclusive millisecond range',
    );
  const { websiteId, startAt, endAt } = parsed.data;
  const base = `/api/websites/${websiteId}`;
  const dates = { startAt, endAt };
  if (name === 'find_people') {
    encodeFilters(args.filters, true);
    const search = z.string().trim().min(2).max(100).safeParse(args.search);
    if (
      !search.success ||
      (args.property !== undefined && !z.string().min(1).max(500).safeParse(args.property).success)
    )
      throw new AnalyticsError('invalid_arguments', 'Search must contain 2–100 characters');
    const data = await read(`${base}/people`, {
      ...dates,
      search: search.data,
      ...(args.property === undefined ? {} : { property: args.property }),
    });
    return { ...data, empty: !data.candidates.length };
  }
  if (name === 'analytics_schema') {
    encodeFilters(args.filters, true);
    const [events, eventProperties, sessionProperties, stats, people] = await Promise.all([
      read(`${base}/metrics`, { ...dates, type: 'event', limit: 50 }),
      read(`${base}/event-data/properties`, dates),
      read(`${base}/session-data/properties`, dates),
      read(`${base}/stats`, dates),
      read(`${base}/people/count`, dates),
    ]);
    return {
      events,
      eventProperties,
      sessionProperties,
      ...counts(stats, people),
      hasPageviews: Number(stats.pageviews || 0) > 0,
      hasCustomEvents: events.length > 0,
      truncated: events.length >= 50,
    };
  }
  if (name === 'query_series') {
    if (!['pageviews', 'visitors', 'events'].includes(args.metric))
      throw new AnalyticsError(
        'unsupported_metric',
        'Series support pageviews, visitors or events only',
        'metric',
      );
    const unit = z.enum(['hour', 'day', 'month']).safeParse(args.unit);
    const timezone = timezoneParam.safeParse(args.timezone);
    if (!unit.success || !timezone.success)
      throw new AnalyticsError('invalid_arguments', 'A valid unit and timezone are required');
    const appliedFilters = encodeFilters(args.filters);
    // Routes silently coarsen unsupported units; never label those aggregates as finer buckets.
    if (!getAllowedUnits(new Date(startAt), new Date(endAt)).includes(unit.data))
      throw new AnalyticsError('result_too_large', 'Use a coarser unit for this date range');
    // Validate size before fetching, as well as before emitting the chart.
    const bucketArgs = { ...dates, timezone: timezone.data, unit: unit.data };
    normalizeBuckets([], bucketArgs);
    const data = await read(`${base}/${args.metric === 'events' ? 'events/series' : 'pageviews'}`, {
      ...dates,
      unit: unit.data,
      timezone: timezone.data,
      ...appliedFilters,
    });
    const rows =
      args.metric === 'events' ? data : data[args.metric === 'visitors' ? 'sessions' : 'pageviews'];
    const buckets = normalizeBuckets(
      rows.map((row: any) => ({ t: row.t ?? row.x, y: row.y })),
      bucketArgs,
    );
    const series: AssistantSeries = {
      label:
        args.metric === 'events'
          ? 'Tracked events'
          : args.metric === 'visitors'
            ? 'Visitors (sessions)'
            : 'Pageviews',
      metric: args.metric,
      unit: unit.data,
      range: dates,
      timezone: timezone.data,
      appliedFilters,
      buckets,
      total: buckets.reduce((sum, bucket) => sum + bucket.y, 0),
    };
    if (
      Buffer.byteLength(
        JSON.stringify({
          type: 'result-chart',
          id: '00000000-0000-0000-0000-000000000000',
          kind: 'line',
          series,
        }),
      ) > 8192
    )
      throw new AnalyticsError('result_too_large', 'Use a coarser unit: result exceeds 8 KiB');
    return {
      resultId: saveResult(context, series),
      ...series,
      empty: series.total === 0,
      truncated: false,
    };
  }
  if (name === 'query_totals') {
    // people/count has no filter schema: never silently mix filtered and unfiltered counts.
    encodeFilters(args.filters, true);
    const [stats, people] = await Promise.all([
      read(`${base}/stats`, dates),
      read(`${base}/people/count`, dates),
    ]);
    const data = counts(stats, people);
    return { resultId: saveResult(context, data), ...data };
  }
  const dimension = z
    .enum([
      'path',
      'title',
      'referrer',
      'browser',
      'os',
      'device',
      'country',
      'region',
      'city',
      'language',
      'hostname',
      'event',
      'channel',
      'utmSource',
      'utmMedium',
      'utmCampaign',
      'utmContent',
      'utmTerm',
    ])
    .safeParse(args.dimension);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(50)
    .safeParse(args.limit ?? 10);
  if (!dimension.success || !limit.success)
    throw new AnalyticsError('invalid_arguments', 'Invalid breakdown dimension or limit');
  const filters = encodeFilters(args.filters);
  const rows = await read(`${base}/metrics`, {
    ...dates,
    type: dimension.data,
    limit: limit.data,
    ...filters,
  });
  // Channel metrics return all groups; other dimensions enforce the upstream limit.
  const data = {
    rows: rows.slice(0, limit.data),
    truncated: dimension.data === 'channel' ? rows.length > limit.data : rows.length >= limit.data,
    empty: rows.length === 0,
  };
  return { resultId: saveResult(context, data), ...data };
}
function counts(stats: any, people: any) {
  return {
    pageviews: Number(stats.pageviews || 0),
    visits: Number(stats.visits || 0),
    visitors: Number(stats.visitors || 0),
    identifiedUsers: Number(people.identifiedUsers),
    labels: {
      pageviews: 'Pageviews',
      visits: 'Visits',
      visitors: 'Visitors (sessions)',
      identifiedUsers: 'Identified users (distinct ids)',
    },
  };
}
