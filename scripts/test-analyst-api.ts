/* eslint-disable no-console */
/**
 * Analyst foundation acceptance against the disposable synthetic engines
 * (scripts/ai/synthetic-engines/setup.sh). Exactly one of:
 *
 *   tsx scripts/test-analyst-api.ts --postgres     events + metadata in PostgreSQL
 *   tsx scripts/test-analyst-api.ts --clickhouse   events in ClickHouse, metadata in PostgreSQL
 *
 * Creates an isolated PostgreSQL schema (all Prisma migrations, including the new additive one)
 * and, for --clickhouse, an isolated ClickHouse database from db/clickhouse/schema.sql. Seeds one
 * deterministic synthetic fixture and drives the real exported route handlers with real auth
 * tokens. Expected values are fixed constants derived by hand from the fixture below, identical
 * for both engines, so a pass on both is parity without mocks. Isolated namespaces are dropped
 * afterwards. Exits non-zero on missing fixtures, wrong selection or any failed check.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const PG_BIN = '/opt/homebrew/opt/postgresql@16/bin';
const PG_BASE = 'postgresql://ai_synthetic@127.0.0.1:25432/ai_synthetic';
const CH_HTTP = 'http://127.0.0.1:28123';
const CH_AUTH = { username: 'ai_synthetic', password: 'synthetic-only' };
const MIN_CHECKS = 60;

const modes = process.argv.slice(2).filter(a => a === '--postgres' || a === '--clickhouse');
// Restart scenario: the parent re-runs this script as a fresh process to execute saved analyses.
const child = process.env.ANALYST_RESTART_CHILD
  ? (JSON.parse(process.env.ANALYST_RESTART_CHILD) as {
      namespace: string;
      owner: string;
      analysisIds: string[];
    })
  : null;
if (modes.length !== 1 || process.argv.length !== 3) {
  console.error('Usage: tsx scripts/test-analyst-api.ts --postgres | --clickhouse');
  process.exit(2);
}
const engine = modes[0] === '--clickhouse' ? 'clickhouse' : 'postgresql';
const namespace =
  child?.namespace ?? `analyst_${engine === 'clickhouse' ? 'ch' : 'pg'}_${Date.now()}`;
if (!/^analyst_(pg|ch)_[0-9]+$/.test(namespace)) throw new Error('Invalid namespace');

let checks = 0;
function check(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok ${checks} ${name}`);
}

function psql(sql: string) {
  return execFileSync(
    `${PG_BIN}/psql`,
    [
      '-XAt',
      '-h',
      '127.0.0.1',
      '-p',
      '25432',
      '-U',
      'ai_synthetic',
      '-d',
      'ai_synthetic',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  ).trim();
}

async function chCommand(query: string, database = 'default') {
  const response = await fetch(`${CH_HTTP}/?database=${database}`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${CH_AUTH.username}:${CH_AUTH.password}`).toString('base64')}`,
    },
    body: query,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`ClickHouse: ${text.slice(0, 300)}`);
  return text;
}

async function chInsert(table: string, rows: Record<string, unknown>[]) {
  await chCommand(
    `INSERT INTO ${namespace}.${table} FORMAT JSONEachRow\n${rows.map(r => JSON.stringify(r)).join('\n')}`,
  );
}

// ---- Fixture ownership: refuse anything but the owned disposable pair. ----
function verifyFixtures() {
  assert.equal(
    psql('select owner from public.ai_synthetic_owner'),
    'umami-ai-synthetic-r3',
    'PostgreSQL fixture marker',
  );
}

const T = (iso: string) => Date.parse(iso);
const ids = {
  owner: randomUUID(),
  stranger: randomUUID(),
  viewer: randomUUID(),
  team: randomUUID(),
  website: randomUUID(),
  foreignWebsite: randomUUID(),
  s1: randomUUID(),
  s2: randomUUID(),
  s3: randomUUID(),
  s4: randomUUID(),
  s5: randomUUID(),
};
const RANGE = {
  type: 'fixed',
  startAt: T('2026-01-01T00:00:00Z'),
  endAt: T('2026-01-04T00:00:00Z'),
};

/**
 * Fixture (UTC). Website W (owner):
 *  s1 DE chrome distinct u1: pageviews /a,/b @01 10:00; signup @01 10:05 amount=10; session age=20
 *  s2 FR firefox:            pageview /a @02 12:00;    signup @02 12:05 amount=30
 *  s3 DE safari distinct u2: pageview /c @03 23:00;    signup @03 23:05 (no amount); age=40
 *  s4 DE chrome:             pageview /a @01 00:00:00.000 (start, included)
 *                            pageview /a @04 00:00:00.000 (end, excluded by half-open range)
 * Foreign website (stranger): s5 pageview @02 — must never appear.
 */
type Row = {
  session: string;
  at: string;
  type: 1 | 2;
  path: string;
  name?: string;
  amount?: number;
};
const sessions = {
  [ids.s1]: { country: 'DE', browser: 'chrome', distinctId: 'u1', website: ids.website },
  [ids.s2]: { country: 'FR', browser: 'firefox', distinctId: '', website: ids.website },
  [ids.s3]: { country: 'DE', browser: 'safari', distinctId: 'u2', website: ids.website },
  [ids.s4]: { country: 'DE', browser: 'chrome', distinctId: '', website: ids.website },
  [ids.s5]: { country: 'US', browser: 'chrome', distinctId: 'x', website: ids.foreignWebsite },
};
const events: Row[] = [
  { session: ids.s1, at: '2026-01-01T10:00:00Z', type: 1, path: '/a' },
  { session: ids.s1, at: '2026-01-01T10:01:00Z', type: 1, path: '/b' },
  { session: ids.s1, at: '2026-01-01T10:05:00Z', type: 2, path: '/b', name: 'signup', amount: 10 },
  { session: ids.s2, at: '2026-01-02T12:00:00Z', type: 1, path: '/a' },
  { session: ids.s2, at: '2026-01-02T12:05:00Z', type: 2, path: '/a', name: 'signup', amount: 30 },
  { session: ids.s3, at: '2026-01-03T23:00:00Z', type: 1, path: '/c' },
  { session: ids.s3, at: '2026-01-03T23:05:00Z', type: 2, path: '/c', name: 'signup' },
  { session: ids.s4, at: '2026-01-01T00:00:00Z', type: 1, path: '/a' },
  { session: ids.s4, at: '2026-01-04T00:00:00Z', type: 1, path: '/a' },
  { session: ids.s5, at: '2026-01-02T00:00:00Z', type: 1, path: '/a' },
];
const sessionAges = [
  { session: ids.s1, at: '2026-01-01T10:00:00Z', age: 20 },
  { session: ids.s3, at: '2026-01-03T23:00:00Z', age: 40 },
];

async function setupNamespaces() {
  psql(`create schema ${namespace}`);
  execFileSync(path.resolve('node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: `${PG_BASE}?schema=${namespace}` },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (engine === 'clickhouse') {
    assert.equal((await chCommand('SELECT 1')).trim(), '1', 'ClickHouse fixture reachable');
    await chCommand(`CREATE DATABASE ${namespace}`);
    const ddl = readFileSync('db/clickhouse/schema.sql', 'utf8')
      .replace(/--.*$/gm, '')
      .replaceAll('umami.', `${namespace}.`)
      .split(';')
      .map(s => s.trim())
      .filter(Boolean);
    for (const statement of ddl) await chCommand(statement);
  }
}

async function teardownNamespaces() {
  try {
    psql(`drop schema if exists ${namespace} cascade`);
  } catch (e) {
    console.error('PostgreSQL namespace cleanup failed', e);
  }
  if (engine === 'clickhouse')
    await chCommand(`DROP DATABASE IF EXISTS ${namespace}`).catch(e =>
      console.error('ClickHouse namespace cleanup failed', e),
    );
}

async function withUtcWrites(client: any, work: (tx: any) => Promise<void>) {
  await client.$transaction(
    async (tx: any) => {
      await tx.$executeRawUnsafe("SET LOCAL TimeZone = 'UTC'");
      await work(tx);
    },
    { timeout: 60_000 },
  );
}

/** Fresh signup events written after definitions were saved, at true instants. */
async function writeFreshSignups(client: any, instants: number[]) {
  if (engine === 'postgresql')
    return withUtcWrites(client, async tx => {
      for (const at of instants)
        await tx.websiteEvent.create({
          data: {
            id: randomUUID(),
            websiteId: ids.website,
            sessionId: ids.s1,
            visitId: ids.s1,
            createdAt: new Date(at),
            urlPath: '/fresh',
            eventType: 2,
            eventName: 'signup',
            hostname: 'synthetic.invalid',
          },
        });
    });
  const s = sessions[ids.s1];
  await chInsert(
    'website_event',
    instants.map(at => ({
      website_id: ids.website,
      session_id: ids.s1,
      visit_id: ids.s1,
      event_id: randomUUID(),
      hostname: 'synthetic.invalid',
      browser: s.browser,
      country: s.country,
      url_path: '/fresh',
      event_type: 2,
      event_name: 'signup',
      distinct_id: s.distinctId,
      created_at: new Date(at)
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, ''),
    })),
  );
}

/** Restarted process: executes saved analyses through the real route and prints the envelopes. */
async function runRestartChild() {
  const { createSecureToken } = await import('@/lib/jwt');
  const { secret } = await import('@/lib/crypto');
  const execute = await import('@/app/api/analyses/[analysisId]/execute/route');
  const out = [];
  for (const analysisId of child!.analysisIds) {
    const response: Response = await execute.POST(
      new Request(`http://localhost/api/analyses/${analysisId}/execute`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${createSecureToken({ userId: child!.owner, role: 'user' }, secret())}`,
          'content-type': 'application/json',
        },
        body: '{}',
      }),
      { params: Promise.resolve({ analysisId }) },
    );
    out.push({ status: response.status, body: await response.json() });
  }
  console.log(`RESTART_RESULT ${JSON.stringify({ pid: process.pid, out })}`);
}

async function seed(client: any) {
  const users = [ids.owner, ids.stranger, ids.viewer];
  await client.user.createMany({
    data: users.map(id => ({
      id,
      username: `analyst-${id}`,
      password: 'not-a-login',
      role: 'user',
    })),
  });
  await client.team.create({ data: { id: ids.team, name: 'Analyst synthetic team' } });
  await client.teamUser.createMany({
    data: [
      { id: randomUUID(), teamId: ids.team, userId: ids.owner, role: 'team-owner' },
      { id: randomUUID(), teamId: ids.team, userId: ids.viewer, role: 'team-view-only' },
    ],
  });
  await client.website.createMany({
    data: [
      {
        id: ids.website,
        name: 'Analyst synthetic',
        domain: 'synthetic.invalid',
        userId: ids.owner,
      },
      {
        id: ids.foreignWebsite,
        name: 'Foreign synthetic',
        domain: 'foreign.invalid',
        userId: ids.stranger,
      },
    ],
  });
  if (engine === 'postgresql') {
    for (const [id, s] of Object.entries(sessions))
      await client.session.create({
        data: {
          id,
          websiteId: s.website,
          country: s.country,
          browser: s.browser,
          distinctId: s.distinctId || null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      });
    for (const e of events) {
      const id = randomUUID();
      const s = sessions[e.session];
      await client.websiteEvent.create({
        data: {
          id,
          websiteId: s.website,
          sessionId: e.session,
          visitId: e.session,
          createdAt: new Date(e.at),
          urlPath: e.path,
          eventType: e.type,
          eventName: e.name ?? null,
          hostname: 'synthetic.invalid',
        },
      });
      if (e.amount !== undefined)
        await client.eventData.create({
          data: {
            id: randomUUID(),
            websiteId: s.website,
            websiteEventId: id,
            dataKey: 'amount',
            numberValue: e.amount,
            dataType: 2,
            createdAt: new Date(e.at),
          },
        });
    }
    for (const a of sessionAges)
      await client.sessionData.create({
        data: {
          id: randomUUID(),
          websiteId: ids.website,
          sessionId: a.session,
          dataKey: 'age',
          numberValue: a.age,
          dataType: 2,
          createdAt: new Date(a.at),
        },
      });
    return;
  }
  const ch = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$|Z$/, '');
  const rows = events.map(e => {
    const s = sessions[e.session];
    return { ...e, id: randomUUID(), s };
  });
  await chInsert(
    'website_event',
    rows.map(r => ({
      website_id: r.s.website,
      session_id: r.session,
      visit_id: r.session,
      event_id: r.id,
      hostname: 'synthetic.invalid',
      browser: r.s.browser,
      country: r.s.country,
      url_path: r.path,
      event_type: r.type,
      event_name: r.name ?? '',
      distinct_id: r.s.distinctId,
      created_at: ch(r.at),
    })),
  );
  await chInsert(
    'event_data',
    rows
      .filter(r => r.amount !== undefined)
      .map(r => ({
        website_id: r.s.website,
        session_id: r.session,
        event_id: r.id,
        url_path: r.path,
        event_name: r.name,
        data_key: 'amount',
        number_value: r.amount,
        data_type: 2,
        created_at: ch(r.at),
      })),
  );
  await chInsert(
    'session_data',
    sessionAges.map(a => ({
      website_id: ids.website,
      session_id: a.session,
      data_key: 'age',
      number_value: a.age,
      data_type: 2,
      distinct_id: sessions[a.session].distinctId,
      created_at: ch(a.at),
    })),
  );
}

function definition(patch: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    source: { websiteId: ids.website },
    operation: 'totals',
    metric: 'pageviews',
    datePolicy: RANGE,
    timezone: 'UTC',
    semanticBinding: {
      label: 'Synthetic',
      unit: 'count',
      population: 'synthetic visitors',
      meaningSource: 'user_confirmed',
    },
    ...patch,
  };
}

async function main() {
  verifyFixtures();
  if (!child) await setupNamespaces();
  // Never inherit application connection settings; exact loopback synthetic endpoints only.
  // No session TimeZone override: the owned fixture server runs non-UTC (asserted below), so
  // product execution must normalize it itself.
  process.env.DATABASE_URL = `${PG_BASE}?schema=${namespace}`;
  if (engine === 'clickhouse')
    process.env.CLICKHOUSE_URL = `http://${CH_AUTH.username}:${CH_AUTH.password}@127.0.0.1:28123/${namespace}`;
  else delete process.env.CLICKHOUSE_URL;
  delete process.env.DATABASE_REPLICA_URL;
  delete process.env.REDIS_URL;
  delete process.env.CLOUD_MODE;
  delete process.env.AI_ANALYST_ENABLED;
  process.env.APP_SECRET = `analyst-synthetic-${namespace}`;
  if (child) {
    process.env.AI_ANALYST_ENABLED = 'true';
    await runRestartChild();
    process.exit(0);
  }

  const prisma = (await import('@/lib/prisma')).default;
  const client = prisma.client as any;
  const [{ tz }] = await client.$queryRawUnsafe("select current_setting('TimeZone') tz");
  try {
    check(`product database session is non-UTC (${tz})`, () => assert.notEqual(tz, 'UTC'));
    // Fixture rows must hold their true instants; only this seeding transaction is pinned (the
    // pg driver sends Dates without an offset). Product reads are never pinned by the harness.
    await withUtcWrites(client, seed);
    await run(client);
  } finally {
    await client.$disconnect().catch(() => {});
    await teardownNamespaces();
  }
  assert.ok(checks >= MIN_CHECKS, `expected at least ${MIN_CHECKS} checks, ran ${checks}`);
  console.log(`PASS ${engine}: ${checks} checks (namespace ${namespace} dropped)`);
}

async function run(client: any) {
  const { createSecureToken } = await import('@/lib/jwt');
  const { secret } = await import('@/lib/crypto');
  const { hashDefinition, normalizeDefinition } = await import('@/lib/analyst/definition');
  const analyses = await import('@/app/api/analyses/route');
  const analysis = await import('@/app/api/analyses/[analysisId]/route');
  const execute = await import('@/app/api/analyses/[analysisId]/execute/route');
  const preview = await import('@/app/api/analyses/preview/route');
  const boards = await import('@/app/api/boards/route');
  const board = await import('@/app/api/boards/[boardId]/route');
  const shares = await import('@/app/api/boards/[boardId]/shares/route');
  const token = (userId: string) => createSecureToken({ userId, role: 'user' }, secret());
  const call = async (
    handler: any,
    method: string,
    url: string,
    user: string,
    body?: unknown,
    params?: any,
  ) => {
    const response: Response = await handler(
      new Request(`http://localhost${url}`, {
        method,
        headers: { authorization: `Bearer ${token(user)}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { params: Promise.resolve(params ?? {}) },
    );
    return { status: response.status, body: await response.json() };
  };
  const previewAs = (def: unknown, user = ids.owner) =>
    call(preview.POST, 'POST', '/api/analyses/preview', user, { definition: def });

  console.log(`# ${engine}: flags off by default`);
  {
    const created = await call(analyses.POST, 'POST', '/api/analyses', ids.owner, {
      operationKey: 'off',
      name: 'Off',
      definition: definition({}),
    });
    check('create is disabled without AI_ANALYST_ENABLED', () => {
      assert.equal(created.status, 404);
      assert.equal(created.body.error.code, 'feature_disabled');
    });
    const p = await previewAs(definition({}));
    check('preview is disabled without AI_ANALYST_ENABLED', () => assert.equal(p.status, 404));
    const v0_0_0 = await client.savedAnalysis.count();
    check('nothing persisted while disabled', () => {
      assert.equal(v0_0_0, 0);
    });
  }
  process.env.AI_ANALYST_ENABLED = 'true';

  console.log(`# ${engine}: execution matrix against fixed expected values`);
  const ok = async (def: unknown) => {
    const r = await previewAs(def);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  {
    const e = await ok(definition({}));
    check('totals pageviews = 5 (start boundary in, end boundary out, foreign site excluded)', () =>
      assert.deepEqual(e.rows, [{ metric: 'pageviews', value: 5 }]),
    );
    check('envelope provenance and completeness', () => {
      assert.equal(e.completeness, 'complete');
      assert.deepEqual(e.reasons, []);
      assert.equal(e.definition, null);
      assert.equal(e.definitionHash, hashDefinition(normalizeDefinition(definition({}))));
      assert.deepEqual(e.range, {
        startAt: RANGE.startAt,
        endAt: RANGE.endAt,
        timezone: 'UTC',
        policy: RANGE,
      });
      assert.equal(e.freshness.engine, engine);
      assert.equal(e.limits.maxRows, 200);
      assert.match(e.executionId, /^[0-9a-f-]{36}$/);
      assert.ok(!JSON.stringify(e).toLowerCase().includes('select '), 'no SQL in envelope');
    });
  }
  const totals = async (metric: string, extra: Record<string, unknown> = {}) =>
    (await ok(definition({ metric, ...extra }))).rows[0].value;
  const v1_0_0 = await totals('sessions');
  check('totals sessions = 4', () => {
    assert.equal(v1_0_0, 4);
  });
  const v2_0_0 = await totals('visits');
  check('totals visits = 4', () => {
    assert.equal(v2_0_0, 4);
  });
  const v3_0_0 = await totals('events', { event: 'signup' });
  check('totals signup events = 3', () => {
    assert.equal(v3_0_0, 3);
  });
  const v4_0_0 = await totals('events', { event: 'never-happened' });
  check('totals unknown event is explicit zero', () => {
    assert.equal(v4_0_0, 0);
  });
  const v5_0_0 = await totals('identified_users');
  check('totals identified users = 2 (u1, u2)', () => {
    assert.equal(v5_0_0, 2);
  });
  const v6_0_0 = await totals('pageviews', {
    filters: [{ dimension: 'country', operator: 'eq', values: ['DE'] }],
  });
  check('filtered totals pageviews country=DE = 4', () => {
    assert.equal(v6_0_0, 4);
  });
  const v7_0_0 = await totals('pageviews', {
    filters: [{ dimension: 'country', operator: 'neq', values: ['DE'] }],
  });
  check('filtered totals pageviews country!=DE = 1', () => {
    assert.equal(v7_0_0, 1);
  });
  const v8_0_0 = await totals('pageviews', {
    filters: [{ dimension: 'path', operator: 'eq', values: ['/a'] }],
  });
  check('filtered totals pageviews path contains /a = 3 (end-boundary /a excluded)', () => {
    assert.equal(v8_0_0, 3);
  });
  {
    const e = await ok(definition({ operation: 'series', metric: 'pageviews', unit: 'day' }));
    check('series pageviews/day UTC = 3,1,1', () =>
      assert.deepEqual(e.rows, [
        { t: '2026-01-01T00:00:00Z', y: 3 },
        { t: '2026-01-02T00:00:00Z', y: 1 },
        { t: '2026-01-03T00:00:00Z', y: 1 },
      ]),
    );
    check('series total equals bucket sum', () => assert.deepEqual(e.totals, { total: 5 }));
  }
  {
    const e = await ok(
      definition({
        operation: 'series',
        metric: 'pageviews',
        unit: 'day',
        timezone: 'America/New_York',
      }),
    );
    check('series pageviews/day America/New_York = 1,2,1,1 local buckets', () =>
      assert.deepEqual(e.rows, [
        { t: '2025-12-31T00:00:00-05:00', y: 1 },
        { t: '2026-01-01T00:00:00-05:00', y: 2 },
        { t: '2026-01-02T00:00:00-05:00', y: 1 },
        { t: '2026-01-03T00:00:00-05:00', y: 1 },
      ]),
    );
  }
  {
    const e = await ok(definition({ operation: 'series', metric: 'sessions', unit: 'day' }));
    check('series sessions/day = 2,1,1 with bucketSessionSum, no unique total', () => {
      assert.deepEqual(
        e.rows.map((r: any) => r.y),
        [2, 1, 1],
      );
      assert.deepEqual(e.totals, { bucketSessionSum: 4 });
      assert.ok(e.warnings.includes('bucket_sum_not_unique_sessions'));
    });
  }
  {
    const e = await ok(
      definition({ operation: 'series', metric: 'events', event: 'signup', unit: 'day' }),
    );
    check('series signup/day = 1,1,1', () =>
      assert.deepEqual(
        e.rows.map((r: any) => r.y),
        [1, 1, 1],
      ),
    );
  }
  {
    const e = await ok(
      definition({
        operation: 'breakdown',
        metric: 'sessions',
        groupBy: { dimension: 'country', top: 5 },
      }),
    );
    check('breakdown sessions by country = DE 3, FR 1, complete', () => {
      assert.deepEqual(
        e.rows.map((r: any) => [r.key, r.value]),
        [
          ['DE', 3],
          ['FR', 1],
        ],
      );
      assert.equal(e.completeness, 'complete');
      assert.deepEqual(e.counts, { returned: 2, available: 2 });
    });
  }
  {
    const e = await ok(
      definition({
        operation: 'breakdown',
        metric: 'sessions',
        groupBy: { dimension: 'country', top: 1 },
      }),
    );
    check('top-1 breakdown is labeled partial top-N without fabricated remainder', () => {
      assert.deepEqual(
        e.rows.map((r: any) => [r.key, r.value]),
        [['DE', 3]],
      );
      assert.equal(e.completeness, 'partial');
      assert.deepEqual(e.reasons, ['top_n_truncated']);
      assert.equal(e.counts.available, null);
    });
  }
  {
    const e = await ok(
      definition({
        operation: 'breakdown',
        metric: 'sessions',
        groupBy: { dimension: 'path', top: 5 },
      }),
    );
    check('breakdown sessions by path = /a 3, /b 1, /c 1', () =>
      assert.deepEqual(e.rows.map((r: any) => [r.key, r.value]).sort(), [
        ['/a', 3],
        ['/b', 1],
        ['/c', 1],
      ]),
    );
  }
  {
    const e = await ok(
      definition({
        operation: 'breakdown',
        metric: 'events',
        event: 'signup',
        groupBy: { dimension: 'country', top: 5 },
      }),
    );
    check('breakdown signup events by country = DE 2, FR 1', () =>
      assert.deepEqual(
        e.rows.map((r: any) => [r.key, r.value]),
        [
          ['DE', 2],
          ['FR', 1],
        ],
      ),
    );
  }
  const numeric = async (metric: string, owner: string, name: string) =>
    (
      await ok(
        definition({
          operation: 'numeric_property',
          metric,
          ...(owner === 'event' ? { event: 'signup' } : {}),
          property: { owner, name },
        }),
      )
    ).rows[0];
  for (const [metric, value] of [
    ['sum', 40],
    ['average', 20],
    ['median', 20],
    ['min', 10],
    ['max', 30],
    ['count', 2],
  ] as const) {
    const row = await numeric(metric, 'event', 'amount');
    check(`event numeric amount ${metric} = ${value}`, () => {
      assert.equal(row.value, value);
      assert.equal(row.count, 2);
    });
  }
  {
    const row = await numeric('sum', 'session', 'age');
    check('session numeric age sum = 60 over 2 values', () =>
      assert.deepEqual(row, { metric: 'sum', value: 60, count: 2 }),
    );
    const missing = await ok(
      definition({
        operation: 'numeric_property',
        metric: 'average',
        property: { owner: 'session', name: 'missing' },
      }),
    );
    check('missing numeric values are null, not zero', () => {
      assert.deepEqual(missing.rows, [{ metric: 'average', value: null, count: 0 }]);
      assert.ok(missing.warnings.includes('no_numeric_values'));
    });
  }

  console.log(`# ${engine}: unsupported requests fail before execution`);
  for (const [name, def, code] of [
    ['unknown metric', definition({ metric: 'bounce_rate' }), 'unsupported_combination'],
    [
      'eq value containing a comma (would split and widen population)',
      definition({ filters: [{ dimension: 'country', operator: 'eq', values: ['DE,FR'] }] }),
      'unsupported_filter',
    ],
    [
      'filtered identified users',
      definition({
        metric: 'identified_users',
        filters: [{ dimension: 'country', operator: 'eq', values: ['DE'] }],
      }),
      'unsupported_combination',
    ],
    [
      'event property filter on pageviews',
      definition({
        propertyFilters: [
          { owner: 'event', name: 'amount', dataType: 2, operator: 'gt', value: '1' },
        ],
      }),
      'unsupported_combination',
    ],
    [
      'property filter on numeric aggregate',
      definition({
        operation: 'numeric_property',
        metric: 'sum',
        property: { owner: 'session', name: 'age' },
        propertyFilters: [
          { owner: 'session', name: 'age', dataType: 2, operator: 'gt', value: '1' },
        ],
      }),
      'unsupported_combination',
    ],
    [
      'unknown filter',
      definition({ filters: [{ dimension: 'raw_sql', operator: 'eq', values: ['1'] }] }),
      'unsupported_filter',
    ],
    ['schema version 2', definition({ schemaVersion: 2 }), 'unsupported_schema_version'],
    ['raw sql field', definition({ sql: 'select 1' }), 'invalid_definition'],
    [
      'too many buckets',
      definition({
        operation: 'series',
        metric: 'pageviews',
        unit: 'hour',
        datePolicy: {
          type: 'fixed',
          startAt: RANGE.startAt,
          endAt: RANGE.startAt + 9 * 86_400_000,
        },
      }),
      'result_too_large',
    ],
  ] as const) {
    const r = await previewAs(def);
    check(`${name} → ${code}`, () => {
      assert.notEqual(r.status, 200);
      assert.equal(r.body.error.code, code, JSON.stringify(r.body));
      assert.equal(typeof r.body.error.retryable, 'boolean');
    });
  }
  {
    const r = await previewAs(definition({ source: { websiteId: ids.foreignWebsite } }));
    check('preview of another principal’s website is denied', () => {
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, 'denied');
    });
  }

  console.log(`# ${engine}: persistence, idempotency, immutable revisions`);
  const create = (key: string, extra: Record<string, unknown> = {}, user = ids.owner) =>
    call(analyses.POST, 'POST', '/api/analyses', user, {
      operationKey: key,
      name: 'Signups',
      definition: definition({ metric: 'events', event: 'signup' }),
      ...extra,
    });
  const first = await create('create-1');
  const id = first.body.analysis?.id;
  check('create returns draft revision 1 with normalized hash', () => {
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.replayed, false);
    assert.equal(first.body.analysis.status, 'draft');
    assert.equal(first.body.analysis.revision, 1);
    assert.equal(first.body.analysis.userId, ids.owner);
    assert.equal(
      first.body.analysis.definitionHash,
      hashDefinition(normalizeDefinition(definition({ metric: 'events', event: 'signup' }))),
    );
  });
  const replay = await create('create-1');
  check('same key + same request replays the original result', () => {
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.analysis.id, id);
  });
  const conflict = await create('create-1', { name: 'Different' });
  check('same key + different request conflicts', () => assert.equal(conflict.status, 409));
  const racers = await Promise.all([1, 2, 3].map(() => create('race-key', { name: 'Race' })));
  const v9_2_0 = await client.savedAnalysis.count({ where: { name: 'Race' } });
  check('concurrent same-key creates yield exactly one analysis', () => {
    assert.deepEqual(
      racers.map(r => r.status),
      [200, 200, 200],
    );
    assert.equal(new Set(racers.map(r => r.body.analysis.id)).size, 1);
    assert.equal(v9_2_0, 1);
  });
  const spoof = await call(analyses.POST, 'POST', '/api/analyses', ids.owner, {
    operationKey: 'spoof',
    name: 'X',
    userId: ids.stranger,
    definition: definition({}),
  });
  check('caller cannot choose the owner principal', () => assert.equal(spoof.status, 400));
  const foreign = await create('foreign', {
    definition: definition({ source: { websiteId: ids.foreignWebsite } }),
  });
  check('cannot save an analysis over an inaccessible source', () =>
    assert.equal(foreign.status, 403),
  );
  const teamDraft = await create('team-draft', { teamId: ids.team });
  check('team analyses cannot be private drafts', () => assert.equal(teamDraft.status, 400));
  const strangerTeam = await create(
    'stranger-team',
    { teamId: ids.team, status: 'ready' },
    ids.stranger,
  );
  check('non-members cannot create team analyses', () => assert.equal(strangerTeam.status, 403));

  const patch = (body: Record<string, unknown>, user = ids.owner, target = id) =>
    call(analysis.PATCH, 'PATCH', `/api/analyses/${target}`, user, body, { analysisId: target });
  const renamed = await patch({ operationKey: 'patch-1', expectedRevision: 1, name: 'Signups v2' });
  check('PATCH with expected revision advances to 2', () => {
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.analysis.revision, 2);
  });
  const stale = await patch({ operationKey: 'patch-stale', expectedRevision: 1, name: 'Stale' });
  check('stale expected revision conflicts', () => {
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.field, 'expectedRevision');
  });
  const missingRevision = await patch({ operationKey: 'patch-norev', name: 'No revision' });
  check('PATCH requires expectedRevision', () => assert.equal(missingRevision.status, 400));
  const invalidPatch = await patch({
    operationKey: 'patch-bad',
    expectedRevision: 2,
    definition: definition({ metric: 'bounce_rate' }),
  });
  check('PATCH validates the definition', () =>
    assert.equal(invalidPatch.body.error.code, 'unsupported_combination'),
  );
  const racing = await Promise.all([
    patch({ operationKey: 'race-a', expectedRevision: 2, name: 'Racer A' }),
    patch({ operationKey: 'race-b', expectedRevision: 2, name: 'Racer B' }),
  ]);
  check('concurrent PATCH at same revision: exactly one wins', () =>
    assert.deepEqual(racing.map(r => r.status).sort(), [200, 409]),
  );
  const history = await client.savedAnalysisRevision.findMany({
    where: { analysisId: id },
    orderBy: { revision: 'asc' },
  });
  check('revision history is append-only and complete', () => {
    assert.deepEqual(
      history.map((h: any) => h.revision),
      [1, 2, 3],
    );
    assert.equal(history[0].name, 'Signups');
    assert.equal(history[1].name, 'Signups v2');
  });
  const redefine = await patch({
    operationKey: 'redefine',
    expectedRevision: 3,
    definition: definition({
      metric: 'events',
      event: 'signup',
      filters: [{ dimension: 'country', operator: 'eq', values: ['DE'] }],
    }),
  });
  check('definition change creates revision 4 with a new hash; revision 1 is unchanged', () => {
    assert.equal(redefine.body.analysis.revision, 4);
    assert.notEqual(redefine.body.analysis.definitionHash, first.body.analysis.definitionHash);
  });
  assert.equal(
    (await client.savedAnalysisRevision.findFirst({ where: { analysisId: id, revision: 1 } }))
      .definitionHash,
    first.body.analysis.definitionHash,
  );

  console.log(`# ${engine}: readback and saved execution`);
  const read = await call(analysis.GET, 'GET', `/api/analyses/${id}`, ids.owner, undefined, {
    analysisId: id,
  });
  check('readback returns stored definition whose hash re-derives', () => {
    assert.equal(read.status, 200);
    assert.equal(read.body.revision, 4);
    assert.equal(
      hashDefinition(normalizeDefinition(read.body.definition)),
      read.body.definitionHash,
    );
  });
  const executed = await call(
    execute.POST,
    'POST',
    `/api/analyses/${id}/execute`,
    ids.owner,
    {},
    { analysisId: id },
  );
  check('saved execution = DE signups 2 with saved provenance', () => {
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    assert.deepEqual(executed.body.rows, [{ metric: 'events', value: 2 }]);
    assert.deepEqual(executed.body.definition, {
      id,
      revision: 4,
      definitionHash: read.body.definitionHash,
    });
  });
  const previewed = await ok(read.body.definition);
  check('preview of the read-back definition equals saved execution data', () => {
    assert.deepEqual(previewed.rows, executed.body.rows);
    assert.equal(previewed.definitionHash, executed.body.definitionHash);
  });
  const override = await call(
    execute.POST,
    'POST',
    `/api/analyses/${id}/execute`,
    ids.owner,
    { filters: [] },
    { analysisId: id },
  );
  check('execute rejects caller overrides', () => assert.equal(override.status, 400));

  console.log(`# ${engine}: authority`);
  const strangerRead = await call(
    analysis.GET,
    'GET',
    `/api/analyses/${id}`,
    ids.stranger,
    undefined,
    { analysisId: id },
  );
  const strangerExec = await call(
    execute.POST,
    'POST',
    `/api/analyses/${id}/execute`,
    ids.stranger,
    {},
    { analysisId: id },
  );
  const strangerPatch = await patch(
    { operationKey: 'steal', expectedRevision: 4, name: 'Mine' },
    ids.stranger,
  );
  check('stranger cannot read, execute or patch a private draft', () => {
    assert.equal(strangerRead.status, 404);
    assert.equal(strangerExec.status, 404);
    assert.equal(strangerPatch.status, 404);
  });
  const viewerRead = await call(analysis.GET, 'GET', `/api/analyses/${id}`, ids.viewer, undefined, {
    analysisId: id,
  });
  check('team member cannot see owner’s private draft', () => assert.equal(viewerRead.status, 404));
  const lists = await Promise.all(
    [ids.owner, ids.stranger].map(u =>
      call(analyses.GET, 'GET', '/api/analyses?page=1&pageSize=100', u),
    ),
  );
  check('list is principal-scoped and bounded', () => {
    assert.ok(lists[0].body.data.some((a: any) => a.id === id));
    assert.equal(lists[1].body.count, 0);
    assert.equal(lists[0].body.pageSize, 100);
  });
  const big = await call(analyses.GET, 'GET', '/api/analyses?pageSize=1000', ids.owner);
  check('page size above 100 is rejected', () => assert.equal(big.status, 400));
  const team = await create('team-ready', {
    teamId: ids.team,
    status: 'ready',
    name: 'Team signups',
  });
  const teamId = team.body.analysis.id;
  const viewerTeam = await call(
    analysis.GET,
    'GET',
    `/api/analyses/${teamId}`,
    ids.viewer,
    undefined,
    { analysisId: teamId },
  );
  const viewerPatch = await patch(
    { operationKey: 'v', expectedRevision: 1, name: 'x' },
    ids.viewer,
    teamId,
  );
  const viewerExec = await call(
    execute.POST,
    'POST',
    `/api/analyses/${teamId}/execute`,
    ids.viewer,
    {},
    { analysisId: teamId },
  );
  check('team view-only member can read but not edit a ready team analysis', () => {
    assert.equal(viewerTeam.status, 200);
    assert.equal(viewerPatch.status, 403);
  });
  check('execution rechecks source access: viewer lacks website access → denied', () => {
    assert.equal(viewerExec.status, 403);
    assert.equal(viewerExec.body.error.code, 'denied');
  });
  await client.website.update({ where: { id: ids.website }, data: { userId: ids.stranger } });
  const revoked = await call(
    execute.POST,
    'POST',
    `/api/analyses/${id}/execute`,
    ids.owner,
    {},
    { analysisId: id },
  );
  await client.website.update({ where: { id: ids.website }, data: { userId: ids.owner } });
  check('revoked source access denies saved execution (no stale grant)', () =>
    assert.equal(revoked.status, 403),
  );
  const restored = await call(
    execute.POST,
    'POST',
    `/api/analyses/${id}/execute`,
    ids.owner,
    {},
    { analysisId: id },
  );
  check('restored access executes again', () => assert.equal(restored.status, 200));

  console.log(`# ${engine}: boards`);
  const widget = (
    analysisId: string,
    visualization = 'metric',
    extra: Record<string, unknown> = {},
  ) => ({
    rows: [
      {
        id: 'r',
        columns: [
          {
            id: 'c',
            component: { type: 'AnalysisWidget', props: { analysisId, visualization, ...extra } },
          },
        ],
      },
    ],
  });
  const created = await call(boards.POST, 'POST', '/api/boards', ids.owner, {
    type: 'mixed',
    name: 'Draft board',
    parameters: widget(id),
  });
  const boardId = created.body.id;
  check('board with own analysis widget saves at revision 1', () => {
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.revision, 1);
  });
  const badViz = await call(boards.POST, 'POST', '/api/boards', ids.owner, {
    type: 'mixed',
    name: 'x',
    parameters: widget(id, 'line'),
  });
  check('renderer incompatible with result shape is rejected', () =>
    assert.equal(badViz.status, 400),
  );
  const extraProps = await call(boards.POST, 'POST', '/api/boards', ids.owner, {
    type: 'mixed',
    name: 'x',
    parameters: widget(id, 'metric', { sql: 'select 1' }),
  });
  check('widget config cannot carry SQL/rows/extra props', () =>
    assert.equal(extraProps.status, 400),
  );
  const strangerBoard = await call(boards.POST, 'POST', '/api/boards', ids.stranger, {
    type: 'mixed',
    name: 'x',
    parameters: widget(id),
  });
  check('cannot reference another principal’s analysis', () =>
    assert.equal(strangerBoard.status, 400),
  );
  const teamBoard = await call(boards.POST, 'POST', '/api/boards', ids.owner, {
    type: 'mixed',
    name: 'x',
    teamId: ids.team,
    parameters: widget(id),
  });
  check('team board cannot expose a private draft', () => {
    assert.equal(teamBoard.status, 400);
    assert.match(teamBoard.body.error.message, /narrower/);
  });
  const teamBoardOk = await call(boards.POST, 'POST', '/api/boards', ids.owner, {
    type: 'mixed',
    name: 'x',
    teamId: ids.team,
    parameters: widget(teamId),
  });
  check('team board may reference a ready team analysis', () =>
    assert.equal(teamBoardOk.status, 200),
  );
  const update = (body: Record<string, unknown>) =>
    call(board.POST, 'POST', `/api/boards/${boardId}`, ids.owner, body, { boardId });
  const cas = await update({ name: 'Renamed', expectedRevision: 1 });
  check('board compare-and-set at revision 1 → 2', () => assert.equal(cas.body.revision, 2));
  const staleBoard = await update({ name: 'Stale', expectedRevision: 1 });
  check('stale board revision → 409 without mutation', () => assert.equal(staleBoard.status, 409));
  const legacy = await update({ name: 'Legacy explicit save' });
  check('legacy save without expectedRevision still works and advances revision', () => {
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.revision, 3);
  });
  const sneaky = await update({ parameters: widget(teamId, 'metric'), expectedRevision: 3 });
  check('board update re-validates analysis visibility', () => assert.equal(sneaky.status, 400));
  const share = await call(
    shares.POST,
    'POST',
    `/api/boards/${boardId}/shares`,
    ids.owner,
    { name: 'Public' },
    { boardId },
  );
  check('sharing a board with analysis widgets is explicitly unsupported', () => {
    assert.equal(share.status, 422);
    assert.equal(share.body.error.code, 'unsupported_sharing');
  });
  const after = await client.board.findUnique({ where: { id: boardId } });
  const v10_1_0 = await client.share.count({ where: { entityId: boardId } });
  check('refused share leaves widget intact and creates no share', () => {
    assert.equal(after.parameters.rows[0].columns[0].component.props.analysisId, id);
    assert.equal(v10_1_0, 0);
  });

  console.log(`# ${engine}: revoked source denies board save`);
  await client.website.update({ where: { id: ids.website }, data: { userId: ids.stranger } });
  const revokedCreate = await call(boards.POST, 'POST', '/api/boards', ids.owner, {
    type: 'mixed',
    name: 'Revoked',
    parameters: widget(id),
  });
  const revokedUpdate = await update({ parameters: widget(id, 'metric'), expectedRevision: 3 });
  await client.website.update({ where: { id: ids.website }, data: { userId: ids.owner } });
  const v11_0_0 = await client.board.findUnique({ where: { id: boardId } });
  check('revoked source access denies board create and update save', () => {
    assert.equal(revokedCreate.status, 400);
    assert.match(revokedCreate.body.error.message, /source is not accessible/);
    assert.equal(revokedUpdate.status, 400);
    assert.match(revokedUpdate.body.error.message, /source is not accessible/);
    assert.equal(v11_0_0.revision, 3);
    assert.equal(v11_0_0.name, 'Legacy explicit save');
  });

  console.log(`# ${engine}: atomic bundle commits`);
  const bundleRoute = await import('@/app/api/boards/bundle/route');
  const { issueBundleConfirmation } = await import('@/lib/analyst/bundle');
  const task = randomUUID();
  const otherTask = randomUUID();
  const bundleBody = (extra: Record<string, unknown> = {}) => ({
    taskId: task,
    board: {
      type: 'mixed',
      name: 'Bundle board',
      parameters: {
        rows: [
          {
            id: 'r',
            columns: [
              {
                id: 'a',
                component: {
                  type: 'AnalysisWidget',
                  props: { analysisRef: 'a', visualization: 'metric' },
                },
              },
              {
                id: 'b',
                component: {
                  type: 'AnalysisWidget',
                  props: { analysisRef: 'b', visualization: 'line' },
                },
              },
            ],
          },
        ],
      },
    },
    analyses: [
      {
        ref: 'a',
        name: 'Bundle signups',
        definition: definition({ metric: 'events', event: 'signup' }),
      },
      {
        ref: 'b',
        name: 'Bundle series',
        definition: definition({ operation: 'series', metric: 'pageviews', unit: 'day' }),
      },
    ],
    ...extra,
  });
  const commit = (body: Record<string, unknown>, user = ids.owner) =>
    call(bundleRoute.POST, 'POST', '/api/boards/bundle', user, body);
  const counts = async () => ({
    boards: await client.board.count(),
    analyses: await client.savedAnalysis.count(),
    revisions: await client.savedAnalysisRevision.count(),
  });
  const beforeBundle = await counts();
  const bundled = await commit({ ...bundleBody(), operationKey: 'bundle-1' });
  const afterBundle = await counts();
  const bundleBoard = await client.board.findUnique({ where: { id: bundled.body.board?.id } });
  check('bundle commits one board + two analyses with revisions atomically', () => {
    assert.equal(bundled.status, 200, JSON.stringify(bundled.body));
    assert.equal(bundled.body.replayed, false);
    assert.deepEqual(afterBundle, {
      boards: beforeBundle.boards + 1,
      analyses: beforeBundle.analyses + 2,
      revisions: beforeBundle.revisions + 2,
    });
    const widgetIds = bundleBoard.parameters.rows[0].columns.map(
      (c: any) => c.component.props.analysisId,
    );
    assert.deepEqual(
      widgetIds,
      bundled.body.analyses.map((a: any) => a.id),
    );
    assert.ok(
      bundled.body.analyses.every((a: any) => a.createdByTaskId === task && a.status === 'draft'),
    );
    assert.equal(bundleBoard.userId, ids.owner);
  });
  const bundledExec = await call(
    execute.POST,
    'POST',
    `/api/analyses/${bundled.body.analyses[1].id}/execute`,
    ids.owner,
    {},
    { analysisId: bundled.body.analyses[1].id },
  );
  check('bundle-created series executes with correct UTC buckets on non-UTC session', () =>
    assert.deepEqual(bundledExec.body.rows, [
      { t: '2026-01-01T00:00:00Z', y: 3 },
      { t: '2026-01-02T00:00:00Z', y: 1 },
      { t: '2026-01-03T00:00:00Z', y: 1 },
    ]),
  );
  const bundleReplay = await commit({ ...bundleBody(), operationKey: 'bundle-1' });
  const bundleRacers = await Promise.all(
    [1, 2, 3].map(() => commit({ ...bundleBody(), operationKey: 'bundle-race' })),
  );
  const afterReplay = await counts();
  check('principal/task/key replay and concurrent same-key commits return the same board', () => {
    assert.equal(bundleReplay.body.replayed, true);
    assert.equal(bundleReplay.body.board.id, bundled.body.board.id);
    assert.ok(
      bundleRacers.every(r => r.status === 200),
      JSON.stringify(bundleRacers.map(r => r.body)),
    );
    assert.equal(new Set(bundleRacers.map(r => r.body.board.id)).size, 1);
    assert.deepEqual(afterReplay, {
      boards: afterBundle.boards + 1,
      analyses: afterBundle.analyses + 2,
      revisions: afterBundle.revisions + 2,
    });
  });
  const otherTaskCommit = await commit({
    ...bundleBody({ taskId: otherTask }),
    operationKey: 'bundle-1',
  });
  const strangerCommit = await commit({ ...bundleBody(), operationKey: 'bundle-1' }, ids.stranger);
  const keyConflict = await commit({
    ...bundleBody({ board: { ...bundleBody().board, name: 'Other' } }),
    operationKey: 'bundle-1',
  });
  check('same key is scoped by principal/task; changed request under a key conflicts', () => {
    assert.notEqual(otherTaskCommit.body.board.id, bundled.body.board.id);
    assert.equal(strangerCommit.status, 403, 'stranger has no source access');
    assert.equal(keyConflict.status, 409);
  });
  const afterReplayAll = await counts();
  const badRef = await commit({
    ...bundleBody({ analyses: [bundleBody().analyses[0]] }),
    operationKey: 'bundle-bad-ref',
  });
  const beforeRollback = await counts();
  check('unknown analysisRef is rejected before any write', () => {
    assert.equal(badRef.status, 400);
    assert.deepEqual(beforeRollback, afterReplayAll);
  });

  console.log(`# ${engine}: scoped confirmation for existing boards`);
  const target = bundled.body.board.id;
  const edit = (extra: Record<string, unknown> = {}) =>
    bundleBody({
      boardId: target,
      expectedRevision: 1,
      board: { ...bundleBody().board, name: 'Edited' },
      ...extra,
    });
  // Trusted host seam only (no HTTP mint). Mirrors route-level error mapping for assertions.
  const getAuthUser = (id: string) => ({ user: { id, isAdmin: false } }) as any;
  const confirm = async (body: Record<string, unknown>, user = ids.owner) => {
    try {
      const g = await issueBundleConfirmation(getAuthUser(user), body);
      return { status: 200, body: { confirmationId: g.id, diffHash: g.diffHash } };
    } catch (e: any) {
      return { status: e?.code === 'not_found' ? 404 : 400, body: { error: e?.message } };
    }
  };
  const { existsSync } = await import('node:fs');
  const selfMint = await commit({
    ...edit(),
    operationKey: 'edit-selfmint',
    confirmationId: randomUUID(),
  });
  check('no public self-service confirmation route; invented grant ids are denied', () => {
    assert.equal(existsSync('src/app/api/boards/bundle/confirm/route.ts'), false);
    assert.equal(selfMint.status, 403);
  });
  const unconfirmed = await commit({ ...edit(), operationKey: 'edit-none' });
  const grantOtherTask = await confirm(edit({ taskId: otherTask }));
  const crossTask = await commit({
    ...edit(),
    operationKey: 'edit-cross',
    confirmationId: grantOtherTask.body.confirmationId,
  });
  const grantOtherDiff = await confirm(
    edit({ board: { ...bundleBody().board, name: 'Something else' } }),
  );
  const crossDiff = await commit({
    ...edit(),
    operationKey: 'edit-diff',
    confirmationId: grantOtherDiff.body.confirmationId,
  });
  const strangerGrant = await confirm(edit(), ids.stranger);
  const { createConfirmation, hashBundle } = await import('@/queries/prisma/analysis');
  const exactHash = hashBundle({
    ...edit(),
    teamId: null,
    analyses: edit().analyses.map((a: any) => ({
      ...a,
      status: 'draft',
      definition: normalizeDefinition(a.definition),
    })),
  } as any);
  // Otherwise-matching grants that differ only in expiry or principal.
  const expired = await createConfirmation({
    userId: ids.owner,
    taskId: task,
    boardId: target,
    expectedRevision: 1,
    diffHash: exactHash,
    now: Date.now() - 11 * 60 * 1000,
  });
  const expiredUse = await commit({
    ...edit(),
    operationKey: 'edit-expired',
    confirmationId: expired.id,
  });
  const foreignGrant = await createConfirmation({
    userId: ids.stranger,
    taskId: task,
    boardId: target,
    expectedRevision: 1,
    diffHash: exactHash,
  });
  const foreignUse = await commit({
    ...edit(),
    operationKey: 'edit-foreign',
    confirmationId: foreignGrant.id,
  });
  const unchanged = await client.board.findUnique({ where: { id: target } });
  const afterDenied = await counts();
  check(
    'existing-board edit without/with wrong-task, wrong-diff, foreign-principal or expired (otherwise matching) grant is denied with no mutation',
    () => {
      for (const r of [unconfirmed, crossTask, crossDiff, expiredUse, foreignUse])
        assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(strangerGrant.status, 404, 'stranger cannot be issued a grant');
      assert.equal(unchanged.revision, 1);
      assert.equal(unchanged.name, 'Bundle board');
      assert.deepEqual(afterDenied, beforeRollback);
    },
  );
  // Revocation after issuance: a valid grant is useless once source authority is gone.
  const revokeGrant = await confirm(edit());
  await client.website.update({ where: { id: ids.website }, data: { userId: ids.stranger } });
  const revokedAfterIssue = await commit({
    ...edit(),
    operationKey: 'edit-revoked-after-issue',
    confirmationId: revokeGrant.body.confirmationId,
  });
  await client.website.update({ where: { id: ids.website }, data: { userId: ids.owner } });
  const afterRevokeIssue = await counts();
  const revokeBoard = await client.board.findUnique({ where: { id: target } });
  const revokeRow = await client.analysisConfirmation.findUnique({
    where: { id: revokeGrant.body.confirmationId },
  });
  check('authority revoked after grant issuance denies the commit with zero mutation', () => {
    assert.equal(revokedAfterIssue.status, 403, JSON.stringify(revokedAfterIssue.body));
    assert.deepEqual(afterRevokeIssue, beforeRollback);
    assert.equal(revokeRow.usedAt, null);
    assert.equal(revokeBoard.revision, 1);
  });
  // Stale grant: board advances after confirmation; the commit's CAS fails after the grant claim
  // and the new analyses were inserted, so the whole transaction must roll back.
  const staleGrant = await confirm(edit());
  check('confirmation grant is bound to the exact bundle hash', () =>
    assert.equal(staleGrant.body.diffHash, exactHash),
  );
  await client.board.update({ where: { id: target }, data: { revision: 2 } });
  const staleCommit = await commit({
    ...edit(),
    operationKey: 'edit-stale',
    confirmationId: staleGrant.body.confirmationId,
  });
  const afterStale = await counts();
  const staleRow = await client.analysisConfirmation.findUnique({
    where: { id: staleGrant.body.confirmationId },
  });
  const staleOp = await client.analysisOperation.count({ where: { key: 'edit-stale' } });
  check(
    'stale revision conflicts and rolls back analyses, grant claim and idempotency record',
    () => {
      assert.equal(staleCommit.status, 409, JSON.stringify(staleCommit.body));
      assert.deepEqual(afterStale, beforeRollback);
      assert.equal(staleRow.usedAt, null);
      assert.equal(staleOp, 0);
    },
  );
  const fresh = edit({ expectedRevision: 2 });
  const grant = await confirm(fresh);
  const confirmed = await commit({
    ...fresh,
    operationKey: 'edit-ok',
    confirmationId: grant.body.confirmationId,
  });
  await client.board.update({ where: { id: target }, data: { revision: 2 } });
  const reused = await commit({
    ...fresh,
    operationKey: 'edit-reuse',
    confirmationId: grant.body.confirmationId,
  });
  const afterReuse = await client.board.findUnique({ where: { id: target } });
  await client.board.update({ where: { id: target }, data: { revision: 3 } });
  const confirmedReplay = await commit({
    ...fresh,
    operationKey: 'edit-ok',
    confirmationId: grant.body.confirmationId,
  });
  check(
    'matching grant applies once; identical bundle under a fresh key cannot reuse it; same key replays',
    () => {
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      assert.equal(confirmed.body.board.id, target);
      assert.equal(confirmed.body.board.revision, 3);
      assert.equal(confirmed.body.board.name, 'Edited');
      assert.equal(reused.status, 403, 'same bundle + same revision, only the key differs');
      assert.equal(afterReuse.revision, 2);
      assert.equal(confirmedReplay.body.replayed, true);
      assert.equal(confirmedReplay.body.board.revision, 3);
    },
  );
  await client.website.update({ where: { id: ids.website }, data: { userId: ids.stranger } });
  const revokedBundle = await commit({ ...bundleBody(), operationKey: 'bundle-revoked' });
  await client.website.update({ where: { id: ids.website }, data: { userId: ids.owner } });
  check('revoked source denies bundle save', () => assert.equal(revokedBundle.status, 403));

  console.log(`# ${engine}: rolling/fixed saved definitions, fresh writes and process restart`);
  const savedRolling = await create('rolling-24h', {
    name: 'Rolling signups',
    definition: definition({
      metric: 'events',
      event: 'signup',
      datePolicy: { type: 'rolling', window: '24h' },
    }),
  });
  const savedFixed = await create('fixed-signups', {
    name: 'Fixed signups',
    definition: definition({ metric: 'events', event: 'signup' }),
  });
  const persisted = [savedRolling.body.analysis.id, savedFixed.body.analysis.id];
  const execSaved = (analysisId: string) =>
    call(
      execute.POST,
      'POST',
      `/api/analyses/${analysisId}/execute`,
      ids.owner,
      {},
      { analysisId },
    );
  const beforeFresh = await Promise.all(persisted.map(execSaved));
  check('before fresh writes: rolling 24h = 0, fixed = 3', () => {
    assert.equal(beforeFresh[0].body.rows[0].value, 0, JSON.stringify(beforeFresh[0].body));
    assert.equal(beforeFresh[1].body.rows[0].value, 3);
  });
  const now = Date.now();
  await writeFreshSignups(client, [
    now - 60 * 60 * 1000,
    now - 2 * 60 * 60 * 1000,
    now - 48 * 60 * 60 * 1000,
  ]);
  const afterFresh = await Promise.all(persisted.map(execSaved));
  check('after fresh writes: rolling 24h = 2 (48h-old excluded), fixed stays 3', () => {
    assert.equal(afterFresh[0].body.rows[0].value, 2, JSON.stringify(afterFresh[0].body));
    assert.equal(afterFresh[1].body.rows[0].value, 3);
    assert.ok(afterFresh[0].body.range.endAt >= now);
  });
  const childOut = execFileSync(
    path.resolve('node_modules/.bin/tsx'),
    ['scripts/test-analyst-api.ts', `--${engine === 'clickhouse' ? 'clickhouse' : 'postgres'}`],
    {
      env: {
        ...process.env,
        ANALYST_RESTART_CHILD: JSON.stringify({
          namespace,
          owner: ids.owner,
          analysisIds: persisted,
        }),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  const restarted = JSON.parse(childOut.split('RESTART_RESULT ')[1]);
  check(
    'restarted process executes persisted definitions with identical semantics and results',
    () => {
      assert.notEqual(restarted.pid, process.pid);
      restarted.out.forEach((r: any, i: number) => {
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(r.body.definition, afterFresh[i].body.definition);
        assert.equal(r.body.definitionHash, afterFresh[i].body.definitionHash);
        assert.deepEqual(r.body.range.policy, afterFresh[i].body.range.policy);
        assert.deepEqual(r.body.appliedFilters, afterFresh[i].body.appliedFilters);
      });
      assert.equal(restarted.out[0].body.rows[0].value, 2);
      assert.equal(restarted.out[1].body.rows[0].value, 3);
      assert.equal(restarted.out[1].body.range.startAt, RANGE.startAt);
      assert.equal(restarted.out[1].body.range.endAt, RANGE.endAt);
    },
  );

  console.log(`# ${engine}: flag off keeps saved execution available`);
  delete process.env.AI_ANALYST_ENABLED;
  const offExec = await call(
    execute.POST,
    'POST',
    `/api/analyses/${id}/execute`,
    ids.owner,
    {},
    { analysisId: id },
  );
  const offPatch = await patch({ operationKey: 'off', expectedRevision: 4, name: 'off' });
  check('flag off: saved execution works, mutation is disabled', () => {
    assert.equal(offExec.status, 200);
    assert.equal(offPatch.status, 404);
  });
}

main().catch(error => {
  console.error(`FAIL ${engine} after ${checks} checks:`, error);
  process.exit(1);
});
