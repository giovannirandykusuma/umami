import { hasPermission } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/constants';
import type { Auth } from '@/lib/types';
import { getTeamUser } from '@/queries/prisma/teamUser';

export interface AnalysisOwnership {
  userId: string;
  teamId: string | null;
  status: string;
}

/**
 * Drafts are private to their owner. A team analysis becomes visible to team members only once
 * ready. Share tokens never grant analysis access (no public execution contract exists).
 */
export async function canViewAnalysis({ user }: Auth, analysis: AnalysisOwnership) {
  if (!user) return false;
  if (user.id === analysis.userId) return true;
  if (user.isAdmin) return true;
  if (!analysis.teamId || analysis.status !== 'ready') return false;
  return !!(await getTeamUser(analysis.teamId, user.id));
}

export async function canUpdateAnalysis({ user }: Auth, analysis: AnalysisOwnership) {
  if (!user) return false;
  if (user.id === analysis.userId) return true;
  if (user.isAdmin) return true;
  if (!analysis.teamId || analysis.status !== 'ready') return false;
  const teamUser = await getTeamUser(analysis.teamId, user.id);
  return !!teamUser && hasPermission(teamUser.role, PERMISSIONS.websiteUpdate);
}

export async function canCreateTeamAnalysis({ user }: Auth, teamId: string) {
  if (!user) return false;
  if (user.isAdmin) return true;
  const teamUser = await getTeamUser(teamId, user.id);
  return !!teamUser && hasPermission(teamUser.role, PERMISSIONS.websiteCreate);
}

/**
 * A board may reference an analysis only if every viewer of the board can view the analysis:
 * private boards need the same owner; team boards need a ready analysis of the same team.
 */
export function isAnalysisVisibleOnBoard(
  board: { userId: string | null; teamId: string | null },
  analysis: AnalysisOwnership,
) {
  if (board.teamId) return analysis.teamId === board.teamId && analysis.status === 'ready';
  return !!board.userId && !analysis.teamId && analysis.userId === board.userId;
}
