import { randomUUID } from 'node:crypto';
import type { AssistantSeries } from '../protocol';

export type ToolContext = { userId: string; chatId: string; turn: number };
const chats = new Map<
  string,
  { turn: number; results: Map<string, { turn: number; value: unknown }> }
>();
const key = (context: Pick<ToolContext, 'userId' | 'chatId'>) =>
  JSON.stringify([context.userId, context.chatId]);
export function advanceTurn(userId: string, chatId: string): ToolContext {
  const context = { userId, chatId, turn: 0 };
  const state = chats.get(key(context)) || { turn: 0, results: new Map() };
  context.turn = ++state.turn;
  for (const [id, entry] of state.results)
    if (entry.turn < context.turn - 1) state.results.delete(id);
  chats.set(key(context), state);
  return context;
}
export function finishTurn(context: ToolContext) {
  const state = chats.get(key(context));
  if (state?.turn !== context.turn) return;
  for (const [id, entry] of state.results) if (entry.turn < context.turn) state.results.delete(id);
}
export function clearResults(userId: string, chatId: string) {
  chats.delete(key({ userId, chatId }));
}
export function saveResult(context: ToolContext, value: unknown) {
  const state = chats.get(key(context));
  if (!state || state.turn !== context.turn) throw new Error('Expired tool context');
  const resultId = randomUUID();
  state.results.set(resultId, { turn: context.turn, value });
  while (state.results.size > 50) state.results.delete(state.results.keys().next().value!);
  return resultId;
}
export function getSeries(context: ToolContext, id: string): AssistantSeries | undefined {
  const state = chats.get(key(context));
  const entry = state?.results.get(id);
  if (!entry || state.turn !== context.turn || entry.turn < context.turn - 1) return;
  const value = entry.value as AssistantSeries;
  if (!Array.isArray(value.buckets)) return;
  state.results.delete(id);
  state.results.set(id, entry);
  return value;
}
