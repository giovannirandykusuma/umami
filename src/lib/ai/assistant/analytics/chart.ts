import { z } from 'zod';
import type { AssistantPart } from '../protocol';
import { AnalyticsError } from './filters';
import { getSeries, type ToolContext } from './results';

const dates = {
  startAt: z.number().int().nonnegative().optional(),
  endAt: z.number().int().nonnegative().optional(),
};
const unit = z.enum(['hour', 'day', 'month']).optional();
const component = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('WebsiteCompareChart'),
      props: z
        .object({
          websiteIds: z.array(z.uuid()).min(2).max(10),
          metric: z.enum(['visitors', 'pageviews']),
          unit,
          ...dates,
        })
        .strict(),
    })
    .strict(),
  ...(['WebsiteChart', 'WebsiteMetricsBar', 'WorldMap'] as const).map(type =>
    z
      .object({
        type: z.literal(type),
        websiteId: z.uuid(),
        props: z.object({}).strict().optional(),
      })
      .strict(),
  ),
  z
    .object({
      type: z.literal('MetricsTable'),
      websiteId: z.uuid(),
      props: z
        .object({
          type: z.enum(['path', 'referrer', 'browser', 'os', 'device', 'country', 'event']),
          limit: z.union([z.literal(5), z.literal(10), z.literal(20)]).optional(),
        })
        .strict(),
    })
    .strict(),
]);
export function chartPart(args: any, context: ToolContext | undefined, id: string): AssistantPart {
  const title = z.string().max(200).optional().safeParse(args.title);
  if (!title.success) throw new AnalyticsError('invalid_chart', 'Invalid title', 'title');
  let part: AssistantPart;
  if (args.resultId !== undefined) {
    for (const key of Object.keys(args))
      if (!['resultId', 'kind', 'title'].includes(key))
        throw new AnalyticsError('invalid_chart', 'Unknown chart field', key);
    if (!['line', 'bar', 'table'].includes(args.kind))
      throw new AnalyticsError('invalid_chart', 'Invalid chart kind', 'kind');
    const series = context && getSeries(context, args.resultId);
    if (!series)
      throw new AnalyticsError(
        'unknown_result',
        'Unknown, foreign or expired resultId',
        'resultId',
      );
    part = { type: 'result-chart', id, title: title.data, kind: args.kind, series };
  } else {
    for (const key of Object.keys(args))
      if (!['component', 'title'].includes(key))
        throw new AnalyticsError('invalid_chart', 'Unknown chart field', key);
    const parsed = component.safeParse(args.component);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = [
        ...issue.path,
        ...(issue.code === 'unrecognized_keys' ? [issue.keys[0]] : []),
      ].join('.');
      throw new AnalyticsError('invalid_chart', `Invalid chart field: ${path}`, path);
    }
    const value = parsed.data;
    if (value.type === 'WebsiteCompareChart') {
      if (
        new Set(value.props.websiteIds).size !== value.props.websiteIds.length ||
        (value.props.startAt === undefined) !== (value.props.endAt === undefined) ||
        (value.props.startAt !== undefined && value.props.endAt! < value.props.startAt)
      )
        throw new AnalyticsError(
          'invalid_chart',
          'Invalid comparison range or website IDs',
          'props',
        );
    }
    part = { type: 'chart', id, title: title.data, component: value };
  }
  if (Buffer.byteLength(JSON.stringify(part)) > 8192)
    throw new AnalyticsError('result_too_large', 'Chart exceeds 8 KiB; use a coarser unit');
  return part;
}
