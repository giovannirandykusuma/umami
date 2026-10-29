import { z } from 'zod';
import { type AnalysisDefinition, AnalysisError, normalizeDefinition } from '@/lib/analyst/definition';
import { executeAnalysis } from '@/lib/analyst/execute';
import { analysisErrorResponse } from '@/lib/analyst/http';
import { parseRequest } from '@/lib/request';
import { json } from '@/lib/response';
import { canViewAnalysis } from '@/permissions/analysis';
import { getAnalysis } from '@/queries/prisma/analysis';

/** Executes the stored definition only; the body cannot override source, filters or dates. */
export async function POST(request: Request, { params }: { params: Promise<{ analysisId: string }> }) {
  const schema = z.object({}).strict().optional();
  const { auth, error } = await parseRequest(request, schema);
  if (error) return error();
  try {
    const { analysisId } = await params;
    const analysis = z.uuid().safeParse(analysisId).success ? await getAnalysis(analysisId) : null;
    if (!analysis || !(await canViewAnalysis(auth, analysis)))
      throw new AnalysisError('not_found', 'Analysis not found');
    // Re-normalize: unknown schema versions surface as unsupported, never as empty data.
    const definition: AnalysisDefinition = normalizeDefinition(analysis.definition);
    return json(
      await executeAnalysis(auth, definition, {
        now: Date.now(),
        signal: request.signal,
        saved: { id: analysis.id, revision: analysis.revision, definitionHash: analysis.definitionHash },
      }),
    );
  } catch (e) {
    return analysisErrorResponse(e);
  }
}
