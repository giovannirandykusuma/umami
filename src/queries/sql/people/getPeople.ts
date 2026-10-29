import clickhouse from '@/lib/clickhouse';
import prisma from '@/lib/prisma';
import { EVENT_TYPE } from '@/lib/constants';

export function peopleQuery(ch: boolean, count = false, property = false) {
  const site = ch ? '{websiteId:UUID}' : '{{websiteId::uuid}}';
  const start = ch ? '{startDate:DateTime64}' : '{{startDate}}';
  const end = ch ? '{endDate:DateTime64}' : '{{endDate}}';
  if (count)
    return `select count(distinct ${ch ? 'e' : 's'}.distinct_id) as "identifiedUsers"
    from website_event e ${ch ? '' : 'join session s on s.session_id = e.session_id and s.website_id = e.website_id'}
    where e.website_id = ${site} and e.created_at between ${start} and ${end}
      and e.event_type != ${EVENT_TYPE.performance} and ${ch ? 'e' : 's'}.distinct_id is not null and ${ch ? 'e' : 's'}.distinct_id <> ''`;
  return `select distinct_id as "distinctId",
    ${ch ? 'tupleElement(min(tuple(data_key, string_value)), 1)' : '(array_agg(data_key order by data_key, string_value))[1]'} as "matchedProperty",
    ${ch ? 'tupleElement(min(tuple(data_key, string_value)), 2)' : '(array_agg(string_value order by data_key, string_value))[1]'} as "matchedValue",
    count(distinct session_id) as sessions, max(created_at) as "lastAt"
    from session_data where website_id = ${site} and created_at between ${start} and ${end}
      and distinct_id is not null and distinct_id <> ''
      and ${ch ? 'positionCaseInsensitive(string_value, {search:String}) > 0' : "string_value ilike {{search}} escape '\\'"}
      ${property ? `and data_key = ${ch ? '{property:String}' : '{{property}}'}` : ''}
    group by distinct_id order by max(created_at) desc, distinct_id limit 11`;
}
export function escapeSearch(search: string) {
  return `%${search.replace(/[\\%_]/g, value => `\\${value}`)}%`;
}
export async function getPeople(
  websiteId: string,
  startDate: Date,
  endDate: Date,
  search?: string,
  property?: string,
) {
  const ch = !!process.env.CLICKHOUSE_URL;
  const params = {
    websiteId,
    startDate: ch ? startDate.toISOString().replace('T', ' ').replace('Z', '') : startDate,
    endDate: ch ? endDate.toISOString().replace('T', ' ').replace('Z', '') : endDate,
    search: ch ? search : search === undefined ? undefined : escapeSearch(search),
    property,
  };
  const sql = peopleQuery(ch, search === undefined, property !== undefined);
  const rows = await (ch ? clickhouse.rawQuery(sql, params) : prisma.rawQuery(sql, params));
  if (search === undefined) return { identifiedUsers: Number(rows[0]?.identifiedUsers || 0) };
  return {
    candidates: rows.slice(0, 10).map(row => ({ ...row, sessions: Number(row.sessions) })),
    truncated: rows.length > 10,
  };
}
