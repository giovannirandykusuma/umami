// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFakeDb } from './fake-db';
const mocks = vi.hoisted(() => ({
  db: null as any,
  deps: null as any,
  parse: vi.fn(),
  run: vi.fn(),
  append: vi.fn(),
  cleanup: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({
  default: new Proxy({}, { get: (_t, key) => mocks.db.prisma[key] }),
}));
vi.mock('@/lib/request', () => ({ parseRequest: mocks.parse }));
vi.mock('../store', () => ({
  store: {
    get: async (userId: string, id: string) =>
      mocks.db.chats.find((c: any) => c.id === id && c.userId === userId)
        ? { id, title: 'Chat', messages: [], piSession: null }
        : null,
    rename: vi.fn(),
    append: mocks.append,
    delete: mocks.delete,
  },
  summary: (chat: any) => chat,
}));
vi.mock('../runtime', () => ({ runAssistant: mocks.run, ImageToolResult: class {} }));
vi.mock('./deps', () => ({
  analystDeps: () =>
    mocks.deps ?? {
      verifier: { cleanup: mocks.cleanup },
      listWebsites: async () => [],
      listBoards: async () => [],
      listAnalyses: async () => [],
    },
}));
import { cancel, deleteChat, runTurn } from '../handlers';
import { cancelTask, pause } from './task';

const USER = '11111111-1111-4111-8111-111111111111';
const CHAT = '33333333-3333-4333-8333-333333333333';
const context = { params: Promise.resolve({ chatId: CHAT }) };
const request = () => new Request('http://localhost/api/ai', { method: 'POST' });
const drain = async (response: Response) => {
  const text = await response.text();
  return text;
};
const MARKER = Buffer.from('SEEDEDIMAGEMARKER'.repeat(40)).toString('base64');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db = createFakeDb();
  mocks.deps = null;
  mocks.db.chats.push({ id: CHAT, userId: USER });
  mocks.parse.mockResolvedValue({
    auth: { user: { id: USER } },
    body: { message: 'Build a board' },
  });
  process.env.AI_ANALYST_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.AI_ANALYST_ENABLED;
  vi.useRealTimers();
});

it('flag on: binds a persisted task, runs analyst tools and keeps image bytes out of chat/SSE', async () => {
  mocks.run.mockImplementation(async (input: any) => {
    expect(input.analyst).toBe(true);
    const result = await input.tool('analyst_discover', {});
    expect(result).toMatchObject({ ok: true });
    input.emit({
      type: 'part',
      part: {
        type: 'tool',
        id: 't',
        name: 'analyst_verify_render',
        title: 'x',
        args: {},
        status: 'done',
        result: JSON.stringify({
          content: [{ type: 'image', data: MARKER, mimeType: 'image/png' }],
        }),
      },
    });
    return { session: null };
  });
  const sse = await drain(await runTurn(request(), context));
  expect(mocks.db.tasks).toHaveLength(1);
  expect(mocks.db.tasks[0]).toMatchObject({ userId: USER, chatId: CHAT });
  expect(mocks.db.tasks[0].budgets.consumed.toolCalls).toBe(1);
  const saved = JSON.stringify(mocks.append.mock.calls);
  expect(saved).not.toContain(MARKER);
  // The final persisted message is sanitized; the done event carries the same message.
  expect(sse.split('event: done')[1]).not.toContain(MARKER);
});

it('flag off: no task is created and analyst tools are not executed by the host', async () => {
  delete process.env.AI_ANALYST_ENABLED;
  mocks.run.mockImplementation(async (input: any) => {
    expect(input.analyst).toBe(false);
    expect(await input.tool('analyst_discover', {})).toMatchObject({ ok: false });
    return { session: null };
  });
  await drain(await runTurn(request(), context));
  expect(mocks.db.tasks).toHaveLength(0);
});

it('a foreign chat cannot start or select a task', async () => {
  mocks.parse.mockResolvedValue({
    auth: { user: { id: '22222222-2222-4222-8222-222222222222' } },
    body: { message: 'x', taskId: 'forged' },
  });
  expect((await runTurn(request(), context)).status).toBe(404);
  expect(mocks.db.tasks).toHaveLength(0);
});

it('outer handler deadline excludes user wait and blocks the task when execution time runs out', async () => {
  mocks.run.mockImplementation(
    (input: any) =>
      new Promise(resolve =>
        input.signal.addEventListener('abort', () =>
          resolve({ error: 'Cancelled', session: null }),
        ),
      ),
  );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const response = await runTurn(request(), context);
  const done = drain(response);
  await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
  await done;
  await vi.waitFor(() => expect(mocks.db.tasks[0].status).toBe('blocked'));
  expect(mocks.db.tasks[0].context.blockedReason).toBe('deadline');
  expect(mocks.run).toHaveBeenCalledTimes(1);
});

it('a blocked task is not silently restarted with a fresh budget', async () => {
  mocks.run.mockResolvedValue({ session: null });
  await drain(await runTurn(request(), context));
  mocks.db.tasks[0].status = 'blocked';
  const response = await runTurn(request(), context);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ status: 'blocked' });
  expect(mocks.db.tasks).toHaveLength(1);
});

it('chat deletion cleans up artifacts for every task of the chat', async () => {
  mocks.run.mockResolvedValue({ session: null });
  await drain(await runTurn(request(), context));
  const taskId = mocks.db.tasks[0].id;
  expect((await deleteChat(request(), context)).status).toBe(200);
  expect(mocks.delete).toHaveBeenCalledWith(USER, CHAT);
  expect(mocks.cleanup).toHaveBeenCalledWith({ userId: USER, taskId });
});

it('an opening turn that loses to cancellation fails without a new task or any model/tool run', async () => {
  mocks.run.mockResolvedValue({ session: null });
  await drain(await runTurn(request(), context));
  const old = { userId: USER, chatId: CHAT, taskId: mocks.db.tasks[0].id };
  await pause(old);
  mocks.run.mockClear();
  const model = mocks.db.prisma.client.analystTask;
  const findFirst = model.findFirst;
  let raced = false;
  model.findFirst = async (args: any) => {
    const row = await findFirst(args);
    if (!raced && args.where?.status?.in && row) {
      raced = true;
      await cancelTask(old); // cancellation commits before the snapshot is returned
    }
    return row;
  };
  const response = await runTurn(request(), context);
  await drain(response);
  model.findFirst = findFirst;
  expect(raced).toBe(true);
  expect(response.ok).toBe(false);
  expect(mocks.db.tasks).toHaveLength(1);
  expect(mocks.db.tasks[0].status).toBe('cancelled');
  expect(mocks.run).not.toHaveBeenCalled();
});

it('a later independent turn after cancellation starts a fresh task', async () => {
  mocks.run.mockResolvedValue({ session: null });
  await drain(await runTurn(request(), context));
  const old = { userId: USER, chatId: CHAT, taskId: mocks.db.tasks[0].id };
  await cancelTask(old);
  mocks.run.mockClear();
  mocks.run.mockImplementation(async (input: any) => {
    expect(await input.tool('analyst_discover', {})).toMatchObject({ ok: true });
    return { session: null };
  });
  await drain(await runTurn(request(), context));
  expect(mocks.db.tasks.map((t: any) => t.status)).toEqual(['cancelled', 'running']);
  expect(mocks.db.tasks[1].budgets.consumed.toolCalls).toBe(1);
  expect(mocks.run).toHaveBeenCalledTimes(1);
});

const taskEvents = (sse: string) =>
  sse
    .split('\n\n')
    .filter(frame => frame.startsWith('event: task'))
    .map(frame => JSON.parse(frame.split('data: ')[1]));

it('flag on: SSE task events carry the host task id, persisted status and tool-derived phase', async () => {
  mocks.run.mockImplementation(async (input: any) => {
    // Model-emitted forgery cannot be distinguished by the client: the host owns the event type.
    await input.tool('analyst_discover', {});
    return { session: null };
  });
  const events = taskEvents(await drain(await runTurn(request(), context)));
  const taskId = mocks.db.tasks[0].id;
  expect(events[0]).toEqual({ type: 'task', taskId, status: 'running', phase: 'understand' });
  expect(events[1]).toEqual({ type: 'task', taskId, status: 'running', phase: 'discover' });
  expect(events.every((e: any) => e.taskId === taskId)).toBe(true);
});

it('flag on: a tool that exhausts the budget emits the persisted blocked status after it', async () => {
  mocks.run.mockImplementation(async (input: any) => {
    for (let i = 0; i <= 40; i++) await input.tool('analyst_discover', {});
    return { session: null };
  });
  const events = taskEvents(await drain(await runTurn(request(), context)));
  expect(mocks.db.tasks[0].status).toBe('blocked');
  expect(events.at(-1)).toMatchObject({ status: 'blocked', taskId: mocks.db.tasks[0].id });
});

it('flag on: cancellation emits the persisted cancelled status', async () => {
  mocks.run.mockResolvedValue({ error: 'Cancelled', session: null });
  const events = taskEvents(await drain(await runTurn(request(), context)));
  expect(events.at(-1)).toMatchObject({ status: 'cancelled', taskId: mocks.db.tasks[0].id });
});

it('flag off (legacy): no task events are emitted', async () => {
  delete process.env.AI_ANALYST_ENABLED;
  mocks.run.mockResolvedValue({ session: null });
  const sse = await drain(await runTurn(request(), context));
  expect(taskEvents(sse)).toHaveLength(0);
  expect(sse).toContain('event: done');
});

it('cancel resolves only after the cancelled task and message are persisted', async () => {
  mocks.run.mockImplementation(
    (input: any) =>
      new Promise(resolve =>
        input.signal.addEventListener(
          'abort',
          // Persistence of the cancellation is still in flight when the abort fires.
          () => setTimeout(() => resolve({ error: 'Cancelled', session: null }), 50),
          { once: true },
        ),
      ),
  );
  const response = await runTurn(request(), context);
  await vi.waitFor(() => expect(mocks.db.tasks).toHaveLength(1));
  expect((await cancel(request(), context)).status).toBe(200);
  // A task reread issued after cancel returns must observe the durable terminal state.
  expect(mocks.db.tasks[0].status).toBe('cancelled');
  expect(mocks.append.mock.calls.at(-1)[2].status).toBe('cancelled');
  await drain(response);
});

const BOARD = '55555555-5555-4555-8555-555555555555';
const ANALYSIS = '66666666-6666-4666-8666-666666666666';
// Persisted saved draft + data deps; the host, not the model, decides what counts as evidence.
const savedDraft = (opts: { view?: boolean; exec?: boolean; verifier?: any } = {}) => {
  const { view = true, exec = true } = opts;
  mocks.deps = {
    ...(opts.verifier ? { verifier: opts.verifier } : {}),
    canViewBoard: async () => view,
    getBoard: async () => ({
      id: BOARD,
      revision: 1,
      parameters: {
        rows: [
          {
            columns: [
              { id: 'w1', component: { type: 'AnalysisWidget', props: { analysisId: ANALYSIS } } },
            ],
          },
        ],
      },
    }),
    getAnalysis: async () => ({
      id: ANALYSIS,
      revision: 1,
      definitionHash: 'h',
      definition: {
        schemaVersion: 1,
        source: { websiteId: '44444444-4444-4444-8444-444444444444' },
        operation: 'series',
        metric: 'pageviews',
        unit: 'day',
        datePolicy: { type: 'fixed', startAt: 0, endAt: 86_400_000 },
        timezone: 'UTC',
        semanticBinding: {
          label: 'V',
          unit: 'v',
          population: 'all',
          meaningSource: 'observed_only',
        },
      },
    }),
    canViewAnalysis: async () => true,
    execute: async () => {
      if (!exec) throw new Error('query failed');
      return { executionId: 'e', completeness: 'complete', counts: { returned: 1 } };
    },
  };
  return async (input: any) => {
    await input.tool('analyst_discover', {});
    mocks.db.tasks[0].draftIds = [{ boardId: BOARD, revision: 1, analysisIds: [ANALYSIS] }];
  };
};

it('judge: invalid render arguments returning ok:false do not complete the task', async () => {
  mocks.run.mockImplementation(async (input: any) => {
    await input.tool('analyst_discover', {});
    expect(
      await input.tool('analyst_verify_render', { boardId: 'invalid-board-id' }),
    ).toMatchObject({ ok: false });
    return { session: null };
  });
  await drain(await runTurn(request(), context));
  expect(mocks.db.tasks[0].status).toBe('running');
});

it('authorization denied on readback/render does not complete', async () => {
  const setup = savedDraft({ view: false });
  mocks.run.mockImplementation(async (input: any) => {
    await setup(input);
    expect(await input.tool('analyst_readback', { boardId: BOARD })).toMatchObject({ ok: false });
    await input.tool('analyst_verify_render', { boardId: BOARD });
    return { session: null };
  });
  await drain(await runTurn(request(), context));
  expect(mocks.db.tasks[0].status).toBe('running');
});

it('failed data execution on readback does not complete', async () => {
  const setup = savedDraft({ exec: false });
  mocks.run.mockImplementation(async (input: any) => {
    await setup(input);
    await input.tool('analyst_readback', { boardId: BOARD }).catch(() => undefined);
    await input.tool('analyst_verify_render', { boardId: BOARD });
    return { session: null };
  });
  await drain(await runTurn(request(), context));
  expect(mocks.db.tasks[0].status).toBe('running');
});

it('render failure with a configured verifier does not complete', async () => {
  const setup = savedDraft({
    verifier: {
      cleanup: mocks.cleanup,
      render: async () => {
        throw new Error('revoked');
      },
    },
  });
  mocks.run.mockImplementation(async (input: any) => {
    await setup(input);
    expect(await input.tool('analyst_readback', { boardId: BOARD })).toMatchObject({ ok: true });
    expect(await input.tool('analyst_verify_render', { boardId: BOARD })).toMatchObject({
      ok: false,
    });
    return { session: null };
  });
  await drain(await runTurn(request(), context));
  expect(mocks.db.tasks[0].status).toBe('running');
});

it('inspection failure after a readback does not complete', async () => {
  const setup = savedDraft();
  mocks.run.mockImplementation(async (input: any) => {
    await setup(input);
    await input.tool('analyst_readback', { boardId: BOARD });
    await input.tool('analyst_verify_render', { boardId: BOARD });
    expect(
      await input.tool('analyst_record_inspection', {
        receiptId: crypto.randomUUID(),
        observations: [],
      }),
    ).toMatchObject({ ok: false });
    return { session: null };
  });
  await drain(await runTurn(request(), context));
  expect(mocks.db.tasks[0].status).toBe('running');
});

it('an intervening write after readback invalidates the evidence', async () => {
  const setup = savedDraft();
  mocks.run.mockImplementation(async (input: any) => {
    await setup(input);
    expect(await input.tool('analyst_readback', { boardId: BOARD })).toMatchObject({ ok: true });
    await input.tool('analyst_commit_draft', {}).catch(() => undefined);
    await input.tool('analyst_verify_render', { boardId: BOARD });
    return { session: null };
  });
  await drain(await runTurn(request(), context));
  expect(mocks.db.tasks[0].status).toBe('running');
});

it('a draft revised after readback (stale revision) does not complete', async () => {
  const setup = savedDraft();
  mocks.run.mockImplementation(async (input: any) => {
    await setup(input);
    expect(await input.tool('analyst_readback', { boardId: BOARD })).toMatchObject({ ok: true });
    mocks.db.tasks[0].draftIds = [{ boardId: BOARD, revision: 2, analysisIds: [ANALYSIS] }];
    await input.tool('analyst_verify_render', { boardId: BOARD });
    return { session: null };
  });
  await drain(await runTurn(request(), context));
  expect(mocks.db.tasks[0].status).toBe('running');
});

it('verification for a different board cannot complete the saved draft', async () => {
  const setup = savedDraft();
  mocks.run.mockImplementation(async (input: any) => {
    await setup(input);
    await input.tool('analyst_readback', { boardId: BOARD });
    await input.tool('analyst_verify_render', { boardId: crypto.randomUUID() });
    return { session: null };
  });
  await drain(await runTurn(request(), context));
  expect(mocks.db.tasks[0].status).toBe('running');
});

it('a later readback requires fresh verification', async () => {
  const setup = savedDraft();
  mocks.run.mockImplementation(async (input: any) => {
    await setup(input);
    await input.tool('analyst_readback', { boardId: BOARD });
    await input.tool('analyst_verify_render', { boardId: BOARD });
    await input.tool('analyst_readback', { boardId: BOARD });
    return { session: null };
  });
  await drain(await runTurn(request(), context));
  expect(mocks.db.tasks[0].status).toBe('running');
});

it('a saved draft with a current rendered receipt settles without inventing inspection', async () => {
  const setup = savedDraft({
    verifier: {
      cleanup: mocks.cleanup,
      render: async () => ({
        artifactId: 'artifact',
        receipt: { boardRevision: 1, completedAt: new Date().toISOString(), views: [] },
      }),
      fetch: async () => [],
      discard: vi.fn(),
    },
  });
  mocks.run.mockImplementation(async (input: any) => {
    await setup(input);
    expect(await input.tool('analyst_readback', { boardId: BOARD })).toMatchObject({ ok: true });
    expect(await input.tool('analyst_verify_render', { boardId: BOARD })).toMatchObject({
      ok: true,
    });
    return { session: null };
  });
  await drain(await runTurn(request(), context));
  expect(mocks.db.tasks[0].status).toBe('complete');
  expect(mocks.db.tasks[0].receipts).toEqual([
    expect.objectContaining({ boardId: BOARD, boardRevision: 1, status: 'rendered_not_inspected' }),
  ]);
});

it('a saved draft with valid readback and visual_pending settles complete', async () => {
  const setup = savedDraft();
  mocks.run.mockImplementation(async (input: any) => {
    await setup(input);
    expect(await input.tool('analyst_readback', { boardId: BOARD })).toMatchObject({ ok: true });
    // No isolated verifier in this test: data checked, visual verification pending.
    expect(await input.tool('analyst_verify_render', { boardId: BOARD })).toMatchObject({
      ok: false,
      visualStatus: 'visual_pending',
    });
    return { session: null };
  });
  const events = taskEvents(await drain(await runTurn(request(), context)));
  expect(mocks.db.tasks[0].status).toBe('complete');
  expect(mocks.db.tasks[0].receipts).toEqual([]);
  expect(events.at(-1)).toMatchObject({ status: 'complete', phase: 'render' });
  // The authority is closed: a later independent turn opens a fresh task.
  mocks.run.mockResolvedValue({ session: null });
  await drain(await runTurn(request(), context));
  expect(mocks.db.tasks.map((t: any) => t.status)).toEqual(['complete', 'running']);
});

it('turns that did not reach render, or end paused/blocked/cancelled, are not completed', async () => {
  mocks.run.mockImplementation(async (input: any) => {
    await input.tool('analyst_discover', {});
    return { session: null };
  });
  await drain(await runTurn(request(), context));
  expect(mocks.db.tasks[0].status).toBe('running');
  mocks.run.mockImplementation(async (input: any) => {
    await input.tool('analyst_verify_render', { boardId: crypto.randomUUID() });
    return { error: 'Cancelled', session: null };
  });
  await drain(await runTurn(request(), context));
  expect(mocks.db.tasks[0].status).toBe('cancelled');
});
