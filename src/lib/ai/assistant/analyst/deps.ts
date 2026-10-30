import { validateBundle, issueBundleConfirmation } from '@/lib/analyst/bundle';
import { normalizeDefinition } from '@/lib/analyst/definition';
import { executeAnalysis } from '@/lib/analyst/execute';
import { canViewAnalysis } from '@/permissions/analysis';
import { canUpdateBoard, canViewBoard } from '@/permissions/board';
import { canViewWebsite } from '@/permissions/website';
import { getBoard, getUserBoards } from '@/queries/prisma/board';
import { commitBundle, getAnalysis, getUserAnalyses, hashBundle } from '@/queries/prisma/analysis';
import { getAllUserWebsitesIncludingTeamAccess } from '@/queries/prisma/website';
import { getWebsiteDateRange } from '@/queries/sql/getWebsiteDateRange';
import { getUser } from '@/queries/prisma/user';
import { isAnalystVerifierEnabled } from '@/lib/analyst/flags';
import {
  createVerifierPort,
  isolatedLauncher,
  registerIsolatedLauncher,
} from '@/lib/analyst-verifier/port.mjs';
import { createDockerLauncher } from '@/lib/analyst-verifier/launcher.mjs';
import { getUserTask } from './task';
import type { AnalystDeps, VerifierPort } from './tools';

type VerifierScope = {
  userId: string;
  taskId: string;
  boardId: string;
  boardRevision: number;
  analysisRevisions: Record<string, number>;
};

/**
 * Re-derives authority from the database on every capability/session/artifact use: the task must
 * still be active for this principal, and the board and every analysis must be viewable at exactly
 * the captured revisions. Any change (revision bump, revocation, cancellation) fails closed.
 */
export async function verifierAuthority(scope: VerifierScope): Promise<boolean> {
  try {
    const task = await getUserTask(scope.userId, scope.taskId);
    if (!task || !['running', 'awaiting_user'].includes(task.status)) return false;
    // Trusted server clock: an elapsed row is not authority even if its status was never updated.
    if (task.expiresAt.getTime() <= Date.now()) return false;
    const user = await getUser(scope.userId);
    if (!user) return false;
    const auth = { user: { ...user, isAdmin: user.role === 'admin' } } as any;
    const board = await getBoard(scope.boardId);
    if (!board || board.revision !== scope.boardRevision) return false;
    if (!(await canViewBoard(auth, board.id))) return false;
    for (const [id, revision] of Object.entries(scope.analysisRevisions)) {
      const analysis = await getAnalysis(id);
      if (!analysis || analysis.revision !== revision) return false;
      if (!(await canViewAnalysis(auth, analysis))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Trusted host execution for the verifier canvas: each widget's saved analysis is re-executed
 * with the task principal at exactly the captured revision. The resulting executionId and
 * definitionHash are what the render receipt must match; nothing comes from the model.
 */
export async function prepareVerifierWidgets(
  scope: VerifierScope,
  expected: { id: string; definitionHash: string }[],
  signal?: AbortSignal,
) {
  if (!(await verifierAuthority(scope))) throw new Error('revoked');
  // Widget -> analysis binding comes from the stored board at the captured revision only.
  const board = await getBoard(scope.boardId);
  if (!board || board.revision !== scope.boardRevision) throw new Error('stale_revision');
  const bound = new Map<string, string>();
  for (const row of ((board.parameters as any)?.rows ?? []) as any[])
    for (const column of (row?.columns ?? []) as any[])
      if (typeof column?.component?.props?.analysisId === 'string')
        bound.set(column.id, column.component.props.analysisId);
  const user = await getUser(scope.userId);
  if (!user) throw new Error('revoked');
  const auth = { user: { ...user, isAdmin: user.role === 'admin' } } as any;
  const widgets = [];
  for (const widget of expected) {
    const analysisId = bound.get(widget.id);
    const analysis = analysisId ? await getAnalysis(analysisId) : null;
    if (
      !analysis ||
      analysis.revision !== scope.analysisRevisions[analysis.id] ||
      analysis.definitionHash !== widget.definitionHash ||
      !(await canViewAnalysis(auth, analysis))
    )
      throw new Error('stale_revision');
    const envelope = await executeAnalysis(auth, normalizeDefinition(analysis.definition), {
      now: Date.now(),
      signal,
      saved: {
        id: analysis.id,
        revision: analysis.revision,
        definitionHash: analysis.definitionHash,
      },
    });
    if (envelope.definitionHash !== analysis.definitionHash) throw new Error('stale_revision');
    widgets.push({
      id: widget.id,
      title: analysis.name,
      executionId: envelope.executionId,
      definitionHash: envelope.definitionHash,
      columns: envelope.columns,
      rows: envelope.rows,
    });
  }
  return widgets;
}

let port: VerifierPort | null | undefined;
/** Both the flag AND a trusted registered restricted launcher are required; otherwise null. */
function verifier(): VerifierPort | null {
  if (!isAnalystVerifierEnabled()) return null;
  // Trusted bootstrap: only the explicit server setting selects the restricted Docker launcher.
  if (!isolatedLauncher() && process.env.AI_ANALYST_VERIFIER_LAUNCHER === 'docker')
    registerIsolatedLauncher(createDockerLauncher());
  const launcher = isolatedLauncher();
  if (!launcher) return null;
  port ??= createVerifierPort({
    enabled: true,
    launcher,
    authorize: verifierAuthority,
    prepare: prepareVerifierWidgets,
  }) as VerifierPort | null;
  return port;
}

/**
 * Production dependencies. The verifier is null unless the verifier flag is on AND trusted
 * bootstrap registered an isolated launcher; there is no automatic host-browser fallback.
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
    verifier: verifier(),
  };
}
