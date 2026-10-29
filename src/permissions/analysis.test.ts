import { beforeEach, expect, test, vi } from 'vitest';
import { canUpdateAnalysis, canViewAnalysis, isAnalysisVisibleOnBoard } from './analysis';
import { getTeamUser } from '@/queries/prisma/teamUser';

vi.mock('@/lib/prisma', () => ({ default: {} }));
vi.mock('@/queries/prisma/teamUser', () => ({ getTeamUser: vi.fn() }));
const member = vi.mocked(getTeamUser);
const owner = { id: 'owner', username: 'o', role: 'user', isAdmin: false };
const other = { id: 'other', username: 'x', role: 'user', isAdmin: false };
const draft = { userId: 'owner', teamId: null, status: 'draft' };
const team = { userId: 'owner', teamId: 'team', status: 'ready' };

beforeEach(() => member.mockReset());

test('drafts are owner-private; share tokens and strangers never see them', async () => {
  expect(await canViewAnalysis({ user: owner }, draft)).toBe(true);
  expect(await canViewAnalysis({ user: other }, draft)).toBe(false);
  expect(await canViewAnalysis({ shareToken: { boardId: 'b' } } as any, draft)).toBe(false);
  member.mockResolvedValue({ role: 'team-member' } as any);
  expect(await canViewAnalysis({ user: other }, { ...draft, teamId: 'team' })).toBe(false);
});

test('team analyses follow board-style team roles', async () => {
  member.mockResolvedValue(null as any);
  expect(await canViewAnalysis({ user: other }, team)).toBe(false);
  member.mockResolvedValue({ role: 'team-view-only' } as any);
  expect(await canViewAnalysis({ user: other }, team)).toBe(true);
  expect(await canUpdateAnalysis({ user: other }, team)).toBe(false);
  member.mockResolvedValue({ role: 'team-member' } as any);
  expect(await canUpdateAnalysis({ user: other }, team)).toBe(true);
  expect(await canUpdateAnalysis({}, team)).toBe(false);
});

test('a board cannot expose an analysis more restricted than itself', () => {
  expect(isAnalysisVisibleOnBoard({ userId: 'owner', teamId: null }, draft)).toBe(true);
  expect(isAnalysisVisibleOnBoard({ userId: 'other', teamId: null }, draft)).toBe(false);
  expect(isAnalysisVisibleOnBoard({ userId: null, teamId: 'team' }, draft)).toBe(false);
  expect(isAnalysisVisibleOnBoard({ userId: null, teamId: 'team' }, team)).toBe(true);
  expect(isAnalysisVisibleOnBoard({ userId: null, teamId: 'other' }, team)).toBe(false);
  expect(isAnalysisVisibleOnBoard({ userId: 'owner', teamId: null }, team)).toBe(false);
});
