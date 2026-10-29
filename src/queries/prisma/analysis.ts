import { uuid } from '@/lib/crypto';
import type { Prisma } from '@/generated/prisma/client';
import {
  type AnalysisDefinition,
  AnalysisError,
  hashDefinition,
  hashRequest,
} from '@/lib/analyst/definition';
import prisma from '@/lib/prisma';

export interface AnalysisFields {
  name: string;
  description?: string | null;
  status: 'draft' | 'ready';
  definition: AnalysisDefinition;
}

const pageSizeMax = 100;

export async function getAnalysis(analysisId: string) {
  return prisma.client.savedAnalysis.findUnique({ where: { id: analysisId } });
}

export async function getAnalysisRevision(analysisId: string, revision: number) {
  return prisma.client.savedAnalysisRevision.findUnique({
    where: { analysisId_revision: { analysisId, revision } },
  });
}

/** Owner-private analyses plus analyses of teams the user belongs to. */
export async function getUserAnalyses(
  userId: string,
  { page = 1, pageSize = 20 }: { page?: number; pageSize?: number } = {},
) {
  const take = Math.min(Math.max(1, pageSize), pageSizeMax);
  const memberships = await prisma.client.teamUser.findMany({
    where: { userId },
    select: { teamId: true },
  });
  const where: Prisma.SavedAnalysisWhereInput = {
    OR: [
      { userId, teamId: null },
      { teamId: { in: memberships.map(m => m.teamId) }, status: 'ready' },
    ],
  };
  const [data, count] = await Promise.all([
    prisma.client.savedAnalysis.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take,
      skip: take * (Math.max(1, page) - 1),
    }),
    prisma.client.savedAnalysis.count({ where }),
  ]);
  return { data, count, page, pageSize: take };
}

type Tx = Prisma.TransactionClient;

/**
 * Replays the stored result for the same principal/task/key and request; a different request
 * under the same key is a conflict. Runs `work` and records its result in the same transaction.
 */
async function idempotent<T extends object>(
  userId: string,
  taskId: string | null | undefined,
  key: string,
  request: unknown,
  work: (tx: Tx) => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const requestHash = hashRequest(request);
  const taskScope = taskId ?? '';
  const find = (tx: Tx | typeof prisma.client) =>
    tx.analysisOperation.findUnique({
      where: { userId_taskScope_key: { userId, taskScope, key } },
    });
  const replay = (existing: { requestHash: string; result: unknown }) => {
    if (existing.requestHash !== requestHash)
      throw new AnalysisError(
        'conflict',
        'Operation key was used with a different request',
        'operationKey',
      );
    return { result: existing.result as T, replayed: true };
  };
  const prior = await find(prisma.client);
  if (prior) return replay(prior);
  try {
    // SAFETY: both the base and replica-extended clients expose interactive $transaction with a
    // TransactionClient callback; the extension only widens the overload union TS can't narrow.
    const client = prisma.client as unknown as {
      $transaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R>;
    };
    return await client.$transaction(async tx => {
      const result = await work(tx);
      await tx.analysisOperation.create({
        data: {
          id: uuid(),
          userId,
          taskScope,
          key,
          requestHash,
          result: result as Prisma.InputJsonValue,
        },
      });
      return { result, replayed: false };
    });
  } catch (e: any) {
    // Concurrent same-key request won the unique index: replay or conflict, never duplicate.
    if (e?.code === 'P2002') {
      const winner = await find(prisma.client);
      if (winner) return replay(winner);
      // Otherwise the (analysis, revision) unique index rejected a concurrent writer: the
      // transaction rolled back, so this is a revision conflict, never a partial write.
      throw new AnalysisError(
        'conflict',
        'Analysis revision changed; reread before editing',
        'expectedRevision',
      );
    }
    throw e;
  }
}

function json(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

export async function createAnalysis(
  args: AnalysisFields & {
    userId: string;
    teamId?: string | null;
    taskId?: string | null;
    operationKey: string;
  },
) {
  const { userId, teamId = null, taskId = null, operationKey, ...fields } = args;
  return idempotent(userId, taskId, operationKey, { op: 'create', teamId, ...fields }, async tx => {
    const id = uuid();
    const definitionHash = hashDefinition(fields.definition);
    const row = await tx.savedAnalysis.create({
      data: {
        id,
        userId,
        teamId,
        name: fields.name,
        description: fields.description ?? null,
        schemaVersion: fields.definition.schemaVersion,
        revision: 1,
        status: fields.status,
        definition: fields.definition as Prisma.InputJsonValue,
        definitionHash,
        createdByTaskId: taskId,
      },
    });
    await tx.savedAnalysisRevision.create({
      data: {
        id: uuid(),
        analysisId: id,
        revision: 1,
        name: row.name,
        description: row.description,
        status: row.status,
        schemaVersion: row.schemaVersion,
        definition: row.definition as Prisma.InputJsonValue,
        definitionHash,
        userId,
      },
    });
    return json(row);
  });
}

/** Optimistic update: only succeeds when the stored revision equals `expectedRevision`. */
export async function updateAnalysis(
  analysisId: string,
  args: Partial<AnalysisFields> & {
    userId: string;
    expectedRevision: number;
    taskId?: string | null;
    operationKey: string;
  },
) {
  const { userId, expectedRevision, taskId = null, operationKey, ...patch } = args;
  return idempotent(
    userId,
    taskId,
    operationKey,
    { op: 'update', analysisId, expectedRevision, ...patch },
    async tx => {
      const current = await tx.savedAnalysis.findUnique({ where: { id: analysisId } });
      if (!current) throw new AnalysisError('not_found', 'Analysis not found');
      const definition = patch.definition ?? (current.definition as AnalysisDefinition);
      const definitionHash = hashDefinition(definition);
      const revision = expectedRevision + 1;
      const next = {
        name: patch.name ?? current.name,
        description: patch.description === undefined ? current.description : patch.description,
        status: patch.status ?? current.status,
        schemaVersion: definition.schemaVersion,
        definition: definition as Prisma.InputJsonValue,
        definitionHash,
      };
      // Compare-and-set inside the transaction: a concurrent writer leaves count 0.
      const { count } = await tx.savedAnalysis.updateMany({
        where: { id: analysisId, revision: expectedRevision },
        data: { ...next, revision },
      });
      if (count !== 1)
        throw new AnalysisError(
          'conflict',
          'Analysis revision changed; reread before editing',
          'expectedRevision',
        );
      await tx.savedAnalysisRevision.create({
        data: { id: uuid(), analysisId, revision, ...next, userId },
      });
      return json(await tx.savedAnalysis.findUniqueOrThrow({ where: { id: analysisId } }));
    },
  );
}

export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

export interface BundleAnalysis extends AnalysisFields {
  /** Caller-chosen reference; widgets point at it with `props.analysisRef`. */
  ref: string;
}

export interface BundleRequest {
  taskId?: string | null;
  /** Existing board to edit; requires `expectedRevision` and a matching confirmation. */
  boardId?: string;
  expectedRevision?: number;
  teamId?: string | null;
  board: { type: string; name: string; description?: string; parameters: any };
  analyses: BundleAnalysis[];
}

/** Hash of the exact change a confirmation approves (everything but key/confirmation id). */
export function hashBundle(request: BundleRequest) {
  return hashRequest({ op: 'bundle', ...request, taskId: request.taskId ?? null });
}

/** Replaces `analysisRef` widget props with the ids created in this bundle. */
export function resolveBundleRefs(parameters: any, ids: Record<string, string>) {
  return {
    ...parameters,
    rows: (parameters?.rows ?? []).map((row: any) => ({
      ...row,
      columns: (row.columns ?? []).map((column: any) => {
        const props = column.component?.props;
        if (!props || props.analysisRef === undefined) return column;
        const { analysisRef, ...rest } = props;
        if (!ids[analysisRef])
          throw new AnalysisError('invalid_definition', 'Unknown analysisRef', 'board.parameters');
        return {
          ...column,
          component: { ...column.component, props: { ...rest, analysisId: ids[analysisRef] } },
        };
      }),
    })),
  };
}

/** Records a trusted, single-use confirmation bound to principal/task/board/revision/diff. */
export async function createConfirmation(args: {
  userId: string;
  taskId?: string | null;
  boardId: string;
  expectedRevision: number;
  diffHash: string;
  now?: number;
}) {
  return prisma.client.analysisConfirmation.create({
    data: {
      id: uuid(),
      userId: args.userId,
      taskScope: args.taskId ?? '',
      boardId: args.boardId,
      expectedRevision: args.expectedRevision,
      diffHash: args.diffHash,
      expiresAt: new Date((args.now ?? Date.now()) + CONFIRMATION_TTL_MS),
    },
  });
}

/**
 * Atomic metadata bundle: creates the new analyses (with revision history) and creates or
 * compare-and-sets the board in one transaction, recorded under the principal/task/key so a
 * replay returns the same committed board. Editing an existing board consumes a matching,
 * unexpired confirmation in the same transaction; any failure rolls back every write.
 * Authorization and reference validation are the caller's responsibility (see bundle route).
 */
export async function commitBundle(
  request: BundleRequest & { userId: string; operationKey: string; confirmationId?: string },
) {
  const { userId, operationKey, confirmationId, ...bundle } = request;
  const taskId = bundle.taskId ?? null;
  const teamId = bundle.teamId ?? null;
  return idempotent(userId, taskId, operationKey, { ...bundle, confirmationId }, async tx => {
    if (bundle.boardId) {
      if (!confirmationId)
        throw new AnalysisError('denied', 'A matching confirmation is required', 'confirmationId');
      // Single-use: the conditional update is the claim; a reused/stale/foreign grant leaves 0.
      const { count } = await tx.analysisConfirmation.updateMany({
        where: {
          id: confirmationId,
          userId,
          taskScope: taskId ?? '',
          boardId: bundle.boardId,
          expectedRevision: bundle.expectedRevision,
          diffHash: hashBundle(bundle),
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      });
      if (count !== 1)
        throw new AnalysisError('denied', 'A matching confirmation is required', 'confirmationId');
    }
    const ids: Record<string, string> = {};
    const analyses = [];
    for (const { ref, ...fields } of bundle.analyses) {
      const id = uuid();
      ids[ref] = id;
      const definitionHash = hashDefinition(fields.definition);
      const data = {
        name: fields.name,
        description: fields.description ?? null,
        status: fields.status,
        schemaVersion: fields.definition.schemaVersion,
        definition: fields.definition as Prisma.InputJsonValue,
        definitionHash,
      };
      analyses.push(
        await tx.savedAnalysis.create({
          data: { id, userId, teamId, revision: 1, createdByTaskId: taskId, ...data },
        }),
      );
      await tx.savedAnalysisRevision.create({
        data: { id: uuid(), analysisId: id, revision: 1, userId, ...data },
      });
    }
    const parameters = resolveBundleRefs(bundle.board.parameters, ids);
    const fields = {
      type: bundle.board.type,
      name: bundle.board.name,
      description: bundle.board.description ?? '',
      parameters,
    };
    let boardId = bundle.boardId;
    if (boardId) {
      const { count } = await tx.board.updateMany({
        where: { id: boardId, revision: bundle.expectedRevision },
        data: { ...fields, revision: { increment: 1 } },
      });
      if (count !== 1)
        throw new AnalysisError(
          'conflict',
          'Board revision changed; reread and reconfirm',
          'expectedRevision',
        );
    } else {
      boardId = uuid();
      await tx.board.create({
        data: { id: boardId, ...fields, userId: teamId ? null : userId, teamId },
      });
    }
    const board = await tx.board.findUniqueOrThrow({ where: { id: boardId } });
    return json({ board, analyses });
  });
}
