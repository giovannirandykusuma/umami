import { describe, expect, it } from 'vitest';
import { resolveDatePolicy, toNativeRange } from './dates';
import {
  AnalysisError,
  COMPATIBILITY,
  hashDefinition,
  isRendererCompatible,
  normalizeDefinition,
} from './definition';

const websiteId = '11111111-1111-4111-8111-111111111111';
const base = {
  schemaVersion: 1,
  source: { websiteId },
  operation: 'totals',
  metric: 'pageviews',
  datePolicy: { type: 'fixed', startAt: 1_000, endAt: 2_000 },
  timezone: 'UTC',
  semanticBinding: {
    label: 'Pageviews',
    unit: 'pageviews',
    population: 'all visitors',
    meaningSource: 'observed_only',
  },
};
function code(input: unknown) {
  try {
    normalizeDefinition(input);
  } catch (e) {
    expect(e).toBeInstanceOf(AnalysisError);
    return (e as AnalysisError).toJSON();
  }
  throw new Error('expected rejection');
}

describe('definition v1 compatibility matrix', () => {
  const accepted: Record<string, unknown>[] = [
    { operation: 'series', metric: 'pageviews', unit: 'day' },
    { operation: 'series', metric: 'sessions', unit: 'hour' },
    { operation: 'series', metric: 'events', unit: 'month', event: 'signup' },
    { operation: 'breakdown', metric: 'sessions', groupBy: { dimension: 'country', top: 5 } },
    { operation: 'breakdown', metric: 'events', event: 'signup', groupBy: { dimension: 'path' } },
    { operation: 'totals', metric: 'visits' },
    { operation: 'totals', metric: 'identified_users' },
    { operation: 'totals', metric: 'events', event: 'signup' },
    {
      operation: 'numeric_property',
      metric: 'median',
      event: 'buy',
      property: { owner: 'event', name: 'amount' },
    },
    { operation: 'numeric_property', metric: 'count', property: { owner: 'session', name: 'age' } },
  ];
  it.each(accepted)('accepts %o', patch => {
    expect(normalizeDefinition({ ...base, ...patch }).operation).toBe(patch.operation);
  });
  const rejected: [Record<string, unknown>, string, string?][] = [
    [{ operation: 'series', metric: 'visitors', unit: 'day' }, 'unsupported_combination', 'metric'],
    [
      { operation: 'breakdown', metric: 'pageviews', groupBy: { dimension: 'path' } },
      'unsupported_combination',
      'metric',
    ],
    [{ operation: 'totals', metric: 'events' }, 'invalid_definition', 'event'],
    [{ operation: 'totals', metric: 'pageviews', event: 'x' }, 'unsupported_combination', 'event'],
    [{ operation: 'series', metric: 'pageviews' }, 'invalid_definition', 'unit'],
    [{ operation: 'totals', metric: 'pageviews', unit: 'day' }, 'unsupported_combination', 'unit'],
    [{ operation: 'breakdown', metric: 'sessions' }, 'invalid_definition', 'groupBy'],
    [
      { operation: 'numeric_property', metric: 'sum', property: { owner: 'event', name: 'a' } },
      'invalid_definition',
      'event',
    ],
    [
      { operation: 'numeric_property', metric: 'p99', property: { owner: 'session', name: 'a' } },
      'unsupported_combination',
      'metric',
    ],
    [
      {
        operation: 'totals',
        metric: 'identified_users',
        filters: [{ dimension: 'country', operator: 'eq', values: ['DE'] }],
      },
      'unsupported_combination',
      'filters',
    ],
    [{ filters: [{ dimension: 'sql', operator: 'eq', values: ['x'] }] }, 'unsupported_filter'],
    [{ filters: [{ dimension: 'path', operator: 're', values: ['x'] }] }, 'unsupported_filter'],
    [{ filters: [{ dimension: 'path', operator: 'neq', values: ['a,b'] }] }, 'unsupported_filter'],
    [{ filters: [{ dimension: 'country', operator: 'eq', values: ['DE,FR'] }] }, 'unsupported_filter'],
    [
      {
        propertyFilters: [
          { owner: 'session', name: 'n', dataType: 2, operator: 'gt', value: 'abc' },
        ],
      },
      'unsupported_filter',
    ],
    [
      {
        propertyFilters: [{ owner: 'session', name: 'b', dataType: 3, operator: 't', value: 'x' }],
      },
      'unsupported_filter',
    ],
    [
      {
        propertyFilters: [{ owner: 'session', name: 's', dataType: 1, operator: 'eq', value: '' }],
      },
      'unsupported_filter',
    ],
    [
      { datePolicy: { type: 'fixed', startAt: 5, endAt: 5 } },
      'invalid_definition',
      'datePolicy.endAt',
    ],
    [{ datePolicy: { type: 'rolling', window: '365d' } }, 'invalid_definition'],
    [{ timezone: 'Mars/Base' }, 'invalid_definition', 'timezone'],
    [{ schemaVersion: 2 }, 'unsupported_schema_version', 'schemaVersion'],
    [{ sql: 'select 1' }, 'invalid_definition'],
    [{ limits: { maxRows: 100000 } }, 'invalid_definition'],
  ];
  it.each(rejected)('rejects %o as %s', (patch, expected, field) => {
    const error = code({ ...base, ...patch });
    expect(error.code).toBe(expected);
    if (field) expect(error.field).toBe(field);
    expect(error.retryable).toBe(false);
  });
  it('every matrix entry is reachable and matrix keys equal the operation enum', () => {
    expect(Object.keys(COMPATIBILITY).sort()).toEqual([
      'breakdown',
      'numeric_property',
      'series',
      'totals',
    ]);
  });
});

describe('normalization and hashing', () => {
  it('hash ignores filter order, duplicate eq values and timezone alias but not semantics', () => {
    const a = normalizeDefinition({
      ...base,
      timezone: 'Asia/Calcutta',
      filters: [
        { dimension: 'country', operator: 'eq', values: ['DE', 'FR', 'DE'] },
        { dimension: 'path', operator: 'c', values: ['/x'] },
      ],
    });
    const b = normalizeDefinition({
      ...base,
      timezone: 'Asia/Kolkata',
      filters: [
        { dimension: 'path', operator: 'c', values: ['/x'] },
        { dimension: 'country', operator: 'eq', values: ['FR', 'DE'] },
      ],
    });
    expect(hashDefinition(a)).toBe(hashDefinition(b));
    expect(hashDefinition(a)).not.toBe(
      hashDefinition(normalizeDefinition({ ...base, timezone: 'Asia/Kolkata', filters: [] })),
    );
    expect(hashDefinition(normalizeDefinition(base))).not.toBe(
      hashDefinition(
        normalizeDefinition({
          ...base,
          semanticBinding: { ...base.semanticBinding, meaningSource: 'user_confirmed' },
        }),
      ),
    );
  });
  it('renderer compatibility follows result shape', () => {
    expect(isRendererCompatible('series', 'line')).toBe(true);
    expect(isRendererCompatible('totals', 'line')).toBe(false);
    expect(isRendererCompatible('breakdown', 'metric')).toBe(false);
    expect(isRendererCompatible('unknown', 'table')).toBe(false);
  });
});

describe('date policy resolution', () => {
  const now = Date.parse('2026-03-29T10:30:00Z'); // after Europe/Berlin spring-forward (01:00Z)
  it('today starts at local midnight; 24h is elapsed time', () => {
    expect(
      resolveDatePolicy({ type: 'rolling', window: 'today' }, 'Europe/Berlin', now).startAt,
    ).toBe(Date.parse('2026-03-28T23:00:00Z'));
    expect(
      resolveDatePolicy({ type: 'rolling', window: '24h' }, 'Europe/Berlin', now),
    ).toMatchObject({
      startAt: now - 86_400_000,
      endAt: now,
    });
  });
  it('7d starts at local midnight six calendar days back across DST', () => {
    // 2026-03-23 00:00 CET (+01:00) even though now is CEST (+02:00).
    expect(resolveDatePolicy({ type: 'rolling', window: '7d' }, 'Europe/Berlin', now).startAt).toBe(
      Date.parse('2026-03-22T23:00:00Z'),
    );
    expect(resolveDatePolicy({ type: 'rolling', window: '30d' }, 'UTC', now).startAt).toBe(
      Date.parse('2026-02-28T00:00:00Z'),
    );
  });
  it('fixed half-open range maps to native inclusive bounds by excluding the end millisecond', () => {
    const range = resolveDatePolicy({ type: 'fixed', startAt: 1000, endAt: 5000 }, 'UTC', now);
    expect(toNativeRange(range)).toEqual({ startDate: new Date(1000), endDate: new Date(4999) });
  });
});
