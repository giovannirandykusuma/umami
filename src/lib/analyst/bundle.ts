import { z } from 'zod';
import { AnalysisError, isRendererCompatible, normalizeDefinition } from '@/lib/analyst/definition';
import type { Auth, BoardParameters } from '@/lib/types';
import { canCreateTeamAnalysis } from '@/permissions/analysis';
import { getAnalysisWidgets, getInvalidBoardAnalysis } from '@/permissions/board';
import {
  canCreateTeamWebsite,
  canCreateWebsite,
  canUpdateBoard,
  canViewBoardEntities,
  hasValidBoardReports,
} from '@/permissions';
import { canViewWebsite } from '@/permissions/website';
import { getBoard } from '@/queries/prisma';
import { type BundleRequest, createConfirmation, hashBundle } from '@/queries/prisma/analysis';

export const bundleSchema = {
  taskId: z.uuid().optional(),
  boardId: z.uuid().optional(),
  expectedRevision: z.number().int().positive().optional(),
  teamId: z.uuid().optional(),
  board: z
    .object({
      type: z.enum(['mixed']),
      name: z.string().trim().min(1).max(200),
      description: z.string().max(500).optional(),
      parameters: z.object({}).passthrough(),
    })
    .strict(),
  analyses: z
    .array(
      z
        .object({
          ref: z.string().min(1).max(64),
          name: z.string().trim().min(1).max(200),
          description: z.string().max(500).optional(),
          status: z.enum(['draft', 'ready']).default('draft'),
          definition: z.unknown(),
        })
        .strict(),
    )
    .max(12),
};

/**
 * Normalizes and authorizes a bundle against current authority: board write access, team
 * permission, every new definition's source and every referenced existing analysis/source.
 */
export async function validateBundle(auth: Auth, body: any): Promise<BundleRequest> {
  if (body.boardId && (body.expectedRevision === undefined || body.teamId))
    throw new AnalysisError(
      'invalid_definition',
      'Existing board edits need expectedRevision only',
      'expectedRevision',
    );
  let owner: { userId: string | null; teamId: string | null };
  if (body.boardId) {
    const current = await getBoard(body.boardId);
    if (!current || !(await canUpdateBoard(auth, body.boardId)))
      throw new AnalysisError('not_found', 'Board not found');
    owner = { userId: current.userId, teamId: current.teamId };
  } else {
    if (
      (body.teamId && !(await canCreateTeamWebsite(auth, body.teamId))) ||
      !(await canCreateWebsite(auth))
    )
      throw new AnalysisError('denied', 'Board cannot be created', 'teamId');
    owner = { userId: body.teamId ? null : auth.user.id, teamId: body.teamId ?? null };
  }
  if (owner.teamId && !(await canCreateTeamAnalysis(auth, owner.teamId)))
    throw new AnalysisError('denied', 'Team is not writable', 'teamId');
  const refs = new Map<string, string>();
  const analyses = [];
  for (const a of body.analyses) {
    if (refs.has(a.ref)) throw new AnalysisError('invalid_definition', 'Duplicate ref', 'analyses');
    // New analyses take the board's visibility; team analyses must be ready (drafts are private).
    if (owner.teamId && a.status !== 'ready')
      throw new AnalysisError('invalid_definition', 'Team analyses must be ready', 'status');
    const definition = normalizeDefinition(a.definition);
    if (!(await canViewWebsite({ user: auth.user }, definition.source.websiteId)))
      throw new AnalysisError('denied', 'Source website is not accessible', 'source.websiteId');
    refs.set(a.ref, definition.operation);
    analyses.push({ ...a, definition });
  }
  const parameters = body.board.parameters as BoardParameters;
  const existing: BoardParameters = { rows: [] };
  for (const component of getAnalysisWidgets(parameters)) {
    const props = component.props ?? {};
    if (props.analysisRef === undefined) continue;
    const allowed = ['analysisRef', 'title', 'visualization'];
    const operation = refs.get(String(props.analysisRef));
    if (
      !operation ||
      Object.keys(props).some(key => !allowed.includes(key)) ||
      (props.title !== undefined &&
        (typeof props.title !== 'string' || props.title.length > 200)) ||
      !isRendererCompatible(operation, String(props.visualization))
    )
      throw new AnalysisError('invalid_definition', 'Invalid analysis widget', 'board.parameters');
  }
  // Remaining widgets reference saved analyses: full current-authority validation.
  existing.rows = (parameters.rows ?? []).map(row => ({
    ...row,
    columns: (row.columns ?? []).filter(c => c.component?.props?.analysisRef === undefined),
  }));
  if (
    !(await canViewBoardEntities(auth, body.board.type, existing)) ||
    !(await hasValidBoardReports(body.board.type, existing))
  )
    throw new AnalysisError('denied', 'Board contains inaccessible entities', 'board.parameters');
  const invalid = await getInvalidBoardAnalysis(auth, owner, existing);
  if (invalid) throw new AnalysisError('denied', invalid, 'board.parameters');
  return {
    taskId: body.taskId ?? null,
    // New analyses always take the target board's visibility (team board → team analyses).
    teamId: owner.teamId,
    ...(body.boardId ? { boardId: body.boardId, expectedRevision: body.expectedRevision } : {}),
    board: body.board,
    analyses,
  };
}

/**
 * Internal trusted seam: records a user's approval of one exact existing-board bundle diff.
 * Deliberately NOT exposed as an HTTP route — an ordinary authenticated (or model-driven) caller
 * must never mint its own grant. Only trusted host orchestration that has obtained an explicit
 * human approval for this principal/task may call it. Single-use, expires after 10 minutes.
 */
export async function issueBundleConfirmation(auth: Auth, input: unknown) {
  const body = z.object(bundleSchema).strict().parse(input);
  if (!body.boardId)
    throw new AnalysisError(
      'invalid_definition',
      'Confirmation targets an existing board',
      'boardId',
    );
  if (!body.taskId)
    throw new AnalysisError('invalid_definition', 'Confirmation is task-scoped', 'taskId');
  const bundle = await validateBundle(auth, body);
  return createConfirmation({
    userId: auth.user.id,
    taskId: bundle.taskId,
    boardId: bundle.boardId!,
    expectedRevision: bundle.expectedRevision!,
    diffHash: hashBundle(bundle),
  });
}
