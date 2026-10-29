import { z } from 'zod';
import { analysisErrorResponse, disabledResponse, isAnalystEnabled } from '@/lib/analyst/http';
import { parseRequest } from '@/lib/request';
import { json } from '@/lib/response';
import { commitBundle } from '@/queries/prisma/analysis';
import { bundleSchema, validateBundle } from '@/lib/analyst/bundle';

/** Atomic board + new analyses commit; replays the same board for the same principal/task/key. */
export async function POST(request: Request) {
  const schema = z
    .object({
      ...bundleSchema,
      operationKey: z.string().min(1).max(200),
      confirmationId: z.uuid().optional(),
    })
    .strict();
  const { auth, body, error } = await parseRequest(request, schema);
  if (error) return error();
  if (!isAnalystEnabled()) return disabledResponse();
  try {
    const bundle = await validateBundle(auth, body);
    const { result, replayed } = await commitBundle({
      ...bundle,
      userId: auth.user.id,
      operationKey: body.operationKey,
      confirmationId: body.confirmationId,
    });
    return json({ ...result, replayed });
  } catch (e) {
    return analysisErrorResponse(e);
  }
}
