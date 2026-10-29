import { describe, expect, it, vi } from 'vitest';
import { executeTool, Interaction } from '../tools';
import { advanceTurn, clearResults, saveResult } from './results';
import { encodeFilters } from './filters';
import { escapeSearch, peopleQuery } from '@/queries/sql/people/getPeople';

vi.mock('@/lib/prisma', () => ({ default: {} }));
vi.mock('@/lib/clickhouse', () => ({ default: {} }));
const websiteId = '11111111-1111-4111-8111-111111111111';
const args = {
  websiteId,
  startAt: Date.parse('2026-01-01T00:00:00Z'),
  endAt: Date.parse('2026-01-02T23:59:59Z'),
  unit: 'day',
  timezone: 'UTC',
  metric: 'events',
};
function input() {
  const parts: any[] = [];
  return {
    credentials: new Headers({ authorization: 'Bearer trusted' }),
    interaction: new Interaction(part => parts.push(part), new AbortController().signal),
    context: advanceTurn('user', crypto.randomUUID()),
    fetch: vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify([{ t: '2026-01-01T00:00:00.000Z', y: 7 }]))),
    parts,
  };
}
describe('typed analytics', () => {
  it('encodes property filters with no loss', () => {
    expect(
      encodeFilters({
        distinctId: 'u_1',
        eventProperty: [{ name: 'button.name', op: 'eq', type: 1, value: 'save' }],
        sessionProperty: [{ name: 'name', op: 'c', type: 1, value: 'Dewi' }],
      }),
    ).toEqual({ distinctId: 'u_1', epf0: '1.eq.button%2Ename.save', spf0: '1.c.name.Dewi' });
  });
  it.each([
    [{ filters: { typo: 'x' } }, 'unsupported_filter'],
    [{ metric: 'visits' }, 'unsupported_metric'],
    [{ metric: 'identifiedUsers' }, 'unsupported_metric'],
  ])('rejects unsupported requests before fetch (%j)', async (extra, code) => {
    const host = input();
    expect(await executeTool('query_series', { ...args, ...extra }, host)).toMatchObject({
      ok: false,
      code,
      isError: true,
    });
    expect(host.fetch).not.toHaveBeenCalled();
  });
  it.each(['events', 'pageviews', 'visitors'])(
    'rejects daily %s beyond upstream daily range before fetching',
    async metric => {
      const host = input();
      expect(
        await executeTool(
          'query_series',
          { ...args, metric, endAt: Date.parse('2026-10-01T00:00:00Z') },
          host,
        ),
      ).toMatchObject({ ok: false, code: 'result_too_large', message: expect.stringContaining('coarser') });
      expect(host.fetch).not.toHaveBeenCalled();
    },
  );
  it.each([0, 1, 3])('caps channel rows with exact truncation metadata (%s rows)', async count => {
    const host = input();
    // The channel metrics route ignores limit and returns its entire grouped result.
    const rows = ['Direct', 'Search', 'Social'].slice(0, count).map((x, i) => ({ x, y: 5 - i }));
    host.fetch.mockResolvedValue(new Response(JSON.stringify(rows)));
    const result = await executeTool('query_breakdown', { ...args, dimension: 'channel', limit: 1 }, host);
    expect(result).toMatchObject({
      ok: true,
      data: { rows: rows.slice(0, 1), truncated: count > 1, empty: count === 0 },
    });
  });
  it.each([400, 404, 500])('strips unsafe HTTP %s bodies', async status => {
    const host = input();
    host.fetch.mockResolvedValue(new Response('<html>secret stack</html>', { status }));
    const result = await executeTool('query_series', args, host);
    expect(result).toMatchObject({
      ok: false,
      status,
      code: 'http_error',
      isError: true,
      retryable: status >= 500,
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('rejects HTML even on 200', async () => {
    const host = input();
    host.fetch.mockResolvedValue(new Response('<html>secret</html>'));
    expect(
      await executeTool('umami_api', { method: 'GET', path: '/api/websites' }, host),
    ).toMatchObject({ ok: false, code: 'http_error' });
  });
  it('charts identical host buckets and ignores forged scope arguments', async () => {
    const host = input();
    const result = await executeTool(
      'query_series',
      { ...args, userId: 'evil', chatId: 'evil' },
      host,
    );
    expect(result.ok).toBe(true);
    expect(result.data.total).toBe(7);
    expect(result.data.buckets).toHaveLength(2);
    expect(result.data.buckets[1].y).toBe(0);
    const queued = await executeTool(
      'show_chart',
      { resultId: result.data.resultId, kind: 'line' },
      host,
    );
    expect(queued).toMatchObject({ ok: true, status: 'queued' });
    expect(host.parts[0]).toMatchObject({
      type: 'result-chart',
      series: { buckets: result.data.buckets, total: 7 },
    });
    for (const context of [
      advanceTurn('other', host.context.chatId),
      advanceTurn('user', 'foreign'),
    ]) {
      expect(
        await executeTool(
          'show_chart',
          { resultId: result.data.resultId, kind: 'table' },
          { ...host, context },
        ),
      ).toMatchObject({ code: 'unknown_result' });
    }
    const next = advanceTurn('user', host.context.chatId);
    expect(
      await executeTool(
        'show_chart',
        { resultId: result.data.resultId, kind: 'table' },
        { ...host, context: next },
      ),
    ).toMatchObject({ ok: true });
    const expired = advanceTurn('user', host.context.chatId);
    expect(
      await executeTool(
        'show_chart',
        { resultId: result.data.resultId, kind: 'table' },
        { ...host, context: expired },
      ),
    ).toMatchObject({ code: 'unknown_result' });
  });
  it('clears deleted chats and caps the LRU at 50', async () => {
    const host = input();
    const series = { buckets: [], total: 0 };
    const first = saveResult(host.context, series);
    for (let i = 0; i < 50; i++) saveResult(host.context, series);
    expect(await executeTool('show_chart', { resultId: first, kind: 'line' }, host)).toMatchObject({
      code: 'unknown_result',
    });
    const last = saveResult(host.context, series);
    clearResults(host.context.userId, host.context.chatId);
    expect(await executeTool('show_chart', { resultId: last, kind: 'line' }, host)).toMatchObject({
      code: 'unknown_result',
    });
  });
  it('reports exact invalid widget path and never emits it', async () => {
    const host = input();
    expect(
      await executeTool(
        'show_chart',
        { component: { type: 'WebsiteChart', websiteId, props: { websiteId } } },
        host,
      ),
    ).toMatchObject({ code: 'invalid_chart', path: 'props.websiteId' });
    expect(host.parts).toHaveLength(0);
  });
  it('rejects oversized charts and series rather than truncating', async () => {
    const host = input();
    expect(
      await executeTool(
        'query_series',
        { ...args, unit: 'hour', endAt: args.startAt + 500 * 3600000 },
        host,
      ),
    ).toMatchObject({ code: 'result_too_large' });
    expect(host.fetch).not.toHaveBeenCalled();
    const resultId = saveResult(host.context, {
      buckets: Array.from({ length: 400 }, () => ({ t: 'x'.repeat(100), y: 1 })),
      total: 400,
    });
    expect(await executeTool('show_chart', { resultId, kind: 'line' }, host)).toMatchObject({
      code: 'result_too_large',
    });
  });
  it.each([false, true])(
    'people query is literal, excludes anonymous IDs, aggregates before cap (CH %s)',
    ch => {
      expect(escapeSearch('%_\\')).toBe('%\\%\\_\\\\%');
      const sql = peopleQuery(ch);
      expect(sql).toContain("distinct_id <> ''");
      expect(sql).toContain('distinct_id is not null');
      expect(sql.indexOf('group by distinct_id')).toBeLessThan(sql.indexOf('limit 11'));
      expect(sql).toContain('count(distinct session_id)');
      expect(sql).toContain(ch ? 'positionCaseInsensitive' : "ilike {{search}} escape '\\'");
      const count = peopleQuery(ch, true);
      expect(count).toContain('from website_event e');
      expect(count).toContain('e.created_at between');
      expect(count.includes('join session s')).toBe(!ch);
      expect(count).toContain("distinct_id <> ''");
    },
  );
});
