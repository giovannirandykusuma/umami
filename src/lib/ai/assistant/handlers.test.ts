// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  parse: vi.fn(),
  run: vi.fn(),
  store: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    append: vi.fn(),
  },
}));
vi.mock('@/lib/request', () => ({ parseRequest: mocks.parse }));
vi.mock('./store', () => ({
  store: mocks.store,
  summary: (chat: any) => ({ id: chat.id, title: chat.title }),
}));
vi.mock('./runtime', () => ({ runAssistant: mocks.run }));
import { getSeries } from './analytics/results';
import {
  cancel,
  createChat,
  deleteChat,
  getChat,
  listChats,
  renameChat,
  reply,
  runTurn,
} from './handlers';
const id = '11111111-1111-1111-1111-111111111111';
const context = (chatId = id) => ({ params: Promise.resolve({ chatId }) });
const request = (signal?: AbortSignal) =>
  new Request('http://localhost/api/ai/assistant', {
    method: 'POST',
    signal,
    headers: { authorization: 'Bearer user' },
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.parse.mockResolvedValue({
    auth: { user: { id: 'user' } },
    body: { message: 'hello', title: 'Renamed' },
  });
  mocks.store.get.mockImplementation(async (_user, chatId) =>
    chatId === id ? { id, title: 'New chat', messages: [], piSession: null } : null,
  );
  mocks.store.append.mockResolvedValue(undefined);
  mocks.store.rename.mockResolvedValue({ count: 1 });
  mocks.run.mockImplementation(async input => {
    input.emit({ type: 'text_delta', partId: 'text', delta: 'Hello' });
    return { session: 'session' };
  });
});
it.each([getChat, renameChat, deleteChat, runTurn, reply, cancel])(
  'returns 404 for foreign chats (%s)',
  async handler => {
    const response = await handler(request(), context('22222222-2222-2222-2222-222222222222'));
    expect(response.status).toBe(404);
    expect(mocks.store.get).toHaveBeenCalledWith('user', '22222222-2222-2222-2222-222222222222');
    expect(mocks.store.append).not.toHaveBeenCalled();
    expect(mocks.store.rename).not.toHaveBeenCalled();
    expect(mocks.store.delete).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  },
);
it.each([listChats, createChat, getChat, renameChat, deleteChat, runTurn, reply, cancel])(
  'requires authentication (%s)',
  async handler => {
    mocks.parse.mockResolvedValue({ error: () => new Response(null, { status: 401 }) });
    expect((await handler(request(), context())).status).toBe(401);
  },
);
it('scopes create/list/get/rename/delete to the caller', async () => {
  mocks.store.list.mockResolvedValue([{ id, title: 'Test' }]);
  mocks.store.create.mockResolvedValue({ id, title: 'Renamed' });
  expect((await listChats(request(), context())).status).toBe(200);
  expect(mocks.store.list).toHaveBeenCalledWith('user');
  await createChat(request(), context());
  expect(mocks.store.create).toHaveBeenCalledWith('user', 'Renamed');
  expect((await getChat(request(), context())).status).toBe(200);
  await renameChat(request(), context());
  expect(mocks.store.rename).toHaveBeenCalledWith('user', id, 'Renamed');
  await deleteChat(request(), context());
  expect(mocks.store.delete).toHaveBeenCalledWith('user', id);
});
it('persists user before streaming, titles the first turn and persists terminal message', async () => {
  const response = await runTurn(request(), context());
  const text = await response.text();
  expect(text.indexOf('event: start')).toBeLessThan(text.indexOf('event: text_delta'));
  expect(text).toContain('event: title');
  expect(text.match(/event: done/g)).toHaveLength(1);
  expect(mocks.store.append.mock.calls[0][2]).toMatchObject({ role: 'user', text: 'hello' });
  expect(mocks.store.append.mock.calls[1][2]).toMatchObject({
    role: 'assistant',
    status: 'done',
    parts: [{ type: 'text', text: 'Hello' }],
  });
  expect(mocks.store.append.mock.calls[1][3]).toBe('session');
});
it('passes trusted handler scope, advances it, and clears results on deletion', async () => {
  let resultId: string;
  let trusted: any;
  mocks.run.mockImplementation(async input => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('[{"t":"2026-01-01T00:00:00Z","y":2}]')),
    );
    const result = await input.tool('query_series', {
      websiteId: '11111111-1111-4111-8111-111111111111',
      startAt: Date.parse('2026-01-01T00:00:00Z'),
      endAt: Date.parse('2026-01-01T23:59:59Z'),
      metric: 'events',
      unit: 'day',
      timezone: 'UTC',
      userId: 'forged',
      chatId: 'forged',
    });
    expect(result).toMatchObject({ ok: true });
    resultId = result.data.resultId;
    vi.unstubAllGlobals();
    return {};
  });
  // Observe the actual seam without replacing executeTool: a scoped result can be saved only for the handler-created generation.
  await (await runTurn(request(), context())).text();
  const { advanceTurn } = await import('./analytics/results');
  trusted = advanceTurn('user', id);
  expect(getSeries(trusted, resultId!)).toMatchObject({ total: 2 });
  expect(getSeries({ ...trusted, userId: 'forged', chatId: 'forged' }, resultId!)).toBeUndefined();
  await deleteChat(request(), context());
  expect(getSeries(trusted, resultId)).toBeUndefined();
});
it('enforces one per chat, four process-wide, and cancellation persistence', async () => {
  mocks.store.get.mockImplementation(async (_user, chatId) => ({
    id: chatId,
    title: 'Chat',
    messages: [],
    piSession: null,
  }));
  mocks.run.mockImplementation(
    input =>
      new Promise(resolve =>
        input.signal.addEventListener(
          'abort',
          () => resolve({ error: 'Cancelled', session: 'cancel-session' }),
          { once: true },
        ),
      ),
  );
  const ids = [id, ...[2, 3, 4, 5].map(n => `${n}`.repeat(8) + '-1111-1111-1111-111111111111')];
  const streams: Response[] = [];
  for (const chatId of ids.slice(0, 4)) streams.push(await runTurn(request(), context(chatId)));
  expect((await runTurn(request(), context(id))).status).toBe(409);
  expect((await runTurn(request(), context(ids[4]))).status).toBe(429);
  for (const chatId of ids.slice(0, 4))
    expect((await cancel(request(), context(chatId))).status).toBe(200);
  for (const stream of streams) expect(await stream.text()).toContain('"status":"cancelled"');
});
it('routes confirmation replies to only the running owned chat', async () => {
  mocks.run.mockImplementation(async input => {
    const answer = await input.tool('ask_user', {
      question: 'Which site?',
      options: ['A', 'B'],
      allowText: false,
    });
    input.emit({ type: 'text_delta', partId: 'answer', delta: answer });
    return { session: null };
  });
  const response = await runTurn(request(), context());
  const reader = response.body!.getReader();
  let text = '';
  let question: any;
  while (!question) {
    const chunk = await reader.read();
    text += new TextDecoder().decode(chunk.value);
    question = text
      .split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)))
      .find(event => event.part?.type === 'question')?.part;
  }
  mocks.parse.mockResolvedValue({
    auth: { user: { id: 'user' } },
    body: { kind: 'question', partId: question.id, answer: 'A' },
  });
  expect((await reply(request(), context('22222222-2222-2222-2222-222222222222'))).status).toBe(
    404,
  );
  expect((await reply(request(), context())).status).toBe(200);
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  expect(text).toContain('"state":"answered"');
  expect(mocks.store.append.mock.calls[1][2]).toMatchObject({ status: 'done' });
});
it('persists failed model output and emits exactly one terminal error', async () => {
  mocks.run.mockResolvedValue({ error: 'Assistant model failed', session: 'partial-session' });
  const text = await (await runTurn(request(), context())).text();
  expect(text.match(/event: error/g)).toHaveLength(1);
  expect(text).not.toContain('event: done');
  expect(mocks.store.append.mock.calls[1][2]).toMatchObject({
    status: 'error',
    error: 'Assistant model failed',
  });
});
it('client stream cancellation persists cancelled', async () => {
  mocks.run.mockImplementation(
    input =>
      new Promise(resolve =>
        input.signal.addEventListener('abort', () => resolve({ error: 'Cancelled' }), {
          once: true,
        }),
      ),
  );
  const response = await runTurn(request(), context());
  await response.body!.cancel();
  await vi.waitFor(() => expect(mocks.store.append).toHaveBeenCalledTimes(2));
  expect(mocks.store.append.mock.calls[1][2].status).toBe('cancelled');
});
