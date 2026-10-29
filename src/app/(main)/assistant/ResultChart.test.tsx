import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantSeries } from '@/lib/ai/assistant/protocol';
import { getThemeColors } from '@/lib/colors';
import { ResultChart } from './ResultChart';

const chart = vi.hoisted(() => vi.fn((_props: any) => <div />));
const theme = vi.hoisted(() => ({ theme: 'light' }));
vi.mock('@/components/charts/Chart', () => ({ Chart: chart }));
vi.mock('@umami/react-zen', () => ({
  useTheme: () => theme,
  Button: ({ onPress, children, ...props }: any) => (
    <button onClick={onPress} {...props}>
      {children}
    </button>
  ),
}));

describe('result chart presentation', () => {
  it.each([
    ['day', 'Asia/Tokyo', '2026-10-27T15:00:00Z', '28 Oct'],
    ['hour', 'Asia/Tokyo', '2026-10-28T05:00:00Z', '28 Oct 14:00'],
    ['month', 'Asia/Tokyo', '2026-09-30T15:00:00Z', 'Oct 2026'],
    ['day', 'America/Los_Angeles', '2026-10-28T00:00:00Z', '27 Oct'],
    ['hour', 'America/New_York', '2026-11-01T06:00:00Z', '01 Nov 01:00'],
  ] as const)('formats %s in %s without changing data', (unit, timezone, t, label) => {
    const series: AssistantSeries = {
      label: 'Tracked clicks',
      metric: 'events',
      unit,
      timezone,
      range: { startAt: Date.parse(t), endAt: Date.parse(t) },
      appliedFilters: {},
      buckets: [
        { t, y: 17 },
        { t, y: 25 },
      ],
      total: 42,
    };
    render(<ResultChart part={{ type: 'result-chart', id: 'r', kind: 'bar', series }} />);
    const { chartData } = chart.mock.calls.at(-1)![0] as any;
    expect(chartData.labels).toEqual([label, label]);
    expect(chartData.datasets[0].data).toEqual([17, 25]);
    expect(screen.getByText('Total events: 42')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show table' }));
    expect(screen.getAllByRole('rowheader').map(node => node.textContent)).toEqual([t, t, 'Total']);
    expect(series.buckets).toEqual([
      { t, y: 17 },
      { t, y: 25 },
    ]);
  });

  it.each(['light', 'dark'])('uses the %s Umami chart palette', value => {
    theme.theme = value;
    render(
      <ResultChart
        part={{
          type: 'result-chart',
          id: 'r',
          kind: 'line',
          series: {
            label: 'Views',
            metric: 'pageviews',
            unit: 'day',
            timezone: 'UTC',
            range: { startAt: 0, endAt: 0 },
            appliedFilters: {},
            buckets: [],
            total: 0,
          },
        }}
      />,
    );
    const { chartData, chartOptions } = chart.mock.calls.at(-1)![0] as any;
    expect(chartData.datasets[0]).toMatchObject(getThemeColors(value).colors.chart.views);
    expect(chartOptions.scales.x.ticks.color).toBe(getThemeColors(value).colors.chart.text);
  });
});
