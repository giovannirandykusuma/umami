'use client';
import { Button, Column, Row, Text, useTheme } from '@umami/react-zen';
import { Chart } from '@/components/charts/Chart';
import { queryRenderState, receiptAttributes } from '@/components/charts/renderReceipt';
import { useAnalysisExecutionQuery } from '@/components/hooks/queries/useAnalysisQuery';
import type { ExecutionEnvelope } from '@/lib/analyst/execute';
import { getThemeColors } from '@/lib/colors';

type Visualization = 'line' | 'bar' | 'table' | 'metric';

// Mirrors RENDERERS in src/lib/analyst/definition.ts (server-only module, node:crypto).
const RENDERERS: Record<string, Visualization[]> = {
  series: ['line', 'bar', 'table'],
  breakdown: ['bar', 'table'],
  totals: ['metric', 'table'],
  numeric_property: ['metric', 'table'],
};

const ERROR_STATES: Record<string, string> = {
  not_found: 'Analysis is unavailable or you no longer have access.',
  denied: 'Access to this analysis source was denied.',
  unsupported_schema: 'This analysis uses an unsupported definition version.',
  unsupported_combination: 'This analysis is not supported by this version.',
  feature_disabled: 'Analysis execution is disabled.',
};

const date = (value: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(
    value,
  );

/**
 * Live, saved-definition widget. Every visible number comes from the execute envelope; the
 * widget never sends filters/dates and ignores the global board date (fixed stays fixed).
 */
export function AnalysisWidget({
  analysisId,
  title,
  visualization = 'table',
  widgetId,
}: {
  analysisId: string;
  title?: string;
  visualization?: Visualization;
  /** Board column id (set by BoardViewColumn); keys the verifier's render receipt. */
  widgetId?: string;
}) {
  const { data, error, isLoading, isFetching, refetch } = useAnalysisExecutionQuery(analysisId);
  const label = title || data?.semanticBinding?.label || 'Saved analysis';
  // Receipt state/execution/hash come only from the execute query result, never the DOM.
  const state = queryRenderState({
    isLoading,
    error,
    data,
    isEmpty: (d: ExecutionEnvelope) => !d.rows.length,
  });

  return (
    <Column
      gap="2"
      width="100%"
      role="region"
      aria-label={label}
      aria-busy={isFetching}
      data-analysis-widget={analysisId}
      data-widget-id={widgetId}
      {...receiptAttributes({
        state,
        executionId: error ? undefined : data?.executionId,
        definitionHash: error ? undefined : data?.definitionHash,
      })}
      style={{ minWidth: 0, overflowWrap: 'anywhere' }}
    >
      <Row gap="2" alignItems="center" wrap="wrap" justifyContent="space-between">
        <Row gap="2" alignItems="center" wrap="wrap">
          <Text size="sm" weight="bold">
            Live
          </Text>
          {data && (
            <Text size="sm" color="muted">
              {data.range.policy.type === 'fixed'
                ? 'Fixed range'
                : `Rolling ${data.range.policy.window}`}
            </Text>
          )}
        </Row>
        <Button
          aria-label={`Refresh ${label}`}
          onPress={() => void refetch()}
          isDisabled={isFetching}
        >
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </Button>
      </Row>
      {isLoading ? (
        <Text color="muted">Running saved analysis…</Text>
      ) : error ? (
        <Text role="alert">
          {ERROR_STATES[error.code ?? ''] ?? 'Analysis execution failed. Try refreshing.'}
        </Text>
      ) : data ? (
        <AnalysisResult data={data} visualization={visualization} />
      ) : null}
    </Column>
  );
}

function AnalysisResult({
  data,
  visualization,
}: {
  data: ExecutionEnvelope;
  visualization: Visualization;
}) {
  const { theme } = useTheme();
  const { colors } = getThemeColors(theme);
  const allowed = RENDERERS[data.operation] ?? ['table'];
  const kind: Visualization = allowed.includes(visualization) ? visualization : 'table';
  const valueKey = data.columns.find(c => c.type === 'number')?.key;
  const labelKey = data.columns.find(c => c.type !== 'number')?.key;
  const { range } = data;

  return (
    <>
      {kind !== visualization && (
        <Text role="note" color="muted">
          Shown as a table: {visualization} cannot represent a {data.operation} result.
        </Text>
      )}
      {data.completeness !== 'complete' && (
        <Text role="note">
          {data.completeness === 'partial' ? 'Partial result' : 'Completeness unknown'}
          {data.reasons.length ? `: ${data.reasons.join(', ')}` : ''}
        </Text>
      )}
      {!data.rows.length ? (
        <Text color="muted">No rows returned for this range (not proof of no activity).</Text>
      ) : kind === 'metric' && valueKey ? (
        <Text size="3xl" weight="bold">
          {data.rows[0][valueKey] ?? 'Unavailable'}
        </Text>
      ) : kind === 'table' ? (
        <div role="region" aria-label="Analysis data" tabIndex={0} style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {data.columns.map(c => (
                  <th key={c.key} scope="col" style={{ textAlign: 'left' }}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={i}>
                  {data.columns.map(c => (
                    <td key={c.key}>{row[c.key] ?? '—'}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div role="img" aria-label={`${data.semanticBinding.label} ${kind} chart`}>
          <Chart
            height="200px"
            type={kind === 'bar' ? 'bar' : 'line'}
            animationDuration={0}
            chartData={{
              focusLabel: null,
              labels: data.rows.map(r => String(r[labelKey!] ?? '')),
              datasets: [
                {
                  label: data.semanticBinding.label,
                  data: data.rows.map(r => r[valueKey!]),
                  ...colors.chart.views,
                  borderWidth: 2,
                },
              ],
            }}
            chartOptions={{
              scales: {
                x: { type: 'category', ticks: { color: colors.chart.text, maxTicksLimit: 6 } },
                y: { beginAtZero: true, ticks: { color: colors.chart.text } },
              },
              plugins: { legend: { display: false } },
            }}
          />
        </div>
      )}
      <details>
        <summary>Definition and provenance</summary>
        <dl style={{ margin: 0 }}>
          <dt>Metric</dt>
          <dd>
            {data.semanticBinding.label} ({data.unit}) · {data.semanticBinding.population} ·{' '}
            {data.semanticBinding.meaningSource.replace(/_/g, ' ')}
          </dd>
          <dt>Date range</dt>
          <dd>
            {date(range.startAt, range.timezone)} – {date(range.endAt, range.timezone)} ·{' '}
            {range.timezone}
          </dd>
          <dt>Executed</dt>
          <dd>{date(data.executedAt, range.timezone)}</dd>
          {data.definition && (
            <>
              <dt>Revision</dt>
              <dd>{data.definition.revision}</dd>
            </>
          )}
          {data.warnings.length > 0 && (
            <>
              <dt>Warnings</dt>
              <dd>{data.warnings.join(', ')}</dd>
            </>
          )}
        </dl>
      </details>
    </>
  );
}
