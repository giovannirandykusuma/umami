// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/prisma', () => ({ default: { rawQuery: vi.fn() } }));
vi.mock('@/lib/clickhouse', () => ({ default: { rawQuery: vi.fn() } }));
vi.mock('./query', () => ({ getAiQueryScope: vi.fn(() => ({ deadline: Date.now() + 1000 })) }));
import prisma from '@/lib/prisma';
import clickhouse from '@/lib/clickhouse';
import { getAiQueryScope } from './query';
import { discoverAnalytics } from './discovery';
const engineProof = process.env.AI_DISCOVERY_ENGINES === '1';
const args = { websiteId: '11111111-1111-4111-8111-111111111111', startAt: 1, endAt: 1000 };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic');
  vi.stubEnv('CLICKHOUSE_URL', '');
});
it.each(['postgresql', 'clickhouse'])(
  'uses bounded metadata-only parameterized %s queries',
  async engine => {
    if (engine === 'clickhouse') vi.stubEnv('CLICKHOUSE_URL', 'http://synthetic');
    const query = vi.mocked(engine === 'clickhouse' ? clickhouse.rawQuery : prisma.rawQuery);
    query
      .mockResolvedValueOnce([{ eventName: 'login?', count: '18446744073709551615', raw: 'never' }])
      .mockResolvedValueOnce([
        { eventName: 'login?', propertyName: 'method', dataType: 1, string_value: 'secret' },
      ]);
    const result = await discoverAnalytics(args, 1000);
    expect(result.events).toEqual([{ name: 'login?', count: '18446744073709551615' }]);
    expect(result.properties).toEqual([{ eventName: 'login?', name: 'method', type: 'string' }]);
    expect(JSON.stringify(result)).not.toMatch(/secret|never|string_value/);
    expect(result.coverage).toBe('unavailable');
    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql, params] of query.mock.calls) {
      expect(sql).not.toMatch(
        /select\s+\*|string_value|number_value|date_value|session_id|user_id/i,
      );
      expect(sql).not.toContain(args.websiteId);
      expect(params).toMatchObject({ websiteId: args.websiteId });
      expect(sql).toMatch(/limit (51|101)/);
    }
  },
);
it('reports truncation without implying absence', async () => {
  vi.mocked(prisma.rawQuery)
    .mockResolvedValueOnce(
      Array.from({ length: 51 }, (_, n) => ({ eventName: `e${n}`, count: '1' })),
    )
    .mockResolvedValueOnce(
      Array.from({ length: 101 }, (_, n) => ({
        eventName: 'e',
        propertyName: `p${n}`,
        dataType: 4,
      })),
    );
  const result = await discoverAnalytics(args, 1000);
  expect(result.events).toHaveLength(50);
  expect(result.properties).toHaveLength(100);
  expect(result.truncated).toEqual({ events: true, properties: true });
  expect(result.properties[0].type).toBe('date');
});
it.each([
  { ...args, extra: 'value' },
  { ...args, startAt: -1 },
  { ...args, endAt: 1001 },
  { ...args, startAt: 999, endAt: 1 },
  { ...args, startAt: 0, endAt: 32 * 86400000 },
  Object.assign(Object.create({ extra: 'inherited' }), args),
  JSON.parse(JSON.stringify(args).replace('"websiteId"', '"__proto__":{},"websiteId"')),
])('rejects invalid or prototype-bearing arguments without querying', async input => {
  await expect(discoverAnalytics(input, 1000)).rejects.toThrow();
  expect(prisma.rawQuery).not.toHaveBeenCalled();
  expect(clickhouse.rawQuery).not.toHaveBeenCalled();
});
it('fails explicitly for unsupported databases', async () => {
  vi.stubEnv('DATABASE_URL', 'mysql://synthetic');
  await expect(discoverAnalytics(args, 1000)).rejects.toThrow('Unsupported');
  expect(prisma.rawQuery).not.toHaveBeenCalled();
});
it('requires the bounded host scope', async () => {
  vi.mocked(getAiQueryScope).mockReturnValueOnce(undefined);
  await expect(discoverAnalytics(args, 1000)).rejects.toThrow('scope');
});
it.skipIf(!engineProof)(
  'executes real scoped SQL against both disposable synthetic engines',
  async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/prisma');
    vi.doUnmock('@/lib/clickhouse');
    vi.doUnmock('./query');
    vi.stubEnv('DATABASE_URL', 'postgresql://ai_synthetic@127.0.0.1:25432/ai_synthetic');
    vi.stubEnv('CLICKHOUSE_URL', 'http://ai_synthetic:synthetic-only@127.0.0.1:28123/default');
    const { execFileSync } = await import('node:child_process');
    const pool = {
      query: (sql: string, params?: string[]) => {
        const query = params ? sql.replaceAll('$1', `'${params[0]}'`) : sql;
        execFileSync('/opt/homebrew/opt/postgresql@16/bin/psql', [
          '-X',
          '-h',
          '127.0.0.1',
          '-p',
          '25432',
          '-U',
          'ai_synthetic',
          '-d',
          'ai_synthetic',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          query,
        ]);
      },
      end: async () => {},
    };
    const { createClient } = await import('@clickhouse/client');
    const ch = createClient({
      url: 'http://127.0.0.1:28123',
      username: 'ai_synthetic',
      password: 'synthetic-only',
    });
    const schema = `discovery_${Date.now()}`;
    if (!/^discovery_[0-9]+$/.test(schema)) throw new Error('Invalid synthetic schema');
    // Additive isolated synthetic fixtures only; never modify an existing application table.
    await pool.query(`create schema ${schema}`);
    await pool.query(
      `create table ${schema}.website_event (event_id uuid, website_id uuid, created_at timestamp, event_type integer, event_name text)`,
    );
    await pool.query(
      `create table ${schema}.event_data (website_event_id uuid, website_id uuid, created_at timestamp, data_key text, data_type integer, string_value text)`,
    );
    await pool.query(
      `insert into ${schema}.website_event values ($1,$1,timestamp '1970-01-01 00:00:00.500',2,'synthetic-login')`,
      [args.websiteId],
    );
    await pool.query(
      `insert into ${schema}.event_data values ($1,$1,timestamp '1970-01-01 00:00:00.500','method',1,'PRIVATE_VALUE')`,
      [args.websiteId],
    );
    await ch.command({ query: `create database ${schema}` });
    await ch.command({
      query: `create table ${schema}.website_event (website_id UUID, created_at DateTime64(3), event_type UInt32, event_name String) engine=MergeTree order by website_id`,
    });
    await ch.command({
      query: `create table ${schema}.event_data (website_id UUID, created_at DateTime64(3), event_name String, data_key String, data_type UInt32, string_value String) engine=MergeTree order by website_id`,
    });
    await ch.insert({
      table: `${schema}.website_event`,
      format: 'JSONEachRow',
      values: [
        {
          website_id: args.websiteId,
          created_at: '1970-01-01 00:00:00.500',
          event_type: 2,
          event_name: 'synthetic-login',
        },
      ],
    });
    await ch.insert({
      table: `${schema}.event_data`,
      format: 'JSONEachRow',
      values: [
        {
          website_id: args.websiteId,
          created_at: '1970-01-01 00:00:00.500',
          event_name: 'synthetic-login',
          data_key: 'method',
          data_type: 1,
          string_value: 'PRIVATE_VALUE',
        },
      ],
    });
    vi.stubEnv(
      'DATABASE_URL',
      `postgresql://ai_synthetic@127.0.0.1:25432/ai_synthetic?schema=${schema}`,
    );
    vi.stubEnv('CLICKHOUSE_URL', `http://ai_synthetic:synthetic-only@127.0.0.1:28123/${schema}`);
    const actualScope = await import('./query');
    const actualDiscovery = await import('./discovery');
    try {
      for (const engine of ['postgresql', 'clickhouse']) {
        vi.stubEnv(
          'CLICKHOUSE_URL',
          engine === 'clickhouse'
            ? `http://ai_synthetic:synthetic-only@127.0.0.1:28123/${schema}`
            : '',
        );
        const result = await actualScope.withAiRead(
          () => actualDiscovery.discoverAnalytics(args, 1000),
          AbortSignal.timeout(10000),
        );
        expect(result.events, engine).toEqual([{ name: 'synthetic-login', count: '1' }]);
        expect(result.properties).toEqual([
          { eventName: 'synthetic-login', name: 'method', type: 'string' },
        ]);
        expect(JSON.stringify(result)).not.toContain('PRIVATE_VALUE');
      }
    } finally {
      await pool.end();
      await ch.close();
    }
  },
  30000,
);
it('rejects rounded counts', async () => {
  vi.mocked(prisma.rawQuery)
    .mockResolvedValueOnce([{ eventName: 'e', count: 1e18 }])
    .mockResolvedValueOnce([]);
  await expect(discoverAnalytics(args, 1000)).rejects.toThrow('count');
});
