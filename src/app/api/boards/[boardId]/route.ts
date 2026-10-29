import { z } from 'zod';
import { BOARD_TYPES, normalizeBoardType } from '@/lib/boards';
import type { BoardParameters } from '@/lib/types';
import { parseRequest } from '@/lib/request';
import { badRequest, json, ok, serverError, unauthorized } from '@/lib/response';
import {
  canDeleteBoard,
  canUpdateBoard,
  canViewBoard,
  canViewBoardEntities,
  hasValidBoardReports,
} from '@/permissions';
import { getInvalidBoardAnalysis } from '@/permissions/board';
import { deleteBoard, getBoard, updateBoard } from '@/queries/prisma';
import { updateBoardAtRevision } from '@/queries/prisma/board';

export async function GET(request: Request, { params }: { params: Promise<{ boardId: string }> }) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { boardId } = await params;

  if (!(await canViewBoard(auth, boardId))) {
    return unauthorized();
  }

  const board = await getBoard(boardId);

  return json(board);
}

export async function POST(request: Request, { params }: { params: Promise<{ boardId: string }> }) {
  const schema = z.object({
    type: z
      .enum([
        BOARD_TYPES.dashboard,
        BOARD_TYPES.mixed,
        BOARD_TYPES.website,
        BOARD_TYPES.pixel,
        BOARD_TYPES.link,
      ])
      .or(z.literal('open'))
      .optional(),
    name: z.string().max(200).optional(),
    description: z.string().max(500).optional(),
    parameters: z.object({}).passthrough().optional(),
    // Optional for legacy clients; lifecycle callers send it for compare-and-set.
    expectedRevision: z.number().int().positive().optional(),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { boardId } = await params;
  const { name, description, parameters } = body;
  const type = normalizeBoardType(body.type);

  if (!(await canUpdateBoard(auth, boardId))) {
    return unauthorized();
  }

  if (type !== undefined || parameters !== undefined) {
    const currentBoard = await getBoard(boardId);

    if (!currentBoard) {
      return unauthorized();
    }

    const nextType = type ?? currentBoard.type;
    const nextParameters = (parameters ?? currentBoard.parameters) as BoardParameters;

    if (!(await canViewBoardEntities(auth, nextType, nextParameters))) {
      return badRequest({ message: 'Board contains inaccessible entities.' });
    }

    if (!(await hasValidBoardReports(nextType, nextParameters))) {
      return badRequest({ message: 'Board contains invalid saved reports.' });
    }

    const analysisError = await getInvalidBoardAnalysis(auth, currentBoard, nextParameters);

    if (analysisError) {
      return badRequest({ message: analysisError });
    }
  }

  try {
    const data = { type, name, description, parameters };

    if (body.expectedRevision !== undefined) {
      const board = await updateBoardAtRevision(boardId, body.expectedRevision, data);

      if (!board) {
        return Response.json(
          { error: { message: 'Board revision changed.', code: 'conflict', status: 409 } },
          { status: 409 },
        );
      }

      return Response.json(board);
    }

    const board = await updateBoard(boardId, data);

    return Response.json(board);
  } catch (e: any) {
    return serverError(e);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ boardId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { boardId } = await params;

  if (!(await canDeleteBoard(auth, boardId))) {
    return unauthorized();
  }

  await deleteBoard(boardId);

  return ok();
}
