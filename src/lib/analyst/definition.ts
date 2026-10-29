import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isValidTimezone, normalizeTimezone } from '@/lib/date';

/** Structured failure: never SQL, credentials or raw HTML. */
export type AnalysisErrorCode =
  | 'invalid_definition'
  | 'unsupported_combination'
  | 'unsupported_filter'
  | 'unsupported_schema_version'
  | 'type_mismatch'
  | 'missing_metric'
  | 'result_too_large'
  | 'denied'
  | 'not_found'
  | 'conflict'
  | 'feature_disabled'
  | 'unsupported_sharing'
  | 'execution_failed';

export class AnalysisError extends Error {
  constructor(
    readonly code: AnalysisErrorCode,
    message: string,
    readonly field?: string,
    readonly retryable = false,
  ) {
    super(message);
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.field ? { field: this.field } : {}),
    };
  }
}

export const OPERATIONS = ['series', 'breakdown', 'totals', 'numeric_property'] as const;
export const ROLLING_WINDOWS = ['today', '24h', '7d', '30d', '90d'] as const;
export const SERIES_UNITS = ['hour', 'day', 'month'] as const;
export const NUMERIC_AGGREGATES = ['sum', 'average', 'median', 'min', 'max', 'count'] as const;
export const VISUALIZATIONS = ['line', 'bar', 'table', 'metric'] as const;

/** Dimensions served by native pageview/session metric queries (pageview dataset). */
export const PAGEVIEW_DIMENSIONS = [
  'path',
  'title',
  'referrer',
  'query',
  'hostname',
  'tag',
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'utmContent',
  'utmTerm',
] as const;
export const SESSION_DIMENSIONS = [
  'browser',
  'os',
  'device',
  'country',
  'region',
  'city',
  'language',
] as const;
export const BREAKDOWN_DIMENSIONS = [...PAGEVIEW_DIMENSIONS, ...SESSION_DIMENSIONS] as const;
/** `event` is the dedicated definition field, never a filter (pageviews are a different dataset). */
export const FILTER_DIMENSIONS = [...BREAKDOWN_DIMENSIONS, 'distinctId'] as const;

/**
 * Explicit operation × metric compatibility matrix. `event` says whether an exact custom-event
 * name is required, forbidden or (numeric_property) decided by property owner.
 */
export const COMPATIBILITY = {
  series: {
    pageviews: { event: 'forbidden' },
    sessions: { event: 'forbidden' },
    events: { event: 'required' },
  },
  breakdown: {
    sessions: { event: 'forbidden' },
    events: { event: 'required' },
  },
  totals: {
    pageviews: { event: 'forbidden' },
    visits: { event: 'forbidden' },
    sessions: { event: 'forbidden' },
    events: { event: 'required' },
    identified_users: { event: 'forbidden', filters: false },
  },
  numeric_property: Object.fromEntries(
    NUMERIC_AGGREGATES.map(metric => [metric, { event: 'owner' }]),
  ),
} as Record<
  (typeof OPERATIONS)[number],
  Record<string, { event: 'required' | 'forbidden' | 'owner'; filters?: false }>
>;

/** Which visualizations can faithfully render each operation's result shape. */
export const RENDERERS: Record<(typeof OPERATIONS)[number], (typeof VISUALIZATIONS)[number][]> = {
  series: ['line', 'bar', 'table'],
  breakdown: ['bar', 'table'],
  totals: ['metric', 'table'],
  numeric_property: ['metric', 'table'],
};

/** Host-owned ceilings; definitions cannot raise them. */
export const LIMITS = {
  maxRows: 200,
  maxBuckets: 200,
  maxTop: 50,
  maxBytes: 32 * 1024,
  timeoutMs: 10_000,
} as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const dimensionFilter = z
  .object({
    dimension: z.enum(FILTER_DIMENSIONS),
    operator: z.enum(['eq', 'neq', 'c', 'dnc']),
    values: z.array(z.string().min(1).max(500)).min(1).max(20),
  })
  .strict();
// Operators the native property-filter SQL actually applies per DATA_TYPE (1 string, 2 number,
// 4 date). Booleans/set operators are not natively applied, so they are rejected, not dropped.
const PROPERTY_OPERATORS: Record<number, string[]> = {
  1: ['eq', 'neq', 'c', 'dnc'],
  2: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  4: ['bf', 'af'],
};
const propertyFilter = z
  .object({
    owner: z.enum(['event', 'session']),
    name: text(500),
    dataType: z.union([z.literal(1), z.literal(2), z.literal(4)]),
    operator: z.enum(['eq', 'neq', 'c', 'dnc', 'gt', 'gte', 'lt', 'lte', 'bf', 'af']),
    // Native SQL silently skips an empty value; require one.
    value: z.string().min(1).max(500),
  })
  .strict();

export const definitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.object({ websiteId: z.uuid() }).strict(),
    operation: z.enum(OPERATIONS),
    metric: z.string().min(1).max(50),
    event: text(50).optional(),
    filters: z.array(dimensionFilter).max(20).default([]),
    propertyFilters: z.array(propertyFilter).max(20).default([]),
    groupBy: z
      .object({
        dimension: z.enum(BREAKDOWN_DIMENSIONS),
        top: z.number().int().min(1).max(LIMITS.maxTop).default(10),
      })
      .strict()
      .optional(),
    unit: z.enum(SERIES_UNITS).optional(),
    property: z
      .object({ owner: z.enum(['event', 'session']), name: text(500) })
      .strict()
      .optional(),
    datePolicy: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('fixed'),
          startAt: z.number().int().nonnegative(),
          endAt: z.number().int().positive(),
        })
        .strict(),
      z.object({ type: z.literal('rolling'), window: z.enum(ROLLING_WINDOWS) }).strict(),
    ]),
    timezone: z.string().refine(isValidTimezone, 'Invalid IANA timezone'),
    semanticBinding: z
      .object({
        label: text(200),
        unit: text(50),
        population: text(200),
        meaningSource: z.enum(['user_confirmed', 'repository_definition', 'observed_only']),
      })
      .strict(),
  })
  .strict();

export type AnalysisDefinition = z.infer<typeof definitionSchema>;

function fail(code: AnalysisErrorCode, message: string, field?: string): never {
  throw new AnalysisError(code, message, field);
}

function sortKey(value: unknown) {
  return JSON.stringify(canonical(value));
}

/** Validates against schema and compatibility matrix and returns the normalized definition. */
export function normalizeDefinition(input: unknown): AnalysisDefinition {
  if (
    input &&
    typeof input === 'object' &&
    'schemaVersion' in input &&
    (input as any).schemaVersion !== 1
  )
    fail(
      'unsupported_schema_version',
      'Only definition schemaVersion 1 is supported',
      'schemaVersion',
    );
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.');
    const code =
      field?.startsWith('filters') || field?.startsWith('propertyFilters')
        ? 'unsupported_filter'
        : 'invalid_definition';
    fail(code, issue?.message || 'Invalid definition', field);
  }
  const d = parsed.data;
  const rule = COMPATIBILITY[d.operation][d.metric];
  if (!rule)
    fail('unsupported_combination', `${d.operation} does not support metric ${d.metric}`, 'metric');
  if (d.datePolicy.type === 'fixed' && d.datePolicy.endAt <= d.datePolicy.startAt)
    fail('invalid_definition', 'Fixed range end must be after start', 'datePolicy.endAt');
  const eventRequired =
    rule.event === 'required' || (rule.event === 'owner' && d.property?.owner === 'event');
  if (eventRequired && !d.event)
    fail('invalid_definition', 'An exact custom-event name is required', 'event');
  if (!eventRequired && d.event)
    fail('unsupported_combination', 'This metric does not use a custom event', 'event');
  if (rule.filters === false && (d.filters.length || d.propertyFilters.length))
    fail('unsupported_combination', 'Filtered identified-user totals are not supported', 'filters');
  if ((d.operation === 'series') !== !!d.unit)
    fail(
      d.unit ? 'unsupported_combination' : 'invalid_definition',
      'A time unit is required for series only',
      'unit',
    );
  if ((d.operation === 'breakdown') !== !!d.groupBy)
    fail(
      d.groupBy ? 'unsupported_combination' : 'invalid_definition',
      'groupBy is required for breakdown only',
      'groupBy',
    );
  if ((d.operation === 'numeric_property') !== !!d.property)
    fail(
      d.property ? 'unsupported_combination' : 'invalid_definition',
      'property is required for numeric_property only',
      'property',
    );
  d.filters.forEach((f, i) => {
    // Native filters comma-split every value list; a literal comma would silently widen the
    // population, so reject it for every operator.
    if (f.values.some(v => v.includes(',')))
      fail('unsupported_filter', 'Filter values cannot contain commas', `filters.${i}.values`);
    if (f.operator !== 'eq' && f.values.length !== 1)
      fail('unsupported_filter', `${f.operator} takes exactly one value`, `filters.${i}.values`);
  });
  d.propertyFilters.forEach((f, i) => {
    if (!PROPERTY_OPERATORS[f.dataType].includes(f.operator))
      fail(
        'unsupported_filter',
        `Operator ${f.operator} is invalid for this property type`,
        `propertyFilters.${i}.operator`,
      );
    if (f.dataType === 2 && !Number.isFinite(Number(f.value)))
      fail(
        'unsupported_filter',
        'Numeric property filters require a numeric value',
        `propertyFilters.${i}.value`,
      );
    if (f.dataType === 4 && Number.isNaN(Date.parse(f.value)))
      fail(
        'unsupported_filter',
        'Date property filters require an ISO date',
        `propertyFilters.${i}.value`,
      );
    // Native string equality comma-splits values; reject rather than change meaning.
    if (f.dataType === 1 && f.value.includes(','))
      fail(
        'unsupported_filter',
        'String property values cannot contain commas',
        `propertyFilters.${i}.value`,
      );
  });
  return {
    ...d,
    timezone: normalizeTimezone(d.timezone),
    filters: d.filters
      .map(f => ({ ...f, values: f.operator === 'eq' ? [...new Set(f.values)].sort() : f.values }))
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
    propertyFilters: [...d.propertyFilters].sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
  };
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Deterministic key order for hashing; undefined members are dropped as JSON would. */
export function canonical(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .filter(key => (value as any)[key] !== undefined)
        .sort()
        .map(key => [key, canonical((value as any)[key])]),
    );
  return value as JsonValue;
}

/** Hash of the normalized definition; name/description are row fields and never included. */
export function hashDefinition(definition: AnalysisDefinition) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(definition)))
    .digest('hex');
}

export function hashRequest(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

export function isRendererCompatible(operation: string, visualization: string) {
  return (RENDERERS as Record<string, string[]>)[operation]?.includes(visualization) ?? false;
}
