import { render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BoardComponentRenderer } from '@/app/(main)/boards/[boardId]/BoardComponentRenderer';
import { useWebsiteMetricsQuery } from '@/components/hooks';
import { validateBoardDraft } from './board-draft';

vi.mock('@/components/hooks', () => ({
  useWebsiteMetricsQuery: vi.fn(() => ({ data: undefined })),
  useNavigation: () => ({ updateParams: vi.fn() }),
  useMessages: () => ({ t: (value: string) => value, labels: {} }),
}));
vi.mock('@/components/icons', () => ({ Maximize: () => null }));
vi.mock('@/components/common/IconLabel', () => ({ IconLabel: () => null }));
vi.mock('@/components/common/LinkButton', () => ({ LinkButton: () => null }));
vi.mock('@/components/common/LoadingPanel', () => ({ LoadingPanel: () => null }));
vi.mock('@/components/metrics/MetricLabel', () => ({ MetricLabel: () => null }));
vi.mock('@/components/metrics/ListTable', () => ({ ListTable: () => null }));
// Isolate unrelated registry widgets, but use the real renderer and MetricsTable.
// Include the registry default to prove that it is NOT applied by the renderer.
vi.mock('@/app/(main)/boards/boardComponentRegistry', async () => {
  const { MetricsTable } = await import('@/components/metrics/MetricsTable');
  return {
    getComponentDefinition: () => ({
      component: MetricsTable,
      defaultProps: { type: 'path', limit: 10 },
    }),
  };
});

const websiteId = '12345678-1234-4234-8234-123456789abc';
const otherId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const component = (type = 'WebsiteChart', props?: Record<string, unknown>) => ({
  type,
  ...(props ? { props } : {}),
});
const draft = (widget: Record<string, unknown> = component()) => ({
  websiteId,
  rows: [{ id: 'row-1', columns: [{ id: 'col-1', component: widget }] }],
});

// All strings/IDs are synthetic. No network, server imports, or production fixtures.
describe('validateBoardDraft', () => {
  it.each([
    component('WebsiteMetricsBar'),
    component('WebsiteChart'),
    component('WorldMap'),
    component('MetricsTable', { type: 'path' }),
    component('MetricsTable', { type: 'country', limit: 20 }),
    component('TextBlock', { text: '<script>untrusted analytics</script>' }),
  ])('round-trips supported widget %j as detached data', widget => {
    const input = draft(widget);
    const output = validateBoardDraft(input);
    expect(output).toEqual(input);
    expect(validateBoardDraft(JSON.parse(JSON.stringify(output)))).toEqual(input);
    expect(output).not.toBe(input);
    expect(output.rows[0].columns[0].component).not.toBe(widget);
    expect(input).toEqual(draft(widget));
  });

  it.each([
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
  ])('accepts registry table dimension %s', type => {
    expect(validateBoardDraft(draft(component('MetricsTable', { type, limit: 5 })))).toBeTruthy();
  });

  it.each([undefined, {}, { limit: 10 }])('rejects MetricsTable without a type: %j', props => {
    expect(() => validateBoardDraft(draft(component('MetricsTable', props)))).toThrow();
  });

  it.each([
    { type: 'path' },
    { type: 'country', limit: 5 },
    { type: 'event', limit: 10 },
    { type: 'browser', limit: 20 },
  ])('delivers explicit table query props through the real consumer: %j', props => {
    const output = validateBoardDraft(
      JSON.parse(JSON.stringify(draft(component('MetricsTable', props)))),
    );
    vi.mocked(useWebsiteMetricsQuery).mockClear();
    render(
      createElement(BoardComponentRenderer, {
        config: output.rows[0].columns[0].component!,
        websiteId: output.websiteId,
      }),
    );
    expect(useWebsiteMetricsQuery).toHaveBeenLastCalledWith(websiteId, {
      type: props.type,
      limit: 'limit' in props ? props.limit : undefined,
    });
  });

  it('supports inherited, legacy, and explicit website entities and bounded sizes', () => {
    for (const selection of [
      { websiteId: otherId },
      { entityType: 'website', entityId: otherId },
      { entityType: 'website', entityId: otherId, websiteId: otherId },
    ]) {
      const input = draft({
        ...component(),
        ...selection,
        title: 'Traffic',
        description: 'Overview',
      });
      input.rows[0] = { ...input.rows[0], size: 100 } as (typeof input.rows)[0];
      expect(validateBoardDraft(input)).toEqual(input);
      expect(validateBoardDraft({ rows: input.rows })).toEqual({ rows: input.rows });
    }
    expect(
      validateBoardDraft({ rows: draft(component('TextBlock', { text: '' })).rows }),
    ).toBeTruthy();
  });

  it.each([
    null,
    undefined,
    true,
    1,
    'draft',
    [],
    {},
    { rows: [] },
    { ...draft(), pixelId: websiteId },
    { ...draft(), linkId: websiteId },
    { ...draft(), options: {} },
    { ...draft(), websiteId: 'not-a-uuid' },
    { rows: draft().rows },
    { ...draft(), rows: [{ id: 'r', columns: [] }] },
    { ...draft(), rows: [{ id: 'r', columns: [{ id: 'c' }] }] },
    { ...draft(), rows: [{ id: 'r', columns: [{ id: 'c', component: null }] }] },
  ])('rejects invalid root/layout %j', input => {
    expect(() => validateBoardDraft(input)).toThrow('Invalid board draft');
  });

  it.each([
    component('Unknown'),
    component('Goal', { reportId: websiteId }),
    component('Funnel'),
    component('RevenueChart'),
    component('Aggregate'),
    { ...component(), entityType: 'pixel', entityId: websiteId },
    { ...component(), entityType: 'link', entityId: websiteId },
    { ...component(), entityType: 'all' },
    { ...component(), entityId: websiteId },
    { ...component(), entityType: 'website', entityId: 'bad' },
    { ...component(), websiteId: 'bad' },
    { ...component(), entityType: 'website', entityId: websiteId, websiteId: otherId },
    { ...component('TextBlock', { text: 'note' }), websiteId },
    { ...component('TextBlock', { text: 'note' }), entityType: 'website' },
    component('TextBlock'),
    component('TextBlock', {}),
    component('TextBlock', { text: 5 }),
    component('TextBlock', { text: 'ok', html: '<b>bad</b>' }),
    component('WebsiteChart', { websiteId: otherId }),
    component('WebsiteMetricsBar', { filters: [] }),
    component('WorldMap', { onClick: 'code' }),
    component('MetricsTable', { type: 'unknown' }),
    component('MetricsTable', { type: 'path', limit: '10' }),
    component('MetricsTable', { type: 'path', limit: 0 }),
    component('MetricsTable', { type: 'path', limit: 21 }),
    component('MetricsTable', { type: 'path', options: {} }),
    component('MetricsTable', { type: ['country'] }),
    { ...component(), title: 1 },
    { ...component(), description: null },
  ])('rejects unsupported widget, entity or props %j', widget => {
    expect(() => validateBoardDraft(draft(widget))).toThrow();
  });

  it.each([0, -1, 101, NaN, Infinity, '50', null])('rejects size %j at both levels', size => {
    const input = draft();
    expect(() => validateBoardDraft({ ...input, rows: [{ ...input.rows[0], size }] })).toThrow();
    expect(() =>
      validateBoardDraft({
        ...input,
        rows: [{ ...input.rows[0], columns: [{ ...input.rows[0].columns[0], size }] }],
      }),
    ).toThrow();
  });

  it('rejects unknown fields on rows, columns and widgets, including per-row filters', () => {
    const input = draft();
    for (const field of ['filters', 'options', 'websiteId']) {
      expect(() =>
        validateBoardDraft({ ...input, rows: [{ ...input.rows[0], [field]: {} }] }),
      ).toThrow();
      expect(() =>
        validateBoardDraft({
          ...input,
          rows: [{ ...input.rows[0], columns: [{ ...input.rows[0].columns[0], [field]: {} }] }],
        }),
      ).toThrow();
    }
    expect(() => validateBoardDraft(draft({ ...component(), filters: [] }))).toThrow();
  });

  it.each(['', 'a'.repeat(65), '__proto__', 'constructor', 'prototype', 'bad id'])(
    'rejects layout ID %j',
    id => {
      const input = draft();
      input.rows[0].id = id;
      expect(() => validateBoardDraft(input)).toThrow();
    },
  );

  it('requires globally unique layout IDs', () => {
    const input = draft();
    input.rows[0].columns[0].id = input.rows[0].id;
    expect(() => validateBoardDraft(input)).toThrow();
    const repeated = draft();
    repeated.rows.push(repeated.rows[0]);
    expect(() => validateBoardDraft(repeated)).toThrow();
  });

  it('enforces row, column and total widget budgets', () => {
    const rows = (n: number, columns: number) =>
      Array.from({ length: n }, (_, r) => ({
        id: `r${r}`,
        columns: Array.from({ length: columns }, (_, c) => ({
          id: `c${r}-${c}`,
          component: component(),
        })),
      }));
    expect(validateBoardDraft({ websiteId, rows: rows(8, 4) }).rows).toHaveLength(8);
    expect(validateBoardDraft({ websiteId, rows: rows(12, 1) }).rows).toHaveLength(12);
    for (const [r, c] of [
      [13, 1],
      [1, 5],
      [9, 4],
    ]) {
      expect(() => validateBoardDraft({ websiteId, rows: rows(r, c) })).toThrow();
    }
  });

  it('bounds display strings and total string payload without interpreting analytics text', () => {
    for (const [field, max] of [
      ['title', 200],
      ['description', 1000],
    ] as const) {
      expect(validateBoardDraft(draft({ ...component(), [field]: 'x'.repeat(max) }))).toBeTruthy();
      expect(() =>
        validateBoardDraft(draft({ ...component(), [field]: 'x'.repeat(max + 1) })),
      ).toThrow();
    }
    expect(
      validateBoardDraft(draft(component('TextBlock', { text: 'x'.repeat(4000) }))),
    ).toBeTruthy();
    expect(() =>
      validateBoardDraft(draft(component('TextBlock', { text: 'x'.repeat(4001) }))),
    ).toThrow();
    const rows = Array.from({ length: 9 }, (_, i) => ({
      id: `r${i}`,
      columns: [
        {
          id: `c${i}`,
          component: component('TextBlock', { text: 'x'.repeat(4000) }),
        },
      ],
    }));
    expect(() => validateBoardDraft({ rows })).toThrow();
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects dangerous key %s at every object level',
    key => {
      const input = draft(component('MetricsTable', { type: 'path' }));
      for (const target of [
        input,
        input.rows[0],
        input.rows[0].columns[0],
        input.rows[0].columns[0].component,
        input.rows[0].columns[0].component.props,
      ]) {
        const clone = JSON.parse(JSON.stringify(input));
        Object.defineProperty(target, key, { value: {}, enumerable: true, configurable: true });
        expect(() => validateBoardDraft(input)).toThrow();
        delete (target as Record<string, unknown>)[key];
        expect(validateBoardDraft(clone)).toEqual(clone);
      }
      expect(() => validateBoardDraft(JSON.parse(`{"${key}":{},"rows":[]}`))).toThrow();
    },
  );

  it('rejects non-JSON objects, accessors, symbols, undefined and functions without invoking getters', () => {
    const input = draft();
    let invoked = false;
    Object.defineProperty(input, 'title', {
      enumerable: true,
      get() {
        invoked = true;
        return 'x';
      },
    });
    expect(() => validateBoardDraft(input)).toThrow();
    expect(invoked).toBe(false);
    const exotic = [
      new Date(),
      new Map(),
      Object.create({ rows: [] }),
      { ...draft(), [Symbol('key')]: true },
      { ...draft(), extra: undefined },
      { ...draft(), extra: () => 1 },
      { ...draft(), extra: 1n },
    ];
    for (const value of exotic) {
      expect(() => validateBoardDraft(value)).toThrow();
    }
    const hidden = draft();
    Object.defineProperty(hidden, 'secret', { value: 1 });
    expect(() => validateBoardDraft(hidden)).toThrow();
  });

  it('rejects cycles, sparse arrays, array properties and excessive nesting/keys', () => {
    const cycle: Record<string, unknown> = draft();
    cycle.extra = cycle;
    expect(() => validateBoardDraft(cycle)).toThrow();
    const sparse = draft();
    sparse.rows.length = 2;
    expect(() => validateBoardDraft(sparse)).toThrow();
    const extra = draft();
    Object.assign(extra.rows, { custom: 'bad' });
    expect(() => validateBoardDraft(extra)).toThrow();
    let deep: unknown = {};
    for (let i = 0; i < 10; i++) deep = { nested: deep };
    expect(() => validateBoardDraft({ ...draft(), deep })).toThrow();
    expect(() =>
      validateBoardDraft({
        ...draft(),
        ...Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`key${i}`, i])),
      }),
    ).toThrow();
  });
});
