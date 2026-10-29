// @vitest-environment node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeTool, Interaction } from './tools';
import { advanceTurn } from './analytics/results';

const enabled = process.env.AI_ANALYTICS_INTEGRATION === '1';
const user = randomUUID(),
  other = randomUUID(),
  site = randomUUID(),
  siteB = randomUUID();
const startAt = Date.parse('2026-01-01T00:00:00+07:00');
const endAt = Date.parse('2026-01-07T23:59:59+07:00');
const range = { websiteId: site, startAt, endAt };
let client: any, token: string, otherToken: string;
const routes = new Map<string, any>();
async function call(name: string, args: any, bearer = token) {
  return executeTool(name, args, {
    credentials: new Headers({ authorization: `Bearer ${bearer}` }),
    context: advanceTurn(user, randomUUID()),
    interaction: new Interaction(() => {}, new AbortController().signal),
    fetch: async (input, options) => {
      const url = new URL(String(input));
      const match = url.pathname.match(/^\/api\/websites\/([^/]+)\/(.*)$/)!;
      const handler = routes.get(match[2]);
      assert.ok(handler, `Unknown synthetic route ${match[2]}`);
      const response = await handler(new Request(url, options), {
        params: Promise.resolve({ websiteId: match[1] }),
      });
      return response;
    },
  });
}
beforeAll(async () => {
  if (!enabled) return;
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '25432');
  assert.equal(url.username, 'ai_synthetic');
  assert.equal(url.pathname, '/ai_synthetic');
  assert.equal(url.searchParams.get('schema'), 'analytics_integration');
  assert.equal(process.env.CLICKHOUSE_URL, undefined);
  process.env.DATABASE_TYPE = 'postgresql';
  process.env.APP_SECRET = 'analytics-synthetic-only';
  delete process.env.REDIS_URL;
  delete process.env.DATABASE_REPLICA_URL;
  client = (await import('@/lib/prisma')).default.client;
  assert.deepEqual(await client.$queryRawUnsafe('select owner from public.ai_synthetic_owner'), [
    { owner: 'umami-ai-synthetic-r3' },
  ]);
  await client.user.createMany({
    data: [user, other].map(id => ({
      id,
      username: `analytics-${id}`,
      password: 'not-a-login',
      role: 'user',
    })),
  });
  await client.website.createMany({
    data: [
      { id: site, userId: user, name: 'Analytics event-only', domain: 'synthetic.invalid' },
      { id: siteB, userId: user, name: 'Jakarta boundary', domain: 'synthetic.invalid' },
    ],
  });
  const { createSecureToken } = await import('@/lib/jwt');
  const { secret } = await import('@/lib/crypto');
  token = createSecureToken({ userId: user, role: 'user' }, secret());
  otherToken = createSecureToken({ userId: other, role: 'user' }, secret());
  for (const distinctId of [
    'u_1',
    'u_1',
    'u_1',
    'u_2',
    '',
    ...Array.from({ length: 12 }, (_, i) => `staff_${i}`),
  ]) {
    const sessionId = randomUUID();
    await client.session.create({ data: { id: sessionId, websiteId: site, distinctId } });
    const name =
      distinctId === 'u_1'
        ? 'Dewi Anggraini'
        : distinctId === 'u_2'
          ? 'Dewi Ayu'
          : distinctId === ''
            ? 'Dewi Anonymous'
            : `Staff ${distinctId.slice(6).padStart(2, '0')}`;
    for (const [dataKey, stringValue] of [
      ['name', name],
      ['email', distinctId === 'u_1' ? 'dewi@example.invalid' : `${distinctId}@example.invalid`],
    ]) {
      await client.sessionData.create({
        data: {
          id: randomUUID(),
          websiteId: site,
          sessionId,
          distinctId,
          dataKey,
          stringValue,
          dataType: 1,
          createdAt: new Date(startAt + 3600000),
        },
      });
    }
    if (distinctId === 'u_2') await event(sessionId, site, startAt + 3600000, 2, 'login');
    if (
      distinctId === 'u_1' &&
      (await client.websiteEvent.count({
        where: { websiteId: site, eventName: 'ui.element_clicked' },
      })) === 0
    ) {
      for (let day = 0; day < 7; day++)
        if (day !== 3)
          for (let i = 0; i < day + 1; i++)
            await event(
              sessionId,
              site,
              startAt + day * 86400000 + 3600000,
              2,
              'ui.element_clicked',
            );
    }
  }
  const boundarySession = randomUUID();
  await client.session.create({
    data: { id: boundarySession, websiteId: siteB, distinctId: 'boundary' },
  });
  await event(boundarySession, siteB, startAt - 1000, 1, '');
  await event(boundarySession, siteB, startAt + 1000, 1, '');
  routes.set('people', (await import('@/app/api/websites/[websiteId]/people/route')).GET);
  routes.set(
    'people/count',
    (await import('@/app/api/websites/[websiteId]/people/count/route')).GET,
  );
  routes.set('metrics', (await import('@/app/api/websites/[websiteId]/metrics/route')).GET);
  routes.set(
    'event-data/properties',
    (await import('@/app/api/websites/[websiteId]/event-data/properties/route')).GET,
  );
  routes.set(
    'session-data/properties',
    (await import('@/app/api/websites/[websiteId]/session-data/properties/route')).GET,
  );
  routes.set('stats', (await import('@/app/api/websites/[websiteId]/stats/route')).GET);
  routes.set(
    'events/series',
    (await import('@/app/api/websites/[websiteId]/events/series/route')).GET,
  );
  routes.set('pageviews', (await import('@/app/api/websites/[websiteId]/pageviews/route')).GET);
}, 30000);
async function event(
  sessionId: string,
  websiteId: string,
  time: number,
  eventType: number,
  eventName: string,
) {
  // Explicit timestamptz text avoids Prisma Date binding inheriting the synthetic DB's ambient timezone.
  await client.$executeRawUnsafe(
    'insert into analytics_integration.website_event (event_id, session_id, website_id, visit_id, created_at, event_type, event_name, url_path) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6, $7, $8)',
    randomUUID(),
    sessionId,
    websiteId,
    randomUUID(),
    new Date(time).toISOString(),
    eventType,
    eventName,
    '/',
  );
}
afterAll(async () => {
  if (!enabled || !client) return;
  await client.sessionData.deleteMany({ where: { websiteId: { in: [site, siteB] } } });
  await client.websiteEvent.deleteMany({ where: { websiteId: { in: [site, siteB] } } });
  await client.session.deleteMany({ where: { websiteId: { in: [site, siteB] } } });
  await client.website.deleteMany({ where: { id: { in: [site, siteB] } } });
  await client.user.deleteMany({ where: { id: { in: [user, other] } } });
  await client.$disconnect();
});
describe.skipIf(!enabled)('analytics real authenticated PostgreSQL routes', () => {
  it('event-only schema counts active identified staff, not pageviews', async () => {
    const result = await call('analytics_schema', range);
    expect(result).toMatchObject({
      ok: true,
      data: { hasPageviews: false, hasCustomEvents: true, identifiedUsers: 2 },
    });
  });
  it('resolves names from traits and aggregates matching sessions before limit', async () => {
    const result = await call('find_people', { ...range, search: 'Dewi' });
    expect(result.ok).toBe(true);
    expect(result.data.candidates.map((p: any) => p.distinctId).sort()).toEqual(['u_1', 'u_2']);
    expect(result.data.candidates.find((p: any) => p.distinctId === 'u_1').sessions).toBe(3);
  });
  it('treats SQL wildcard characters literally', async () => {
    for (const search of ['__', '%%'])
      expect(await call('find_people', { ...range, search })).toMatchObject({
        ok: true,
        data: { candidates: [] },
      });
  });
  it('excludes matching anonymous trait rows', async () => {
    expect(await call('find_people', { ...range, search: 'Dewi Anonymous' })).toMatchObject({
      ok: true,
      data: { candidates: [] },
    });
  });
  it('returns 10 unique candidates and an honest cap', async () => {
    const result = await call('find_people', { ...range, search: 'Staff' });
    expect(result.data.truncated).toBe(true);
    expect(result.data.candidates).toHaveLength(10);
    expect(new Set(result.data.candidates.map((p: any) => p.distinctId)).size).toBe(10);
  });
  it('matches the seeded person total and Jakarta reference buckets including the empty day', async () => {
    const result = await call('query_series', {
      ...range,
      metric: 'events',
      timezone: 'Asia/Jakarta',
      unit: 'day',
      filters: { distinctId: 'u_1', event: 'ui.element_clicked' },
    });
    expect(result.ok).toBe(true);
    expect(result.data.total, JSON.stringify(result.data)).toBe(24);
    expect(result.data.buckets).toEqual(
      [1, 2, 3, 0, 5, 6, 7].map((y, i) => ({ t: `2026-01-0${i + 1}T00:00:00+07:00`, y })),
    );
    const boundary = await call('query_series', {
      ...range,
      websiteId: siteB,
      metric: 'pageviews',
      unit: 'day',
      timezone: 'Asia/Jakarta',
    });
    expect(boundary.ok, JSON.stringify(boundary)).toBe(true);
    expect(boundary.data.buckets[0]).toEqual({ t: '2026-01-01T00:00:00+07:00', y: 1 });
  });
  it('denies every typed read on the forbidden site with the real non-admin bearer', async () => {
    for (const name of [
      'find_people',
      'analytics_schema',
      'query_totals',
      'query_breakdown',
      'query_series',
    ]) {
      const result = await call(
        name,
        {
          ...range,
          websiteId: siteB,
          search: 'Dewi',
          dimension: 'event',
          metric: 'events',
          unit: 'day',
          timezone: 'UTC',
        },
        otherToken,
      );
      expect(result).toMatchObject({ ok: false, status: 401, code: 'http_error', isError: true });
    }
  });
});
