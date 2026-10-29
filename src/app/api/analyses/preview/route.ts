import { z } from 'zod';
import { normalizeDefinition } from '@/lib/analyst/definition';
import { executeAnalysis } from '@/lib/analyst/execute';
import { analysisErrorResponse, disabledResponse, isAnalystEnabled } from '@/lib/analyst/http';
import { parseRequest } from '@/lib/request';
import { json } from '@/lib/response';

/** Executes an unsaved definition read-only; nothing is persisted. */
export async function POST(request: Request) {
  const schema = z.object({ definition: z.unknown() }).strict();
  const { auth, body, error } = await parseRequest(request, schema);
  if (error) return error();
  if (!isAnalystEnabled()) return disabledResponse();
  try {
    const definition = normalizeDefinition(body.definition);
    return json(await executeAnalysis(auth, definition, { now: Date.now(), signal: request.signal }));
  } catch (e) {
    return analysisErrorResponse(e);
  }
}
