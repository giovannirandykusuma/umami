// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  task: null as any,
  user: { id: 'u', role: 'user' } as any,
  board: { id: 'b', revision: 3 } as any,
  analysis: { id: 'a', revision: 2 } as any,
  viewBoard: true,
  viewAnalysis: true,
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
vi.mock('@/lib/analyst/execute', () => ({ executeAnalysis: vi.fn() }));
import { analystDeps, verifierAuthority } from '@/lib/ai/assistant/analyst/deps';

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
  m.viewBoard = m.viewAnalysis = true;
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

it('verifier flag alone never yields a port without a registered isolated launcher', () => {
  process.env.AI_ANALYST_VERIFIER_ENABLED = 'true';
  expect(analystDeps().verifier).toBeNull();
});
