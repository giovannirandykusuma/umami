import { createHash, randomUUID } from 'node:crypto';
import { validateBundle, issueBundleConfirmation } from '@/lib/analyst/bundle';
import { getResolvedComponentEntity } from '@/lib/boards';
import { getCompareDate, parseDateRange } from '@/lib/date';
import { DEFAULT_DATE_RANGE_VALUE } from '@/lib/constants';
import { getQueryFilters } from '@/lib/request';
import { withDateRange } from '@/lib/schema';
import { canViewWebsiteSection } from '@/permissions';
import { getWebsiteStats } from '@/queries/sql';
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
  createBuiltRenderer,
  isolatedLauncher,
  registerIsolatedLauncher,
} from '@/lib/analyst-verifier/port.mjs';
import { createDockerLauncher } from '@/lib/analyst-verifier/launcher.mjs';
import { getUserTask } from './task';
import type { AnalystDeps, VerifierPort } from './tools';
import type { BoardParameters } from '@/lib/types';

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
    for (const row of (board.parameters as any)?.rows ?? [])
      for (const column of row.columns ?? []) {
        if (column.component?.type === 'WebsiteMetricsBar') {
          const { entityType, entityId } = getResolvedComponentEntity(
            board as any,
            column.component,
          );
          if (
            entityType !== 'website' ||
            !entityId ||
            !(await canViewWebsiteSection(auth, entityId, ['overview', 'compare']))
          )
            return false;
        }
      }
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
  // Copy once: neither a caller nor a renderer may mutate the saved layout used for this job.
  const savedBoard = structuredClone({
    id: board.id,
    revision: board.revision,
    type: board.type,
    name: board.name,
    parameters: board.parameters as BoardParameters,
  });
  if (Buffer.byteLength(JSON.stringify(savedBoard)) > 128_000)
    throw new Error('prepared_payload_too_large');
  const bound = new Map<string, any>();
  for (const row of savedBoard.parameters?.rows ?? [])
    for (const column of row.columns ?? []) {
      if (!column.component || bound.has(column.id)) throw new Error('unsupported_widget');
      bound.set(column.id, column.component);
    }
  if (
    !expected.length ||
    expected.length > 20 ||
    new Set(expected.map(w => w.id)).size !== expected.length ||
    bound.size !== expected.length ||
    expected.some(w => !bound.has(w.id))
  )
    throw new Error('widget_set_mismatch');
  const user = await getUser(scope.userId);
  if (!user) throw new Error('revoked');
  const auth = { user: { ...user, isAdmin: user.role === 'admin' } } as any;
  const widgets = [];
  for (const widget of expected) {
    if (signal?.aborted) throw new Error('cancelled');
    const component = bound.get(widget.id);
    // Native support is intentionally narrow: the normal board's default date range in UTC,
    // with no URL filters. Neither model arguments nor renderer requests can change it.
    // All other native components and non-default semantics fail closed.
    if (component.type === 'WebsiteMetricsBar') {
      const { entityType, entityId } = getResolvedComponentEntity(savedBoard, component);
      const props = component.props ?? {};
      const dates = parseDateRange(DEFAULT_DATE_RANGE_VALUE, '', 'en-US', 'UTC');
      const range = {
        startAt: dates.startDate.getTime(),
        endAt: dates.endDate.getTime(),
        timezone: 'UTC',
      };
      if (
        entityType !== 'website' ||
        !entityId ||
        Object.keys(props).some(key => key !== 'compareMode') ||
        (props.compareMode !== undefined && typeof props.compareMode !== 'boolean')
      )
        throw new Error('unsupported_native_semantics');
      const parsed = withDateRange({}).safeParse(range);
      if (
        !parsed.success ||
        Object.keys(range).some(key => !['startAt', 'endAt', 'timezone'].includes(key))
      )
        throw new Error('unsupported_native_semantics');
      if (!(await canViewWebsiteSection(auth, entityId, ['overview', 'compare'])))
        throw new Error('revoked');
      const definitionHash = createHash('sha256')
        .update(
          JSON.stringify({ type: component.type, entityId, datePolicy: 'default-UTC', props }),
        )
        .digest('hex');
      if (widget.definitionHash !== definitionHash) throw new Error('stale_revision');
      // Same authorized native API helpers as /websites/:id/stats, no duplicated SQL.
      const filters = await getQueryFilters(parsed.data, entityId);
      const stats = await getWebsiteStats(entityId, filters);
      const comparisonRange = getCompareDate('prev', filters.startDate, filters.endDate);
      const comparison = await getWebsiteStats(entityId, { ...filters, ...comparisonRange });
      widgets.push({
        id: widget.id,
        executionId: randomUUID(),
        definitionHash,
        native: {
          type: component.type,
          websiteId: entityId,
          range: parsed.data,
          data: { ...stats, comparison },
        },
        board: savedBoard,
      });
      continue;
    }
    if (component.type !== 'AnalysisWidget') throw new Error('unsupported_widget');
    const analysisId = component.props?.analysisId;
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
    if (
      envelope.definitionHash !== analysis.definitionHash ||
      envelope.definition?.id !== analysis.id ||
      envelope.definition.revision !== analysis.revision ||
      envelope.definition.definitionHash !== analysis.definitionHash ||
      envelope.source.websiteId !== normalizeDefinition(analysis.definition).source.websiteId ||
      !envelope.executionId ||
      envelope.completeness !== 'complete'
    )
      throw new Error('stale_revision');
    widgets.push({
      id: widget.id,
      title: analysis.name,
      executionId: envelope.executionId,
      definitionHash: envelope.definitionHash,
      columns: envelope.columns,
      rows: envelope.rows,
      analysisId: analysis.id,
      revision: analysis.revision,
      envelope,
      board: savedBoard,
    });
  }
  if (signal?.aborted) throw new Error('cancelled');
  if (!(await verifierAuthority(scope))) throw new Error('revoked');
  // Recheck native source authority after preparation as well as before each query.
  for (const widget of widgets)
    if (
      widget.native &&
      !(await canViewWebsiteSection(auth, widget.native.websiteId, ['overview', 'compare']))
    )
      throw new Error('revoked');
  const serialized = JSON.stringify(widgets);
  if (Buffer.byteLength(serialized) > 1_000_000) throw new Error('prepared_payload_too_large');
  const freeze = (value: any): any => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(structuredClone(widgets));
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
    // Only trusted bootstrap selects the local built app; never a model/request URL.
    ...(process.env.NODE_ENV === 'production'
      ? {
          renderer: async request => {
            const renderer = await createBuiltRenderer({
              root: process.cwd(),
              port: Number(process.env.PORT ?? 3000),
            });
            return renderer(request);
          },
        }
      : {}),
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
