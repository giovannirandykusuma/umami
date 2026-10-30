// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFakeDb } from './fake-db';
const mocks = vi.hoisted(() => ({
  db: null as any,
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
  analystDeps: () => ({
    verifier: { cleanup: mocks.cleanup },
    listWebsites: async () => [],
    listBoards: async () => [],
    listAnalyses: async () => [],
  }),
}));
import { deleteChat, runTurn } from '../handlers';
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
