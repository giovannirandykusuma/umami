import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisWidget } from './AnalysisWidget';

const query = vi.hoisted(() => ({ value: {} as any, ids: [] as string[] }));
vi.mock('@/components/hooks/queries/useAnalysisQuery', () => ({
  useAnalysisExecutionQuery: (id: string) => {
    query.ids.push(id);
    return { refetch: vi.fn(), ...query.value };
  },
}));
vi.mock('@/components/charts/Chart', () => ({ Chart: () => <div data-testid="chart" /> }));
vi.mock('@umami/react-zen', () => ({
  useTheme: () => ({ theme: 'light' }),
  Button: ({ onPress, children, isDisabled, ...p }: any) => (
    <button onClick={onPress} disabled={isDisabled} {...p}>
      {children}
    </button>
  ),
  Column: ({ children, gap, ...p }: any) => <div {...p}>{children}</div>,
  Row: ({ children }: any) => <div>{children}</div>,
  Text: ({ children, role }: any) => <span role={role}>{children}</span>,
}));

const envelope = (patch: any = {}) => ({
  executionId: 'exec-1',
  executedAt: Date.UTC(2026, 0, 5),
  definition: { id: 'a1', revision: 2, definitionHash: 'h' },
  definitionHash: 'h',
  operation: 'totals',
  unit: 'count',
  range: {
    startAt: Date.UTC(2026, 0, 1),
    endAt: Date.UTC(2026, 0, 4),
    timezone: 'UTC',
    policy: { type: 'fixed' },
  },
  semanticBinding: {
    label: 'Signups',
    unit: 'count',
    population: 'visitors',
    meaningSource: 'user_confirmed',
  },
  columns: [
    { key: 'metric', label: 'Metric', type: 'string' },
    { key: 'value', label: 'Signups', type: 'number' },
  ],
  rows: [{ metric: 'events', value: 3 }],
  completeness: 'complete',
  reasons: [],
  warnings: [],
  ...patch,
});

afterEach(() => {
  cleanup();
  query.ids = [];
});

describe('AnalysisWidget', () => {
  it('renders the executed envelope with provenance and fixed badge', () => {
    query.value = { data: envelope(), isLoading: false, isFetching: false };
    render(<AnalysisWidget analysisId="a1" visualization="metric" />);
    expect(query.ids).toEqual(['a1']);
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('Fixed range')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Signups' }).dataset.executionId).toBe('exec-1');
    expect(screen.getByText('Definition and provenance')).toBeTruthy();
  });

  it('falls back to table with a visible reason for incompatible chart kind', () => {
    query.value = { data: envelope(), isLoading: false, isFetching: false };
    render(<AnalysisWidget analysisId="a1" visualization="line" />);
    expect(screen.getByRole('note').textContent).toContain('cannot represent a totals result');
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('shows partial completeness and empty state without zero substitution', () => {
    query.value = {
      data: envelope({ rows: [], completeness: 'partial', reasons: ['top_n_truncated'] }),
      isLoading: false,
      isFetching: false,
    };
    render(<AnalysisWidget analysisId="a1" />);
    expect(screen.getByText(/Partial result: top_n_truncated/)).toBeTruthy();
    expect(screen.getByText(/not proof of no activity/)).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });

  it.each([
    ['not_found', /no longer have access/],
    ['unsupported_schema', /unsupported definition version/],
    ['execution_failed', /execution failed/],
  ])('renders %s as a visible error state, not an empty chart', (code, text) => {
    query.value = { error: Object.assign(new Error('x'), { code }), isLoading: false };
    render(<AnalysisWidget analysisId="a1" />);
    expect(screen.getByRole('alert').textContent).toMatch(text);
    expect(screen.queryByTestId('chart')).toBeNull();
  });

  it('binds the receipt to the query result and the board widget id', () => {
    query.value = { data: envelope(), isLoading: false, isFetching: false };
    render(<AnalysisWidget analysisId="a1" widgetId="w1" />);
    const region = screen.getByRole('region', { name: 'Signups' });
    expect(region.dataset.widgetId).toBe('w1');
    expect(region.dataset.analysisState).toBe('rendered');
    expect(region.dataset.definitionHash).toBe('h');
  });

  it('carries no execution or hash in the receipt when the query failed', () => {
    query.value = { data: envelope(), error: Object.assign(new Error('x'), { status: 403 }) };
    render(<AnalysisWidget analysisId="a1" widgetId="w1" />);
    const region = document.querySelector('[data-widget-id="w1"]') as HTMLElement;
    expect(region.dataset.analysisState).toBe('denied');
    expect(region.dataset.executionId).toBeUndefined();
    expect(region.dataset.definitionHash).toBeUndefined();
  });
});
