import { render, screen, cleanup } from '@testing-library/react';
import { toZonedTime } from 'date-fns-tz';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebsiteCompareChart } from './WebsiteCompareChart';

const mocks = vi.hoisted(() => ({
  results: [] as any[],
  queries: vi.fn(),
  chart: vi.fn(),
  get: vi.fn(),
  timezone: 'UTC',
}));
vi.mock('@tanstack/react-query', () => ({
  useQueries: (options: any) => {
    mocks.queries(options);
    return mocks.results;
  },
}));
vi.mock('@/components/hooks', () => ({
  useApi: () => ({ get: mocks.get }),
  useTimezone: () => ({
    timezone: mocks.timezone,
    fromUtc: (date: number) => toZonedTime(date, mocks.timezone),
  }),
  useDateRange: () => ({
    dateRange: { startDate: new Date('2026-01-01'), endDate: new Date('2026-01-02') },
  }),
  useDateParameters: () => ({ startAt: 1, endAt: 2, timezone: 'UTC', unit: 'day' }),
  useFilterParameters: () => ({ url: '/test' }),
  useLocale: () => ({ locale: 'en-US', dateLocale: undefined }),
}));
vi.mock('@/components/charts/BarChart', () => ({
  BarChart: (props: any) => {
    mocks.chart(props);
    return <div data-test="chart" />;
  },
}));
vi.mock('@/components/common/LoadingPanel', () => ({
  LoadingPanel: ({ data, error, isLoading, isFetching, children }: any) =>
    error ? (
      <div>Error</div>
    ) : isLoading || isFetching ? (
      <div>Loading</div>
    ) : !data.length ? (
      <div>Empty</div>
    ) : (
      children
    ),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.timezone = 'UTC';
});

const websiteIds = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];
const result = (name: string, n: number) => ({
  data: {
    name,
    series: {
      pageviews: [{ x: '2026-01-01 00:00:00', y: n * 2 }],
      sessions: [{ x: '2026-01-01 00:00:00', y: n }],
    },
  },
});

describe('WebsiteCompareChart', () => {
  it.each(['visitors', 'pageviews'] as const)('renders one line per website for %s', metric => {
    mocks.results = [result('First', 3), result('Second', 5)];
    render(<WebsiteCompareChart websiteIds={websiteIds} metric={metric} />);
    expect(screen.getAllByTestId('chart')).toHaveLength(1);
    const props = mocks.chart.mock.lastCall![0];
    expect(props.chartData.datasets.map((item: any) => item.label)).toEqual(['First', 'Second']);
    expect(props.chartData.datasets.every((item: any) => item.type === 'line')).toBe(true);
    expect(new Set(props.chartData.datasets.map((item: any) => item.borderColor)).size).toBe(2);
    expect(props.chartData.datasets[0].data[0].y).toBe(metric === 'visitors' ? 3 : 6);
    expect(props.unit).toBe('day');
  });

  it('requests every website with board dates and optional unit', async () => {
    mocks.results = [result('First', 3), result('Second', 5)];
    mocks.get.mockImplementation(async (path: string) =>
      path.endsWith('/pageviews') ? { pageviews: [], sessions: [] } : { name: 'Site' },
    );
    render(<WebsiteCompareChart websiteIds={websiteIds} metric="visitors" unit="hour" />);
    const queries = mocks.queries.mock.lastCall![0].queries;
    await Promise.all(queries.map((query: any) => query.queryFn()));
    for (const id of websiteIds) {
      expect(mocks.get).toHaveBeenCalledWith(`/websites/${id}/pageviews`, {
        startAt: 1,
        endAt: 2,
        timezone: 'UTC',
        unit: 'hour',
        url: '/test',
      });
    }
  });

  it.each(['UTC', 'America/New_York'])('pins requests and axis to explicit dates in %s', async timezone => {
    mocks.timezone = timezone;
    mocks.results = [result('First', 3), result('Second', 5)];
    const startAt = Date.parse('2026-01-01T05:00:00Z');
    const endAt = Date.parse('2026-01-14T05:00:00Z');
    render(
      <WebsiteCompareChart
        websiteIds={websiteIds}
        metric="visitors"
        unit="day"
        startAt={startAt}
        endAt={endAt}
      />,
    );
    const queries = mocks.queries.mock.lastCall![0].queries;
    await Promise.all(queries.map((query: any) => query.queryFn()));
    for (const id of websiteIds) {
      expect(mocks.get).toHaveBeenCalledWith(`/websites/${id}/pageviews`,
        expect.objectContaining({ startAt, endAt, unit: 'day' }));
    }
    expect(queries[0].queryKey[1]).toEqual(expect.objectContaining({ startAt, endAt }));
    const props = mocks.chart.mock.lastCall![0];
    expect(props.minDate).toEqual(toZonedTime(startAt, timezone));
    expect(props.maxDate).toEqual(toZonedTime(endAt, timezone));
    expect(props.chartData.datasets[0].data).toHaveLength(14);
  });

  it.each([
    { startAt: 1 },
    { startAt: 2, endAt: 1 },
    { startAt: Number.NaN, endAt: 2 },
  ])('keeps global board dates for an incomplete or invalid range: %j', range => {
    mocks.results = [result('First', 3), result('Second', 5)];
    render(<WebsiteCompareChart websiteIds={websiteIds} metric="visitors" {...range} />);
    const props = mocks.chart.mock.lastCall![0];
    expect(props.minDate).toEqual(new Date('2026-01-01'));
    expect(props.maxDate).toEqual(new Date('2026-01-02'));
    expect(mocks.queries.mock.lastCall![0].queries[0].queryKey[1]).toEqual(
      expect.objectContaining({ startAt: 1, endAt: 2 }),
    );
  });

  it.each([
    [[{ isLoading: true }, {}], 'Loading'],
    [[{ isFetching: true }, {}], 'Loading'],
    [[{ error: new Error('denied') }, {}], 'Error'],
    [[], 'Empty'],
  ])('handles loading, errors and invalid selection', (results, text) => {
    mocks.results = results as any[];
    render(<WebsiteCompareChart websiteIds={results.length ? websiteIds : []} metric="visitors" />);
    expect(screen.getByText(text as string)).toBeTruthy();
  });
});
