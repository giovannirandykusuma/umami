import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@/generated/prisma/client';

/** Internal host capability, never supplied by the model or an HTTP caller. */
export interface AiQueryScope {
  signal: AbortSignal;
  deadline: number;
}
export const aiReads = new AsyncLocalStorage<
  AiQueryScope & {
    tx: Prisma.TransactionClient;
    closed: boolean;
  }
>();
export function getAiQueryScope() {
  const scope = aiReads.getStore();
  if (scope) {
    scope.signal.throwIfAborted();
    if (scope.closed || Date.now() >= scope.deadline) throw new Error('AI read expired.');
  }
  return scope;
}

let activeReads = 0;

/** No transaction survives this callback; callers must not include model generation. */
export async function withAiRead<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  if (activeReads >= 4) throw new Error('AI database capacity reached.');
  activeReads++;
  try {
    const { withAiPrismaRead } = await import('@/lib/prisma');
    return await withAiPrismaRead(work, { signal, deadline: Date.now() + 10_000 });
  } finally {
    activeReads--;
  }
}
