import { randomUUID } from 'node:crypto';
import { parseRequest } from '@/lib/request';
import {
  applyAssistantEvent,
  type AssistantMessage,
  type AssistantPart,
  type AssistantStreamEvent,
} from './protocol';
import { store, summary } from './store';
import { runAssistant } from './runtime';
import { executeTool, Interaction } from './tools';
import { advanceTurn, clearResults, finishTurn } from './analytics/results';

type Context = { params: Promise<{ chatId?: string }> };
type Turn = { userId: string; controller: AbortController; interaction: Interaction };
const running = new Map<string, Turn>();
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
  return { userId, chatId, chat, body: parsed.body };
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
  await store.delete(result.userId, result.chatId);
  clearResults(result.userId, result.chatId);
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
  const { userId, chatId, chat, body } = result;
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
  const interaction = new Interaction(part => emit({ type: 'part', part }), controller.signal);
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
      void (async () => {
        let failure: string | undefined;
        let session: string | null | undefined;
        const timeout = setTimeout(() => controller.abort(), 300000);
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
              tool: (name, args) =>
                executeTool(name, args, { credentials, interaction, context: toolContext }),
            });
            failure = outcome.error;
            session = outcome.session;
          }
        } catch {
          failure = 'Assistant failed';
        } finally {
          finishTurn(toolContext);
          clearTimeout(timeout);
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
            parts,
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
