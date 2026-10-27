// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgresql://synthetic@127.0.0.1:25432/postgres';
  process.env.CLICKHOUSE_URL = 'http://default@127.0.0.1:28123/default';
  const model = { findUnique: vi.fn(async () => ({ id: 'synthetic' })) };
  const tx = {
    website: model,
    share: { findFirst: vi.fn(async () => null) },
    board: { findUnique: vi.fn(async () => ({ userId: 'owner' })) },
    link: { findUnique: vi.fn(async () => null) },
    pixel: { findUnique: vi.fn(async () => null) },
    $executeRawUnsafe: vi.fn(async (_query: string) => 0),
    $queryRawUnsafe: vi.fn(async (_query: string) => [{ value: 1 }]),
  };
  const client = {
    website: { findUnique: vi.fn(async () => ({ id: 'ordinary' })) },
    $queryRawUnsafe: vi.fn(async () => []),
    $executeRawUnsafe: vi.fn(async () => 0),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(tx)),
  };
  const ch = {
    query: vi.fn(async (_options: unknown) => ({
      json: async (): Promise<unknown[]> => [{ value: 1 }],
    })),
  };
  return { tx, client, ch, adapter: vi.fn() };
});
vi.mock('@clickhouse/client', () => ({ createClient: () => mock.ch }));
vi.mock('@/lib/redis', () => ({ default: { enabled: false } }));
vi.mock('@prisma/adapter-pg', () => ({ PrismaPg: mock.adapter }));
vi.mock('@/generated/prisma/client', () => ({
  PrismaClient: vi.fn(function () {
    return mock.client;
  }),
}));
import prisma from '@/lib/prisma';
import { aiReads, getAiQueryScope, withAiRead } from './query';

beforeEach(() => vi.clearAllMocks());
afterAll(() => vi.unstubAllEnvs());
describe('AI-only shared database scope (synthetic forwarding, not engine proof)', () => {
  it('enlists model/helper and raw reads, preserves concurrent ordinary calls and clears scope', async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(r => {
      entered = r;
    });
    const gate = new Promise<void>(r => {
      release = r;
    });
    const work = withAiRead(async () => {
      entered();
      await gate;
      expect(prisma.client).toBe(mock.tx);
      await prisma.client.website.findUnique({ where: { id: 'synthetic' } });
      await prisma.rawQuery('select 1', {});
      expect(getAiQueryScope()).toBeDefined();
    }, new AbortController().signal);
    await ready;
    expect(prisma.client).toBe(mock.client);
    await prisma.client.website.findUnique({ where: { id: 'ordinary' } });
    release();
    await work;
    expect(mock.tx.website.findUnique).toHaveBeenCalledOnce();
    expect(mock.client.website.findUnique).toHaveBeenCalledOnce();
    expect(mock.tx.$queryRawUnsafe).toHaveBeenCalledWith('select 1');
    expect(mock.client.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(mock.tx.$executeRawUnsafe.mock.calls.map(c => c[0])).toEqual([
      'SET TRANSACTION READ ONLY',
      "SET LOCAL statement_timeout = '1000ms'",
    ]);
    expect(mock.client.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 1000,
      timeout: 10_000,
    });
    expect(mock.adapter).toHaveBeenCalledWith(
      {
        connectionString: 'postgresql://synthetic@127.0.0.1:25432/postgres',
        max: 4,
        connectionTimeoutMillis: 1000,
        statement_timeout: 1000,
      },
      { schema: null },
    );
    expect(getAiQueryScope()).toBeUndefined();
  });
  it('rejects nested transactions and writes; cleans scope after failure and admits next read', async () => {
    await expect(
      withAiRead(async () => {
        expect(() => prisma.transaction(() => {})).toThrow('Nested');
        await prisma.writeRawQuery('delete from website', {});
      }, new AbortController().signal),
    ).rejects.toThrow('cannot write');
    expect(aiReads.getStore()).toBeUndefined();
    await expect(withAiRead(async () => 'recovered', new AbortController().signal)).resolves.toBe(
      'recovered',
    );
  });
  it('covers actual getQueryFilters and permission helper model reads', async () => {
    const { getQueryFilters } = await import('@/lib/request');
    const { canViewWebsite } = await import('@/permissions/website');
    const { canUpdateBoard } = await import('@/permissions/board');
    await withAiRead(async () => {
      const site = '11111111-1111-4111-8111-111111111111';
      await getQueryFilters({ startAt: 1, endAt: 86400000, timezone: 'UTC', unit: 'day' }, site);
      await canViewWebsite({ user: { id: 'owner' } } as any, site);
      expect(await canUpdateBoard({ user: { id: 'owner' } } as any, 'board')).toBe(true);
    }, new AbortController().signal);
    expect(mock.tx.website.findUnique.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mock.tx.board.findUnique).toHaveBeenCalled();
    expect(mock.client.website.findUnique).not.toHaveBeenCalled();
  });
  it('forwards scoped ClickHouse limits/abort without altering ordinary query options', async () => {
    const { default: clickhouse } = await import('@/lib/clickhouse');
    const controller = new AbortController();
    await withAiRead(async () => {
      await clickhouse.rawQuery('select 1');
    }, controller.signal);
    expect(mock.ch.query.mock.calls[0][0]).toEqual({
      query: 'select 1',
      query_params: {},
      format: 'JSONEachRow',
      abort_signal: controller.signal,
      clickhouse_settings: {
        max_execution_time: 1,
        wait_end_of_query: 1,
        timeout_overflow_mode: 'throw',
        date_time_output_format: 'iso',
        output_format_json_quote_64bit_integers: 0,
      },
    });
    await clickhouse.rawQuery('select 1');
    expect(mock.ch.query.mock.calls[1][0]).toEqual({
      query: 'select 1',
      query_params: {},
      format: 'JSONEachRow',
      clickhouse_settings: {
        date_time_output_format: 'iso',
        output_format_json_quote_64bit_integers: 0,
      },
    });
  });
  it('withholds late ClickHouse exception rows but preserves ordinary decoding', async () => {
    const { default: clickhouse } = await import('@/lib/clickhouse');
    mock.ch.query.mockResolvedValueOnce({ json: async () => [{ exception: 'synthetic timeout' }] });
    await expect(
      withAiRead(() => clickhouse.rawQuery('select 1'), new AbortController().signal),
    ).rejects.toThrow('AI analytics query failed');
    mock.ch.query.mockResolvedValueOnce({ json: async () => [{ exception: 'ordinary' }] });
    await expect(clickhouse.rawQuery('select 1')).resolves.toEqual([{ exception: 'ordinary' }]);
  });
  it('caps all scopes including authorization, and recovers admission after cleanup', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const reads = Array.from({ length: 4 }, () =>
      withAiRead(() => gate, new AbortController().signal),
    );
    await expect(withAiRead(async () => 'overflow', new AbortController().signal)).rejects.toThrow(
      'capacity',
    );
    release();
    await Promise.all(reads);
    await expect(withAiRead(async () => 'recovered', new AbortController().signal)).resolves.toBe(
      'recovered',
    );
  });
  it('refuses new reads after abort, even if callback catches the abort', async () => {
    const controller = new AbortController();
    await expect(
      withAiRead(async () => {
        controller.abort();
        expect(() => prisma.client).toThrow();
      }, controller.signal),
    ).rejects.toThrow();
    expect(aiReads.getStore()).toBeUndefined();
  });
});
