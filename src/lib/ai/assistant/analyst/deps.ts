import { validateBundle, issueBundleConfirmation } from '@/lib/analyst/bundle';
import { executeAnalysis } from '@/lib/analyst/execute';
import { canViewAnalysis } from '@/permissions/analysis';
import { canUpdateBoard, canViewBoard } from '@/permissions/board';
import { canViewWebsite } from '@/permissions/website';
import { getBoard, getUserBoards } from '@/queries/prisma/board';
import { commitBundle, getAnalysis, getUserAnalyses, hashBundle } from '@/queries/prisma/analysis';
import { getAllUserWebsitesIncludingTeamAccess } from '@/queries/prisma/website';
import { getWebsiteDateRange } from '@/queries/sql/getWebsiteDateRange';
import type { AnalystDeps } from './tools';

/**
 * Production dependencies. The verifier stays null: Stage 2 only certified a fixture adapter, and
 * there is no automatic host-browser fallback. MAIN wires an isolated production dispatcher later.
 */
export function analystDeps(): AnalystDeps {
  return {
    async listWebsites(auth) {
      const { data } = await getAllUserWebsitesIncludingTeamAccess(auth.user!.id, {
        pageSize: 100,
      });
      return data.map((w: any) => ({ id: w.id, name: w.name }));
    },
    async listBoards(auth) {
      const { data } = await getUserBoards(auth.user!.id, { pageSize: 50 });
      return data.map((b: any) => ({ id: b.id, name: b.name, revision: b.revision }));
    },
    async listAnalyses(auth) {
      const { data } = await getUserAnalyses(auth.user!.id, { pageSize: 50 });
      return data.map(a => ({
        id: a.id,
        name: a.name,
        revision: a.revision,
        definitionHash: a.definitionHash,
      }));
    },
    async dateRange(auth, websiteId) {
      if (!(await canViewWebsite(auth, websiteId))) return { startAt: null, endAt: null };
      const range = await getWebsiteDateRange(websiteId);
      return {
        startAt: range?.startDate ? new Date(range.startDate).getTime() : null,
        endAt: range?.endDate ? new Date(range.endDate).getTime() : null,
      };
    },
    execute: executeAnalysis,
    getBoard: getBoard as AnalystDeps['getBoard'],
    canUpdateBoard,
    canViewBoard,
    getAnalysis,
    canViewAnalysis,
    validateBundle,
    hashBundle,
    commitBundle,
    issueConfirmation: issueBundleConfirmation,
    verifier: null,
  };
}
