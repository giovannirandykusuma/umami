import { randomUUID } from 'node:crypto';
import { parseRequest } from '@/lib/request';
import {
  applyAssistantEvent,
  type AssistantMessage,
  type AssistantPart,
  type AssistantStreamEvent,
  type AnalystPhase,
  type AnalystTaskStatus,
  analystToolPhase,
} from './protocol';
import { store, summary } from './store';
import { runAssistant } from './runtime';
import { executeTool, Interaction } from './tools';
import { advanceTurn, clearResults, finishTurn } from './analytics/results';
import { isAnalystEnabled } from '@/lib/analyst/flags';
import { ImageToolResult } from './runtime';
import type { AnalystToolName } from './analyst/tools';
import type { TaskScope } from './analyst/task';
import { sanitize } from './analyst/sanitize';
// DB-backed analyst modules load only when the default-off flag is enabled.
const analystModules = async () => ({
  ...(await import('./analyst/task')),
  ...(await import('./analyst/tools')),
  ...(await import('./analyst/deps')),
});

type Context = { params: Promise<{ chatId?: string }> };
type Turn = { userId: string; controller: AbortController; interaction: Interaction };
/**
 * Active turns, shared by every route module in THIS process (Next dev may load the turn, reply
 * and cancel routes as separate module instances). Not persisted and not cross-process: a reply
 * or cancel served by another process finds no turn and is rejected.
 */
const TURNS = Symbol.for('umami.assistant.runningTurns');
const shared = globalThis as typeof globalThis & { [TURNS]?: Map<string, Turn> };
const running = (shared[TURNS] ??= new Map<string, Turn>());
const json = (body: unknown, status = 200) => Response.json(body, { status });
const missing = () => json({ error: 'Chat not found' }, 404);
const validTitle = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim() && value.trim().length <= 200;

async function owned(request: Request, context: Context) {
  const parsed = await parseRequest(request);
  if (parsed.error) return { response: parsed.error() as Response };
  if (!parsed.auth?.user?.id) return { response: json({ error: 'Unauthorized' }, 401) };
  const userId = parsed.auth.user.id as string;
  const { chatId } = await context.params;
  if (!chatId || !/^[0-9a-f-]{36}$/i.test(chatId)) return { response: missing() };
  const chat = await store.get(userId, chatId);
  if (!chat) return { response: missing() };
  return { userId, chatId, chat, body: parsed.body, auth: parsed.auth };
}

export async function listChats(request: Request, _context: Context): Promise<Response> {
  const { auth, error } = await parseRequest(request);
  if (error) return error();
  if (!auth?.user?.id) return json({ error: 'Unauthorized' }, 401);
  return json((await store.list(auth.user.id)).map(summary));
}
export async function createChat(request: Request, _context: Context): Promise<Response> {
  const { auth, error, body } = await parseRequest(request);
  if (error) return error();
  if (!auth?.user?.id) return json({ error: 'Unauthorized' }, 401);
  if (body?.title !== undefined && !validTitle(body.title))
    return json({ error: 'Invalid title' }, 400);
  return json(summary(await store.create(auth.user.id, body?.title?.trim() || 'New chat')));
}
export async function getChat(request: Request, context: Context): Promise<Response> {
  const result = await owned(request, context);
  if (result.response) return result.response;
  return json({
    ...summary(result.chat),
    messages: result.chat.messages.map(message => message.content),
  });
}
export async function renameChat(request: Request, context: Context): Promise<Response> {
  const result = await owned(request, context);
  if (result.response) return result.response;
  if (!validTitle(result.body?.title)) return json({ error: 'Invalid title' }, 400);
  await store.rename(result.userId, result.chatId, result.body.title.trim());
  const chat = await store.get(result.userId, result.chatId);
  return chat ? json(summary(chat)) : missing();
}
export async function deleteChat(request: Request, context: Context): Promise<Response> {
  const result = await owned(request, context);
  if (result.response) return result.response;
  // Wait for cancellation persistence before deleting by rejecting deletion while active.
  if (running.has(result.chatId))
    return json({ error: 'Cancel the active turn before deleting this chat' }, 409);
  // Collect task ids first: the cascade removes the rows, artifacts must still be purged.
  const lifecycle = isAnalystEnabled() ? await analystModules() : null;
  const taskIds = lifecycle ? await lifecycle.listChatTaskIds(result.userId, result.chatId) : [];
  await store.delete(result.userId, result.chatId);
  clearResults(result.userId, result.chatId);
  const verifier = lifecycle && taskIds.length ? lifecycle.analystDeps().verifier : null;
  for (const taskId of taskIds) verifier?.cleanup({ userId: result.userId, taskId });
  return json({ ok: true });
}
export async function reply(request: Request, context: Context): Promise<Response> {
  const result = await owned(request, context);
  if (result.response) return result.response;
  const turn = running.get(result.chatId);
  if (!turn || turn.userId !== result.userId || !turn.interaction.reply(result.body))
    return json({ error: 'No matching pending interaction' }, 409);
  return json({ ok: true });
}
export async function cancel(request: Request, context: Context): Promise<Response> {
  const result = await owned(request, context);
  if (result.response) return result.response;
  const turn = running.get(result.chatId);
  if (turn?.userId === result.userId) turn.controller.abort();
  return json({ ok: true });
}
export async function runTurn(request: Request, context: Context): Promise<Response> {
  const result = await owned(request, context);
  if (result.response) return result.response;
  const { userId, chatId, chat, body, auth } = result;
  if (
    typeof body?.message !== 'string' ||
    !body.message.trim() ||
    Buffer.byteLength(body.message) > 32768
  )
    return json({ error: 'Invalid message' }, 400);
  if (body.context !== undefined) {
    const c = body.context;
    if (
      !c ||
      typeof c !== 'object' ||
      Array.isArray(c) ||
      Object.keys(c).some(
        key => !['websiteId', 'boardId', 'startAt', 'endAt', 'timezone'].includes(key),
      ) ||
      ['websiteId', 'boardId', 'timezone'].some(
        key => c[key] !== undefined && (typeof c[key] !== 'string' || c[key].length > 100),
      ) ||
      ['startAt', 'endAt'].some(
        key => c[key] !== undefined && (!Number.isFinite(c[key]) || c[key] < 0),
      )
    )
      return json({ error: 'Invalid context' }, 400);
  }
  if (running.has(chatId)) return json({ error: 'Chat already running' }, 409);
  if (running.size >= 4) return json({ error: 'Assistant busy' }, 429);
  const toolContext = advanceTurn(userId, chatId);
  const controller = new AbortController();
  let parts: AssistantPart[] = [];
  let output: ReadableStreamDefaultController<Uint8Array>;
  let disconnected = false;
  const encoder = new TextEncoder();
  const emit = (event: AssistantStreamEvent) => {
    parts = applyAssistantEvent(parts, event);
    if (!disconnected && output) {
      try {
        output.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      } catch {
        disconnected = true;
        controller.abort();
      }
    }
  };
  // Trusted server decision; the request cannot opt in, select a task or a principal.
  const analyst = isAnalystEnabled();
  const lifecycle = analyst ? await analystModules() : null;
  let scope: TaskScope | undefined;
  // Host-derived task status/phase; only emitted when the analyst flag bound a persisted task.
  let taskStatus: AnalystTaskStatus = 'running';
  let phase: AnalystPhase = 'understand';
  const emitTask = (status?: AnalystTaskStatus, next?: AnalystPhase) => {
    if (!scope) return;
    if (status) taskStatus = status;
    if (next) phase = next;
    emit({ type: 'task', taskId: scope.taskId, status: taskStatus, phase });
  };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let activeUntil = 0;
  let deadlineHit = false;
  const arm = (ms: number) => {
    clearTimeout(deadline);
    activeUntil = Date.now() + ms;
    deadline = setTimeout(
      () => {
        deadlineHit = true;
        if (scope && lifecycle)
          void lifecycle
            .block(scope, 'deadline')
            .then(task => emitTask(task.status))
            .catch(() => undefined);
        controller.abort();
      },
      Math.max(0, ms),
    );
  };
  let remainingAtPause = 0;
  const hooks = analyst
    ? {
        async pause() {
          // Only validated pending confirm/question parts reach here; the wait does not count.
          remainingAtPause = activeUntil - Date.now();
          clearTimeout(deadline);
          if (scope && lifecycle) emitTask((await lifecycle.pause(scope)).status);
        },
        async resume() {
          if (scope && lifecycle) emitTask((await lifecycle.resume(scope)).status);
          if (!controller.signal.aborted) arm(remainingAtPause);
        },
      }
    : undefined;
  if (lifecycle) {
    try {
      const task = await lifecycle.ensureTask(userId, chatId, body.message.trim(), body.context);
      if (task.status === 'blocked')
        return json({ error: 'Task is blocked', status: 'blocked', taskId: task.id }, 409);
      scope = { userId, chatId, taskId: task.id };
      taskStatus = task.status;
      remainingAtPause = lifecycle.remainingMs(task);
      if (remainingAtPause <= 0) {
        await lifecycle.block(scope, 'deadline');
        return json({ error: 'Task execution window exhausted', status: 'blocked' }, 409);
      }
    } catch {
      return json({ error: 'Unable to start analyst task' }, 500);
    }
  }
  const interaction = new Interaction(
    part => emit({ type: 'part', part }),
    controller.signal,
    300000,
    hooks,
  );
  const deps = lifecycle?.analystDeps();
  const queryState = { queries: 0 };
  running.set(chatId, { userId, controller, interaction });
  const disconnect = () => {
    disconnected = true;
    controller.abort();
  };
  request.signal.addEventListener('abort', disconnect, { once: true });
  if (request.signal.aborted) disconnect();
  const userMessage: AssistantMessage = {
    id: randomUUID(),
    role: 'user',
    createdAt: new Date().toISOString(),
    text: body.message.trim(),
  };
  try {
    await store.append(userId, chatId, userMessage);
  } catch {
    running.delete(chatId);
    request.signal.removeEventListener('abort', disconnect);
    return json({ error: 'Unable to save message' }, 500);
  }
  const messageId = randomUUID();
  const createdAt = new Date().toISOString();
  const credentials = new Headers();
  // Forward only the caller's credentials, never an administrator or service token.
  for (const name of ['authorization', 'cookie', 'x-umami-api-key']) {
    const value = request.headers.get(name);
    if (value) credentials.set(name, value);
  }
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      output = streamController;
      emit({ type: 'start', chatId, messageId });
      emitTask();
      void (async () => {
        let failure: string | undefined;
        let session: string | null | undefined;
        // Legacy: fixed 5-minute wall clock. Analyst: 5 minutes of non-waiting execution.
        const timeout = analyst ? undefined : setTimeout(() => controller.abort(), 300000);
        if (analyst) arm(remainingAtPause);
        try {
          if (!chat.messages.some(message => message.role === 'user')) {
            const title = userMessage.text.slice(0, 60);
            await store.rename(userId, chatId, title);
            emit({ type: 'title', chatId, title });
          }
          if (!controller.signal.aborted) {
            const outcome = await runAssistant({
              message: userMessage.text,
              context: body.context,
              session: chat.piSession,
              signal: controller.signal,
              emit,
              analyst,
              tool: async (name, args) => {
                if (
                  scope &&
                  deps &&
                  lifecycle &&
                  (lifecycle.ANALYST_TOOLS as readonly string[]).includes(name)
                ) {
                  emitTask(undefined, analystToolPhase(name) ?? undefined);
                  const outcome = await lifecycle.executeAnalystTool(
                    name as AnalystToolName,
                    args,
                    {
                      auth,
                      scope,
                      interaction,
                      deps,
                      running: queryState,
                    },
                  );
                  // The tool may have persisted a lifecycle change (e.g. budget block); re-read it.
                  const persisted = await lifecycle.getTask(scope).catch(() => null);
                  if (persisted) emitTask(persisted.status);
                  return outcome.images?.length
                    ? new ImageToolResult(outcome.json, outcome.images)
                    : outcome.json;
                }
                return executeTool(name, args, {
                  credentials,
                  interaction,
                  context: toolContext,
                  analyst,
                });
              },
            });
            failure = outcome.error;
            session = outcome.session;
          }
        } catch {
          failure = 'Assistant failed';
        } finally {
          finishTurn(toolContext);
          clearTimeout(timeout);
          clearTimeout(deadline);
          // A deadline stays resumable (blocked); only a user/client cancel cancels the task.
          if (scope && lifecycle && failure === 'Cancelled' && !deadlineHit)
            await lifecycle
              .cancelTask(scope)
              .then(task => emitTask(task.status))
              .catch(() => undefined);
          // Resolve any outstanding interactions and stop running tools on every terminal path.
          const cancelled = controller.signal.aborted || failure === 'Cancelled';
          controller.abort();
          parts = parts.map(part =>
            part.type === 'tool' && part.status === 'running'
              ? { ...part, status: 'error', result: cancelled ? 'Cancelled' : 'Tool interrupted' }
              : part.type === 'confirm' && part.state === 'pending'
                ? { ...part, state: 'expired' }
                : part.type === 'question' && part.state === 'pending'
                  ? { ...part, state: 'expired' }
                  : part,
          );
          const message: AssistantMessage = {
            id: messageId,
            role: 'assistant',
            createdAt,
            // Image blocks/markers never reach the chat table, even via a tool result.
            parts: sanitize(parts),
            status: cancelled ? 'cancelled' : failure ? 'error' : 'done',
            ...(failure && !cancelled ? { error: failure } : {}),
          };
          try {
            await store.append(userId, chatId, message, session);
            emit(
              failure && !cancelled
                ? { type: 'error', error: failure, message }
                : { type: 'done', message },
            );
          } catch {
            emit({ type: 'error', error: 'Unable to save assistant message', message });
          }
          running.delete(chatId);
          request.signal.removeEventListener('abort', disconnect);
          if (!disconnected) {
            try {
              output.close();
            } catch {
              /* Client already closed. */
            }
          }
        }
      })();
    },
    cancel() {
      disconnect();
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
