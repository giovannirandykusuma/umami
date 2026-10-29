import { z } from 'zod';
import { ENTITY_TYPE } from '@/lib/constants';
import { uuid } from '@/lib/crypto';
import { getRandomChars } from '@/lib/generate';
import { parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { anyObjectParam, filterParams, pagingParams } from '@/lib/schema';
import { canUpdateBoard, canViewBoard } from '@/permissions';
import { getAnalysisWidgets } from '@/permissions/board';
import { createShare, getBoard, getSharesByEntityId } from '@/queries/prisma';

export async function GET(request: Request, { params }: { params: Promise<{ boardId: string }> }) {
  const schema = z.object({
    ...filterParams,
    ...pagingParams,
  });

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { boardId } = await params;
  const { page, pageSize, search } = query;

  if (!(await canViewBoard(auth, boardId))) {
    return unauthorized();
  }

  const data = await getSharesByEntityId(boardId, {
    page,
    pageSize,
    search,
  });

  return json(data);
}

export async function POST(request: Request, { params }: { params: Promise<{ boardId: string }> }) {
  const schema = z.object({
    name: z.string().max(200),
    parameters: anyObjectParam.optional(),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { boardId } = await params;
  const { name, parameters } = body;
  const shareParameters = parameters ?? {};

  if (!(await canUpdateBoard(auth, boardId))) {
    return unauthorized();
  }

  const board = await getBoard(boardId);

  // No secure public execution contract exists for saved analyses: refuse, never strip widgets.
  if (getAnalysisWidgets(board?.parameters as any).length) {
    return Response.json(
      {
        error: {
          message: 'Boards with analysis widgets cannot be shared yet.',
          code: 'unsupported_sharing',
          status: 422,
        },
      },
      { status: 422 },
    );
  }

  const share = await createShare({
    id: uuid(),
    entityId: boardId,
    shareType: ENTITY_TYPE.board,
    name,
    slug: getRandomChars(16),
    parameters: shareParameters,
  });

  return json(share);
}
