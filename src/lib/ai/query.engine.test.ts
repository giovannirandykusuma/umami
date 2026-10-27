// @vitest-environment node
/** Opt-in disposable engines only. Never reads application connection environment. */
import { afterAll, describe, expect, it, vi } from 'vitest';

const enabled = process.env.AI_SYNTHETIC_ENGINES === '1';
vi.hoisted(() => {
  if (process.env.AI_SYNTHETIC_ENGINES === '1') {
    process.env.DATABASE_URL = 'postgresql://ai_synthetic@127.0.0.1:25432/ai_synthetic';
    delete process.env.DATABASE_REPLICA_URL;
    process.env.CLICKHOUSE_URL = 'http://ai_synthetic:synthetic-only@127.0.0.1:28123/default';
    delete process.env.REDIS_URL;
  }
});

describe.skipIf(!enabled)('isolated PostgreSQL 16 / ClickHouse 24.8 driver integration', () => {
  let disconnect: (() => Promise<void>) | undefined;
  afterAll(async () => {
    await disconnect?.();
  });
  it('PostgreSQL cancels execution, rolls back, resets local settings, and recovers connection', async () => {
    const { default: prisma } = await import('@/lib/prisma');
    const { withAiRead } = await import('./query');
    disconnect = () => prisma.client.$disconnect();
    expect(await prisma.rawQuery('select owner from ai_synthetic_owner', {})).toEqual([
      { owner: 'umami-ai-synthetic-r3' },
    ]);
    const start = Date.now();
    await expect(
      withAiRead(() => prisma.rawQuery('select pg_sleep(5)', {}), new AbortController().signal),
    ).rejects.toThrow(/statement timeout/);
    expect(Date.now() - start).toBeLessThan(4000);
    const settings = await prisma.rawQuery('show statement_timeout', {});
    expect(settings[0].statement_timeout).toBe('0');
    await expect(
      withAiRead(() => prisma.rawQuery('select 1 as value', {}), new AbortController().signal),
    ).resolves.toEqual([{ value: 1 }]);
    await expect(
      withAiRead(
        () => prisma.rawQuery('create table ai_must_not_write (id int)', {}),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/read-only transaction/);
    expect(
      await prisma.rawQuery(
        "select count(*)::int as count from pg_stat_activity where query like 'select pg_sleep(5)%' and state = 'active'",
        {},
      ),
    ).toEqual([{ count: 0 }]);
  });
  it('PostgreSQL abort waits for server cancellation/rollback and recovers all admissions', async () => {
    const { default: prisma } = await import('@/lib/prisma');
    const { withAiRead } = await import('./query');
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const work = controllers.map(controller =>
      withAiRead(() => prisma.rawQuery('select pg_sleep(5)', {}), controller.signal),
    );
    const timer = setTimeout(() => {
      for (const controller of controllers) controller.abort();
    }, 100);
    const start = Date.now();
    try {
      const results = await Promise.allSettled(work);
      expect(results.every(result => result.status === 'rejected')).toBe(true);
      expect(Date.now() - start).toBeLessThan(4000);
    } finally {
      clearTimeout(timer);
    }
    await expect(
      withAiRead(() => prisma.rawQuery('select 1 as value', {}), new AbortController().signal),
    ).resolves.toEqual([{ value: 1 }]);
    expect(
      await prisma.rawQuery(
        "select count(*)::int as count from pg_stat_activity where query like 'select pg_sleep(5)%' and state = 'active'",
        {},
      ),
    ).toEqual([{ count: 0 }]);
  });
  it('rolls back an expired callback and prevents abandoned continuations from opening new reads', async () => {
    const { default: prisma, withAiPrismaRead } = await import('@/lib/prisma');
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    let continuation!: Promise<void>;
    await expect(
      withAiPrismaRead(
        async () => {
          continuation = gate.then(() => {
            expect(() => prisma.client).toThrow('expired');
          });
          await gate;
        },
        { signal: new AbortController().signal, deadline: Date.now() + 100 },
      ),
    ).rejects.toThrow('stopped');
    release();
    await continuation;
    expect(await prisma.rawQuery('select 1 as value', {})).toEqual([{ value: 1 }]);
  });
  it('PostgreSQL scopes actual model reads and isolates unscoped settings concurrently', async () => {
    const { default: prisma } = await import('@/lib/prisma');
    const { withAiRead } = await import('./query');
    const { canUpdateBoard } = await import('@/permissions/board');
    const boardId = '11111111-1111-4111-8111-111111111111';
    const userId = '22222222-2222-4222-8222-222222222222';
    await prisma.client.$executeRawUnsafe(
      'create table if not exists board (board_id uuid primary key, type varchar(50), name varchar(200), description varchar(500), parameters jsonb, user_id uuid, team_id uuid, created_at timestamptz, updated_at timestamptz)',
    );
    await prisma.client.$executeRawUnsafe(
      'insert into board (board_id, user_id) values ($1::uuid, $2::uuid) on conflict (board_id) do update set user_id = excluded.user_id',
      boardId,
      userId,
    );
    await withAiRead(async () => {
      expect(await canUpdateBoard({ user: { id: userId } } as any, boardId)).toBe(true);
    }, new AbortController().signal);
    await prisma.client.$executeRawUnsafe(
      'update board set user_id = null where board_id = $1::uuid',
      boardId,
    );
    await withAiRead(async () => {
      expect(await canUpdateBoard({ user: { id: userId } } as any, boardId)).toBe(false);
    }, new AbortController().signal);
    await prisma.client.$executeRawUnsafe(
      'create table if not exists website (website_id uuid primary key)',
    );
    await withAiRead(async () => {
      expect(await prisma.client.website.findMany({ select: { id: true } })).toEqual([]);
      expect(await prisma.rawQuery('show statement_timeout', {})).toEqual([
        { statement_timeout: '1s' },
      ]);
    }, new AbortController().signal);
    const [scoped, ordinary] = await Promise.all([
      withAiRead(
        () =>
          prisma.rawQuery(
            "select current_setting('statement_timeout') as timeout from pg_sleep(0.1)",
            {},
          ),
        new AbortController().signal,
      ),
      prisma.rawQuery("select current_setting('statement_timeout') as timeout", {}),
    ]);
    expect(scoped[0].timeout).toBe('1s');
    expect(ordinary[0].timeout).toBe('0');
  });
  it('ClickHouse enforces server deadline and recovers after abort without claiming instant cancellation', async () => {
    const { default: clickhouse } = await import('@/lib/clickhouse');
    const { withAiRead } = await import('./query');
    // sleepEachRow prevents a fast constant-folded/empty query; max_block_size keeps checks frequent.
    const slow = 'select sleepEachRow(0.1) from numbers(100) settings max_block_size=1';
    const start = Date.now();
    await expect(
      withAiRead(() => clickhouse.rawQuery(slow), new AbortController().signal),
    ).rejects.toThrow(/timeout|exceeded/i);
    expect(Date.now() - start).toBeLessThan(5000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(
        withAiRead(() => clickhouse.rawQuery(slow), controller.signal),
      ).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
    await expect(
      withAiRead(() => clickhouse.rawQuery('select 1 as value'), new AbortController().signal),
    ).resolves.toEqual([{ value: 1 }]);
    // Client disconnect alone is not cancellation proof: wait for server execution limit.
    await new Promise(resolve => setTimeout(resolve, 1500));
    const active = await clickhouse.rawQuery<{ count: number }[]>(
      "select count() as count from system.processes where query like 'select sleepEachRow(0.1)%'",
    );
    expect(active[0].count).toBe(0);
    await (await clickhouse.connect()).close();
  });
});
