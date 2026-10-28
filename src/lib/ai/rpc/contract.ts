import { z } from 'zod';
import type { BoardParameters } from '../../types';
import { validateBoardDraft } from '../board-draft';

export const AI_READ_TOOLS = [
  'analytics_summary',
  'analytics_breakdown',
  'analytics_timeseries',
  'analytics_discover',
] as const;
export type AiReadTool = (typeof AI_READ_TOOLS)[number];
export const AI_LIMITS = {
  inputBytes: 32_768,
  outputBytes: 262_144,
  toolBytes: 32_768,
  tools: 8,
  turns: 12,
  timeoutMs: 45_000,
  concurrency: 2,
} as const;

export type AiQuestion = {
  id: string;
  question: string;
  options?: { label: string; value: string }[];
};
export type AiResult = { message: string; draft?: BoardParameters; questions?: AiQuestion[] };
export type AiPhase = 'start' | 'check' | 'read' | 'prepare' | 'validate' | 'complete';
export type AiEvent =
  | { type: 'progress'; phase: AiPhase }
  | { type: 'result'; result: AiResult }
  | { type: 'error'; error: string };

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      value =>
        !!value.trim() &&
        !Array.from(value).some(
          character =>
            character === '<' ||
            character === '>' ||
            character.charCodeAt(0) === 127 ||
            (character.charCodeAt(0) < 32 && character !== '\n' && character !== '\t'),
        ),
    );
const safeId = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,64}$/)
  .refine(value => !['__proto__', 'prototype', 'constructor'].includes(value));
export const aiQuestionsSchema = z
  .array(
    z
      .object({
        id: safeId,
        question: text(500),
        options: z
          .array(z.object({ label: text(120), value: text(120) }).strict())
          .min(1)
          .max(6)
          .refine(
            options =>
              new Set(options.map(option => option.value)).size === options.length &&
              new Set(options.map(option => option.label)).size === options.length,
          )
          .optional(),
      })
      .strict(),
  )
  .min(1)
  .max(3)
  .refine(questions => new Set(questions.map(question => question.id)).size === questions.length);
export const aiResultSchema = z
  .object({
    message: text(2000),
    draft: z.unknown().optional(),
    questions: aiQuestionsSchema.optional(),
  })
  .strict();

/** Strict JSON only: do not invoke accessors/toJSON or accept inherited authority. */
type JsonValue = null | string | boolean | number | JsonValue[] | { [key: string]: JsonValue };
function jsonCopy(value: unknown): JsonValue {
  let nodes = 0;
  const visit = (item: unknown, depth: number): JsonValue => {
    if (++nodes > 2000 || depth > 12) throw new Error('Invalid AI result');
    if (item === null) return null;
    if (typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object') throw new Error('Invalid AI result');
    if (Array.isArray(item)) {
      if (
        Object.getPrototypeOf(item) !== Array.prototype ||
        Object.keys(item).length !== item.length ||
        Object.keys(item).some((key, index) => key !== String(index))
      )
        throw new Error('Invalid AI result');
    } else if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      throw new Error('Invalid AI result');
    }
    const copy: any = Array.isArray(item) ? [] : {};
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key))
        throw new Error('Invalid AI result');
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Invalid AI result');
      copy[key] = visit(descriptor.value, depth + 1);
    }
    return copy;
  };
  return visit(value, 0);
}

/** Untrusted display data only. Answers never grant permissions or execute actions. */
export function validateAiResult(value: unknown): AiResult {
  const copy = jsonCopy(value);
  if (new TextEncoder().encode(JSON.stringify(copy)).byteLength > AI_LIMITS.toolBytes)
    throw new Error('AI result exceeded limit');
  const parsed = aiResultSchema.parse(copy);
  return {
    message: parsed.message,
    ...(parsed.draft === undefined ? {} : { draft: validateBoardDraft(parsed.draft) }),
    ...(parsed.questions === undefined ? {} : { questions: parsed.questions }),
  };
}

export const analyticsDiscoverSchema = z
  .object({
    websiteId: z.uuid(),
    startAt: z.number().int().min(0).max(8_640_000_000_000_000),
    endAt: z.number().int().min(0).max(8_640_000_000_000_000),
  })
  .strict();
export type AnalyticsDiscoverArgs = z.infer<typeof analyticsDiscoverSchema>;
/** Host still authorizes the website and enforces its selected date context. */
export function validateAnalyticsDiscoverArgs(value: unknown, now: number): AnalyticsDiscoverArgs {
  const args = analyticsDiscoverSchema.parse(jsonCopy(value));
  if (
    !Number.isFinite(now) ||
    args.endAt > now ||
    args.startAt > args.endAt ||
    args.endAt - args.startAt > 31 * 86_400_000
  )
    throw new Error('Invalid AI date range');
  return args;
}

export type AiTurn = {
  messages: { role: 'user' | 'assistant'; content: string }[];
  draft?: unknown;
  signal?: AbortSignal;
  executeTool: (name: AiReadTool, args: Record<string, unknown>) => Promise<unknown>;
  onEvent?: (event: AiEvent) => void;
};
