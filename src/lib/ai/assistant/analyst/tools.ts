import { createHash, randomUUID } from 'node:crypto';
import { getResolvedComponentEntity } from '@/lib/boards';
import { z } from 'zod';
import {
  AnalysisError,
  COMPATIBILITY,
  hashDefinition,
  hashRequest,
  normalizeDefinition,
  RENDERERS,
  type AnalysisDefinition,
} from '@/lib/analyst/definition';
import type { Auth } from '@/lib/types';
import type { AssistantPart } from '../protocol';
import type { Interaction } from '../tools';
import {
  block,
  consume,
  getTask,
  ISSUES,
  pause,
  remainingMs,
  resume,
  TASK_LIMITS,
  TaskError,
  updateTask,
  updateTaskInTx,
  type Receipt,
  type Task,
  type TaskScope,
  type TaskState,
} from './task';
import { sanitize } from './sanitize';
import { TaskFenceError } from '@/queries/prisma/analysis';

export const ANALYST_TOOLS = [
  'analyst_discover',
  'analyst_preview',
  'analyst_plan_board',
  'analyst_commit_draft',
  'analyst_readback',
  'analyst_verify_render',
  'analyst_record_inspection',
  'analyst_request_change',
] as const;
export type AnalystToolName = (typeof ANALYST_TOOLS)[number];

const IMAGE_LIMIT = 1024 * 1024;
const JOB_IMAGE_LIMIT = 6 * IMAGE_LIMIT;
const RESULT_BYTES = 32 * 1024;

/** Host-only verifier port. Capabilities/URLs stay inside it; the model never supplies them. */
export interface VerifierPort {
  render(input: {
    scope: {
      userId: string;
      taskId: string;
      boardId: string;
      boardRevision: number;
      analysisRevisions: Record<string, number>;
    };
    expectedWidgets: { id: string; executionId: string; definitionHash: string }[];
    signal: AbortSignal;
  }): Promise<{
    artifactId: string;
    receipt: {
      boardRevision: number;
      completedAt: string;
      views: {
        viewport: { width: number; height: number };
        hash: string;
        offset: number;
        widgets: { id: string; state: string }[];
      }[];
    };
  }>;
  fetch(
    artifactId: string,
    principal: { userId: string; taskId: string },
  ): Promise<{ bytes: Buffer; mime: string; hash: string }[]>;
  discard(artifactId: string): void;
  cleanup(scope: { userId: string; taskId: string }): void;
}

export interface AnalystDeps {
  listWebsites(auth: Auth): Promise<{ id: string; name: string }[]>;
  listBoards(auth: Auth): Promise<{ id: string; name: string; revision: number }[]>;
  listAnalyses(
    auth: Auth,
  ): Promise<{ id: string; name: string; revision: number; definitionHash: string }[]>;
  dateRange(
    auth: Auth,
    websiteId: string,
  ): Promise<{ startAt: number | null; endAt: number | null }>;
  execute(
    auth: Auth,
    definition: AnalysisDefinition,
    options: { now: number; signal: AbortSignal; saved?: any },
  ): Promise<any>;
  getBoard(boardId: string): Promise<{
    id: string;
    revision: number;
    userId: string | null;
    teamId: string | null;
    parameters: any;
  } | null>;
  canUpdateBoard(auth: Auth, boardId: string): Promise<boolean>;
  canViewBoard(auth: Auth, boardId: string): Promise<boolean>;
  getAnalysis(id: string): Promise<{
    id: string;
    revision: number;
    definitionHash: string;
    definition: unknown;
    userId: string;
    teamId: string | null;
    status: string;
  } | null>;
  canViewAnalysis(auth: Auth, analysis: any): Promise<boolean>;
  validateBundle(auth: Auth, body: unknown): Promise<any>;
  hashBundle(bundle: any): string;
  commitBundle(
    request: any,
    fence: {
      chatId: string;
      signal?: AbortSignal;
      record: (tx: any, result: any) => Promise<void>;
    },
  ): Promise<{ result: any; replayed: boolean }>;
  /** Trusted internal issuer; called only after the host-owned approval below. */
  issueConfirmation(auth: Auth, body: unknown): Promise<{ id: string }>;
  verifier: VerifierPort | null;
}

export interface AnalystInput {
  auth: Auth;
  scope: TaskScope;
  interaction: Interaction;
  deps: AnalystDeps;
  /** Host-side query concurrency counter shared across one task's tool calls. */
  running?: { queries: number };
  now?: () => number;
}

/** Images are never part of the JSON result; the runtime transports them separately. */
export interface AnalystResult {
  json: unknown;
  images?: { mime: string; data: string; hash: string }[];
}

const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
  ok: false,
  code,
  message,
  retryable: false,
  isError: true,
  ...extra,
});

const definitionArg = z.unknown();
const bundleArgs = z
  .object({
    boardId: z.uuid().optional(),
    expectedRevision: z.number().int().positive().optional(),
    board: z
      .object({
        type: z.literal('mixed'),
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
            definition: definitionArg,
          })
          .strict(),
      )
      .max(TASK_LIMITS.widgets),
  })
  .strict();
const repairArg = z
  .object({ widgetId: z.string().min(1).max(64), reason: z.string().min(1).max(300) })
  .strict();
const schemas: Record<AnalystToolName, z.ZodType> = {
  analyst_discover: z.object({ websiteId: z.uuid().optional() }).strict(),
  analyst_preview: z.object({ definition: definitionArg }).strict(),
  analyst_plan_board: bundleArgs,
  analyst_commit_draft: bundleArgs.extend({
    operationKey: z.string().min(1).max(200),
    repair: repairArg.optional(),
  }),
  analyst_readback: z.object({ boardId: z.uuid() }).strict(),
  analyst_verify_render: z.object({ boardId: z.uuid(), rerender: z.boolean().optional() }).strict(),
  analyst_record_inspection: z
    .object({
      receiptId: z.uuid(),
      observations: z
        .array(
          z
            .object({
              widgetId: z.string().min(1).max(64),
              hash: z.string().regex(/^[0-9a-f]{64}$/),
              issue: z.enum(ISSUES),
              note: z.string().max(500),
            })
            .strict(),
        )
        .min(1)
        .max(72),
    })
    .strict(),
  analyst_request_change: bundleArgs.extend({
    boardId: z.uuid(),
    expectedRevision: z.number().int().positive(),
  }),
};

/**
 * Meaning-bearing fields only. A repair may change presentation (unit, top-N, label text) but
 * never source, operation, metric, event, filters, property, dates, timezone or population.
 */
export function semanticsHash(definition: AnalysisDefinition) {
  return hashRequest({
    source: definition.source,
    operation: definition.operation,
    metric: definition.metric,
    event: definition.event,
    filters: definition.filters,
    propertyFilters: definition.propertyFilters,
    property: definition.property,
    groupBy: definition.groupBy?.dimension,
    datePolicy: definition.datePolicy,
    timezone: definition.timezone,
    population: definition.semanticBinding.population,
    meaningSource: definition.semanticBinding.meaningSource,
  });
}

function widgets(parameters: any) {
  return ((parameters?.rows ?? []) as any[]).flatMap(row =>
    ((row?.columns ?? []) as any[]).filter(column => column?.component),
  );
}

function withTimeout<T>(
  signal: AbortSignal,
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, ms);
  return work(controller.signal).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  });
}

function boundedJson(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > RESULT_BYTES)
    throw new AnalysisError('result_too_large', 'Result exceeds 32 KiB; narrow the query');
  return value;
}

async function runQuery(input: AnalystInput, definition: AnalysisDefinition, saved?: any) {
  const running = input.running ?? { queries: 0 };
  if (running.queries >= TASK_LIMITS.concurrentQueries)
    return fail('budget_exhausted', 'At most 3 concurrent query executions per task', {
      retryable: true,
    });
  await consume(input.scope, 'analytics');
  running.queries++;
  try {
    const envelope = await withTimeout(input.interaction.signal, 10_000, signal =>
      input.deps.execute(input.auth, definition, {
        now: (input.now ?? Date.now)(),
        signal,
        ...(saved ? { saved } : {}),
      }),
    );
    return { ok: true, data: boundedJson(envelope) };
  } finally {
    running.queries--;
  }
}

async function normalizeBundle(input: AnalystInput, args: z.infer<typeof bundleArgs>, task: Task) {
  if (widgets(args.board.parameters).length > TASK_LIMITS.widgets)
    throw new AnalysisError(
      'invalid_definition',
      'At most 12 widgets per board',
      'board.parameters',
    );
  // The host binds the task; any taskId/teamId/principal field from the model is rejected above.
  const bundle = await input.deps.validateBundle(input.auth, {
    ...args,
    taskId: task.id,
    analyses: args.analyses.map(a => ({ ...a, status: 'draft' })),
  });
  return bundle;
}

function diffSummary(before: any, bundle: any) {
  const old = new Map(widgets(before?.parameters).map(w => [w.id, w.component]));
  const next = new Map(widgets(bundle.board.parameters).map(w => [w.id, w.component]));
  const changed = (id: string) => JSON.stringify(old.get(id)) !== JSON.stringify(next.get(id));
  return {
    added: [...next.keys()].filter(id => !old.has(id)),
    removed: [...old.keys()].filter(id => !next.has(id)),
    changed: [...next.keys()].filter(id => old.has(id) && changed(id)),
    newAnalyses: bundle.analyses.map((a: any) => ({
      ref: a.ref,
      source: a.definition.source.websiteId,
      operation: a.definition.operation,
      metric: a.definition.metric,
      datePolicy: a.definition.datePolicy,
      timezone: a.definition.timezone,
    })),
  };
}

/**
 * Repair policy, keyed by stable board/widget identity rather than model-chosen analysis refs:
 * a widget's replacement definition must preserve semantics, dropping a committed widget is a
 * semantic change, and every changed widget needs repair provenance naming it.
 */
function versionsFor(
  task: Task,
  bundle: any,
  boardId: string | undefined,
  repair?: { widgetId: string; reason: string },
) {
  const versions = [...task.definitionVersions];
  const latest = new Map<string, (typeof versions)[number]>();
  if (boardId)
    for (const v of versions) if (v.boardId === boardId && v.widgetId) latest.set(v.widgetId, v);
  const byRef = new Map(bundle.analyses.map((a: any) => [a.ref, a]));
  let semanticChange = false;
  const changedWidgets: string[] = [];
  const seen = new Set<string>();
  for (const w of widgets(bundle.board.parameters)) {
    const a: any = byRef.get(w.component?.props?.analysisRef);
    if (!a) continue;
    seen.add(w.id);
    const hash = hashDefinition(a.definition);
    const semantics = semanticsHash(a.definition);
    const prior = latest.get(w.id);
    if (prior && prior.semantics !== semantics) semanticChange = true;
    if (prior && prior.hash === hash) continue;
    if (prior) changedWidgets.push(w.id);
    versions.push({
      ref: a.ref,
      ...(boardId ? { boardId } : {}),
      widgetId: w.id,
      hash,
      semantics,
      ...(prior ? { previousHash: prior.hash } : {}),
      ...(prior && repair ? { repair } : {}),
    });
  }
  // A committed widget that disappears (e.g. renamed id/ref) is a replacement, not a repair.
  for (const id of latest.keys()) if (!seen.has(id)) semanticChange = true;
  return {
    versions: versions.slice(-60),
    semanticChange,
    changed: changedWidgets.length > 0,
    changedWidgets,
  };
}

/** Mutation boundary: a cancelled turn or inactive task must never grant or write. */
async function interrupted(input: AnalystInput) {
  if (input.interaction.signal.aborted) return fail('cancelled', 'Turn cancelled; nothing written');
  const task = await getTask(input.scope);
  if (input.interaction.signal.aborted) return fail('cancelled', 'Turn cancelled; nothing written');
  if (!task || !['running', 'awaiting_user'].includes(task.status))
    return fail('task_blocked', `Task is ${task?.status ?? 'missing'}`);
  return null;
}

/** Trusted task fence carried into the commit transaction (never model-supplied). */
const fence = (input: AnalystInput, record: (result: any) => (task: Task) => TaskState) => ({
  chatId: input.scope.chatId,
  signal: input.interaction.signal,
  record: (tx: any, result: any) => updateTaskInTx(tx, input.scope, record(result)),
});

async function commitDraft(input: AnalystInput, args: any, task: Task) {
  const own = args.boardId ? task.draftIds.find(d => d.boardId === args.boardId) : undefined;
  if (args.boardId && !own)
    return fail(
      'confirmation_required',
      'This board existed before the task; use analyst_request_change',
    );
  if (!args.boardId && task.draftIds.length >= TASK_LIMITS.widgets)
    return fail('budget_exhausted', 'Draft board limit reached for this task');
  const bundle = await normalizeBundle(input, args, task);
  const { versions, semanticChange, changed, changedWidgets } = versionsFor(
    task,
    bundle,
    own?.boardId,
    args.repair,
  );
  if (semanticChange)
    return fail(
      'semantic_change',
      'A repair cannot change source, metric, event, filters, dates or population; ask the user',
    );
  if (changed && !args.repair)
    return fail('repair_required', 'Changing a committed definition requires repair provenance');
  if (args.repair && !changedWidgets.includes(args.repair.widgetId))
    return fail('invalid_arguments', 'Repair must name a changed widget of this draft');
  const stop = await interrupted(input);
  if (stop) return stop;
  if (args.repair) {
    try {
      await consume(input.scope, 'repairs');
    } catch (error) {
      if (error instanceof TaskError && error.code === 'budget_exhausted') {
        await block(input.scope, 'repair_limit');
        return fail('repair_limit', 'Two repairs failed; report an honest partial result');
      }
      throw error;
    }
  }
  let confirmationId: string | undefined;
  if (own) {
    // Spec §3.3: a task may revise only its own unchanged private draft. Any revision or
    // visibility drift since its own commit needs a new human confirmation instead.
    const board = await input.deps.getBoard(own.boardId);
    if (
      !board ||
      board.revision !== own.revision ||
      args.expectedRevision !== own.revision ||
      board.teamId !== null ||
      board.userId !== input.scope.userId
    )
      return fail('conflict', 'Draft changed outside this task; reread and request a change');
    const halt = await interrupted(input);
    if (halt) return halt;
    confirmationId = (
      await input.deps.issueConfirmation(input.auth, {
        taskId: task.id,
        boardId: own.boardId,
        expectedRevision: own.revision,
        board: args.board,
        analyses: args.analyses.map((a: any) => ({ ...a, status: 'draft' })),
      })
    ).id;
  }
  const late = await interrupted(input);
  if (late) return late;
  // Provenance is recorded inside the commit transaction under the task row lock: if the
  // commit wins, its provenance is already durable before any cancel can apply; if a cancel
  // wins, nothing (bundle or provenance) is written. No post-commit task write exists.
  const record = (result: any) => (current: Task) => {
    const ids = (result.analyses ?? []).map((a: any) => a.id);
    return {
      ...current,
      operationKeys: [...new Set([...current.operationKeys, args.operationKey])].slice(-200),
      draftIds: [
        ...current.draftIds.filter(d => d.boardId !== result.board.id),
        {
          boardId: result.board.id,
          revision: result.board.revision,
          analysisIds: [
            ...new Set([
              ...(current.draftIds.find(d => d.boardId === result.board.id)?.analysisIds ?? []),
              ...ids,
            ]),
          ].slice(-12),
        },
      ],
      definitionVersions: versions.map(v => {
        if (v.boardId && v.boardId !== result.board.id) return v;
        const index = bundle.analyses.findIndex((a: any) => a.ref === v.ref);
        const bound = { ...v, boardId: result.board.id };
        return v.analysisId || index < 0 || !ids[index]
          ? bound
          : { ...bound, analysisId: ids[index] };
      }),
    };
  };
  const { result, replayed } = await input.deps.commitBundle(
    {
      ...bundle,
      userId: input.scope.userId,
      operationKey: args.operationKey,
      ...(confirmationId ? { confirmationId } : {}),
    },
    fence(input, record),
  );
  return {
    ok: true,
    replayed,
    board: { id: result.board.id, revision: result.board.revision },
    analyses: (result.analyses ?? []).map((a: any) => ({
      id: a.id,
      revision: a.revision,
      definitionHash: a.definitionHash,
    })),
  };
}

async function requestChange(input: AnalystInput, args: any, task: Task) {
  if (task.draftIds.some(d => d.boardId === args.boardId))
    return fail('invalid_arguments', 'Use analyst_commit_draft for this task’s own draft');
  const board = await input.deps.getBoard(args.boardId);
  if (!board || !(await input.deps.canUpdateBoard(input.auth, args.boardId)))
    return fail('not_found', 'Board not found');
  if (board.revision !== args.expectedRevision)
    return fail('conflict', 'Board revision changed; reread before requesting a change');
  const bundle = await normalizeBundle(input, args, task);
  const diff = diffSummary(board, bundle);
  const diffHash = input.deps.hashBundle(bundle);
  const part: AssistantPart = {
    type: 'confirm',
    id: randomUUID(),
    title: `Edit board ${board.id} (revision ${board.revision})`.slice(0, 200),
    message: JSON.stringify({
      target: board.id,
      expectedRevision: board.revision,
      diffHash,
      ...diff,
    }).slice(0, 4000),
    state: 'pending',
  };
  await pause(input.scope);
  let answer;
  try {
    answer = await input.interaction.wait(part);
  } finally {
    await resume(input.scope);
  }
  const accepted = answer?.kind === 'confirm' && answer.confirmed === true;
  input.interaction.emit({
    ...part,
    state: accepted ? 'confirmed' : answer ? 'rejected' : 'expired',
  });
  if (!accepted) return fail('denied', 'User did not confirm; nothing was changed');
  // Revalidate authority after the wait; a stale revision needs reread and reconfirmation.
  const current = await input.deps.getBoard(args.boardId);
  if (!current || current.revision !== args.expectedRevision)
    return fail('conflict', 'Board revision changed; reread and reconfirm');
  const halt = await interrupted(input);
  if (halt) return halt;
  const confirmation = await input.deps.issueConfirmation(input.auth, {
    taskId: task.id,
    boardId: args.boardId,
    expectedRevision: args.expectedRevision,
    board: args.board,
    analyses: args.analyses.map((a: any) => ({ ...a, status: 'draft' })),
  });
  const operationKey = `change:${diffHash}`;
  const late = await interrupted(input);
  if (late) return late;
  const { result } = await input.deps.commitBundle(
    {
      ...bundle,
      userId: input.scope.userId,
      operationKey,
      confirmationId: confirmation.id,
    },
    fence(input, () => (t: Task) => ({
      ...t,
      operationKeys: [...new Set([...t.operationKeys, operationKey])].slice(-200),
    })),
  );
  return { ok: true, board: { id: result.board.id, revision: result.board.revision }, diffHash };
}

async function readback(input: AnalystInput, args: { boardId: string }, task: Task) {
  if (!(await input.deps.canViewBoard(input.auth, args.boardId)))
    return fail('not_found', 'Board not found');
  const board = await input.deps.getBoard(args.boardId);
  if (!board) return fail('not_found', 'Board not found');
  const analyses = [];
  for (const w of widgets(board.parameters)) {
    const id = w.component?.props?.analysisId;
    if (typeof id !== 'string') continue;
    const analysis = await input.deps.getAnalysis(id);
    if (!analysis || !(await input.deps.canViewAnalysis(input.auth, analysis))) {
      analyses.push({ widgetId: w.id, analysisId: id, state: 'denied' });
      continue;
    }
    const intended = task.definitionVersions.filter(v => v.analysisId === id).at(-1);
    const definition = normalizeDefinition(analysis.definition);
    const execution = await runQuery(input, definition, {
      id: analysis.id,
      revision: analysis.revision,
      definitionHash: analysis.definitionHash,
    });
    analyses.push({
      widgetId: w.id,
      analysisId: id,
      revision: analysis.revision,
      definitionHash: analysis.definitionHash,
      matchesIntent: intended ? intended.hash === analysis.definitionHash : null,
      execution: execution.ok
        ? {
            executionId: (execution as any).data.executionId,
            completeness: (execution as any).data.completeness,
            returned: (execution as any).data.counts?.returned,
          }
        : execution,
    });
  }
  return {
    ok: true,
    data: boundedJson({ board: { id: board.id, revision: board.revision }, analyses }),
  };
}

async function verifyRender(
  input: AnalystInput,
  args: { boardId: string; rerender?: boolean },
  task: Task,
): Promise<AnalystResult> {
  const own = task.draftIds.find(d => d.boardId === args.boardId);
  if (!own && !(await input.deps.canViewBoard(input.auth, args.boardId)))
    return { json: fail('not_found', 'Board not found') };
  await consume(input.scope, args.rerender ? 'rerenders' : 'renders');
  // No automatic host-browser fallback: without the isolated verifier the status stays pending.
  if (!input.deps.verifier)
    return {
      json: fail('verifier_unavailable', 'Visual verification is unavailable; data checks only', {
        visualStatus: 'visual_pending',
      }),
    };
  const board = await input.deps.getBoard(args.boardId);
  if (!board) return { json: fail('not_found', 'Board not found') };
  const analysisRevisions: Record<string, number> = {};
  const expectedWidgets = [];
  for (const w of widgets(board.parameters)) {
    if (w.component?.type === 'WebsiteMetricsBar') {
      const { entityType, entityId } = getResolvedComponentEntity(board as any, w.component);
      if (entityType !== 'website' || !entityId)
        return { json: fail('unsupported_combination', 'Native source is unsupported') };
      const definitionHash = createHash('sha256').update(JSON.stringify({
        type: w.component.type, entityId, datePolicy: 'default-UTC', props: w.component.props ?? {},
      })).digest('hex');
      expectedWidgets.push({ id: w.id, executionId: '', definitionHash });
      continue;
    }
    const id = w.component?.props?.analysisId;
    if (w.component?.type !== 'AnalysisWidget' || typeof id !== 'string')
      return { json: fail('unsupported_combination', 'Widget is unsupported by the verifier') };
    const analysis = await input.deps.getAnalysis(id);
    if (!analysis || !(await input.deps.canViewAnalysis(input.auth, analysis)))
      return { json: fail('not_found', 'Analysis not found') };
    analysisRevisions[id] = analysis.revision;
    expectedWidgets.push({ id: w.id, executionId: '', definitionHash: analysis.definitionHash });
  }
  let rendered;
  try {
    rendered = await input.deps.verifier.render({
      scope: {
        userId: input.scope.userId,
        taskId: task.id,
        boardId: board.id,
        boardRevision: board.revision,
        analysisRevisions,
      },
      expectedWidgets,
      signal: input.interaction.signal,
    });
  } catch {
    return {
      json: fail('verifier_unavailable', 'Render failed or was revoked', {
        visualStatus: 'visual_pending',
      }),
    };
  }
  const { verifier } = input.deps;
  try {
    const images = await verifier.fetch(rendered.artifactId, {
      userId: input.scope.userId,
      taskId: task.id,
    });
    const total = images.reduce((n, i) => n + i.bytes.length, 0);
    if (
      images.length > 6 ||
      total > JOB_IMAGE_LIMIT ||
      images.some(
        i => i.bytes.length > IMAGE_LIMIT || !['image/png', 'image/jpeg'].includes(i.mime),
      )
    )
      return { json: fail('image_budget', 'Screenshot payload exceeds limits') };
    const receipt: Receipt = {
      id: randomUUID(),
      boardId: board.id,
      boardRevision: rendered.receipt.boardRevision,
      analysisRevisions,
      status: 'rendered_not_inspected',
      completedAt: String(rendered.receipt.completedAt).slice(0, 40),
      views: rendered.receipt.views.map(v => ({
        hash: v.hash,
        width: v.viewport.width,
        height: v.viewport.height,
        offset: v.offset,
        widgets: v.widgets.map(w => ({ id: w.id, state: w.state as any })),
      })),
      inspections: [],
    };
    await updateTask(input.scope, t => ({
      ...t,
      budgets: { ...t.budgets, imageBytes: t.budgets.imageBytes + total },
      receipts: [...t.receipts, receipt].slice(-10),
    }));
    return {
      json: { ok: true, receipt, images: images.map(i => ({ hash: i.hash, mime: i.mime })) },
      images: images.map(i => ({ mime: i.mime, hash: i.hash, data: i.bytes.toString('base64') })),
    };
  } finally {
    // Pixels are delivered once; reinspection requires a newly authorized render.
    verifier.discard(rendered.artifactId);
  }
}

async function recordInspection(input: AnalystInput, args: any) {
  let error: string | undefined;
  await updateTask(input.scope, task => {
    const receipt = task.receipts.find(r => r.id === args.receiptId);
    if (!receipt) {
      error = 'Unknown receipt';
      return task;
    }
    for (const o of args.observations) {
      const view = receipt.views.find(v => v.hash === o.hash);
      if (!view || !view.widgets.some(w => w.id === o.widgetId)) {
        error = 'Observation must cite a widget in the cited screenshot';
        return task;
      }
    }
    const next: Receipt = {
      ...receipt,
      status: 'inspected',
      inspections: [...receipt.inspections, ...args.observations].slice(-72),
    };
    return { ...task, receipts: task.receipts.map(r => (r.id === receipt.id ? next : r)) };
  });
  return error ? fail('invalid_arguments', error) : { ok: true, status: 'inspected' };
}

async function discover(input: AnalystInput, args: { websiteId?: string }) {
  const websites = await input.deps.listWebsites(input.auth);
  if (args.websiteId && !websites.some(w => w.id === args.websiteId))
    return fail('not_found', 'Website not found');
  return {
    ok: true,
    data: boundedJson({
      websites: websites.slice(0, 100).map(w => ({ id: w.id, name: w.name })),
      ...(args.websiteId
        ? { coverage: await input.deps.dateRange(input.auth, args.websiteId) }
        : {}),
      capabilities: { metrics: COMPATIBILITY, renderers: RENDERERS },
      analyses: (await input.deps.listAnalyses(input.auth)).slice(0, 50),
      boards: (await input.deps.listBoards(input.auth)).slice(0, 50),
    }),
  };
}

/** Executes one analyst tool bound to the trusted task scope. Structured failures, never throws. */
export async function executeAnalystTool(
  name: AnalystToolName,
  rawArgs: unknown,
  input: AnalystInput,
): Promise<AnalystResult> {
  try {
    const parsed = schemas[name].safeParse(rawArgs);
    if (!parsed.success) return { json: fail('invalid_arguments', 'Invalid tool arguments') };
    const args: any = parsed.data;
    const task = await getTask(input.scope);
    if (!task) return { json: fail('not_found', 'Task not found') };
    const now = (input.now ?? Date.now)();
    if (!['running', 'awaiting_user'].includes(task.status))
      return { json: fail('task_blocked', `Task is ${task.status}`, { status: task.status }) };
    if (task.expiresAt.getTime() <= now || remainingMs(task, now) <= 0) {
      await block(input.scope, 'deadline');
      return { json: fail('deadline', 'Task execution window exhausted') };
    }
    await consume(input.scope, 'toolCalls', now);
    switch (name) {
      case 'analyst_discover':
        return { json: await discover(input, args) };
      case 'analyst_preview': {
        const definition = normalizeDefinition(args.definition);
        return { json: await runQuery(input, definition) };
      }
      case 'analyst_plan_board': {
        const bundle = await normalizeBundle(input, args, task);
        const before = args.boardId ? await input.deps.getBoard(args.boardId) : null;
        return {
          json: {
            ok: true,
            diff: diffSummary(before, bundle),
            requiresConfirmation:
              !!args.boardId && !task.draftIds.some(d => d.boardId === args.boardId),
            unsupported: [],
          },
        };
      }
      case 'analyst_commit_draft':
        return { json: await commitDraft(input, args, task) };
      case 'analyst_readback':
        return { json: await readback(input, args, task) };
      case 'analyst_verify_render':
        return await verifyRender(input, args, task);
      case 'analyst_record_inspection':
        return { json: await recordInspection(input, args) };
      case 'analyst_request_change':
        return { json: await requestChange(input, args, task) };
    }
  } catch (error) {
    if (error instanceof TaskFenceError)
      return { json: fail('cancelled', 'Task cancelled or inactive; nothing written') };
    if (error instanceof TaskError)
      return {
        json: fail(error.code, error.message, {
          retryable: false,
          ...(error.code === 'budget_exhausted' || error.code === 'deadline'
            ? { status: 'blocked' }
            : {}),
        }),
      };
    if (error instanceof AnalysisError)
      return {
        json: sanitize(fail(error.code, error.message, error.field ? { path: error.field } : {})),
      };
    return { json: fail('failed', 'Tool failed') };
  }
}
