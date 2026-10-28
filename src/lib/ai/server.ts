import { z } from 'zod';
import { checkAuth } from '@/lib/auth';
import { getBoardEntityIds, getBoardType } from '@/lib/boards';
import { getQueryFilters } from '@/lib/request';
import type { Auth, BoardParameters } from '@/lib/types';
import { canUpdateBoard, canViewBoardEntities } from '@/permissions/board';
import { canViewWebsite } from '@/permissions/website';
import { getBoard, getWebsite } from '@/queries/prisma';
import { getPageviewMetrics, getPageviewStats, getWebsiteStats } from '@/queries/sql';
import { validateBoardDraft } from './board-draft';
import { withAiRead } from './query';
import { AI_LIMITS, runAiTurn, type AiReadTool, type AiTurn } from './runtime';

const bodySchema = z
  .object({
    boardId: z.uuid().optional(),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().trim().min(1).max(4000),
          })
          .strict(),
      )
      .min(1)
      .max(24),
    draft: z.unknown().optional(),
  })
  .strict();
const dates = {
  websiteId: z.uuid(),
  startAt: z.number().int().min(0).max(8_640_000_000_000_000),
  endAt: z.number().int().min(0).max(8_640_000_000_000_000),
};
const schemas = {
  analytics_summary: z.object(dates).strict(),
  analytics_breakdown: z
    .object({
      ...dates,
      dimension: z.enum(['path', 'title', 'referrer', 'hostname']),
      limit: z.union([z.literal(5), z.literal(10), z.literal(20)]),
    })
    .strict(),
  analytics_timeseries: z
    .object({ ...dates, metric: z.literal('pageviews'), unit: z.literal('day') })
    .strict(),
};

class AiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function fail(status: number, message: string): never {
  throw new AiError(status, message);
}
function response(status: number, data: unknown) {
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized, 'utf8') > AI_LIMITS.toolBytes)
    return response(502, { error: 'AI response exceeded limits.' });
  return new Response(serialized, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
  });
}

// Process-local public-staging admission control. No prompts, analytics or IDs are logged.
const users = new Map<string, number>();
let turns = 0;
let queries = 0;

async function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () =>
      reject(
        new AiError(signal.reason?.name === 'TimeoutError' ? 504 : 499, 'AI request stopped.'),
      );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([cancelled, Promise.resolve().then(work)]);
  } finally {
    signal.removeEventListener('abort', abort!);
  }
}

async function readBody(request: Request, signal: AbortSignal) {
  if (Number(request.headers.get('content-length')) > AI_LIMITS.inputBytes)
    fail(413, 'AI request is too large.');
  if (!request.body) fail(400, 'Invalid AI request.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await bounded(() => reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > AI_LIMITS.inputBytes) fail(413, 'AI request is too large.');
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      fail(400, 'Invalid AI request.');
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** Injection is a test seam only; the HTTP route always uses native runAiTurn. */
export async function handleAiChat(
  request: Request,
  runtime: (input: AiTurn) => ReturnType<typeof runAiTurn> = runAiTurn,
) {
  let admitted = false;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(AI_LIMITS.timeoutMs)]);
  try {
    if (process.env.AI_ENABLED !== 'true') fail(503, 'AI board assistance is disabled.');
    const authenticated = await bounded(() => withAiRead(() => checkAuth(request), signal), signal);
    if (!authenticated?.user?.id || authenticated.authType === 'api-key')
      fail(401, 'Sign in to use AI board assistance.');
    const auth: Auth = { user: authenticated.user };
    const now = Date.now();
    for (const [id, expires] of users) if (expires <= now) users.delete(id);
    if (users.has(auth.user.id) || users.size >= 1000 || turns >= AI_LIMITS.concurrency)
      fail(429, 'AI is busy. Try again shortly.');
    users.set(auth.user.id, now + 60_000);
    turns++;
    admitted = true;
    const parsed = bodySchema.safeParse(await readBody(request, signal));
    if (!parsed.success) fail(400, 'Invalid AI request.');
    const input = parsed.data;
    let draft: BoardParameters | undefined;
    if (input.draft !== undefined) {
      try {
        draft = validateBoardDraft(input.draft);
      } catch {
        fail(400, 'Invalid board draft.');
      }
    }
    const website = async (id: string) => {
      if (!(await getWebsite(id)) || !(await canViewWebsite(auth, id)))
        fail(403, 'Website access denied.');
    };
    const references = async (type: string, parameters: BoardParameters) => {
      const ids = getBoardEntityIds({ type, parameters });
      if (ids.pixelIds.length || ids.linkIds.length) fail(400, 'AI supports website boards only.');
      if (!(await canViewBoardEntities(auth, type, parameters)))
        fail(403, 'Board entity access denied.');
      for (const id of ids.websiteIds) await website(id);
    };
    let currentDraft: BoardParameters | undefined;
    const selectedWebsites = new Set<string>();
    const authorize = async (candidate?: BoardParameters) => {
      selectedWebsites.clear();
      let type = 'mixed';
      if (input.boardId) {
        const board = await getBoard(input.boardId);
        if (!board || !(await canUpdateBoard(auth, input.boardId)))
          fail(403, 'Board editing access denied.');
        type = getBoardType({ type: board.type, parameters: board.parameters as BoardParameters });
        if (!['dashboard', 'mixed', 'website'].includes(type))
          fail(400, 'AI supports website boards only.');
        const current = (board.parameters ?? {}) as BoardParameters;
        await references(type, current);
        for (const id of getBoardEntityIds({ type, parameters: current }).websiteIds)
          selectedWebsites.add(id);
        // Only the strict AI-safe subset may leave the host; legacy widgets stay private.
        try {
          currentDraft = validateBoardDraft(current);
        } catch {
          currentDraft = undefined;
        }
        if (type === 'website' && candidate) {
          if (!current.websiteId || candidate.websiteId !== current.websiteId)
            fail(400, 'Keep the website board selection unchanged.');
          const ids = getBoardEntityIds({ type, parameters: candidate }).websiteIds;
          if (ids.some(id => id !== current.websiteId))
            fail(400, 'Website boards must use one website.');
        }
      }
      if (candidate) {
        await references(type, candidate);
        for (const id of getBoardEntityIds({ type, parameters: candidate }).websiteIds)
          selectedWebsites.add(id);
      }
    };
    await bounded(() => withAiRead(() => authorize(draft), signal), signal);
    let calls = 0;
    let reading = false;
    let acceptingTools = true;
    const readWebsites = new Set<string>();
    let toolFailure: unknown;
    const executeTool = async (name: AiReadTool, args: Record<string, unknown>) => {
      try {
        signal.throwIfAborted();
        if (!acceptingTools || ++calls > AI_LIMITS.tools || reading || queries >= 2)
          fail(429, 'AI read limit reached.');
        if (
          !Object.hasOwn(schemas, name) ||
          Buffer.byteLength(JSON.stringify(args)) > AI_LIMITS.toolBytes
        )
          fail(400, 'Invalid analytics request.');
        const parsedArgs = schemas[name].safeParse(args);
        if (!parsedArgs.success) fail(400, 'Invalid analytics request.');
        const a = parsedArgs.data;
        if (a.endAt < a.startAt || a.endAt > Date.now() || a.endAt - a.startAt > 31 * 86_400_000)
          fail(400, 'Analytics range must be at most 31 days and not in the future.');
        reading = true;
        queries++;
        // Retain admission until scoped transaction cleanup, even if HTTP aborts.
        // Server-side statement limits bound SQL; host races alone do not cancel it.
        const readSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
        const work = async () => {
          await authorize(draft);
          await website(a.websiteId);
          readSignal.throwIfAborted();
          const filters = await getQueryFilters(
            { startAt: a.startAt, endAt: a.endAt, unit: 'day', timezone: 'UTC' },
            a.websiteId,
          );
          readSignal.throwIfAborted();
          let data: unknown;
          if (name === 'analytics_summary') data = await getWebsiteStats(a.websiteId, filters);
          else if (name === 'analytics_timeseries')
            data = await getPageviewStats(a.websiteId, filters);
          else {
            const b = schemas.analytics_breakdown.parse(args);
            data = await getPageviewMetrics(
              b.websiteId,
              { type: b.dimension, limit: b.limit, offset: 0 },
              filters,
            );
          }
          readSignal.throwIfAborted();
          await authorize(draft);
          await website(a.websiteId);
          readWebsites.add(a.websiteId);
          const serialized = JSON.stringify(data);
          if (!serialized || Buffer.byteLength(serialized) > AI_LIMITS.toolBytes)
            fail(502, 'Analytics response exceeded limits.');
          return JSON.parse(serialized);
        };
        return await bounded(
          () =>
            withAiRead(work, readSignal).finally(() => {
              queries--;
              reading = false;
            }),
          readSignal,
        );
      } catch (error) {
        toolFailure = error;
        throw error;
      }
    };
    // Reauthorize immediately before provider egress, including every selected reference.
    await bounded(() => withAiRead(() => authorize(draft), signal), signal);
    const endAt = Date.now();
    const context = {
      websiteIds: [...selectedWebsites],
      now: endAt,
      startAt: Math.max(0, endAt - 30 * 86_400_000),
      endAt,
    };
    const result = await bounded(
      () =>
        runtime({
          messages: input.messages,
          draft: draft ?? currentDraft,
          context,
          signal,
          executeTool,
        }).finally(() => {
          acceptingTools = false;
        }),
      signal,
    );
    if (toolFailure) throw toolFailure;
    if (reading) fail(502, 'AI read has not completed.');
    if (
      !result ||
      Object.keys(result).some(key => !['message', 'draft'].includes(key)) ||
      typeof result.message !== 'string' ||
      !result.message.trim() ||
      result.message.length > 2000 ||
      Array.from(result.message).some(
        c => c === '<' || c === '>' || (c.charCodeAt(0) < 32 && c !== '\n' && c !== '\t'),
      )
    )
      fail(502, 'Invalid AI response.');
    let finalDraft: BoardParameters | undefined;
    if (result.draft !== undefined) {
      try {
        finalDraft = validateBoardDraft(result.draft);
      } catch {
        fail(502, 'Invalid AI board proposal.');
      }
    }
    await bounded(
      () =>
        withAiRead(async () => {
          await authorize(draft);
          await authorize(finalDraft);
          for (const id of readWebsites) await website(id);
        }, signal),
      signal,
    );
    return response(200, { message: result.message, ...(finalDraft ? { draft: finalDraft } : {}) });
  } catch (error) {
    if (error instanceof AiError) return response(error.status, { error: error.message });
    if (signal.aborted)
      return response(signal.reason?.name === 'TimeoutError' ? 504 : 499, {
        error: 'AI request stopped.',
      });
    return response(502, { error: 'AI assistance could not complete. Try again.' });
  } finally {
    if (admitted) turns--;
  }
}
