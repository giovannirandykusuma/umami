import { z } from 'zod';
import { isAnalystEnabled } from '@/lib/analyst/flags';
import { parseRequest } from '@/lib/request';
import { json, notFound } from '@/lib/response';

/** Sanitized, principal-bound task status: budgets, drafts, receipts. No images or capabilities. */
export async function GET(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { auth, error } = await parseRequest(request);
  if (error) return error();
  if (!isAnalystEnabled() || !auth?.user?.id) return notFound();
  const { taskId } = await params;
  if (!z.uuid().safeParse(taskId).success) return notFound();
  const { getUserTask, remainingMs, TASK_LIMITS } = await import('@/lib/ai/assistant/analyst/task');
  const task = await getUserTask(auth.user.id, taskId);
  if (!task) return notFound();
  return json({
    id: task.id,
    chatId: task.chatId,
    status: task.status,
    blockedReason: task.context.blockedReason ?? null,
    limits: TASK_LIMITS,
    consumed: task.budgets.consumed,
    remainingMs: Math.max(0, remainingMs(task)),
    expiresAt: task.expiresAt.toISOString(),
    drafts: task.draftIds,
    receipts: task.receipts.map(r => ({
      id: r.id,
      boardId: r.boardId,
      boardRevision: r.boardRevision,
      status: r.status,
      views: r.views.map(v => ({ hash: v.hash, width: v.width, height: v.height })),
    })),
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
