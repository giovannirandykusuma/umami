import type { UseQueryOptions } from '@tanstack/react-query';
import { createContext, createElement, type ReactNode, useContext } from 'react';
import { useDateParameters } from '@/components/hooks/useDateParameters';
import { useApi } from '../useApi';
import { useFilterParameters } from '../useFilterParameters';

export interface WebsiteStatsData {
  pageviews: number;
  visitors: number;
  visits: number;
  bounces: number;
  totaltime: number;
  comparison: {
    pageviews: number;
    visitors: number;
    visits: number;
    bounces: number;
    totaltime: number;
  };
}

/** Only the capability-protected verifier tree installs this context. It is not a query cache. */
export type FrozenWebsiteStats = {
  widgetId: string;
  websiteId: string;
  executionId: string;
  definitionHash: string;
  range: { startAt: number; endAt: number; timezone: string };
  compare?: string;
  data: WebsiteStatsData;
};
const FrozenStats = createContext<FrozenWebsiteStats | null>(null);
export function FrozenWebsiteStatsProvider({
  value,
  children,
}: {
  value: FrozenWebsiteStats;
  children: ReactNode;
}) {
  if (
    !value.websiteId ||
    !value.widgetId ||
    !value.executionId ||
    !value.definitionHash ||
    !Number.isFinite(value.range.startAt) ||
    !Number.isFinite(value.range.endAt) ||
    value.range.endAt <= value.range.startAt ||
    value.range.timezone !== 'UTC' ||
    !value.data ||
    !value.data.comparison
  )
    throw new Error('invalid_frozen_native_execution');
  return createElement(FrozenStats.Provider, { value }, children);
}

export function useWebsiteStatsQuery(
  { websiteId, compare }: { websiteId: string; compare?: string },
  options?: UseQueryOptions<WebsiteStatsData, Error, WebsiteStatsData>,
) {
  const frozen = useContext(FrozenStats);
  const { get, useQuery } = useApi();
  const { startAt, endAt, timezone } = useDateParameters();
  const filters = useFilterParameters();

  const query = useQuery<WebsiteStatsData>({
    queryKey: ['websites:stats', { websiteId, compare, startAt, endAt, ...filters }],
    queryFn: () => get(`/websites/${websiteId}/stats`, { compare, startAt, endAt, ...filters }),
    enabled: !!websiteId,
    ...options,
    ...(frozen ? { enabled: false } : {}),
  });
  if (!frozen) return query;
  const bound =
    frozen.websiteId === websiteId &&
    frozen.compare === compare &&
    frozen.range.startAt === startAt &&
    frozen.range.endAt === endAt &&
    frozen.range.timezone === timezone &&
    Object.values(filters).every(value => value === undefined);
  return {
    ...query,
    data: bound ? frozen.data : undefined,
    error: bound
      ? null
      : Object.assign(new Error('frozen_native_context_mismatch'), {
          expected: { websiteId: frozen.websiteId, range: frozen.range, compare: frozen.compare },
          actual: { websiteId, startAt, endAt, timezone, compare, filters },
        }),
    isLoading: false,
    isFetching: false,
    refetch: () => undefined,
  };
}

/** Query-backed receipt for the supported native renderer; never inferred from DOM presence. */
export function useFrozenWebsiteStatsReceipt(websiteId?: string) {
  const frozen = useContext(FrozenStats);
  return frozen?.websiteId === websiteId ? frozen : null;
}
