import clickhouse from '@/lib/clickhouse';
import { getDatabaseType, POSTGRESQL } from '@/lib/db';
import prisma from '@/lib/prisma';
import { getAiQueryScope } from './query';
import { validateAnalyticsDiscoverArgs } from './rpc/contract';

export const DISCOVERY_LIMITS = { events: 50, properties: 100, nameBytes: 500 } as const;

// Count strings preserve UInt64/bigint precision. Metadata names are untrusted display data.
function count(value: unknown): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new Error('Invalid discovery count');
  const text = String(value);
  if (!/^\d{1,20}$/.test(text)) throw new Error('Invalid discovery count');
  return text;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > DISCOVERY_LIMITS.nameBytes)
    throw new Error('Invalid discovery metadata');
  return value;
}

/** Only aggregate metadata leaves SQL. Never select values, samples, sessions or users. */
export async function discoverAnalytics(input: unknown, now: number) {
  const args = validateAnalyticsDiscoverArgs(input, now);
  if (!getAiQueryScope()) throw new Error('Discovery requires an AI read scope');
  const ch = !!process.env.CLICKHOUSE_URL;
  if (!ch && getDatabaseType() !== POSTGRESQL) throw new Error('Unsupported discovery database');
  const params = {
    websiteId: args.websiteId,
    startDate: ch
      ? new Date(args.startAt).toISOString().replace('T', ' ').replace('Z', '')
      : new Date(args.startAt),
    endDate: ch
      ? new Date(args.endAt).toISOString().replace('T', ' ').replace('Z', '')
      : new Date(args.endAt),
  };
  const site = ch ? '{websiteId:UUID}' : '{{websiteId::uuid}}';
  const start = ch ? '{startDate:DateTime64}' : '{{startDate}}';
  const end = ch ? '{endDate:DateTime64}' : '{{endDate}}';
  const query = (sql: string) =>
    ch ? clickhouse.rawQuery(sql, params) : prisma.rawQuery(sql, params);
  const events = await query(`
    select event_name as "eventName", ${ch ? 'toString(count(*))' : 'cast(count(*) as text)'} as "count"
    from website_event
    where website_id = ${site} and created_at between ${start} and ${end}
      and event_type = 2
    group by event_name order by count(*) desc, event_name asc limit 51
  `);
  getAiQueryScope();
  const properties = await query(
    ch
      ? `
    select event_name as "eventName", data_key as "propertyName", data_type as "dataType"
    from event_data
    where website_id = ${site} and created_at between ${start} and ${end}
    group by event_name, data_key, data_type
    order by event_name, data_key, data_type limit 101
  `
      : `
    select e.event_name as "eventName", d.data_key as "propertyName", d.data_type as "dataType"
    from event_data d join website_event e on e.event_id = d.website_event_id
      and e.website_id = ${site} and e.created_at between ${start} and ${end}
      and e.event_type = 2
    where d.website_id = ${site} and d.created_at between ${start} and ${end}
    group by e.event_name, d.data_key, d.data_type
    order by e.event_name, d.data_key, d.data_type limit 101
  `,
  );
  getAiQueryScope();
  if (
    !Array.isArray(events) ||
    events.length > 51 ||
    !Array.isArray(properties) ||
    properties.length > 101
  )
    throw new Error('Invalid discovery response');
  const types = ['unknown', 'string', 'number', 'boolean', 'date', 'array'];
  return {
    events: events.slice(0, DISCOVERY_LIMITS.events).map(row => ({
      name: name(row.eventName),
      count: count(row.count),
    })),
    properties: properties.slice(0, DISCOVERY_LIMITS.properties).map(row => ({
      eventName: name(row.eventName),
      name: name(row.propertyName),
      type:
        Number.isInteger(row.dataType) && row.dataType >= 1 && row.dataType <= 5
          ? types[row.dataType]
          : 'unknown',
    })),
    truncated: {
      events: events.length > DISCOVERY_LIMITS.events,
      properties: properties.length > DISCOVERY_LIMITS.properties,
    },
    // No coverage denominator is verified across both engines. Omission is not zero coverage.
    coverage: 'unavailable',
  };
}
