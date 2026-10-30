import { beforeEach, expect, test, vi } from 'vitest';
import { normalizeDefinition } from '@/lib/analyst/definition';

// In-memory stand-in for the three tables, with the same unique constraints.
const db = vi.hoisted(() => {
  const state = {
    analyses: [] as any[],
    revisions: [] as any[],
    operations: [] as any[],
    boards: [] as any[],
    tasks: [] as any[],
  };
  const unique = (rows: any[], row: any, keys: string[]) => {
    if (rows.some(r => keys.every(k => r[k] === row[k])))
      throw Object.assign(new Error('unique'), { code: 'P2002' });
  };
  const tx = {
    savedAnalysis: {
      create: async ({ data }: any) => (state.analyses.push({ ...data }), { ...data }),
      findUnique: async ({ where }: any) => state.analyses.find(a => a.id === where.id) ?? null,
      findUniqueOrThrow: async ({ where }: any) => ({
        ...state.analyses.find(a => a.id === where.id),
      }),
      updateMany: async ({ where, data }: any) => {
        const row = state.analyses.find(a => a.id === where.id && a.revision === where.revision);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    savedAnalysisRevision: {
      create: async ({ data }: any) => {
        unique(state.revisions, data, ['analysisId', 'revision']);
        state.revisions.push({ ...data });
      },
    },
    board: {
      create: async ({ data }: any) => (state.boards.push({ ...data, revision: 1 }), { ...data }),
      findUniqueOrThrow: async ({ where }: any) => ({
        ...state.boards.find(b => b.id === where.id),
      }),
    },
    analystTask: {
      updateMany: async ({ where }: any) => ({
        count: state.tasks.filter(
          t =>
            t.id === where.id &&
            t.userId === where.userId &&
            t.chatId === where.chatId &&
            where.status.in.includes(t.status),
        ).length,
      }),
    },
    analysisOperation: {
      findUnique: async ({ where }: any) => {
        const w = where.userId_taskScope_key;
        return (
          state.operations.find(
            o => o.userId === w.userId && o.taskScope === w.taskScope && o.key === w.key,
          ) ?? null
        );
      },
      create: async ({ data }: any) => {
        unique(state.operations, data, ['userId', 'taskScope', 'key']);
        state.operations.push({ ...data });
      },
    },
  };
  const client = {
    ...tx,
    // Rollback on throw: snapshot and restore, like a real transaction.
    $transaction: async (fn: any) => {
      const snapshot = JSON.stringify(state);
      try {
        return await fn(tx);
      } catch (e) {
        Object.assign(state, JSON.parse(snapshot));
        throw e;
      }
    },
  };
  return { state, client };
});
vi.mock('@/lib/prisma', () => ({ default: { client: db.client } }));

const { commitBundle, createAnalysis, TaskFenceError, updateAnalysis } = await import('./analysis');
const definition = normalizeDefinition({
  schemaVersion: 1,
  source: { websiteId: '11111111-1111-4111-8111-111111111111' },
  operation: 'totals',
  metric: 'pageviews',
  datePolicy: { type: 'rolling', window: '7d' },
  timezone: 'UTC',
  semanticBinding: {
    label: 'Pageviews',
    unit: 'pageviews',
    population: 'all',
    meaningSource: 'observed_only',
  },
});
const create = (key = 'k1', name = 'A') =>
  createAnalysis({ userId: 'u1', operationKey: key, name, status: 'draft', definition });

beforeEach(() => {
  db.state.analyses = [];
  db.state.revisions = [];
  db.state.operations = [];
  db.state.boards = [];
  db.state.tasks = [];
});

test('same key and request replays; different payload under same key conflicts', async () => {
  const first = await create();
  const again = await create();
  expect(again).toEqual({ result: first.result, replayed: true });
  await expect(create('k1', 'B')).rejects.toMatchObject({ code: 'conflict' });
  expect(db.state.analyses).toHaveLength(1);
  // Keys are scoped per principal/task: another task may reuse the key.
  await createAnalysis({
    userId: 'u1',
    taskId: 't2',
    operationKey: 'k1',
    name: 'B',
    status: 'draft',
    definition,
  });
  expect(db.state.analyses).toHaveLength(2);
});

test('revisions are append-only and stale expectedRevision conflicts without mutation', async () => {
  const { result } = await create();
  const id = (result as any).id;
  const updated = await updateAnalysis(id, {
    userId: 'u1',
    operationKey: 'u1',
    expectedRevision: 1,
    name: 'Renamed',
  });
  expect(updated.result).toMatchObject({ revision: 2, name: 'Renamed' });
  await expect(
    updateAnalysis(id, { userId: 'u1', operationKey: 'u2', expectedRevision: 1, name: 'Stale' }),
  ).rejects.toMatchObject({ code: 'conflict', field: 'expectedRevision' });
  expect(db.state.revisions.map(r => [r.revision, r.name])).toEqual([
    [1, 'A'],
    [2, 'Renamed'],
  ]);
  // Failed operation left no idempotency record: retry with a fresh revision may proceed.
  expect(db.state.operations.map(o => o.key)).toEqual(['k1', 'u1']);
});

const TASK = '22222222-2222-4222-8222-222222222222';
const fenced = (signal?: AbortSignal, key = 'b1') =>
  commitBundle(
    {
      userId: 'u1',
      taskId: TASK,
      operationKey: key,
      board: { type: 'mixed', name: 'B', parameters: { rows: [] } },
      analyses: [{ ref: 'a', name: 'A', status: 'draft', definition }],
    },
    { chatId: 'c1', signal },
  );
const written = () => [db.state.boards, db.state.analyses, db.state.revisions, db.state.operations];

test('task fence: a cancelled/foreign task commits nothing; an active task commits', async () => {
  db.state.tasks.push({ id: TASK, userId: 'u1', chatId: 'c1', status: 'cancelled' });
  await expect(fenced()).rejects.toBeInstanceOf(TaskFenceError);
  expect(written().every(rows => rows.length === 0)).toBe(true);
  db.state.tasks[0].status = 'running';
  db.state.tasks[0].chatId = 'other';
  await expect(fenced()).rejects.toBeInstanceOf(TaskFenceError);
  expect(written().every(rows => rows.length === 0)).toBe(true);
  db.state.tasks[0].chatId = 'c1';
  await fenced();
  expect(written().map(rows => rows.length)).toEqual([1, 1, 1, 1]);
});

test('task fence: an abort that lands while writes are awaited rolls the whole bundle back', async () => {
  db.state.tasks.push({ id: TASK, userId: 'u1', chatId: 'c1', status: 'running' });
  const controller = new AbortController();
  const create = db.client.savedAnalysis.create;
  db.client.savedAnalysis.create = async (args: any) => {
    controller.abort();
    return create(args);
  };
  try {
    await expect(fenced(controller.signal)).rejects.toBeInstanceOf(TaskFenceError);
  } finally {
    db.client.savedAnalysis.create = create;
  }
  expect(written().every(rows => rows.length === 0)).toBe(true);
});

test('resolveBundleRefs rejects refs that would be stored unresolved (production shape)', async () => {
  const { resolveBundleRefs } = await import('./analysis');
  const params = (component: any) => ({ rows: [{ id: 'r', columns: [{ id: 'w', component }] }] });
  for (const component of [
    { type: 'SavedAnalysis', analysisRef: 'a', props: { chartType: 'line' } },
    { type: 'SavedAnalysis', props: { analysisRef: 'a' } },
  ])
    expect(() => resolveBundleRefs(params(component), { a: 'id' })).toThrow(/AnalysisWidget/);
  expect(
    resolveBundleRefs(
      params({ type: 'AnalysisWidget', props: { analysisRef: 'a', visualization: 'line' } }),
      { a: 'id' },
    ).rows[0].columns[0].component.props,
  ).toEqual({ analysisId: 'id', visualization: 'line' });
});
