#!/usr/bin/env node
// Live synthetic check of the global assistant against a built image + real gateway.
// Invented data only; provider key enters via env file (mode 0600) and is deleted after launch.
// Usage: AI_BASE_URL=... AI_PROVIDER_KEY=... RELEASE_SMOKE_IMAGE=sha256:... node scripts/ai/release-smoke/assistant-live.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  createCipheriv,
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGateway } from '../gateway-config.mjs';
import { pathToFileURL } from 'node:url';

// The IP in the payload bypasses provider location headers, exercising the mmdb.
export async function ingestGate({ origin, website, sql, request = fetch }) {
  const marker = `release-ingest-${randomUUID()}`;
  const url = `/${marker}`;
  const statuses = [];
  for (const name of [undefined, marker]) {
    const response = await request(`${origin}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'event', payload: {
        website, hostname: 'ingest.invalid', url, name, ip: '8.8.8.8',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      } }),
      signal: AbortSignal.timeout(15_000),
    });
    statuses.push(response.status);
    assert.equal(response.status, 200, 'synthetic ingestion must return HTTP 200');
  }
  const rows = await sql(`SELECT count(*) FILTER (WHERE e.event_type=1), count(*) FILTER (WHERE e.event_type=2 AND e.event_name='${marker}'), count(*) FILTER (WHERE s.country IS NOT NULL) FROM website_event e JOIN session s ON s.session_id=e.session_id WHERE e.website_id='${website}' AND e.url_path='${url}';`);
  assert.equal(String(rows).trim(), '1|1|2', 'pageview, named event and geo session must persist');
  return { statuses, persistedPageviews: 1, persistedEvents: 1, geolocatedRows: 2 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const ingestOnly = process.env.RELEASE_SMOKE_INGEST_ONLY === '1';
const image = process.env.RELEASE_SMOKE_IMAGE;
assert.match(image || '', /^sha256:[0-9a-f]{64}$/, 'RELEASE_SMOKE_IMAGE=sha256:<id> required');
const prefix = `assistant-smoke-${randomBytes(4).toString('hex')}`;
const network = `${prefix}-net`,
  db = `${prefix}-db`,
  app = `${prefix}-app`;
const temp = mkdtempSync(join(tmpdir(), 'assistant-smoke-'));
const secret = randomBytes(32).toString('hex');
const evidence = { image, turns: [] };
const delay = ms => new Promise(r => setTimeout(r, ms));
function docker(args, input) {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0)
    throw new Error(`docker ${args[0]} failed: ${(r.stderr || '').slice(0, 300)}`);
  return r.stdout.trim();
}
const sql = q =>
  docker(
    [
      'exec',
      '-i',
      db,
      'psql',
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'synthetic',
      '-d',
      'synthetic',
    ],
    q,
  );
function token(userId) {
  const password = createHash('sha512').update(secret).digest('hex');
  const part = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ userId, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const jwt = `${unsigned}.${createHmac('sha256', password).update(unsigned).digest('base64url')}`;
  const salt = randomBytes(64),
    iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', pbkdf2Sync(password, salt, 10000, 32, 'sha512'), iv);
  const enc = Buffer.concat([cipher.update(jwt), cipher.final()]);
  return Buffer.concat([salt, iv, cipher.getAuthTag(), enc]).toString('base64');
}

async function turn(origin, auth, chatId, message, onPart) {
  const res = await fetch(`${origin}/api/ai/assistant/chats/${chatId}/turn`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message, context: { timezone: 'UTC' } }),
    signal: AbortSignal.timeout(300_000),
  });
  assert.equal(res.status, 200, `turn status ${res.status}`);
  const counts = {};
  let buffer = '',
    final;
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
      const frame = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const type = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.*)$/m)?.[1];
      if (!type || !data) continue;
      counts[type] = (counts[type] || 0) + 1;
      const event = JSON.parse(data);
      if (type === 'part') await onPart?.(event.part);
      if (type === 'done' || type === 'error') final = { type, event };
    }
  }
  return { counts, final };
}

try {
  const gateway = ingestOnly ? {} : resolveGateway(process.env);
  docker(['network', 'create', network]);
  docker([
    'run',
    '-d',
    '--name',
    db,
    '--network',
    network,
    '--network-alias',
    'synthetic-db',
    '-e',
    'POSTGRES_USER=synthetic',
    '-e',
    'POSTGRES_PASSWORD=synthetic-only',
    '-e',
    'POSTGRES_DB=synthetic',
    'postgres:16-alpine',
  ]);
  for (
    let i = 0;
    i < 90 && spawnSync('docker', ['exec', db, 'pg_isready', '-U', 'synthetic']).status !== 0;
    i++
  )
    await delay(1000);
  const envfile = join(temp, 'app.env');
  const env = {
    DATABASE_URL: 'postgresql://synthetic:synthetic-only@synthetic-db:5432/synthetic',
    APP_SECRET: secret,
    AI_ENABLED: ingestOnly ? 'false' : 'true',
    AI_PI_ROOT: '/opt/umami-ai/node_modules/@earendil-works/pi-coding-agent',
    DISABLE_TELEMETRY: '1',
    ...gateway,
  };
  writeFileSync(
    envfile,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    { mode: 0o600 },
  );
  docker([
    'run',
    '-d',
    '--platform',
    'linux/amd64',
    '--name',
    app,
    '--network',
    network,
    '--memory',
    '1g',
    '--env-file',
    envfile,
    '-p',
    '127.0.0.1::3000',
    image,
  ]);
  rmSync(envfile);
  const origin = `http://127.0.0.1:${docker(['port', app, '3000/tcp']).split(':').at(-1)}`;
  let ready = false;
  for (let i = 0; i < 180 && !ready; i++) {
    try {
      ready = (await fetch(`${origin}/api/heartbeat`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {}
    if (!ready) await delay(1000);
  }
  assert.ok(ready, 'app not ready');

  // Invented user, three invented websites with invented traffic over the last 14 days.
  const user = randomUUID(),
    other = randomUUID();
  const sites = [
    ['Alpha app', 'alpha.invalid'],
    ['Beta app', 'beta.invalid'],
    ['Gamma app', 'gamma.invalid'],
  ].map(([n, d]) => ({ id: randomUUID(), name: n, domain: d }));
  sql(
    `INSERT INTO "user" (user_id,username,password,role) VALUES ('${user}','synthetic-owner','x','user'),('${other}','synthetic-other','x','user');`,
  );
  const victimBoard = randomUUID();
  sql(
    sites
      .map(
        s =>
          `INSERT INTO website (website_id,name,domain,user_id) VALUES ('${s.id}','${s.name}','${s.domain}','${user}');`,
      )
      .join('') +
      `INSERT INTO board (board_id,type,name,description,parameters,user_id) VALUES ('${victimBoard}','mixed','Delete me','synthetic','{"rows":[]}','${user}');`,
  );
  // Mandatory before seeded traffic or any paid model turns. Never seed these rows.
  evidence.ingestion = await ingestGate({ origin, website: sites[0].id, sql });
  if (ingestOnly) {
    evidence.status = 'passed';
    console.log(JSON.stringify(evidence, null, 2));
  } else {
  const rows = [];
  sites.forEach((s, si) => {
    for (let d = 0; d < 14; d++)
      for (let v = 0; v < 3 + si * 2 + (d % 4); v++) {
        const sess = randomUUID(),
          ts = `now() - interval '${d} days' - interval '${v} minutes'`;
        rows.push(
          `INSERT INTO session (session_id,website_id,created_at) VALUES ('${sess}','${s.id}',${ts}); INSERT INTO website_event (event_id,website_id,session_id,visit_id,url_path,event_type,created_at) VALUES ('${randomUUID()}','${s.id}','${sess}','${randomUUID()}','/',1,${ts});`,
        );
      }
  });
  sql(rows.join(''));
  const auth = { Authorization: `Bearer ${token(user)}` };
  const otherAuth = { Authorization: `Bearer ${token(other)}` };

  assert.equal((await fetch(`${origin}/api/ai/assistant/chats`)).status, 401);
  const chat = await (
    await fetch(`${origin}/api/ai/assistant/chats`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: '{}',
    })
  ).json();
  assert.ok(chat.id, 'chat created');
  assert.equal(
    (await fetch(`${origin}/api/ai/assistant/chats/${chat.id}`, { headers: otherAuth })).status,
    404,
    'foreign chat hidden',
  );

  // Turn 1: compare chart across all three sites, as a new board.
  const t1 = await turn(
    origin,
    auth,
    chat.id,
    'Compare unique visitors of all three of my websites over the last 14 days in one chart with one line per website, and save it as a new board called "Apps compare". Do not ask me questions; just do it.',
  );
  const parts1 = t1.final?.event?.message?.parts || [];
  const board = JSON.parse(
    sql(
      `SELECT coalesce(json_agg(json_build_object('id',board_id,'name',name,'parameters',parameters)),'[]') FROM board WHERE user_id='${user}' AND board_id <> '${victimBoard}';`,
    ),
  );
  const compare = board
    .flatMap(b => b.parameters.rows?.flatMap(r => r.columns.map(c => c.component)) || [])
    .find(c => c?.type === 'WebsiteCompareChart');
  evidence.turns.push({
    name: 'compare-board',
    error: t1.final?.event?.error,
    final: t1.final?.type,
    counts: t1.counts,
    partTypes: parts1.map(p => p.type),
    tools: parts1.filter(p => p.type === 'tool').map(p => `${p.status} ${p.title}`),
    boardsCreated: board.map(b => b.name),
    compareSites: compare?.props?.websiteIds?.length || 0,
    chartPart: parts1.some(p => p.type === 'chart'),
    text: parts1
      .filter(p => p.type === 'text')
      .map(p => p.text)
      .join('\n')
      .slice(0, 600),
  });

  // Turn 2: delete request → confirm part → reject → board must survive.
  let confirmSeen = false;
  const t2 = await turn(origin, auth, chat.id, 'Delete my board named "Delete me".', async part => {
    if (part.type === 'confirm' && part.state === 'pending') {
      confirmSeen = true;
      const r = await fetch(`${origin}/api/ai/assistant/chats/${chat.id}/reply`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ partId: part.id, kind: 'confirm', confirmed: false }),
      });
      evidence.rejectStatus = r.status;
    }
  });
  const survived = sql(`SELECT count(*) FROM board WHERE board_id='${victimBoard}';`);
  evidence.turns.push({
    name: 'delete-rejected',
    error: t2.final?.event?.error,
    final: t2.final?.type,
    counts: t2.counts,
    confirmSeen,
    boardSurvived: survived === '1',
    tools: (t2.final?.event?.message?.parts || [])
      .filter(p => p.type === 'tool')
      .map(p => `${p.status} ${p.title}`),
  });

  const history = await (
    await fetch(`${origin}/api/ai/assistant/chats/${chat.id}`, { headers: auth })
  ).json();
  evidence.historyMessages = history.messages?.length;
  evidence.thinkingStreamed = (t1.counts.thinking_delta || 0) + (t2.counts.thinking_delta || 0);
  evidence.memory = docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', app]);

  const ok =
    evidence.turns[0].final === 'done' &&
    evidence.turns[0].compareSites === 3 &&
    confirmSeen &&
    survived === '1' &&
    evidence.historyMessages >= 4;
  evidence.status = ok ? 'passed' : 'failed';
  console.log(JSON.stringify(evidence, null, 2));
  process.exitCode = ok ? 0 : 1;
  }
} catch (error) {
  evidence.status = 'error';
  evidence.error = String(error?.message || error).slice(0, 500);
  console.log(JSON.stringify(evidence, null, 2));
  process.exitCode = 1;
} finally {
  if (process.env.KEEP !== '1')
    for (const c of [app, db]) spawnSync('docker', ['rm', '-f', c], { stdio: 'ignore' });
  if (process.env.KEEP !== '1')
    spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  rmSync(temp, { recursive: true, force: true });
}
}
