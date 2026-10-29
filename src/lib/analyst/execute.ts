import { randomUUID } from 'node:crypto';
import { addDays, addHours, addMonths, startOfDay, startOfHour, startOfMonth } from 'date-fns';
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';
import { getAiQueryScope, withAiRead } from '@/lib/ai/query';
import { EVENT_COLUMNS, EVENT_TYPE } from '@/lib/constants';
import { getAllowedUnits } from '@/lib/date';
import { setWebsiteDate } from '@/lib/request';
import type { Auth, PropertyFilter, QueryFilters } from '@/lib/types';
import { canViewWebsite } from '@/permissions/website';
import {
  getEventDataFields,
  getEventDataNumericStats,
  getEventMetrics,
  getEventStats,
  getPageviewMetrics,
  getPageviewStats,
  getSessionDataNumericStats,
  getSessionDataProperties,
  getSessionMetrics,
  getSessionStats,
  getWebsiteStats,
} from '@/queries/sql';
import { getPeople } from '@/queries/sql/people/getPeople';
import { type ResolvedRange, resolveDatePolicy, toNativeRange } from './dates';
import {
  type AnalysisDefinition,
  AnalysisError,
  hashDefinition,
  LIMITS,
  PAGEVIEW_DIMENSIONS,
} from './definition';

export interface SavedReference {
  id: string;
  revision: number;
  definitionHash: string;
}

export interface AnalysisColumn {
  key: string;
  label: string;
  type: 'string' | 'number' | 'time';
}

export interface ExecutionEnvelope {
  executionId: string;
  executedAt: number;
  definition: SavedReference | null;
  definitionHash: string;
  source: { websiteId: string };
  operation: AnalysisDefinition['operation'];
  metric: string;
  unit: string;
  range: {
    startAt: number;
    endAt: number;
    timezone: string;
    policy: AnalysisDefinition['datePolicy'];
  };
  appliedFilters: Pick<AnalysisDefinition, 'filters' | 'propertyFilters'> & { event?: string };
  semanticBinding: AnalysisDefinition['semanticBinding'];
  columns: AnalysisColumn[];
  rows: Record<string, string | number | null>[];
  completeness: 'complete' | 'partial' | 'unknown';
  reasons: string[];
  counts: { returned: number; available: number | null };
  freshness: { cached: false; engine: 'postgresql' | 'clickhouse' };
  warnings: string[];
  limits: typeof LIMITS;
  totals?: Record<string, number | null>;
}

export interface ExecuteOptions {
  /** Injected clock: resolve rolling windows once per verification pass. */
  now: number;
  signal?: AbortSignal;
  saved?: SavedReference;
}

const isClickHouse = () => !!process.env.CLICKHOUSE_URL;

/** Native filter object: QueryFilters plus suffixed dimension keys (e.g. `path1`). */
type NativeFilters = QueryFilters &
  Record<string, string | number | boolean | Date | PropertyFilter[] | QueryFilters | undefined>;

function nativeFilters(definition: AnalysisDefinition): NativeFilters {
  const filters: NativeFilters = {};
  definition.filters.forEach((f, index) => {
    // Suffixed keys keep repeated dimensions as separate AND predicates in native SQL.
    const key = index === 0 || !(f.dimension in filters) ? f.dimension : `${f.dimension}${index}`;
    filters[key] = `${f.operator}.${f.values.join(',')}`;
  });
  const toNative = (f: AnalysisDefinition['propertyFilters'][number]): PropertyFilter => ({
    propertyName: f.name,
    dataType: f.dataType,
    operator: f.operator as PropertyFilter['operator'],
    value: f.value,
  });
  filters.eventPropertyFilters = definition.propertyFilters
    .filter(f => f.owner === 'event')
    .map(toNative);
  filters.sessionPropertyFilters = definition.propertyFilters
    .filter(f => f.owner === 'session')
    .map(toNative);
  return filters;
}

/** Combinations where native SQL is known not to apply the predicate faithfully. */
function assertNativeSupport(definition: AnalysisDefinition) {
  const eventProps = definition.propertyFilters.some(f => f.owner === 'event');
  if (eventProps && !definition.event)
    throw new AnalysisError(
      'unsupported_combination',
      'Event property filters apply only to custom-event metrics',
      'propertyFilters',
    );
  // Native numeric-stat and value-count queries apply property predicates through different
  // paths; v1 rejects the combination instead of risking a mismatched population.
  if (definition.operation === 'numeric_property' && definition.propertyFilters.length)
    throw new AnalysisError(
      'unsupported_combination',
      'Property filters are not supported for numeric property aggregates',
      'propertyFilters',
    );
}

/** ClickHouse pre-aggregated hourly paths store hour starts; sub-hour bounds are approximate. */
function usesHourlyAggregate(definition: AnalysisDefinition) {
  if (!isClickHouse() || definition.event) return false;
  if (definition.operation === 'numeric_property') return false;
  const eventColumnFilter = definition.filters.some(f =>
    (EVENT_COLUMNS as string[]).includes(f.dimension),
  );
  return !eventColumnFilter;
}

function bucketKeys(range: ResolvedRange, unit: 'hour' | 'day' | 'month') {
  const floor = unit === 'hour' ? startOfHour : unit === 'month' ? startOfMonth : startOfDay;
  const add = unit === 'hour' ? addHours : unit === 'month' ? addMonths : addDays;
  const keys: { key: string; t: string }[] = [];
  let wall = floor(toZonedTime(new Date(range.startAt), range.timezone));
  const last = toZonedTime(new Date(range.endAt - 1), range.timezone);
  while (wall <= last) {
    if (keys.length >= LIMITS.maxBuckets)
      throw new AnalysisError(
        'result_too_large',
        `Use a coarser unit: maximum ${LIMITS.maxBuckets} buckets`,
        'unit',
      );
    const instant = fromZonedTime(wall, range.timezone);
    keys.push({
      key: formatInTimeZone(instant, range.timezone, "yyyy-MM-dd'T'HH:mm:ss"),
      t: formatInTimeZone(instant, range.timezone, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    });
    wall = add(wall, 1);
  }
  return keys;
}

/** Native bucket strings are local wall time with a literal Z suffix on both engines. */
function wallKey(value: string) {
  return value
    .replace(/Z$|[+-]\d\d:\d\d$/, '')
    .replace(' ', 'T')
    .slice(0, 19)
    .padEnd(19, ':00');
}

function finiteOrNull(value: unknown) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function requireMetric(row: Record<string, unknown> | undefined, key: string) {
  if (!row || !(key in row) || finiteOrNull(row[key]) === null)
    throw new AnalysisError('missing_metric', `Native query did not return ${key}`, 'metric');
  return Number(row[key]);
}

const METRIC_UNITS: Record<string, string> = {
  pageviews: 'pageviews',
  sessions: 'sessions',
  visits: 'visits',
  events: 'events',
  identified_users: 'distinct ids',
};

async function run(definition: AnalysisDefinition, range: ResolvedRange) {
  // The pg driver sends Date parameters without an offset, so PostgreSQL would read the range
  // bounds in the session TimeZone. Normalize this read transaction to UTC so saved executions
  // never depend on the deployment's database session timezone.
  await getAiQueryScope()?.tx.$executeRawUnsafe("SET LOCAL TimeZone = 'UTC'");
  const filters: NativeFilters & { startDate: Date; endDate: Date } = {
    ...nativeFilters(definition),
    ...toNativeRange(range),
    timezone: range.timezone,
  };
  // Website reset/cloud retention clamp matches native routes exactly.
  const clamped = await setWebsiteDate(definition.source.websiteId, { ...filters });
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (clamped.startDate.getTime() !== filters.startDate.getTime()) {
    filters.startDate = clamped.startDate;
    reasons.push('range_clamped_by_retention');
  }
  if (
    usesHourlyAggregate(definition) &&
    (range.startAt % 3_600_000 !== 0 || range.endAt % 3_600_000 !== 0)
  )
    reasons.push('clickhouse_hourly_boundary');
  const websiteId = definition.source.websiteId;
  const d = definition;
  let columns: AnalysisColumn[] = [];
  let rows: ExecutionEnvelope['rows'] = [];
  let available: number | null = null;
  let totals: ExecutionEnvelope['totals'];

  if (d.operation === 'series') {
    const unit = d.unit!;
    if (!getAllowedUnits(filters.startDate, filters.endDate).includes(unit))
      throw new AnalysisError('result_too_large', 'Use a coarser unit for this date range', 'unit');
    const keys = bucketKeys(range, unit);
    filters.unit = unit;
    let native: { x?: string; t?: string; y: number }[];
    if (d.metric === 'events') {
      filters.event = `eq.${d.event}`;
      native = (await getEventStats(websiteId, {}, filters)).map(r => ({ t: r.t, y: r.y }));
    } else if (d.metric === 'pageviews') native = await getPageviewStats(websiteId, filters);
    else native = await getSessionStats(websiteId, filters);
    const values = new Map<string, number>();
    for (const row of native) {
      const key = wallKey(String(row.t ?? row.x));
      values.set(key, (values.get(key) || 0) + Number(row.y));
    }
    columns = [
      { key: 't', label: 'Bucket start', type: 'time' },
      { key: 'y', label: d.semanticBinding.label, type: 'number' },
    ];
    rows = keys.map(({ key, t }) => ({ t, y: values.get(key) ?? 0 }));
    available = rows.length;
    const sum = rows.reduce((total, row) => total + Number(row.y), 0);
    if (d.metric === 'sessions') {
      // Bucket sums double-count sessions spanning buckets: never call this unique visitors.
      totals = { bucketSessionSum: sum };
      warnings.push('bucket_sum_not_unique_sessions');
    } else totals = { total: sum };
  } else if (d.operation === 'breakdown') {
    const { dimension, top } = d.groupBy!;
    const parameters = { type: dimension, limit: top + 1, offset: 0 };
    let native: { x: string; y: number; country?: string }[];
    if (d.metric === 'events') {
      filters.event = `eq.${d.event}`;
      filters.eventType = EVENT_TYPE.customEvent;
      native = await getEventMetrics(websiteId, parameters as any, filters);
    } else if ((PAGEVIEW_DIMENSIONS as readonly string[]).includes(dimension))
      native = await getPageviewMetrics(websiteId, parameters, filters);
    else native = await getSessionMetrics(websiteId, parameters, filters);
    const hasCountry = dimension === 'city' || dimension === 'region';
    columns = [
      { key: 'key', label: dimension, type: 'string' },
      ...(hasCountry ? [{ key: 'country', label: 'country', type: 'string' as const }] : []),
      { key: 'value', label: d.semanticBinding.label, type: 'number' },
    ];
    rows = native.slice(0, top).map(r => ({
      key: r.x ?? null,
      ...(hasCountry ? { country: r.country ?? null } : {}),
      value: Number(r.y),
    }));
    if (native.length > top) {
      reasons.push('top_n_truncated');
      warnings.push(`top_${top}_only`);
    } else available = rows.length;
  } else if (d.operation === 'totals') {
    let value: number;
    if (d.metric === 'identified_users') {
      const result = await getPeople(websiteId, filters.startDate, filters.endDate);
      value = requireMetric(result as any, 'identifiedUsers');
    } else if (d.metric === 'events') {
      filters.event = `eq.${d.event}`;
      filters.eventType = EVENT_TYPE.customEvent;
      const native = await getEventMetrics(websiteId, { type: 'event', limit: '2' }, filters);
      // A complete filtered query with no group is an explicit zero, not a missing key.
      value = Number(native.find(r => r.x === d.event)?.y ?? 0);
    } else {
      const stats = await getWebsiteStats(websiteId, filters);
      value = requireMetric(stats as any, d.metric === 'sessions' ? 'visitors' : d.metric);
    }
    columns = [
      { key: 'metric', label: 'Metric', type: 'string' },
      { key: 'value', label: d.semanticBinding.label, type: 'number' },
    ];
    rows = [{ metric: d.metric, value }];
    available = 1;
  } else {
    const property = d.property!;
    let stats: Record<string, unknown> | undefined;
    let count: number;
    if (property.owner === 'event') {
      const [numeric, fields] = await Promise.all([
        getEventDataNumericStats(websiteId, d.event!, property.name, filters, []),
        getEventDataFields(websiteId, d.event, filters),
      ]);
      stats = numeric as any;
      count = Number(
        fields.find(f => f.propertyName === property.name && Number(f.dataType) === 2)?.total ?? 0,
      );
    } else {
      const sessionFilters = filters.sessionPropertyFilters;
      const scoped = { ...filters, sessionPropertyFilters: [] };
      const [numeric, fields] = await Promise.all([
        getSessionDataNumericStats(websiteId, property.name, scoped, sessionFilters),
        getSessionDataProperties(websiteId, scoped, sessionFilters, property.name),
      ]);
      stats = numeric as any;
      count = Number(
        fields.find(f => f.propertyName === property.name && Number(f.dataType) === 2)?.total ?? 0,
      );
    }
    const key = { sum: 'total', average: 'average', median: 'median', min: 'min', max: 'max' }[
      d.metric
    ];
    // Native numeric stats coalesce missing values to 0; with no numeric values the aggregate is null.
    const value = d.metric === 'count' ? count : count === 0 ? null : requireMetric(stats, key!);
    if (count === 0 && d.metric !== 'count') warnings.push('no_numeric_values');
    columns = [
      { key: 'metric', label: 'Metric', type: 'string' },
      { key: 'value', label: d.semanticBinding.label, type: 'number' },
      { key: 'count', label: 'Numeric values', type: 'number' },
    ];
    rows = [{ metric: d.metric, value, count }];
    available = 1;
  }
  return { columns, rows, available, totals, reasons, warnings };
}

/**
 * Executes a normalized definition with trusted auth. Read-only and bounded: every native query
 * runs inside the existing AI read scope (read-only transaction, statement deadline, abort).
 */
export async function executeAnalysis(
  auth: Auth,
  definition: AnalysisDefinition,
  options: ExecuteOptions,
): Promise<ExecutionEnvelope> {
  if (!auth.user || !(await canViewWebsite({ user: auth.user }, definition.source.websiteId)))
    throw new AnalysisError('denied', 'Source website is not accessible', 'source.websiteId');
  assertNativeSupport(definition);
  const range = resolveDatePolicy(definition.datePolicy, definition.timezone, options.now);
  if (range.endAt <= range.startAt)
    throw new AnalysisError('invalid_definition', 'Resolved range is empty', 'datePolicy');
  const signal = options.signal ?? new AbortController().signal;
  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await withAiRead(() => run(definition, range), signal);
  } catch (e) {
    if (e instanceof AnalysisError) throw e;
    throw new AnalysisError('execution_failed', 'Analysis query failed', undefined, true);
  }
  const { columns, rows, available, totals, reasons, warnings } = result;
  if (definition.semanticBinding.meaningSource === 'observed_only')
    warnings.unshift('observed_only_meaning');
  const envelope: ExecutionEnvelope = {
    executionId: randomUUID(),
    executedAt: options.now,
    definition: options.saved ?? null,
    definitionHash: hashDefinition(definition),
    source: definition.source,
    operation: definition.operation,
    metric: definition.metric,
    unit: definition.semanticBinding.unit || METRIC_UNITS[definition.metric] || definition.metric,
    range: {
      startAt: range.startAt,
      endAt: range.endAt,
      timezone: range.timezone,
      policy: definition.datePolicy,
    },
    appliedFilters: {
      filters: definition.filters,
      propertyFilters: definition.propertyFilters,
      ...(definition.event ? { event: definition.event } : {}),
    },
    semanticBinding: definition.semanticBinding,
    columns,
    rows,
    completeness: reasons.length ? 'partial' : 'complete',
    reasons,
    counts: { returned: rows.length, available },
    freshness: { cached: false, engine: isClickHouse() ? 'clickhouse' : 'postgresql' },
    warnings,
    limits: LIMITS,
    ...(totals ? { totals } : {}),
  };
  if (rows.length > LIMITS.maxRows || Buffer.byteLength(JSON.stringify(envelope)) > LIMITS.maxBytes)
    throw new AnalysisError('result_too_large', 'Result exceeds host limits; narrow the query');
  return envelope;
}
