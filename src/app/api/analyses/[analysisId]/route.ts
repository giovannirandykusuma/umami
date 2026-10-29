import { z } from 'zod';
import { AnalysisError, normalizeDefinition } from '@/lib/analyst/definition';
import { analysisErrorResponse, disabledResponse, isAnalystEnabled } from '@/lib/analyst/http';
import { parseRequest } from '@/lib/request';
import { json } from '@/lib/response';
import { canUpdateAnalysis, canViewAnalysis } from '@/permissions/analysis';
import { canViewWebsite } from '@/permissions/website';
import { getAnalysis, updateAnalysis } from '@/queries/prisma/analysis';

type Params = { params: Promise<{ analysisId: string }> };

async function load(analysisId: string) {
  const analysis = z.uuid().safeParse(analysisId).success ? await getAnalysis(analysisId) : null;
  if (!analysis) throw new AnalysisError('not_found', 'Analysis not found');
  return analysis;
}

export async function GET(request: Request, { params }: Params) {
  const { auth, error } = await parseRequest(request);
  if (error) return error();
  try {
    const analysis = await load((await params).analysisId);
    // Inaccessible and missing are indistinguishable to the caller.
    if (!(await canViewAnalysis(auth, analysis)))
      throw new AnalysisError('not_found', 'Analysis not found');
    return json(analysis);
  } catch (e) {
    return analysisErrorResponse(e);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  const schema = z
    .object({
      operationKey: z.string().min(1).max(200),
      taskId: z.uuid().optional(),
      expectedRevision: z.number().int().positive(),
      name: z.string().trim().min(1).max(200).optional(),
      description: z.string().max(500).nullable().optional(),
      status: z.enum(['draft', 'ready']).optional(),
      definition: z.unknown().optional(),
    })
    .strict();
  const { auth, body, error } = await parseRequest(request, schema);
  if (error) return error();
  if (!isAnalystEnabled()) return disabledResponse();
  try {
    const analysis = await load((await params).analysisId);
    if (!(await canViewAnalysis(auth, analysis)))
      throw new AnalysisError('not_found', 'Analysis not found');
    if (!(await canUpdateAnalysis(auth, analysis)))
      throw new AnalysisError('denied', 'Analysis is read-only');
    // Team analyses stay ready; demoting would hide them from members' boards.
    if (analysis.teamId && body.status === 'draft')
      throw new AnalysisError('invalid_definition', 'Team analyses must be ready', 'status');
    const definition =
      body.definition === undefined ? undefined : normalizeDefinition(body.definition);
    if (definition && !(await canViewWebsite({ user: auth.user }, definition.source.websiteId)))
      throw new AnalysisError('denied', 'Source website is not accessible', 'source.websiteId');
    const { definition: _raw, ...rest } = body;
    const { result, replayed } = await updateAnalysis(analysis.id, {
      ...rest,
      ...(definition ? { definition } : {}),
      userId: auth.user.id,
    });
    return json({ analysis: result, replayed });
  } catch (e) {
    return analysisErrorResponse(e);
  }
}
