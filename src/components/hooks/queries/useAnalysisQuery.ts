import { createContext, createElement, type ReactNode, useContext } from 'react';
import type { ExecutionEnvelope } from '@/lib/analyst/execute';
import { useApi } from '../useApi';

/**
 * Verifier-only: one frozen, host-prepared execution per saved analysis (exact revision, hash and
 * execution id). Absent everywhere except the verifier canvas route, so normal boards always use
 * the authenticated execute fetch below.
 */
export type FrozenExecution = {
  analysisId: string;
  revision: number;
  definitionHash: string;
  envelope: ExecutionEnvelope;
};
const FrozenExecutions = createContext<Map<string, FrozenExecution> | null>(null);

export function FrozenExecutionProvider({
  executions,
  children,
}: {
  executions: FrozenExecution[];
  children: ReactNode;
}) {
  const map = new Map<string, FrozenExecution>();
  for (const e of executions) {
    // The envelope must be the saved execution of exactly this analysis/revision/hash.
    if (
      map.has(e.analysisId) ||
      e.envelope.definition?.id !== e.analysisId ||
      e.envelope.definition.revision !== e.revision ||
      e.envelope.definition.definitionHash !== e.definitionHash ||
      e.envelope.definitionHash !== e.definitionHash ||
      !e.envelope.executionId
    )
      throw new Error('invalid_frozen_execution');
    map.set(e.analysisId, e);
  }
  return createElement(FrozenExecutions.Provider, { value: map }, children);
}

type Result = {
  data?: ExecutionEnvelope;
  error: (Error & { code?: string; status?: number }) | null;
  isLoading: boolean;
  isFetching: boolean;
  refetch: () => unknown;
};

/**
 * Executes a saved analysis through the same endpoint the assistant uses. The stored definition
 * is the replay source; nothing from the board config (filters, dates) is sent. Refresh is
 * explicit (`refetch`) plus normal mount; there is no background polling. Under a
 * FrozenExecutionProvider it never fetches: it returns that analysis's frozen execution, or a
 * not_found error when none was prepared (never another analysis's result).
 */
export function useAnalysisExecutionQuery(analysisId?: string): Result {
  const frozen = useContext(FrozenExecutions);
  const { post, useQuery } = useApi();
  const query = useQuery<ExecutionEnvelope, Error & { code?: string; status?: number }>({
    queryKey: ['analyses:execute', { analysisId }],
    queryFn: () => post(`/analyses/${analysisId}/execute`, {}),
    enabled: !!analysisId && !frozen,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  if (!frozen) return query;
  const entry = analysisId ? frozen.get(analysisId) : undefined;
  return {
    data: entry?.envelope,
    error: entry
      ? null
      : Object.assign(new Error('No prepared execution'), { code: 'not_found', status: 404 }),
    isLoading: false,
    isFetching: false,
    refetch: () => undefined,
  };
}
