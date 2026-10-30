// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { createFakeDb } from './fake-db';
const db = vi.hoisted(() => ({ current: null as any }));
vi.mock('@/lib/prisma', () => ({
  default: new Proxy({}, { get: (_t, key) => db.current.prisma[key] }),
}));
import {
  block,
  cancelTask,
  completeTask,
  consume,
  ensureTask,
  getTask,
  pause,
  remainingMs,
  resume,
  TASK_LIMITS,
  updateTask,
} from './task';
import { executeAnalystTool, semanticsHash, type AnalystDeps } from './tools';
import { Interaction } from '../tools';
import { containsImage, sanitize, sanitizeSession } from './sanitize';
import { normalizeDefinition } from '@/lib/analyst/definition';
import { TaskFenceError } from '@/queries/prisma/analysis';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CHAT = '33333333-3333-4333-8333-333333333333';
const SITE = '44444444-4444-4444-8444-444444444444';
const BOARD = '55555555-5555-4555-8555-555555555555';
const MARKER = 'SEEDEDIMAGEMARKER';
const definition = (metric = 'pageviews', extra: any = {}) => ({
  schemaVersion: 1,
  source: { websiteId: SITE },
  operation: 'series',
  metric,
  unit: 'day',
  datePolicy: { type: 'fixed', startAt: 0, endAt: 86_400_000 },
  timezone: 'UTC',
  semanticBinding: {
    label: 'Views',
    unit: 'views',
    population: 'all',
    meaningSource: 'observed_only',
  },
  ...extra,
});
const bundle = (def: any = definition(), extra: any = {}) => ({
  board: {
    type: 'mixed',
    name: 'Draft',
    parameters: {
      rows: [
        {
          id: 'r',
          columns: [
            {
              id: 'w1',
              component: {
                type: 'AnalysisWidget',
                props: { analysisRef: 'a', visualization: 'line' },
              },
            },
          ],
        },
      ],
    },
  },
  analyses: [{ ref: 'a', name: 'Views', definition: def }],
  ...extra,
});

function makeDeps(over: Partial<AnalystDeps> = {}) {
  const boards = new Map<string, any>();
  let n = 0;
  const deps: AnalystDeps = {
    listWebsites: async () => [{ id: SITE, name: 'Site' }],
    listBoards: async () => [],
    listAnalyses: async () => [],
    dateRange: async () => ({ startAt: 0, endAt: 1 }),
    execute: vi.fn(async () => ({
      executionId: 'e',
      completeness: 'complete',
      counts: { returned: 1 },
      rows: [],
    })),
    getBoard: async id => boards.get(id) ?? null,
    canUpdateBoard: async () => true,
    canViewBoard: async () => true,
    getAnalysis: async () => null,
    canViewAnalysis: async () => true,
    validateBundle: vi.fn(async (_auth, body: any) => {
      if (body.taskId === undefined) throw new Error('host must bind task');
      return {
        ...body,
        analyses: body.analyses.map((a: any) => ({
          ...a,
          definition: normalizeDefinition(a.definition),
        })),
      };
    }),
    hashBundle: () => 'd'.repeat(64),
    // Mirrors the foundation fence (analysis.test.ts covers the real transaction).
    commitBundle: vi.fn(async (req: any, fence: any) => {
      const owner = db.current.tasks.find((t: any) => t.id === req.taskId);
      if (
        fence?.signal?.aborted ||
        owner?.chatId !== fence?.chatId ||
        !['running', 'awaiting_user'].includes(owner?.status)
      )
        throw new TaskFenceError('Task is no longer active');
      const id = req.boardId ?? `66666666-6666-4666-8666-66666666666${n++}`;
      const prior = boards.get(id);
      const board = {
        id,
        revision: (prior?.revision ?? 0) + 1,
        userId: USER,
        teamId: null,
        parameters: req.board.parameters,
      };
      const result = {
        board,
        analyses: [
          { id: `77777777-7777-4777-8777-77777777777${n}`, revision: 1, definitionHash: 'h' },
        ],
      };
      // Like the real transaction: provenance is recorded before the board becomes visible.
      await fence.record(db.current.prisma.client, result);
      boards.set(id, board);
      return { result, replayed: false };
    }),
    issueConfirmation: vi.fn(async () => ({ id: 'confirmation' })),
    verifier: null,
    ...over,
  };
  return { deps, boards };
}

async function setup(over: Partial<AnalystDeps> = {}, controller = new AbortController()) {
  const task = await ensureTask(USER, CHAT, 'Build a board', { websiteId: SITE, evil: 'x' });
  const scope = { userId: USER, chatId: CHAT, taskId: task.id };
  const parts: any[] = [];
  const interaction = new Interaction(p => parts.push(p), controller.signal);
  const { deps, boards } = makeDeps(over);
  const run = (name: any, args: any) =>
    executeAnalystTool(name, args, {
      auth: { user: { id: USER } } as any,
      scope,
      interaction,
      deps,
    });
  return { task, scope, parts, interaction, deps, boards, run };
}

beforeEach(() => {
  db.current = createFakeDb();
  db.current.chats.push({ id: CHAT, userId: USER });
});

it('binds tasks to the chat owner; a foreign principal cannot open or read the task', async () => {
  await expect(ensureTask(OTHER, CHAT, 'steal')).rejects.toThrow('Chat not found');
  const task = await ensureTask(USER, CHAT, 'goal', { websiteId: SITE, injected: 'x' });
  expect(task.context).toEqual({ websiteId: SITE });
  expect(await getTask({ userId: OTHER, chatId: CHAT, taskId: task.id })).toBeNull();
  expect((await ensureTask(USER, CHAT, 'again')).id).toBe(task.id);
});

it('persists consumed budgets: exhaustion blocks and a resumed task does not reset limits', async () => {
  const task = await ensureTask(USER, CHAT, 'goal');
  const scope = { userId: USER, chatId: CHAT, taskId: task.id };
  for (let i = 0; i < TASK_LIMITS.analytics; i++) await consume(scope, 'analytics');
  await expect(consume(scope, 'analytics')).rejects.toMatchObject({ code: 'budget_exhausted' });
  const stored = (await getTask(scope))!;
  expect(stored.status).toBe('blocked');
  expect(stored.context.blockedReason).toBe('budget:analytics');
  // Resuming returns the same blocked task with the same consumption, never a fresh budget.
  const resumed = await ensureTask(USER, CHAT, 'retry');
  expect(resumed.id).toBe(task.id);
  expect(resumed.budgets.consumed.analytics).toBe(TASK_LIMITS.analytics);
});

it('user-wait pauses do not consume the execution window; 24h expiry starts a new task', async () => {
  const t0 = 1_000_000;
  const task = await ensureTask(USER, CHAT, 'goal', undefined, t0);
  const scope = { userId: USER, chatId: CHAT, taskId: task.id };
  await pause(scope, t0 + 60_000);
  await resume(scope, t0 + 60_000 + 3_600_000);
  const after = (await getTask(scope))!;
  expect(remainingMs(after, t0 + 3_660_000)).toBe(TASK_LIMITS.executionMs - 60_000);
  // Negative control: without the pause the same instant is far past the deadline.
  expect(remainingMs({ ...after, pausedMs: 0 }, t0 + 3_660_000)).toBeLessThan(0);
  await expect(consume(scope, 'toolCalls', t0 + 3_660_000)).resolves.toBeTruthy();
  const fresh = await ensureTask(USER, CHAT, 'later', undefined, t0 + TASK_LIMITS.expiryMs + 1);
  expect(fresh.id).not.toBe(task.id);
});

it('rejects JSON that could carry images or unbounded data into task records', async () => {
  const task = await ensureTask(USER, CHAT, 'goal');
  const row = db.current.tasks[0];
  row.receipts = [{ id: task.id, image: `data:image/png;base64,${MARKER}` }];
  await expect(getTask({ userId: USER, chatId: CHAT, taskId: task.id })).rejects.toThrow();
});

it('tool calls are budgeted per task and model-supplied taskId/principal fields are rejected', async () => {
  const { run, scope } = await setup();
  const bad = await run('analyst_preview', {
    definition: definition(),
    taskId: OTHER,
    userId: OTHER,
  });
  expect(bad.json).toMatchObject({ ok: false, code: 'invalid_arguments' });
  for (let i = 0; i < TASK_LIMITS.toolCalls; i++) await run('analyst_discover', {});
  expect((await run('analyst_discover', {})).json).toMatchObject({
    code: 'budget_exhausted',
    status: 'blocked',
  });
  // Renaming/nesting cannot reset it: every analyst tool now sees the persisted blocked task.
  expect((await run('analyst_preview', { definition: definition() })).json).toMatchObject({
    code: 'task_blocked',
  });
  expect((await getTask(scope))!.budgets.consumed.toolCalls).toBe(TASK_LIMITS.toolCalls);
});

it('creates private drafts automatically but never edits a pre-existing board via commit', async () => {
  const { run, deps, boards } = await setup();
  boards.set(BOARD, { id: BOARD, revision: 3, userId: USER, teamId: null, parameters: {} });
  const denied = await run('analyst_commit_draft', {
    ...bundle(),
    boardId: BOARD,
    expectedRevision: 3,
    operationKey: 'k',
  });
  expect(denied.json).toMatchObject({ ok: false, code: 'confirmation_required' });
  expect(deps.commitBundle).not.toHaveBeenCalled();
  const created: any = (await run('analyst_commit_draft', { ...bundle(), operationKey: 'k1' }))
    .json;
  expect(created).toMatchObject({ ok: true, board: { revision: 1 } });
  expect(deps.issueConfirmation).not.toHaveBeenCalled();
});

it('existing-board change needs human confirmation bound to exact revision; rejection mutates nothing', async () => {
  for (const confirmed of [false, true]) {
    db.current = createFakeDb();
    db.current.chats.push({ id: CHAT, userId: USER });
    const { run, deps, boards, parts, interaction } = await setup();
    boards.set(BOARD, { id: BOARD, revision: 3, userId: USER, teamId: null, parameters: {} });
    const pending = run('analyst_request_change', {
      ...bundle(),
      boardId: BOARD,
      expectedRevision: 3,
    });
    await vi.waitFor(() => expect(parts.some(p => p.type === 'confirm')).toBe(true));
    const part = parts.find(p => p.type === 'confirm');
    expect(JSON.parse(part.message)).toMatchObject({ target: BOARD, expectedRevision: 3 });
    expect(deps.issueConfirmation).not.toHaveBeenCalled();
    interaction.reply({ kind: 'confirm', partId: part.id, confirmed });
    const result: any = (await pending).json;
    expect(result.ok).toBe(confirmed);
    expect(deps.issueConfirmation).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    expect(deps.commitBundle).toHaveBeenCalledTimes(confirmed ? 1 : 0);
  }
});

it('a stale revision after confirmation returns conflict without issuing a grant', async () => {
  const { run, deps, boards, parts, interaction } = await setup();
  boards.set(BOARD, { id: BOARD, revision: 3, userId: USER, teamId: null, parameters: {} });
  const pending = run('analyst_request_change', {
    ...bundle(),
    boardId: BOARD,
    expectedRevision: 3,
  });
  await vi.waitFor(() => expect(parts.length).toBe(1));
  boards.get(BOARD).revision = 4;
  interaction.reply({ kind: 'confirm', partId: parts[0].id, confirmed: true });
  expect((await pending).json).toMatchObject({ code: 'conflict' });
  expect(deps.issueConfirmation).not.toHaveBeenCalled();
});

it('repair policy: provenance required, semantics preserved, at most two repairs', async () => {
  const { run, scope } = await setup();
  const first: any = (await run('analyst_commit_draft', { ...bundle(), operationKey: 'k1' })).json;
  const boardId = first.board.id;
  let revision = first.board.revision;
  const commit = async (def: any, key: string, repair?: any) => {
    const r: any = (
      await run('analyst_commit_draft', {
        ...bundle(def),
        boardId,
        expectedRevision: revision,
        operationKey: key,
        ...(repair ? { repair } : {}),
      })
    ).json;
    if (r.ok) revision = r.board.revision;
    return r;
  };
  const presentation = definition('pageviews', { unit: 'hour' });
  expect(await commit(presentation, 'k2')).toMatchObject({ code: 'repair_required' });
  expect(
    await commit(definition('sessions'), 'k3', { widgetId: 'w1', reason: 'empty' }),
  ).toMatchObject({ code: 'semantic_change' });
  expect(await commit(presentation, 'k4', { widgetId: 'w1', reason: 'too dense' })).toMatchObject({
    ok: true,
  });
  expect(
    await commit(definition('pageviews', { unit: 'month' }), 'k5', {
      widgetId: 'w1',
      reason: 'again',
    }),
  ).toMatchObject({ ok: true });
  expect(
    await commit(definition('pageviews'), 'k6', { widgetId: 'w1', reason: 'third' }),
  ).toMatchObject({ code: 'repair_limit' });
  const task = (await getTask(scope))!;
  expect(task.status).toBe('blocked');
  expect(task.definitionVersions.filter(v => v.repair).map(v => v.repair!.reason)).toEqual([
    'too dense',
    'again',
  ]);
  expect(task.definitionVersions.at(-1)!.previousHash).toBeDefined();
  expect(semanticsHash(normalizeDefinition(presentation))).toBe(
    semanticsHash(normalizeDefinition(definition())),
  );
});

const renamed = (def: any, ref: string) => {
  const b: any = bundle(def);
  b.analyses[0].ref = ref;
  b.board.parameters.rows[0].columns[0].component.props.analysisRef = ref;
  return b;
};

it('renamed analysis refs cannot bypass semantic-change or repair policy on a stable widget', async () => {
  const { run, deps } = await setup();
  const first: any = (await run('analyst_commit_draft', { ...bundle(), operationKey: 'r1' })).json;
  const target = { boardId: first.board.id, expectedRevision: first.board.revision };
  expect(
    (
      await run('analyst_commit_draft', {
        ...renamed(definition('sessions'), 'b'),
        ...target,
        operationKey: 'r2',
      })
    ).json,
  ).toMatchObject({ code: 'semantic_change' });
  expect(
    (
      await run('analyst_commit_draft', {
        ...renamed(definition('pageviews', { unit: 'hour' }), 'c'),
        ...target,
        operationKey: 'r3',
      })
    ).json,
  ).toMatchObject({ code: 'repair_required' });
  // Swapping the widget id with a fresh ref is a replacement of the committed widget too.
  const swapped: any = renamed(definition('sessions'), 'd');
  swapped.board.parameters.rows[0].columns[0].id = 'w9';
  expect(
    (await run('analyst_commit_draft', { ...swapped, ...target, operationKey: 'r4' })).json,
  ).toMatchObject({ code: 'semantic_change' });
  expect(deps.issueConfirmation).not.toHaveBeenCalled();
  expect(deps.commitBundle).toHaveBeenCalledTimes(1);
});

it('abort during awaited validation/authorization prevents grants and writes', async () => {
  // Own-draft revision: abort lands while validateBundle is awaited.
  const controller = new AbortController();
  const { run, deps, scope } = await setup({}, controller);
  const first: any = (await run('analyst_commit_draft', { ...bundle(), operationKey: 'c1' })).json;
  const validate = deps.validateBundle as any;
  const original = validate.getMockImplementation();
  validate.mockImplementation(async (auth: any, body: any) => {
    controller.abort();
    return original(auth, body);
  });
  const before = (await getTask(scope))!;
  const r: any = (
    await run('analyst_commit_draft', {
      ...bundle(),
      boardId: first.board.id,
      expectedRevision: first.board.revision,
      operationKey: 'c2',
    })
  ).json;
  expect(r).toMatchObject({ ok: false, code: 'cancelled' });
  expect(deps.issueConfirmation).not.toHaveBeenCalled();
  expect(deps.commitBundle).toHaveBeenCalledTimes(1);
  expect((await getTask(scope))!.draftIds).toEqual(before.draftIds);

  // Existing-board change: abort lands during the post-confirmation authority reread.
  db.current = createFakeDb();
  db.current.chats.push({ id: CHAT, userId: USER });
  const c2 = new AbortController();
  const s2 = await setup({}, c2);
  s2.boards.set(BOARD, { id: BOARD, revision: 3, userId: USER, teamId: null, parameters: {} });
  let reads = 0;
  const getBoard = s2.deps.getBoard;
  s2.deps.getBoard = async id => {
    if (++reads === 2) c2.abort();
    return getBoard(id);
  };
  const pending = s2.run('analyst_request_change', {
    ...bundle(),
    boardId: BOARD,
    expectedRevision: 3,
  });
  await vi.waitFor(() => expect(s2.parts.some(p => p.type === 'confirm')).toBe(true));
  const part = s2.parts.find(p => p.type === 'confirm');
  s2.interaction.reply({ kind: 'confirm', partId: part.id, confirmed: true });
  expect((await pending).json).toMatchObject({ ok: false, code: 'cancelled' });
  expect(s2.deps.issueConfirmation).not.toHaveBeenCalled();
  expect(s2.deps.commitBundle).not.toHaveBeenCalled();
});

it('a task cancelled while a tool awaits is not overwritten by the late tool completion', async () => {
  const { run, deps, scope } = await setup();
  const validate = deps.validateBundle as any;
  const original = validate.getMockImplementation();
  validate.mockImplementation(async (auth: any, body: any) => {
    const { cancelTask } = await import('./task');
    await cancelTask(scope);
    return original(auth, body);
  });
  const r: any = (await run('analyst_commit_draft', { ...bundle(), operationKey: 'z1' })).json;
  expect(r).toMatchObject({ ok: false, code: 'task_blocked' });
  expect(deps.commitBundle).not.toHaveBeenCalled();
  const task = (await getTask(scope))!;
  expect(task.status).toBe('cancelled');
  expect(task.draftIds).toEqual([]);
});

it('cancellation that wins at the commit boundary leaves no board and no late task record', async () => {
  const { run, deps, scope, boards } = await setup();
  const commit = deps.commitBundle as any;
  const original = commit.getMockImplementation();
  // Cancel lands after every host-side interrupted() check, at entry to the transaction.
  commit.mockImplementation(async (req: any, fence: any) => {
    await cancelTask(scope);
    return original(req, fence);
  });
  const r: any = (await run('analyst_commit_draft', { ...bundle(), operationKey: 'race' })).json;
  expect(r).toMatchObject({ ok: false, code: 'cancelled' });
  expect(commit.mock.calls[0][1]).toMatchObject({ chatId: scope.chatId });
  expect(boards.size).toBe(0);
  const task = (await getTask(scope))!;
  expect(task.status).toBe('cancelled');
  expect(task.draftIds).toEqual([]);
  expect(task.operationKeys).toEqual([]);
});

it('terminal tasks are absorbing: pause/resume/block/late updates never revive them', async () => {
  for (const status of ['cancelled', 'complete', 'expired']) {
    db.current = createFakeDb();
    db.current.chats.push({ id: CHAT, userId: USER });
    const task = await ensureTask(USER, CHAT, 'goal');
    const scope = { userId: USER, chatId: CHAT, taskId: task.id };
    if (status === 'cancelled') await cancelTask(scope);
    else db.current.tasks[0].status = status;
    const late = await Promise.allSettled([
      pause(scope),
      block(scope, 'deadline'),
      resume(scope),
      updateTask(scope, t => ({ ...t, status: 'running' })),
    ]);
    expect(late.every(r => r.status === 'rejected')).toBe(true);
    const stored = (await getTask(scope))!;
    expect(stored.status).toBe(status);
    expect(stored.pausedAt).toBeNull();
  }
});

it('openTask never revives a task cancelled between its read and its write', async () => {
  const task = await ensureTask(USER, CHAT, 'goal');
  const scope = { userId: USER, chatId: CHAT, taskId: task.id };
  await pause(scope);
  const model = db.current.prisma.client.analystTask;
  const findFirst = model.findFirst;
  let raced = false;
  model.findFirst = async (args: any) => {
    const row = await findFirst(args);
    if (!raced && row?.status === 'awaiting_user') {
      raced = true;
      await cancelTask(scope); // commits after the snapshot was taken
    }
    return row;
  };
  await expect(ensureTask(USER, CHAT, 'again')).rejects.toMatchObject({ code: 'conflict' });
  model.findFirst = findFirst;
  expect(raced).toBe(true);
  expect((await getTask(scope))!.status).toBe('cancelled');
  expect(db.current.tasks).toHaveLength(1);
  // A later independent turn sees no active task and may start a new one.
  expect((await ensureTask(USER, CHAT, 'later')).id).not.toBe(task.id);
});

it('terminal task data is immutable: late callbacks cannot append provenance or context', async () => {
  const task = await ensureTask(USER, CHAT, 'goal');
  const scope = { userId: USER, chatId: CHAT, taskId: task.id };
  await cancelTask(scope);
  const before = structuredClone(db.current.tasks[0]);
  await expect(
    updateTask(scope, t => ({ ...t, operationKeys: ['late-provenance'] })),
  ).rejects.toMatchObject({ code: 'not_found' });
  await expect(block(scope, 'deadline')).rejects.toMatchObject({ code: 'not_found' });
  expect(db.current.tasks[0]).toEqual(before);
});

it('a commit that wins records provenance atomically; a later cancel needs no late write', async () => {
  const { run, scope } = await setup();
  const r: any = (await run('analyst_commit_draft', { ...bundle(), operationKey: 'won' })).json;
  expect(r.ok).toBe(true);
  await cancelTask(scope);
  const task = (await getTask(scope))!;
  expect(task.status).toBe('cancelled');
  expect(task.operationKeys).toEqual(['won']);
  expect(task.draftIds.map(d => d.boardId)).toEqual([r.board.id]);
});

it('without an isolated verifier, render reports visual_pending and never claims verification', async () => {
  const { run, scope } = await setup();
  const r: any = (await run('analyst_verify_render', { boardId: BOARD })).json;
  expect(r).toMatchObject({
    ok: false,
    code: 'verifier_unavailable',
    visualStatus: 'visual_pending',
  });
  expect((await getTask(scope))!.receipts).toEqual([]);
});

it('verified render yields images only on the transient path; receipts hold hashes and are inspectable', async () => {
  const hash = 'a'.repeat(64);
  const verifier = {
    render: vi.fn(async () => ({
      artifactId: 'artifact-capability-secret',
      receipt: {
        boardRevision: 1,
        completedAt: 'now',
        views: [
          {
            viewport: { width: 1440, height: 1000 },
            hash,
            offset: 0,
            widgets: [{ id: 'w1', state: 'rendered' }],
          },
        ],
      },
    })),
    fetch: vi.fn(async () => [{ bytes: Buffer.from(MARKER), mime: 'image/png', hash }]),
    discard: vi.fn(),
    cleanup: vi.fn(),
  };
  const { run, scope, boards } = await setup({ verifier });
  boards.set(BOARD, { id: BOARD, revision: 1, userId: USER, teamId: null, parameters: {} });
  const out = await run('analyst_verify_render', { boardId: BOARD });
  expect(out.images).toHaveLength(1);
  expect(JSON.stringify(out.json)).not.toContain(Buffer.from(MARKER).toString('base64'));
  expect(JSON.stringify(out.json)).not.toContain('artifact-capability-secret');
  expect(verifier.discard).toHaveBeenCalledWith('artifact-capability-secret');
  const stored = JSON.stringify(db.current.tasks);
  expect(stored).not.toContain(Buffer.from(MARKER).toString('base64'));
  expect(stored).not.toContain('artifact-capability-secret');
  const receiptId = (out.json as any).receipt.id;
  expect(
    (
      await run('analyst_record_inspection', {
        receiptId,
        observations: [{ widgetId: 'nope', hash, issue: 'none', note: '' }],
      })
    ).json,
  ).toMatchObject({ ok: false });
  expect(
    (
      await run('analyst_record_inspection', {
        receiptId,
        observations: [{ widgetId: 'w1', hash, issue: 'none', note: 'ok' }],
      })
    ).json,
  ).toMatchObject({ ok: true, status: 'inspected' });
  // Render budget: 2 attempts plus 1 rerender.
  await run('analyst_verify_render', { boardId: BOARD });
  expect((await run('analyst_verify_render', { boardId: BOARD })).json).toMatchObject({
    code: 'budget_exhausted',
  });
  expect((await getTask(scope))!.budgets.consumed.renders).toBe(2);
});

it('render expectations include every saved native and analysis widget and reject unsupported widgets', async () => {
  const render = vi.fn(async (_input: any) => {
    throw new Error('stop after binding');
  });
  const { run, boards } = await setup({
    verifier: { render, fetch: vi.fn(), discard: vi.fn(), cleanup: vi.fn() },
    getAnalysis: async id => ({
      id,
      revision: 2,
      definitionHash: 'saved-hash',
      definition: {},
      userId: USER,
      teamId: null,
      status: 'ready',
    }),
  });
  const board = {
    id: BOARD,
    revision: 3,
    userId: USER,
    teamId: null,
    type: 'mixed',
    parameters: {
      rows: [
        {
          id: 'row',
          columns: [
            {
              id: 'native',
              component: { type: 'WebsiteMetricsBar', entityType: 'website', entityId: SITE },
            },
            { id: 'analysis', component: { type: 'AnalysisWidget', props: { analysisId: OTHER } } },
          ],
        },
      ],
    },
  };
  boards.set(BOARD, board);
  await run('analyst_verify_render', { boardId: BOARD });
  expect(render).toHaveBeenCalledOnce();
  expect(render.mock.calls[0][0]).toMatchObject({
    scope: { boardId: BOARD, boardRevision: 3, analysisRevisions: { [OTHER]: 2 } },
    expectedWidgets: [
      { id: 'native', executionId: '', definitionHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { id: 'analysis', executionId: '', definitionHash: 'saved-hash' },
    ],
  });
  board.parameters.rows[0].columns[0].component.type = 'WorldMap';
  expect((await run('analyst_verify_render', { boardId: BOARD })).json).toMatchObject({
    ok: false,
    code: 'unsupported_combination',
  });
  expect(render).toHaveBeenCalledOnce();
});

it('sanitizes image blocks, data URLs and capabilities while keeping session structure', () => {
  const data = Buffer.from(MARKER.repeat(100)).toString('base64');
  const line = (v: any) => JSON.stringify(v);
  const session = [
    line({ type: 'session', id: 's', cwd: '/x' }),
    line({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 't1',
        content: [
          { type: 'text', text: 'receipt' },
          { type: 'image', data, mimeType: 'image/png' },
        ],
      },
    }),
    line({
      type: 'message',
      message: {
        role: 'user',
        content: `see data:image/png;base64,${data} and token=abcdefghijklmnopqrstu`,
      },
    }),
    'not json',
  ].join('\n');
  const clean = sanitizeSession(session)!;
  expect(clean).not.toContain(data);
  expect(clean).not.toContain('abcdefghijklmnopqrstu');
  expect(clean).not.toContain('"type":"image"');
  const lines = clean
    .trim()
    .split('\n')
    .map(l => JSON.parse(l));
  expect(lines).toHaveLength(3);
  expect(lines[1].message).toMatchObject({ role: 'toolResult', toolCallId: 't1' });
  expect(lines[1].message.content[1].text).toMatch(/^\[screenshot omitted sha256=[0-9a-f]{64}\]$/);
  expect(containsImage(JSON.parse(session.split('\n')[1]))).toBe(true);
  expect(containsImage(sanitize(JSON.parse(session.split('\n')[1])))).toBe(false);
});

it('adds analyst lifecycle prompt rules only for analyst turns', async () => {
  const { assistantPrompt } = await import('../prompt');
  expect(assistantPrompt()).not.toContain('analyst_request_change');
  expect(assistantPrompt(undefined, true)).toContain('analyst_request_change');
});

it('stable widget repair: keeping a committed widget by analysisId is repairable by widget id', async () => {
  const { run } = await setup();
  const first: any = (await run('analyst_commit_draft', { ...bundle(), operationKey: 's1' })).json;
  const analysisId = first.analyses[0].id;
  let revision = first.board.revision;
  const keep = (visualization: string, key: string, repair?: any) => {
    const b: any = bundle();
    b.analyses = [];
    b.board.parameters.rows[0].columns[0].component.props = { analysisId, visualization };
    return run('analyst_commit_draft', {
      ...b,
      boardId: first.board.id,
      expectedRevision: revision,
      operationKey: key,
      ...(repair ? { repair } : {}),
    }).then(r => {
      if ((r.json as any).ok) revision = (r.json as any).board.revision;
      return r.json;
    });
  };
  // Pre-fix production failure: this exact repair was denied as "not a changed widget".
  expect(await keep('bar', 's2', { widgetId: 'w1', reason: 'bind' })).toMatchObject({ ok: true });
  expect(await keep('line', 's3')).toMatchObject({ code: 'repair_required' });
  expect(await keep('line', 's4', { widgetId: 'w9', reason: 'x' })).toMatchObject({
    code: 'invalid_arguments',
  });
  expect(await keep('line', 's5', { widgetId: 'w1', reason: 'again' })).toMatchObject({ ok: true });
  expect(await keep('bar', 's6', { widgetId: 'w1', reason: 'third' })).toMatchObject({
    code: 'repair_limit',
  });
});

it('a stable-widget repair never edits a board the task did not create', async () => {
  const { run, boards } = await setup();
  boards.set(BOARD, { id: BOARD, revision: 1, userId: USER, teamId: null, parameters: {} });
  expect(
    (
      await run('analyst_commit_draft', {
        ...bundle(),
        boardId: BOARD,
        expectedRevision: 1,
        operationKey: 'x',
        repair: { widgetId: 'w1', reason: 'x' },
      })
    ).json,
  ).toMatchObject({ code: 'confirmation_required' });
});

it('discover exposes the exact nested definition, widget and repair contracts', async () => {
  const { run } = await setup();
  const data: any = ((await run('analyst_discover', {})).json as any).data;
  expect(data.contracts.definition.required).toEqual(
    expect.arrayContaining([
      'schemaVersion',
      'source',
      'operation',
      'datePolicy',
      'semanticBinding',
    ]),
  );
  expect(data.contracts.definition.additionalProperties).toBe(false);
  expect(data.contracts.widget.component.type).toBe('AnalysisWidget');
});

it('completeTask closes only a plain running task; paused and blocked tasks keep their state', async () => {
  for (const [setup, expected] of [
    [async (s: any) => pause(s), 'awaiting_user'],
    [async (s: any) => block(s, 'deadline'), 'blocked'],
    [async () => undefined, 'complete'],
  ] as const) {
    db.current = createFakeDb();
    db.current.chats.push({ id: CHAT, userId: USER });
    const task = await ensureTask(USER, CHAT, 'goal');
    const scope = { userId: USER, chatId: CHAT, taskId: task.id };
    await setup(scope);
    expect((await completeTask(scope)).status).toBe(expected);
  }
});
