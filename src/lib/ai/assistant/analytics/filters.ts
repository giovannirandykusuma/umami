import { z } from 'zod';
import { filterParams } from '@/lib/schema';
import {
  serializeSessionPropertyFilters,
  serializeUniversalEventPropertyFilters,
} from '@/lib/params';
import type { AssistantToolError } from '../protocol';

export class AnalyticsError extends Error {
  constructor(
    readonly code: AssistantToolError['code'],
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}
const property = z
  .object({
    name: z.string().min(1).max(500),
    op: z.enum([
      'eq',
      'neq',
      's',
      'ns',
      'c',
      'dnc',
      're',
      'nre',
      't',
      'f',
      'gt',
      'gte',
      'lt',
      'lte',
      'bf',
      'af',
    ]),
    value: z.string().max(1000),
    type: z.number().int().min(1).max(5),
  })
  .strict();
export function encodeFilters(filters: unknown = {}, count = false): Record<string, string> {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters))
    throw new AnalyticsError('unsupported_filter', 'Expected a filters object', 'filters');
  const allowed = count
    ? {}
    : {
        ...filterParams,
        eventProperty: z.array(property).max(20).optional(),
        sessionProperty: z.array(property).max(20).optional(),
      };
  for (const key of Object.keys(filters))
    if (!(key in allowed))
      throw new AnalyticsError(
        'unsupported_filter',
        `Unsupported filter: ${key}`,
        `filters.${key}`,
      );
  const parsed = z.object(allowed).strict().safeParse(filters);
  if (!parsed.success)
    throw new AnalyticsError(
      'unsupported_filter',
      'Invalid filter value',
      `filters.${parsed.error.issues[0]?.path.join('.')}`,
    );
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;
    if (key === 'eventProperty' || key === 'sessionProperty') {
      const properties = (value as z.infer<typeof property>[]).map(p => ({
        propertyName: p.name,
        operator: p.op,
        value: p.value,
        dataType: p.type,
      }));
      Object.assign(
        result,
        key === 'eventProperty'
          ? serializeUniversalEventPropertyFilters(properties)
          : serializeSessionPropertyFilters(properties),
      );
    } else result[key] = String(value);
  }
  return result;
}
