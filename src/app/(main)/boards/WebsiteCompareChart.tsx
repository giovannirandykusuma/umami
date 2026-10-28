import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { BarChart } from '@/components/charts/BarChart';
import { LoadingPanel } from '@/components/common/LoadingPanel';
import {
  useApi,
  useDateParameters,
  useDateRange,
  useFilterParameters,
  useLocale,
  useTimezone,
} from '@/components/hooks';
import { renderDateLabels } from '@/lib/charts';
import { generateTimeSeries } from '@/lib/date';
import type { WebsitePageviewsData } from '@/components/hooks/queries/useWebsitePageviewsQuery';

export interface WebsiteCompareChartProps {
  websiteIds: string[];
  metric: 'visitors' | 'pageviews';
  unit?: 'hour' | 'day' | 'month';
}

const palette = [
  '#2563eb',
  '#ea580c',
  '#16a34a',
  '#9333ea',
  '#dc2626',
  '#0891b2',
  '#ca8a04',
  '#db2777',
  '#4f46e5',
  '#475569',
];

export function WebsiteCompareChart({
  websiteIds = [],
  metric,
  unit: requestedUnit,
}: WebsiteCompareChartProps) {
  const { get } = useApi();
  const { timezone } = useTimezone();
  const { dateRange } = useDateRange({ timezone });
  const { startDate, endDate } = dateRange;
  const parameters = useDateParameters();
  const filters = useFilterParameters();
  const { locale, dateLocale } = useLocale();
  const unit = requestedUnit || parameters.unit;
  const valid =
    websiteIds.length >= 2 &&
    websiteIds.length <= 10 &&
    new Set(websiteIds).size === websiteIds.length;
  const params = { ...parameters, ...filters, unit };
  const results = useQueries({
    queries: (valid ? websiteIds : []).map(websiteId => ({
      queryKey: ['website-compare', { websiteId, ...params }],
      queryFn: async () => {
        const [website, series] = await Promise.all([
          get(`/websites/${websiteId}`),
          get(`/websites/${websiteId}/pageviews`, params) as Promise<WebsitePageviewsData>,
        ]);
        return { name: website.name, series };
      },
    })),
  });
  const chartData = useMemo(
    () => ({
      datasets: results.map((result, index) => ({
        type: 'line' as const,
        label: result.data?.name || websiteIds[index],
        data: generateTimeSeries(
          result.data?.series[metric === 'visitors' ? 'sessions' : 'pageviews'] || [],
          startDate,
          endDate,
          unit,
          dateLocale,
        ),
        borderColor: palette[index],
        backgroundColor: palette[index],
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
      })),
    }),
    [results, websiteIds, metric, startDate, endDate, unit, dateLocale],
  );
  const isLoading = results.some(result => result.isLoading);
  const isFetching = results.some(result => result.isFetching);
  const error = results.find(result => result.error)?.error;
  const data = valid && results.every(result => result.data) ? chartData.datasets : [];

  return (
    <LoadingPanel data={data} isLoading={isLoading} isFetching={isFetching} error={error}>
      <BarChart
        chartData={chartData}
        unit={unit}
        minDate={startDate}
        maxDate={endDate}
        renderXLabel={renderDateLabels(unit, locale)}
        height="400px"
      />
    </LoadingPanel>
  );
}
