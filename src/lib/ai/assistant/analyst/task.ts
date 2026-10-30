import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import prisma from '@/lib/prisma';

/** Initial hard ceilings (spec §3.1). Consumption is persisted so retries/resumes never reset it. */
export const TASK_LIMITS = {
  toolCalls: 40,
  analytics: 20,
  concurrentQueries: 3,
  widgets: 12,
  renders: 2,
  rerenders: 1,
  repairs: 2,
  executionMs: 5 * 60_000,
  expiryMs: 24 * 60 * 60_000,
} as const;
export const COUNTERS = ['toolCalls', 'analytics', 'renders', 'rerenders', 'repairs'] as const;
export type Counter = (typeof COUNTERS)[number];
const ACTIVE = ['running', 'awaiting_user', 'blocked'];
const TERMINAL = ['cancelled', 'complete', 'expired'];

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const text = (max: number) => z.string().max(max);
const count = z.number().int().min(0).max(1_000_000_000);
// Strict, bounded schemas: free-form strings are short and no field can carry image payloads.
export const budgetsSchema = z
  .object({
    consumed: z.object({
      toolCalls: count,
      analytics: count,
      renders: count,
      rerenders: count,
      repairs: count,
    }),
    imageBytes: count,
  })
  .strict();
export const contextSchema = z
  .object({
    websiteId: text(100).optional(),
    boardId: text(100).optional(),
    timezone: text(100).optional(),
    blockedReason: z
      .enum([...COUNTERS.map(c => `budget:${c}` as const), 'deadline', 'repair_limit'])
      .optional(),
  })
  .strict();
const draftsSchema = z
  .array(
    z
      .object({
        boardId: z.uuid(),
        revision: z.number().int().positive(),
        analysisIds: z.array(z.uuid()).max(12),
      })
      .strict(),
  )
  .max(12);
const keysSchema = z.array(text(200)).max(200);
const versionsSchema = z
  .array(
    z
      .object({
        ref: text(64),
        // Stable identity: repair policy binds to board + widget, never the model-chosen ref.
        boardId: z.uuid().optional(),
        widgetId: text(64).optional(),
        analysisId: z.uuid().optional(),
        hash,
        semantics: hash,
        previousHash: hash.optional(),
        repair: z
          .object({ widgetId: text(64), reason: text(300) })
          .strict()
          .optional(),
      })
      .strict(),
  )
  .max(60);
const WIDGET_STATES = ['loading', 'rendered', 'empty', 'error', 'denied', 'unsupported'] as const;
export const ISSUES = [
  'none',
  'label',
  'chart_type',
  'axes',
  'date_timezone',
  'units',
  'missing',
  'error',
  'clipping',
  'narrow_layout',
] as const;
export const receiptSchema = z
  .object({
    id: z.uuid(),
    boardId: z.uuid(),
    boardRevision: z.number().int().positive(),
    analysisRevisions: z.record(z.uuid(), z.number().int().positive()),
    status: z.enum(['rendered_not_inspected', 'inspected']),
    completedAt: text(40),
    views: z
      .array(
        z
          .object({
            hash,
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            offset: z.number().int().min(0),
            widgets: z
              .array(z.object({ id: text(64), state: z.enum(WIDGET_STATES) }).strict())
              .max(TASK_LIMITS.widgets),
          })
          .strict(),
      )
      .max(6),
    inspections: z
      .array(
        z.object({ widgetId: text(64), hash, issue: z.enum(ISSUES), note: text(500) }).strict(),
      )
      .max(72),
  })
  .strict();
const receiptsSchema = z.array(receiptSchema).max(10);

export type Receipt = z.infer<typeof receiptSchema>;
export interface TaskState {
  status: 'running' | 'awaiting_user' | 'blocked' | 'complete' | 'cancelled' | 'expired';
  budgets: z.infer<typeof budgetsSchema>;
  pausedAt: Date | null;
  pausedMs: number;
  context: z.infer<typeof contextSchema>;
  draftIds: z.infer<typeof draftsSchema>;
  operationKeys: z.infer<typeof keysSchema>;
  definitionVersions: z.infer<typeof versionsSchema>;
  receipts: Receipt[];
}
export interface Task extends TaskState {
  id: string;
  userId: string;
  chatId: string;
  goal: string;
  deadlineAt: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
export type TaskScope = { userId: string; chatId: string; taskId: string };

export class TaskError extends Error {
  constructor(
    readonly code: 'not_found' | 'budget_exhausted' | 'deadline' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}

function parse(row: any): Task {
  return {
    ...row,
    budgets: budgetsSchema.parse(row.budgets),
    context: contextSchema.parse(row.context),
    draftIds: draftsSchema.parse(row.draftIds),
    operationKeys: keysSchema.parse(row.operationKeys),
    definitionVersions: versionsSchema.parse(row.definitionVersions),
    receipts: receiptsSchema.parse(row.receipts),
  };
}
function serialize(state: TaskState) {
  return {
    status: state.status,
    budgets: budgetsSchema.parse(state.budgets),
    pausedAt: state.pausedAt,
    pausedMs: Math.max(0, Math.round(state.pausedMs)),
    context: contextSchema.parse(state.context),
    draftIds: draftsSchema.parse(state.draftIds),
    operationKeys: keysSchema.parse(state.operationKeys),
    definitionVersions: versionsSchema.parse(state.definitionVersions),
    receipts: receiptsSchema.parse(state.receipts),
  };
}

/** Remaining execution window; user-wait time (closed and currently open pauses) is excluded. */
export function remainingMs(task: Task, now = Date.now()) {
  const open = task.pausedAt ? now - task.pausedAt.getTime() : 0;
  return task.deadlineAt.getTime() + task.pausedMs + Math.max(0, open) - now;
}

function boundedContext(context: any) {
  const result: Record<string, string> = {};
  for (const key of ['websiteId', 'boardId', 'timezone'])
    if (typeof context?.[key] === 'string' && context[key].length <= 100)
      result[key] = context[key];
  return result;
}

/**
 * Returns the chat's active task or creates one. The chat must belong to the principal: the
 * foreign keys alone do not bind the user/chat pair, so ownership is checked in the transaction.
 */
export async function ensureTask(
  userId: string,
  chatId: string,
  goal: string,
  context?: unknown,
  now = Date.now(),
): Promise<Task> {
  let task!: Task;
  // prisma.transaction's overload union widens the callback result; capture it explicitly.
  await prisma.transaction(async (tx: any) => {
    task = await openTask(tx, userId, chatId, goal, context, now);
  });
  return task;
}

/**
 * A lost opening CAS whose observed task was cancelled fails this opening attempt: the turn racing
 * the cancel must not continue under fresh authority/budgets. A later, independent turn (which
 * observes no active task) may still start a new task.
 */
async function rejectIfCancelled(tx: any, version: { id: string; userId: string; chatId: string }) {
  const { id, userId, chatId } = version;
  const row = await tx.analystTask.findFirst({ where: { id, userId, chatId } });
  if (row?.status === 'cancelled') throw new TaskError('conflict', 'Task was cancelled');
}

async function openTask(
  tx: any,
  userId: string,
  chatId: string,
  goal: string,
  context: unknown,
  now: number,
): Promise<Task> {
  {
    const chat = await tx.aiChat.findFirst({ where: { id: chatId, userId } });
    if (!chat) throw new TaskError('not_found', 'Chat not found');
    // Every write below is a CAS on the row version read here; a lost race (e.g. a concurrent
    // cancel) re-reads instead of writing stale serialized state.
    let existing: any;
    for (let attempt = 0; ; attempt++) {
      if (attempt === 5) throw new TaskError('conflict', 'Task changed concurrently');
      existing = await tx.analystTask.findFirst({
        where: { userId, chatId, status: { in: ACTIVE } },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing) break;
      const version = { id: existing.id, userId, chatId, updatedAt: existing.updatedAt };
      if (existing.expiresAt.getTime() > now) {
        const task = parse(existing);
        // A pause left open by a crashed turn is closed on resume; the wait never counts as work.
        if (!task.pausedAt) return task;
        const data = {
          status: task.status === 'awaiting_user' ? 'running' : task.status,
          pausedMs: Math.max(0, Math.round(task.pausedMs + now - task.pausedAt.getTime())),
          pausedAt: null,
        };
        const { count } = await tx.analystTask.updateMany({ where: version, data });
        if (count === 1) return parse({ ...existing, ...data });
        await rejectIfCancelled(tx, version);
        continue;
      }
      const { count } = await tx.analystTask.updateMany({
        where: version,
        data: { status: 'expired' },
      });
      if (count === 1) break;
      await rejectIfCancelled(tx, version);
    }
    const state: TaskState = {
      status: 'running',
      budgets: {
        consumed: { toolCalls: 0, analytics: 0, renders: 0, rerenders: 0, repairs: 0 },
        imageBytes: 0,
      },
      pausedAt: null,
      pausedMs: 0,
      context: boundedContext(context),
      draftIds: [],
      operationKeys: [],
      definitionVersions: [],
      receipts: [],
    };
    const created = await tx.analystTask.create({
      data: {
        id: randomUUID(),
        userId,
        chatId,
        goal: goal.slice(0, 2000),
        deadlineAt: new Date(now + TASK_LIMITS.executionMs),
        expiresAt: new Date(now + TASK_LIMITS.expiryMs),
        ...serialize(state),
      },
    });
    return parse(created);
  }
}

export async function getTask(scope: TaskScope): Promise<Task | null> {
  const row = await prisma.client.analystTask.findFirst({
    where: { id: scope.taskId, userId: scope.userId, chatId: scope.chatId },
  });
  return row ? parse(row) : null;
}

/** Task lookup for the task API: principal-bound, chat not required. */
export async function getUserTask(userId: string, taskId: string): Promise<Task | null> {
  const row = await prisma.client.analystTask.findFirst({ where: { id: taskId, userId } });
  return row ? parse(row) : null;
}

export async function listChatTaskIds(userId: string, chatId: string): Promise<string[]> {
  const rows = await prisma.client.analystTask.findMany({
    where: { userId, chatId },
    select: { id: true },
  });
  return rows.map((row: { id: string }) => row.id);
}

/**
 * Read-modify-write with compare-and-set on updatedAt. `change` returns the next state; when it
 * returns `{ state, error }` the state is persisted first and the error is thrown afterwards.
 */
export async function updateTask(
  scope: TaskScope,
  change: (task: Task) => TaskState | { state: TaskState; error: Error },
): Promise<Task> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await prisma.client.analystTask.findFirst({
      where: { id: scope.taskId, userId: scope.userId, chatId: scope.chatId },
    });
    if (!row) throw new TaskError('not_found', 'Task not found');
    // Terminal tasks are fully immutable at this single CAS boundary: no pause/resume/block or
    // late tool callback may change their status or append drafts/keys/versions/receipts.
    if (TERMINAL.includes(row.status)) throw new TaskError('not_found', 'Task is no longer active');
    const result = change(parse(row));
    const { state, error } = 'state' in result ? result : { state: result, error: undefined };
    const data = serialize(state);
    const { count } = await prisma.client.analystTask.updateMany({
      where: {
        id: scope.taskId,
        userId: scope.userId,
        chatId: scope.chatId,
        status: row.status,
        updatedAt: row.updatedAt,
      },
      data,
    });
    if (count === 1) {
      if (error) throw error;
      return parse({ ...row, ...data });
    }
  }
  throw new TaskError('conflict', 'Task changed concurrently');
}

/**
 * Applies `change` inside a caller's transaction that already holds the task row lock (the
 * commit fence). Used to record commit provenance atomically with the commit, so a later cancel
 * never needs a late metadata write. An inactive task aborts (rolls back) the transaction.
 */
export async function updateTaskInTx(
  tx: any,
  scope: TaskScope,
  change: (task: Task) => TaskState,
): Promise<void> {
  const row = await tx.analystTask.findFirst({
    where: { id: scope.taskId, userId: scope.userId, chatId: scope.chatId },
  });
  if (!row || TERMINAL.includes(row.status))
    throw new TaskError('not_found', 'Task is no longer active');
  const { count } = await tx.analystTask.updateMany({
    where: {
      id: scope.taskId,
      userId: scope.userId,
      chatId: scope.chatId,
      status: row.status,
      updatedAt: row.updatedAt,
    },
    data: serialize(change(parse(row))),
  });
  if (count !== 1) throw new TaskError('conflict', 'Task changed concurrently');
}

const LIMIT_OF: Record<Counter, number> = {
  toolCalls: TASK_LIMITS.toolCalls,
  analytics: TASK_LIMITS.analytics,
  renders: TASK_LIMITS.renders,
  rerenders: TASK_LIMITS.rerenders,
  repairs: TASK_LIMITS.repairs,
};

/** Atomically consumes budget; exhaustion persists a resumable blocked state. */
export function consume(scope: TaskScope, counter: Counter, now = Date.now()) {
  return updateTask(scope, task => {
    if (task.status === 'cancelled' || task.status === 'expired' || task.status === 'complete')
      return { state: task, error: new TaskError('not_found', 'Task is no longer active') };
    if (task.expiresAt.getTime() <= now || remainingMs(task, now) <= 0)
      return {
        state: {
          ...task,
          status: 'blocked',
          context: { ...task.context, blockedReason: 'deadline' },
        },
        error: new TaskError('deadline', 'Task execution window exhausted'),
      };
    if (task.budgets.consumed[counter] + 1 > LIMIT_OF[counter])
      return {
        state: {
          ...task,
          status: 'blocked',
          context: { ...task.context, blockedReason: `budget:${counter}` },
        },
        error: new TaskError('budget_exhausted', `Task ${counter} budget exhausted`),
      };
    return {
      ...task,
      budgets: {
        ...task.budgets,
        consumed: { ...task.budgets.consumed, [counter]: task.budgets.consumed[counter] + 1 },
      },
    };
  });
}

/** Only validated pending clarification/confirmation parts call this (server-owned pause). */
export function pause(scope: TaskScope, now = Date.now()) {
  return updateTask(scope, task =>
    task.pausedAt ? task : { ...task, status: 'awaiting_user', pausedAt: new Date(now) },
  );
}
export function resume(scope: TaskScope, now = Date.now()) {
  return updateTask(scope, task =>
    task.pausedAt
      ? {
          ...task,
          status: task.status === 'awaiting_user' ? 'running' : task.status,
          pausedAt: null,
          pausedMs: task.pausedMs + Math.max(0, now - task.pausedAt.getTime()),
        }
      : task,
  );
}
export function block(
  scope: TaskScope,
  reason: NonNullable<TaskState['context']['blockedReason']>,
) {
  return updateTask(scope, task => ({
    ...task,
    status: 'blocked',
    context: { ...task.context, blockedReason: reason },
  }));
}
export function cancelTask(scope: TaskScope) {
  return updateTask(scope, task => ({ ...task, status: 'cancelled', pausedAt: null }));
}
