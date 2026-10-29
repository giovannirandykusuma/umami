import { z } from 'zod';
import { AnalysisError, normalizeDefinition } from '@/lib/analyst/definition';
import { analysisErrorResponse, disabledResponse, isAnalystEnabled } from '@/lib/analyst/http';
import { parseRequest } from '@/lib/request';
import { json } from '@/lib/response';
import { canCreateTeamAnalysis } from '@/permissions/analysis';
import { canViewWebsite } from '@/permissions/website';
import { createAnalysis, getUserAnalyses } from '@/queries/prisma/analysis';

export async function GET(request: Request) {
  const schema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  });
  const { auth, query, error } = await parseRequest(request, schema);
  if (error) return error();
  return json(await getUserAnalyses(auth.user.id, query));
}

export async function POST(request: Request) {
  const schema = z
    .object({
      operationKey: z.string().min(1).max(200),
      taskId: z.uuid().optional(),
      teamId: z.uuid().optional(),
      name: z.string().trim().min(1).max(200),
      description: z.string().max(500).optional(),
      status: z.enum(['draft', 'ready']).default('draft'),
      definition: z.unknown(),
    })
    .strict();
  const { auth, body, error } = await parseRequest(request, schema);
  if (error) return error();
  if (!isAnalystEnabled()) return disabledResponse();
  try {
    // Drafts are private: a team analysis must be explicitly ready.
    if (body.teamId && body.status !== 'ready')
      throw new AnalysisError('invalid_definition', 'Team analyses must be ready', 'status');
    if (body.teamId && !(await canCreateTeamAnalysis(auth, body.teamId)))
      throw new AnalysisError('denied', 'Team is not writable', 'teamId');
    const definition = normalizeDefinition(body.definition);
    if (!(await canViewWebsite({ user: auth.user }, definition.source.websiteId)))
      throw new AnalysisError('denied', 'Source website is not accessible', 'source.websiteId');
    const { result, replayed } = await createAnalysis({
      ...body,
      definition,
      userId: auth.user.id,
    });
    return json({ analysis: result, replayed });
  } catch (e) {
    return analysisErrorResponse(e);
  }
}
