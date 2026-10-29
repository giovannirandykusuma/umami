'use client';

import { Button, useTheme } from '@umami/react-zen';
import { formatInTimeZone } from 'date-fns-tz';
import { useState } from 'react';
import { Chart } from '@/components/charts/Chart';
import type { AssistantPart } from '@/lib/ai/assistant/protocol';
import { getThemeColors } from '@/lib/colors';
import styles from './AssistantPage.module.css';

export function ResultChart({ part }: { part: Extract<AssistantPart, { type: 'result-chart' }> }) {
  const { series } = part;
  const [table, setTable] = useState(part.kind === 'table');
  const { theme } = useTheme();
  const { colors } = getThemeColors(theme);
  const date = (value: number) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: series.timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(value);
  const labelFormat =
    series.unit === 'month' ? 'MMM yyyy' : series.unit === 'hour' ? 'dd MMM HH:mm' : 'dd MMM';
  const labels = series.buckets.map(bucket =>
    formatInTimeZone(bucket.t, series.timezone, labelFormat),
  );
  return (
    <section className={styles.chart} aria-label={part.title || series.label}>
      <h3>{part.title || series.label}</h3>
      <p className={styles.resultMeta}>
        {series.label} · {series.metric} · {series.unit}
      </p>
      <p className={styles.resultMeta}>
        {date(series.range.startAt)} – {date(series.range.endAt)} · {series.timezone}
      </p>
      <p className={styles.resultMeta}>
        Filters:{' '}
        {Object.entries(series.appliedFilters)
          .map(([key, value]) => `${key} = ${value}`)
          .join(' · ') || 'None'}
      </p>
      <p>
        <strong>
          Total {series.metric}: {series.total}
        </strong>
      </p>
      <Button aria-pressed={table} onPress={() => setTable(!table)}>
        {table ? 'Show chart' : 'Show table'}
      </Button>
      {table ? (
        <div className={styles.resultTable} tabIndex={0} role="region" aria-label="Chart data">
          <table>
            <caption>
              {series.label} · {series.timezone}
            </caption>
            <thead>
              <tr>
                <th scope="col">Bucket ({series.unit})</th>
                <th scope="col">{series.metric}</th>
              </tr>
            </thead>
            <tbody>
              {series.buckets.map(bucket => (
                <tr key={bucket.t}>
                  <th scope="row">{bucket.t}</th>
                  <td>{bucket.y}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td>{series.total}</td>
              </tr>
            </tfoot>
          </table>
          {!series.buckets.length && <p>No data in this range.</p>}
        </div>
      ) : (
        <div
          className={styles.resultPlot}
          data-assistant-chart
          role="img"
          aria-label={`${series.label}: total ${series.total} ${series.metric}`}
        >
          <Chart
            height="180px"
            type={part.kind === 'bar' ? 'bar' : 'line'}
            animationDuration={0}
            chartData={{
              focusLabel: null,
              labels,
              datasets: [
                {
                  label: series.label,
                  data: series.buckets.map(bucket => bucket.y),
                  ...colors.chart.views,
                  borderWidth: 2,
                  pointRadius: 2,
                },
              ],
            }}
            chartOptions={{
              scales: {
                x: {
                  type: 'category',
                  ticks: { color: colors.chart.text, maxTicksLimit: 6, maxRotation: 0 },
                  grid: { display: false },
                },
                y: {
                  beginAtZero: true,
                  ticks: { color: colors.chart.text, precision: 0 },
                  grid: { color: colors.chart.line },
                },
              },
              plugins: { legend: { display: false }, tooltip: { enabled: true } },
            }}
          />
        </div>
      )}
    </section>
  );
}
