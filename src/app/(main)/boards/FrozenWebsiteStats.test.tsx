import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  FrozenWebsiteStatsProvider,
  useWebsiteStatsQuery,
} from '@/components/hooks/queries/useWebsiteStatsQuery';
const m = vi.hoisted(() => ({
  get: vi.fn(),
  range: { startAt: 100, endAt: 200, timezone: 'UTC' },
  filters: {} as any,
}));
vi.mock('@/components/hooks/useDateParameters', () => ({ useDateParameters: () => m.range }));
vi.mock('@/components/hooks/useFilterParameters', () => ({ useFilterParameters: () => m.filters }));
vi.mock('@/components/hooks/useApi', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  return { useApi: () => ({ get: m.get, useQuery }) };
});
const data = {
  pageviews: 9,
  visitors: 3,
  visits: 4,
  bounces: 1,
  totaltime: 80,
  comparison: { pageviews: 8, visitors: 2, visits: 3, bounces: 1, totaltime: 60 },
};
function wrapper(frozen: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }) => (
    <QueryClientProvider client={client}>
      {frozen ? (
        <FrozenWebsiteStatsProvider
          value={{
            widgetId: 'w',
            websiteId: 'site',
            executionId: 'execution',
            definitionHash: 'hash',
            range: { startAt: 100, endAt: 200, timezone: 'UTC' },
            data,
          }}
        >
          {children}
        </FrozenWebsiteStatsProvider>
      ) : (
        children
      )}
    </QueryClientProvider>
  );
}
beforeEach(() => {
  m.get.mockReset();
  m.filters = {};
  m.range = { startAt: 100, endAt: 200, timezone: 'UTC' };
});
it('frozen exact context never requests, including explicit refresh', () => {
  const { result } = renderHook(() => useWebsiteStatsQuery({ websiteId: 'site' }), {
    wrapper: wrapper(true),
  });
  expect(result.current.data).toEqual(data);
  result.current.refetch();
  expect(m.get).not.toHaveBeenCalled();
});
it('rejects foreign website, changed date, timezone and filters without fetching', () => {
  for (const mutate of [
    () => {
      m.range.startAt = 101;
    },
    () => {
      m.range.timezone = 'Asia/Tokyo';
    },
    () => {
      m.filters = { country: 'eq.US' };
    },
  ]) {
    m.range = { startAt: 100, endAt: 200, timezone: 'UTC' };
    m.filters = {};
    mutate();
    const { result, unmount } = renderHook(() => useWebsiteStatsQuery({ websiteId: 'site' }), {
      wrapper: wrapper(true),
    });
    expect(result.current.error?.message).toBe('frozen_native_context_mismatch');
    expect(result.current.data).toBeUndefined();
    unmount();
  }
  const { result } = renderHook(() => useWebsiteStatsQuery({ websiteId: 'foreign' }), {
    wrapper: wrapper(true),
  });
  expect(result.current.data).toBeUndefined();
  expect(m.get).not.toHaveBeenCalled();
});
it('normal authenticated API path still fetches and exposes authorization errors', async () => {
  const denied = Object.assign(new Error('Unauthorized'), { status: 401 });
  m.get.mockRejectedValue(denied);
  const { result } = renderHook(() => useWebsiteStatsQuery({ websiteId: 'site' }), {
    wrapper: wrapper(false),
  });
  await waitFor(() => expect(result.current.error).toBe(denied));
  expect(m.get).toHaveBeenCalledWith('/websites/site/stats', {
    startAt: 100,
    endAt: 200,
    compare: undefined,
  });
});
