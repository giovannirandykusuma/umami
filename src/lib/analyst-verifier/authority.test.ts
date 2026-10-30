// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  task: null as any,
  user: { id: 'u', role: 'user' } as any,
  board: { id: 'b', revision: 3 } as any,
  analysis: { id: 'a', revision: 2 } as any,
  viewBoard: true,
  viewAnalysis: true,
  viewWebsite: true,
  execute: vi.fn(),
  stats: vi.fn(),
}));
vi.mock('@/lib/ai/assistant/analyst/task', () => ({ getUserTask: async () => m.task }));
vi.mock('@/queries/prisma/user', () => ({ getUser: async () => m.user }));
vi.mock('@/queries/prisma/board', () => ({
  getBoard: async () => m.board,
  getUserBoards: vi.fn(),
}));
vi.mock('@/queries/prisma/analysis', () => ({
  getAnalysis: async () => m.analysis,
  commitBundle: vi.fn(),
  getUserAnalyses: vi.fn(),
  hashBundle: vi.fn(),
}));
vi.mock('@/permissions/board', () => ({
  canViewBoard: async () => m.viewBoard,
  canUpdateBoard: vi.fn(),
}));
vi.mock('@/permissions/analysis', () => ({ canViewAnalysis: async () => m.viewAnalysis }));
vi.mock('@/permissions/website', () => ({ canViewWebsite: vi.fn() }));
vi.mock('@/queries/prisma/website', () => ({ getAllUserWebsitesIncludingTeamAccess: vi.fn() }));
vi.mock('@/queries/sql/getWebsiteDateRange', () => ({ getWebsiteDateRange: vi.fn() }));
vi.mock('@/lib/analyst/bundle', () => ({
  validateBundle: vi.fn(),
  issueBundleConfirmation: vi.fn(),
}));
vi.mock('@/lib/analyst/execute', () => ({ executeAnalysis: m.execute }));
vi.mock('@/lib/analyst/definition', () => ({ normalizeDefinition: (value: any) => value }));
vi.mock('@/permissions', () => ({ canViewWebsiteSection: async () => m.viewWebsite }));
vi.mock('@/queries/sql', () => ({ getWebsiteStats: m.stats }));
vi.mock('@/lib/date', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/date')>()),
  parseDateRange: () => ({
    startDate: new Date(1_700_000_000_000),
    endDate: new Date(1_700_086_400_000),
  }),
}));
vi.mock('@/lib/request', () => ({
  getQueryFilters: async (query: any) => ({
    startDate: new Date(query.startAt),
    endDate: new Date(query.endAt),
    timezone: query.timezone,
  }),
}));
import {
  analystDeps,
  prepareVerifierWidgets,
  verifierAuthority,
} from '@/lib/ai/assistant/analyst/deps';
import { createHash } from 'node:crypto';

const scope = {
  userId: 'u',
  taskId: 't',
  boardId: 'b',
  boardRevision: 3,
  analysisRevisions: { a: 2 },
};
beforeEach(() => {
  m.task = { status: 'running', expiresAt: new Date(Date.now() + 60_000) };
  m.board = { id: 'b', revision: 3 };
  m.analysis = { id: 'a', revision: 2 };
  m.viewBoard = m.viewAnalysis = m.viewWebsite = true;
  m.execute.mockReset();
  m.stats.mockReset();
  delete process.env.AI_ANALYST_VERIFIER_ENABLED;
});

it('allows only an active task at exact board/analysis revisions with current view rights', async () => {
  expect(await verifierAuthority(scope)).toBe(true);
  for (const change of [
    () => (m.task = null),
    () => (m.task = { status: 'cancelled' }),
    () => (m.task = { status: 'blocked' }),
    () => (m.task = { status: 'running', expiresAt: new Date(Date.now() - 1) }),
    () => (m.task = { status: 'awaiting_user', expiresAt: new Date(Date.now() - 1) }),
    () => (m.board = { id: 'b', revision: 4 }),
    () => (m.analysis = { id: 'a', revision: 3 }),
    () => (m.viewBoard = false),
    () => (m.viewAnalysis = false),
  ]) {
    beforeEachReset();
    change();
    expect(await verifierAuthority(scope)).toBe(false);
  }
});
function beforeEachReset() {
  m.task = { status: 'running', expiresAt: new Date(Date.now() + 60_000) };
  m.board = { id: 'b', revision: 3 };
  m.analysis = { id: 'a', revision: 2 };
  m.viewBoard = m.viewAnalysis = true;
}

function preparedAnalysis() {
  m.board.parameters = {
    rows: [
      {
        id: 'row',
        columns: [
          {
            id: 'w',
            component: {
              type: 'AnalysisWidget',
              props: { analysisId: 'a' },
            },
          },
        ],
      },
    ],
  };
  m.analysis = {
    id: 'a',
    revision: 2,
    name: 'Saved',
    definitionHash: 'hash',
    definition: { source: { websiteId: 'site' } },
  };
  const envelope = {
    executionId: 'execution',
    definition: { id: 'a', revision: 2, definitionHash: 'hash' },
    definitionHash: 'hash',
    source: { websiteId: 'site' },
    completeness: 'complete',
    columns: [],
    rows: [],
  };
  m.execute.mockResolvedValue(envelope);
  return envelope;
}

it('prepares a deeply frozen saved board and exact execution envelope', async () => {
  preparedAnalysis();
  const widgets = await prepareVerifierWidgets(scope, [{ id: 'w', definitionHash: 'hash' }]);
  expect(widgets[0]).toMatchObject({
    analysisId: 'a',
    revision: 2,
    executionId: 'execution',
    board: { id: 'b', revision: 3 },
  });
  expect(Object.isFrozen(widgets[0].envelope)).toBe(true);
  expect(Object.isFrozen(widgets[0].board.parameters.rows)).toBe(true);
  expect(m.execute.mock.calls[0][2].saved).toEqual({
    id: 'a',
    revision: 2,
    definitionHash: 'hash',
  });
});

it('rejects foreign, stale, failed and mismatched envelopes rather than minting receipts', async () => {
  for (const patch of [
    { definition: { id: 'foreign', revision: 2, definitionHash: 'hash' } },
    { definition: { id: 'a', revision: 3, definitionHash: 'hash' } },
    { definitionHash: 'different' },
    { source: { websiteId: 'foreign' } },
    { completeness: 'partial' },
    { executionId: '' },
  ]) {
    const envelope = preparedAnalysis();
    m.execute.mockResolvedValue({ ...envelope, ...patch });
    await expect(
      prepareVerifierWidgets(scope, [{ id: 'w', definitionHash: 'hash' }]),
    ).rejects.toThrow('stale_revision');
  }
});

it('rechecks authority after execution and rejects unsupported or incomplete widget sets', async () => {
  const envelope = preparedAnalysis();
  m.execute.mockImplementation(async () => {
    m.viewAnalysis = false;
    return envelope;
  });
  await expect(
    prepareVerifierWidgets(scope, [{ id: 'w', definitionHash: 'hash' }]),
  ).rejects.toThrow('revoked');
  m.viewAnalysis = true;
  await expect(
    prepareVerifierWidgets(scope, [{ id: 'foreign', definitionHash: 'hash' }]),
  ).rejects.toThrow('widget_set_mismatch');
  m.board.parameters.rows[0].columns[0].component.type = 'WorldMap';
  await expect(
    prepareVerifierWidgets(scope, [{ id: 'w', definitionHash: 'hash' }]),
  ).rejects.toThrow('unsupported_widget');
});

it('native preparation refuses revoked sources before querying', async () => {
  preparedAnalysis();
  m.board.parameters.rows[0].columns[0].component = {
    type: 'WebsiteMetricsBar',
    entityType: 'website',
    entityId: 'site',
  };
  m.viewWebsite = false;
  await expect(
    prepareVerifierWidgets(scope, [{ id: 'w', definitionHash: 'hash' }]),
  ).rejects.toThrow('revoked');
  expect(m.stats).not.toHaveBeenCalled();
});

it('prepares supported native widgets through the native stats helpers with exact source and hash', async () => {
  preparedAnalysis();
  m.board.parameters.rows[0].columns[0].component = {
    type: 'WebsiteMetricsBar',
    entityType: 'website',
    entityId: 'site',
  };
  const range = { startAt: 1_700_000_000_000, endAt: 1_700_086_400_000, timezone: 'UTC' };
  const definitionHash = createHash('sha256')
    .update(
      JSON.stringify({
        type: 'WebsiteMetricsBar',
        entityId: 'site',
        datePolicy: 'default-UTC',
        props: {},
      }),
    )
    .digest('hex');
  m.stats.mockResolvedValue({ pageviews: 9, visitors: 3, visits: 4, bounces: 1, totaltime: 90 });
  const widgets = await prepareVerifierWidgets(scope, [{ id: 'w', definitionHash }]);
  expect(widgets[0]).toMatchObject({
    definitionHash,
    native: {
      websiteId: 'site',
      range,
      data: { pageviews: 9, comparison: { pageviews: 9 } },
    },
  });
  expect(m.stats).toHaveBeenCalledTimes(2);
  expect(m.stats.mock.calls[0][0]).toBe('site');
  expect(Object.isFrozen(widgets[0].native.data)).toBe(true);
  await expect(
    prepareVerifierWidgets(scope, [{ id: 'w', definitionHash: 'foreign' }]),
  ).rejects.toThrow('stale_revision');
  m.stats.mockImplementation(async () => {
    m.viewWebsite = false;
    return {};
  });
  await expect(prepareVerifierWidgets(scope, [{ id: 'w', definitionHash }])).rejects.toThrow(
    'revoked',
  );
});

it('verifier flag alone never yields a port without a registered isolated launcher', () => {
  process.env.AI_ANALYST_VERIFIER_ENABLED = 'true';
  expect(analystDeps().verifier).toBeNull();
});
