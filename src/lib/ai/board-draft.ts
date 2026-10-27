import type { BoardParameters } from '@/lib/types';

/**
 * Strict AI staging boundary, NOT authorization or a replacement for manual-board schemas.
 * Supports WebsiteMetricsBar, WebsiteChart, WorldMap (no props), MetricsTable
 * (required supported type and optional numeric limit 5/10/20), and TextBlock (required text).
 * Table dimensions match the website renderer registry. No filters, render code,
 * report widgets, pixel/link entities, aggregate widgets, or arbitrary options.
 * Strings are untrusted display data, never instructions or executable markup.
 *
 * Requires 1..12 rows, 1..4 populated columns per row, <=32 widgets, globally
 * unique safe layout IDs (1..64 chars), optional percentage sizes in (0,100].
 * Website UUIDs may be inherited from the root or selected per widget; aliases
 * must agree. Every referenced website must be independently reauthorized later.
 * Titles <=200, descriptions <=1000, text <=4000 UTF-16 code units. JSON objects
 * only: <=16 keys/object, depth <=8, <=1500 values, <=32000 total string units.
 * Unknown fields, dangerous keys, accessors, non-JSON values and sparse arrays
 * are rejected. Returns a detached JSON copy; never mutates the input.
 */
const dimensions = [
  'path',
  'fullPath',
  'entry',
  'exit',
  'title',
  'query',
  'referrer',
  'channel',
  'country',
  'region',
  'city',
  'browser',
  'os',
  'device',
  'language',
  'screen',
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'utmContent',
  'utmTerm',
  'event',
  'hostname',
];
const widgets = ['WebsiteMetricsBar', 'WebsiteChart', 'WorldMap', 'MetricsTable', 'TextBlock'];
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(): never {
  throw new Error('Invalid board draft');
}

function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key))) fail();
  return result;
}

function string(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length > max) fail();
}

function website(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !uuid.test(value)) fail();
}

function size(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) fail();
}

export function validateBoardDraft(input: unknown): BoardParameters {
  let nodes = 0;
  let textSize = 0;
  const seen = new Set<object>();
  function copy(value: unknown, depth = 0): unknown {
    if (++nodes > 1500 || depth > 8) fail();
    if (typeof value === 'string') {
      textSize += value.length;
      if (value.length > 4000 || textSize > 32000) fail();
      return value;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || seen.has(value)) fail();
    seen.add(value);
    const array = Array.isArray(value);
    if (
      Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) &&
      !(Object.getPrototypeOf(value) === null && !array)
    )
      fail();
    const keys = Reflect.ownKeys(value);
    if (keys.length > (array ? 49 : 16)) fail();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || forbidden.has(key)) fail();
      if (array && !/^(0|[1-9]\d*)$/.test(key)) fail();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) fail();
      result[key] = copy(descriptor.value, depth + 1);
    }
    if (array && Object.keys(result).length !== value.length) fail();
    seen.delete(value);
    return array ? Array.from({ length: value.length }, (_, i) => result[i]) : result;
  }

  const draft = object(copy(input), ['websiteId', 'rows']);
  if ('websiteId' in draft) website(draft.websiteId);
  if (!Array.isArray(draft.rows) || draft.rows.length < 1 || draft.rows.length > 12) fail();
  const ids = new Set<string>();
  let count = 0;
  function layout(value: unknown, allowed: string[]) {
    const item = object(value, allowed);
    const id = item.id;
    if (
      typeof id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(id) ||
      forbidden.has(id) ||
      ids.has(id)
    )
      fail();
    ids.add(id);
    if ('size' in item) size(item.size);
    return item;
  }
  for (const rowValue of draft.rows) {
    const row = layout(rowValue, ['id', 'size', 'columns']);
    if (!Array.isArray(row.columns) || row.columns.length < 1 || row.columns.length > 4) fail();
    for (const columnValue of row.columns) {
      if (++count > 32) fail();
      const column = layout(columnValue, ['id', 'size', 'component']);
      const component = object(column.component, [
        'type',
        'entityType',
        'entityId',
        'websiteId',
        'title',
        'description',
        'props',
      ]);
      if (typeof component.type !== 'string' || !widgets.includes(component.type)) fail();
      if ('title' in component) string(component.title, 200);
      if ('description' in component) string(component.description, 1000);
      if (component.type === 'TextBlock') {
        if (['entityType', 'entityId', 'websiteId'].some(key => key in component)) fail();
        const props = object(component.props, ['text']);
        string(props.text, 4000);
      } else {
        if ('entityType' in component && component.entityType !== 'website') fail();
        if ('entityId' in component) {
          website(component.entityId);
          if (component.entityType !== 'website') fail();
        }
        if ('websiteId' in component) website(component.websiteId);
        if (
          'entityId' in component &&
          'websiteId' in component &&
          component.entityId !== component.websiteId
        )
          fail();
        if (!(component.entityId || component.websiteId || draft.websiteId)) fail();
        const props =
          'props' in component
            ? object(component.props, component.type === 'MetricsTable' ? ['type', 'limit'] : [])
            : {};
        // The renderer does not apply registry defaults; MetricsTable needs an explicit API type.
        if (
          component.type === 'MetricsTable' &&
          (typeof props.type !== 'string' || !dimensions.includes(props.type))
        )
          fail();
        if ('limit' in props && ![5, 10, 20].includes(props.limit as number)) fail();
      }
    }
  }
  return draft as BoardParameters;
}
