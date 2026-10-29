import { z } from 'zod';
import { parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { canViewWebsiteSection } from '@/permissions';
import { getPeople } from '@/queries/sql/people/getPeople';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, query, error } = await parseRequest(
    request,
    z
      .object({
        startAt: z.coerce.number().int(),
        endAt: z.coerce.number().int(),
        search: z.string().trim().min(2).max(100),
        property: z.string().min(1).max(500).optional(),
      })
      .refine(value => value.endAt >= value.startAt),
  );
  if (error) return error();
  const { websiteId } = await params;
  if (!(await canViewWebsiteSection(auth, websiteId, 'sessions'))) return unauthorized();
  return json(
    await getPeople(
      websiteId,
      new Date(query.startAt),
      new Date(query.endAt),
      query.search,
      query.property,
    ),
  );
}
