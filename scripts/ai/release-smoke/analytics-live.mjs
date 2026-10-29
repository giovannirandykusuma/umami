#!/usr/bin/env node
// Dedicated synthetic-only baseline/candidate replay. No production connections accepted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveGateway } from '../gateway-config.mjs';

const revisions = {
  baseline: '7db2d49212c258a89c1cc4f10e3d71e1d8b97388',
  candidate: '6ae9baad76f36672fd9c122a94ac0c418ae8e4f6',
};
const start = Date.parse('2026-01-01T00:00:00+07:00');
const owner = randomUUID();
const sites = { A: randomUUID(), B: randomUUID() };
const prefix = `analytics-eval-${randomBytes(6).toString('hex')}`;
const db = `${prefix}-db`, network = `${prefix}-net`, app = `${prefix}-app`;
const marker = `${prefix}-synthetic-only`;
const secret = randomBytes(32).toString('hex');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
function seed() {
  const rows = [
    'CREATE TABLE ai_analytics_owner (owner text NOT NULL);',
    `INSERT INTO ai_analytics_owner VALUES (${quote(marker)});`,
    `INSERT INTO "user" (user_id,username,password,role) VALUES ('${owner}','synthetic-owner','not-a-login','user');`,
    ...Object.entries(sites).map(([name, id]) => `INSERT INTO website (website_id,name,domain,user_id) VALUES ('${id}','Synthetic ${name}','synthetic.invalid','${owner}');`),
  ];
  function event(session, site, time, type, name) {
    rows.push(`INSERT INTO website_event (event_id,session_id,website_id,visit_id,created_at,event_type,event_name,url_path) VALUES ('${randomUUID()}','${session}','${site}','${randomUUID()}','${new Date(time).toISOString()}'::timestamptz,${type},${quote(name)},'/');`);
  }
  const people = ['u_1', 'u_1', 'u_1', 'u_2', '', ...Array.from({ length: 12 }, (_, i) => `staff_${i}`)];
  people.forEach((distinct, index) => {
    const session = randomUUID();
    rows.push(`INSERT INTO session (session_id,website_id,distinct_id) VALUES ('${session}','${sites.A}',${quote(distinct)});`);
    const name = distinct === 'u_1' ? 'Dewi Anggraini' : distinct === 'u_2' ? 'Dewi Ayu' : distinct === '' ? 'Dewi Anonymous' : `Staff ${distinct.slice(6).padStart(2, '0')}`;
    for (const [key, value] of [['name', name], ['email', distinct === 'u_1' ? 'dewi@example.invalid' : `${distinct}@example.invalid`]]) {
      rows.push(`INSERT INTO session_data (session_data_id,website_id,session_id,distinct_id,data_key,string_value,data_type,created_at) VALUES ('${randomUUID()}','${sites.A}','${session}',${quote(distinct)},${quote(key)},${quote(value)},1,'${new Date(start + 3600000).toISOString()}'::timestamptz);`);
    }
    if (distinct === 'u_2') event(session, sites.A, start + 3600000, 2, 'login');
    if (index === 0) for (let day = 0; day < 7; day++) if (day !== 3) for (let i = 0; i <= day; i++) event(session, sites.A, start + day * 86400000 + 3600000, 2, 'ui.element_clicked');
  });
  const boundary = randomUUID();
  rows.push(`INSERT INTO session (session_id,website_id,distinct_id) VALUES ('${boundary}','${sites.B}','boundary');`);
  event(boundary, sites.B, start - 1000, 1, '');
  event(boundary, sites.B, start + 1000, 1, '');
  return rows.join('\n');
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `${command} ${args[0]} failed: ${(result.stderr || '').slice(0, 500)}`);
  return result.stdout.trim();
}
const docker = args => run('docker', args);
const sql = input => run('docker', ['exec', '-i', db, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'synthetic', '-d', 'synthetic'], { input });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function token() {
  const password = createHash('sha512').update(secret).digest('hex');
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ userId: owner, exp: Math.floor(Date.now() / 1000) + 21600 })}`;
  const jwt = `${unsigned}.${createHmac('sha256', password).update(unsigned).digest('base64url')}`;
  const salt = randomBytes(64), iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', pbkdf2Sync(password, salt, 10000, 32, 'sha512'), iv);
  const encrypted = Buffer.concat([cipher.update(jwt), cipher.final()]);
  return Buffer.concat([salt, iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
// Invoked before the image's normal startup, migrations, or server process.
const geoCheck = `const assert = require('node:assert/strict');
(async () => {
  const reader = await require(process.argv[1]).open(process.argv[2]);
  assert.equal(reader.metadata.databaseType, 'GeoLite2-City');
  assert.ok(reader.get('8.8.8.8')?.country?.iso_code);
  console.log('Valid GeoLite2-City database; lookup passed.');
})().catch(() => { console.error('Missing or invalid GeoLite2-City database'); process.exit(1); });`;
const seedSql = seed();
if (process.argv.includes('--self-test')) {
  assert.equal((seedSql.match(/INSERT INTO session \(/g) || []).length, 18);
  assert.equal((seedSql.match(/INSERT INTO session_data /g) || []).length, 34);
  assert.equal((seedSql.match(/INSERT INTO website_event /g) || []).length, 27);
  assert.equal((seedSql.match(/'ui.element_clicked'/g) || []).length, 24);
  assert.equal((seedSql.match(/'login'/g) || []).length, 1);
  const plan = JSON.parse(run('node', ['scripts/ai/eval-analytics.mjs', '--plan']));
  assert.match(plan.fixtureHash, /^[a-f0-9]{64}$/);
  const encrypted = Buffer.from(token(), 'base64');
  const password = createHash('sha512').update(secret).digest('hex');
  const decipher = createDecipheriv('aes-256-gcm', pbkdf2Sync(password, encrypted.subarray(0, 64), 10000, 32, 'sha512'), encrypted.subarray(64, 80));
  decipher.setAuthTag(encrypted.subarray(80, 96));
  const jwt = Buffer.concat([decipher.update(encrypted.subarray(96)), decipher.final()]).toString();
  const [header, body, signature] = jwt.split('.');
  assert.equal(signature, createHmac('sha256', password).update(`${header}.${body}`).digest('base64url'));
  assert.equal(JSON.parse(Buffer.from(body, 'base64url')).userId, owner);
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'HS256');
  console.log('Fixture/config hash and secure bearer auth round-trip passed.');
  console.log('Synthetic seed self-test: 18 sessions, 34 properties, 27 events; 24 clicks, 1 login, 2 pageviews. No requests or spend.');
} else {
  assert.equal(process.env.AI_ANALYTICS_APPROVE_SPEND, 'Randy-approved-synthetic-only');
  const output = resolve(process.env.ANALYTICS_REPORT_DIR || '');
  assert.ok(process.env.ANALYTICS_REPORT_DIR && !output.startsWith(process.cwd() + '/'), 'private output outside worktree required');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const save = (name, data) => writeFileSync(join(output, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const gateway = resolveGateway(JSON.parse(readFileSync(join(homedir(), '.pi/agent/9router-config.json'), 'utf8')));
  const plan = JSON.parse(run('node', ['scripts/ai/eval-analytics.mjs', '--plan']));
  const images = {};
  for (const label of Object.keys(revisions)) {
    const image = process.env[`ANALYTICS_${label.toUpperCase()}_IMAGE`];
    assert.match(image || '', /^sha256:[a-f0-9]{64}$/);
    const inspect = JSON.parse(docker(['image', 'inspect', image]))[0];
    if (label === 'candidate') {
      assert.equal(image, 'sha256:081812c5b2cb1d56fe3563f5f38e17d91c0be994459fbed848f0b624d30cd54c', 'MAIN-attested immutable candidate');
    } else assert.equal(inspect.Config.Labels['org.opencontainers.image.revision'], revisions[label]);
    images[label] = { id: image, revision: revisions[label] };
    // Extract from a stopped container: reject invalid geo before any app starts.
    // Standalone images bundle maxmind into Next chunks, so validate via host module.
    assert.ok(process.env.ANALYTICS_MAXMIND_MODULE, 'absolute host maxmind module path required');
    const probe = docker(['create', '--platform', 'linux/amd64', image]);
    const geoPath = join(output, `${label}-GeoLite2-City.mmdb`);
    try { docker(['cp', `${probe}:/app/geo/GeoLite2-City.mmdb`, geoPath]); }
    finally { docker(['rm', probe]); }
    chmodSync(geoPath, 0o600);
    const geo = run('node', ['-e', geoCheck, process.env.ANALYTICS_MAXMIND_MODULE, geoPath]);
    save(`${label}-geo-check.txt`, geo);
  }
  const receipt = { version: 'analytics.integration.test.ts/5B', marker, owner, sites, seedHash: createHash('sha256').update(seedSql).digest('hex'), images, fixtureHash: plan.fixtureHash, model: 'nine-router cx/gpt-6.1-sol reasoning=medium', evaluatorHash: createHash('sha256').update(readFileSync('scripts/ai/eval-analytics.mjs')).digest('hex') };
  const envfile = join(output, 'app.env');
  let networkCreated = false, dbCreated = false, appCreated = false;
  try {
    docker(['network', 'create', network]); networkCreated = true;
    docker(['run', '-d', '--name', db, '--network', network, '--network-alias', 'synthetic-db', '-e', 'POSTGRES_USER=synthetic', '-e', 'POSTGRES_PASSWORD=synthetic-only', '-e', 'POSTGRES_DB=synthetic', 'postgres:16-alpine']); dbCreated = true;
    let ready = false;
    for (let i = 0; i < 90; i++) {
      if (spawnSync('docker', ['exec', db, 'pg_isready', '-U', 'synthetic']).status === 0) { ready = true; break; }
      await delay(1000);
    }
    assert.ok(ready, 'synthetic database not ready');
    const env = { DATABASE_URL: 'postgresql://synthetic:synthetic-only@synthetic-db:5432/synthetic', APP_SECRET: secret, AI_ENABLED: 'true', AI_PI_ROOT: '/opt/umami-ai/node_modules/@earendil-works/pi-coding-agent', DISABLE_TELEMETRY: '1', ...gateway };
    let counts;
    for (const label of Object.keys(revisions)) {
      writeFileSync(envfile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'), { mode: 0o600 });
      docker(['run', '-d', '--platform', 'linux/amd64', '--name', app, '--network', network, '--memory', '1g', '--env-file', envfile, '-p', '127.0.0.1::3000', images[label].id]); appCreated = true;
      rmSync(envfile);
      const origin = `http://127.0.0.1:${docker(['port', app, '3000/tcp']).split(':').at(-1)}`;
      ready = false;
      for (let i = 0; i < 180; i++) {
        try { ready = (await fetch(`${origin}/api/heartbeat`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
        if (ready) break;
        await delay(1000);
      }
      assert.ok(ready, `${label} app not ready`);
      if (label === 'baseline') {
        sql(seedSql);
        counts = sql('SELECT (SELECT count(*) FROM "user" WHERE role=\'user\'),(SELECT count(*) FROM website),(SELECT count(*) FROM session),(SELECT count(*) FROM session_data),(SELECT count(*) FROM website_event);');
        assert.equal(counts, '1|2|18|34|27');
        assert.equal(sql('SELECT owner FROM ai_analytics_owner;'), marker);
        receipt.counts = counts;
        save('seed-receipt.json', receipt);
        save('seed.sql', seedSql);
      }
      assert.equal(sql('SELECT owner FROM ai_analytics_owner;'), marker);
      // Separate short-lived website keeps the evaluation fixture unchanged.
      const smokeSite = randomUUID();
      sql(`INSERT INTO website (website_id,name,domain,user_id) VALUES ('${smokeSite}','Synthetic ingest gate','synthetic.invalid','${owner}');`);
      const smokeMarker = `release-ingest-${randomUUID().replaceAll('-', '')}`;
      assert.equal(smokeMarker.length, 47);
      const statuses = [];
      for (const eventName of [undefined, smokeMarker]) {
      const smoke = await fetch(`${origin}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' },
        body: JSON.stringify({ type: 'event', payload: { website: smokeSite, hostname: 'synthetic.invalid', url: `/${smokeMarker}`, name: eventName, ip: '8.8.8.8' } }),
        signal: AbortSignal.timeout(30000),
      });
      await smoke.text();
      statuses.push(smoke.status);
      assert.equal(smoke.status, 200, `${label} synthetic ingest must return 200`);
      }
      const arrival = sql(`SELECT count(*) FILTER (WHERE e.event_type=1),count(*) FILTER (WHERE e.event_type=2 AND e.event_name='${smokeMarker}'),count(*) FILTER (WHERE s.country IS NOT NULL) FROM website_event e JOIN session s ON s.session_id=e.session_id WHERE e.website_id='${smokeSite}' AND e.url_path='/${smokeMarker}';`);
      assert.equal(arrival, '1|1|2', `${label} pageview, event and geo must arrive in isolated DB`);
      save(`${label}-ingest-gate.json`, { statuses, arrival, website: smokeSite, marker: smokeMarker });
      sql(`DELETE FROM website_event WHERE website_id='${smokeSite}'; DELETE FROM session WHERE website_id='${smokeSite}'; DELETE FROM website WHERE website_id='${smokeSite}';`);
      const authCheck = await fetch(`${origin}/api/websites/${sites.A}`, { headers: { Authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(10000) });
      assert.equal(authCheck.status, 200, 'synthetic non-admin auth contract');
      assert.equal((await authCheck.json()).domain, 'synthetic.invalid');
      const config = { syntheticOnly: true, fixtureHash: plan.fixtureHash, origin, sites, model: receipt.model, revision: revisions[label], seedReceipt: JSON.stringify(receipt) };
      save(`${label}-config.json`, config);
      console.log(`Running ${label}: ${revisions[label]} ${images[label].id}; dedicated synthetic DB; six cases.`);
      const result = spawnSync('node', ['scripts/ai/eval-analytics.mjs', '--live', join(output, `${label}-config.json`), label, join(output, `${label}.json`)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, AI_ANALYTICS_SYNTHETIC_TOKEN: token() } });
      save(`${label}-runner.log`, result.stdout + result.stderr);
      assert.equal(result.status, 0, `${label} evaluator failed; see private runner log`);
      const report = JSON.parse(readFileSync(join(output, `${label}.json`), 'utf8'));
      console.log(`${label}: ${report.score.passed}/6 (${report.score.rate}); details in private report.`);
      assert.equal(sql('SELECT (SELECT count(*) FROM "user" WHERE role=\'user\'),(SELECT count(*) FROM website),(SELECT count(*) FROM session),(SELECT count(*) FROM session_data),(SELECT count(*) FROM website_event);'), counts);
      assert.equal(sql('SELECT count(*) FROM ai_chat;'), '0');
      docker(['rm', '-f', app]); appCreated = false;
    }
    const comparison = JSON.parse(run('node', ['scripts/ai/eval-analytics.mjs', '--compare', join(output, 'baseline.json'), join(output, 'candidate.json')]));
    save('comparison.json', comparison);
    console.log(JSON.stringify(comparison, null, 2));
    console.log(comparison.delta <= 0 ? 'STOP: candidate did not improve. No deploy authorized.' : 'Improvement observed in six cases only; not statistical proof. No deploy authorized.');
  } finally {
    rmSync(envfile, { force: true });
    if (appCreated) {
      save('app-error.log', docker(['logs', app]));
      docker(['rm', '-f', app]);
    }
    if (dbCreated) {
      // Preserve the isolated seed and transcripts before deleting only our own containers.
      save('synthetic-db.sql', docker(['exec', db, 'pg_dump', '-U', 'synthetic', 'synthetic']));
      docker(['rm', '-f', db]);
    }
    if (networkCreated) docker(['network', 'rm', network]);
  }
}
