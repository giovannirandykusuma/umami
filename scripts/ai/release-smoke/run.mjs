#!/usr/bin/env node
// Generic synthetic-only runner. Provider secrets enter via environment, never argv/logs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGateway } from '../gateway-config.mjs';

const image =
  process.env.RELEASE_SMOKE_IMAGE ||
  'sha256:45255af191b2be5988728fb0da8588153d9c49209697ac5c83a64af2ce8dca9f';
assert.match(image, /^sha256:[0-9a-f]{64}$/);
const prefix = `release-smoke-${randomBytes(5).toString('hex')}`;
const network = `${prefix}-net`, db = `${prefix}-db`, app = `${prefix}-app`;
const temp = mkdtempSync(join(tmpdir(), 'release-smoke-'));
const secret = randomBytes(32).toString('hex');
const evidence = { image, status: 'starting', phases: [] };
function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('docker-operation-failed');
  return result.stdout.trim();
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function sql(query) { return docker(['exec', '-i', db, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'synthetic', '-d', 'synthetic'], query); }
function token(userId) {
  const password = createHash('sha512').update(secret).digest('hex');
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ userId, exp: Math.floor(Date.now() / 1000) + 1800 })}`;
  const jwt = `${unsigned}.${createHmac('sha256', password).update(unsigned).digest('base64url')}`;
  const salt = randomBytes(64), iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', pbkdf2Sync(password, salt, 10000, 32, 'sha512'), iv);
  const encrypted = Buffer.concat([cipher.update(jwt), cipher.final()]);
  return Buffer.concat([salt, iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
const snapshot = () => sql(`SELECT json_build_object('boards',(SELECT json_agg(b ORDER BY board_id) FROM board b),'reports',(SELECT json_agg(r ORDER BY report_id) FROM report r))::text;`);
// Read only numeric resource data; never emit command lines, child output or payloads.
const meter = `const fs=require('fs');let pi=0,app=0,children=0;for(const p of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{const cmd=fs.readFileSync('/proc/'+p+'/cmdline','utf8');if(!cmd.startsWith('node\\0'))continue;const rss=Number(fs.readFileSync('/proc/'+p+'/status','utf8').match(/VmRSS:\\s+(\\d+)/)?.[1]||0)*1024;if(cmd.includes('scripts/ai/native.mjs')){pi+=rss;children++}else if(p==='1')app+=rss;}catch{}}console.log(JSON.stringify({cgroup:Number(fs.readFileSync('/sys/fs/cgroup/memory.current','utf8')),cgroupLifetimePeak:Number(fs.readFileSync('/sys/fs/cgroup/memory.peak','utf8')),appRss:app,piRss:pi,children}));`;
try {
  const gateway = resolveGateway(process.env);
  const metadata = JSON.parse(docker(['image', 'inspect', image]));
  assert.equal(metadata[0].Architecture, 'amd64');
  evidence.runtime = JSON.parse(docker(['run', '--rm', '--platform', 'linux/amd64', '--entrypoint', 'node', image, '-e', `console.log(JSON.stringify({node:process.version,pi:require('/opt/umami-ai/node_modules/@earendil-works/pi-coding-agent/package.json').version}))`]));
  assert.match(evidence.runtime.node, /^v22\./);
  assert.equal(evidence.runtime.pi, '1.4.0');
  docker(['network', 'create', network]);
  docker(['run', '-d', '--name', db, '--network', network, '--network-alias', 'synthetic-db', '-e', 'POSTGRES_USER=synthetic', '-e', 'POSTGRES_PASSWORD=synthetic-only', '-e', 'POSTGRES_DB=synthetic', 'postgres:16-alpine']);
  let ready = false;
  for (let i = 0; i < 90; i++) {
    const result = spawnSync('docker', ['exec', db, 'pg_isready', '-U', 'synthetic'], { stdio: 'ignore' });
    if (result.status === 0) { ready = true; break; }
    await delay(1000);
  }
  assert.ok(ready);
  const env = {
    DATABASE_URL: 'postgresql://synthetic:synthetic-only@synthetic-db:5432/synthetic',
    APP_SECRET: secret, AI_ENABLED: 'true', AI_PI_ROOT: '/opt/umami-ai/node_modules/@earendil-works/pi-coding-agent',
    ...gateway, DISABLE_TELEMETRY: '1',
    ...(process.env.RELEASE_SMOKE_DIAGNOSTIC === '1' ? { NODE_OPTIONS: '--require=/tmp/release-smoke-diagnostic.cjs' } : {}),
  };
  const envfile = join(temp, 'app.env');
  writeFileSync(envfile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'), { mode: 0o600 });
  // Docker assigns an unused loopback port: no fixed-port takeover, production mounts or host credentials.
  const diagnosticMount = process.env.RELEASE_SMOKE_DIAGNOSTIC === '1'
    ? ['--mount', `type=bind,src=${join(process.cwd(), 'scripts/ai/release-smoke/diagnostic.cjs')},dst=/tmp/release-smoke-diagnostic.cjs,readonly`]
    : [];
  docker(['run', '-d', '--platform', 'linux/amd64', '--name', app, '--network', network, '--memory', '2g', '--env-file', envfile, ...diagnosticMount, '-p', '127.0.0.1::3000', image]);
  rmSync(envfile);
  const port = docker(['port', app, '3000/tcp']).split(':').at(-1);
  const origin = `http://127.0.0.1:${port}`;
  ready = false;
  for (let i = 0; i < 180; i++) {
    try { const res = await fetch(`${origin}/api/heartbeat`, { signal: AbortSignal.timeout(2000) }); if (res.ok) { ready = true; break; } } catch {}
    await delay(1000);
  }
  assert.ok(ready, 'app-readiness-failed');
  const websites = Array.from({ length: 3 }, () => randomUUID());
  const users = Array.from({ length: 3 }, () => randomUUID());
  const boards = Array.from({ length: 3 }, () => randomUUID());
  const original = { rows: [{ id: 'original-row', columns: [{ id: 'original-col', component: { type: 'TextBlock', props: { text: 'Invented original' } } }] }] };
  users.forEach((user, i) => sql(`INSERT INTO "user" (user_id,username,password,role) VALUES ('${user}','synthetic-${i}','synthetic','user'); INSERT INTO website (website_id,name,domain,user_id) VALUES ('${websites[i]}','Synthetic website','invented.invalid','${user}'); INSERT INTO board (board_id,type,name,description,parameters,user_id) VALUES ('${boards[i]}','website','Synthetic board','Invented only','${JSON.stringify({ ...original, websiteId: websites[i] })}','${user}');`));
  // Each non-admin owns both their synthetic board and its website.
  const before = snapshot();
  const unauthorized = await fetch(`${origin}/api/ai/boards/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unauthorized.status, 401);
  evidence.unauthenticatedStatus = unauthorized.status;
  for (const count of process.env.RELEASE_SMOKE_SINGLE_PROBE === '1' ? [1] : [1, 2]) {
    const phase = { turns: count, httpStatuses: [], validDrafts: 0, sampledPeakBytes: {}, samples: 0 };
    evidence.phases.push(phase);
    let measuring = true;
    const sampling = (async () => {
      while (measuring) {
        const sample = JSON.parse(docker(['exec', app, 'node', '-e', meter]));
        for (const [key, value] of Object.entries(sample)) phase.sampledPeakBytes[key] = Math.max(phase.sampledPeakBytes[key] || 0, value);
        phase.samples++;
        await delay(250);
      }
    })();
    try {
      const results = await Promise.allSettled(
        Array.from({ length: count }, async (_, index) => {
          const i = count === 1 ? 0 : index + 1;
          const proposed = { websiteId: websites[i], rows: [{ id: 'proposal-row', columns: [{ id: 'proposal-col', component: { type: 'TextBlock', props: { text: 'Invented release proposal' } } }] }] };
          const scriptedPrompt = `Create a revised board draft for this invented synthetic website. No analytics reads are needed. The website ID must remain ${websites[i]}. Replace the original text with exactly Invented release proposal. Use row id proposal-row and column id proposal-col, component type TextBlock and props text. Return this change through propose_board, not prose. IMPORTANT: propose_board must receive TWO top-level arguments: message (a short string) AND draft (the complete board JSON object). The draft field is mandatory for this requested edit; do not omit it or put the JSON inside message. Required draft object: ${JSON.stringify(proposed)}. Call propose_board once with message and draft, then finish.`;
          const scenario = process.env.RELEASE_SMOKE_SCENARIO || 'scripted';
          assert.ok(['scripted', 'ordinary', 'unsupported', 'no-selection'].includes(scenario));
          const prompt = ['ordinary', 'no-selection'].includes(scenario)
            ? 'Create a dashboard showing visits and popular pages for my website'
            : scenario === 'unsupported'
              ? 'I want you to create like the number of usernames of the umami app and thne show or plot like a dashboard showing how many times they have logged in'
              : scriptedPrompt;
          const response = await fetch(`${origin}/api/ai/boards/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(users[i])}` },
            body: JSON.stringify({
              ...(scenario === 'no-selection' ? {} : { boardId: boards[i] }),
              messages: [{ role: 'user', content: prompt }],
            }),
            signal: AbortSignal.timeout(150000),
          });
          phase.httpStatuses.push(response.status);
          const body = await response.json();
          if (!response.ok) throw new Error(`live-http-${response.status}`);
          if (['unsupported', 'no-selection'].includes(scenario)) {
            assert.deepEqual(Object.keys(body), ['message']);
            assert.equal(typeof body.message, 'string');
            assert.ok(body.message.length > 0);
            if (scenario === 'unsupported') {
              phase.unsupportedChecks = {
                mentionsRequestedCapability: /login|username|user.name|sign.in/i.test(body.message),
                explainsLimit:
                  /cannot|can['’]t|not|unable|only|don['’]t|limit|unsupported|missing|need|require/i.test(
                    body.message,
                  ),
              };
              assert.ok(phase.unsupportedChecks.mentionsRequestedCapability);
              assert.ok(phase.unsupportedChecks.explainsLimit);
            } else assert.match(body.message, /select|choose|which website/i);
            phase.helpfulMessages = (phase.helpfulMessages || 0) + 1;
            return true;
          }
          if (!body.draft) throw new Error('live-message-without-draft');
          assert.deepEqual(Object.keys(body).sort(), ['draft', 'message']);
          assert.equal(typeof body.message, 'string');
          if (scenario === 'scripted') assert.deepEqual(body.draft, proposed);
          else {
            assert.equal(body.draft.websiteId, websites[i]);
            const widgets = body.draft.rows.flatMap(row => row.columns.map(col => col.component));
            assert.ok(
              widgets.some(
                widget => widget.type === 'WebsiteMetricsBar' || widget.type === 'WebsiteChart',
              ),
            );
            assert.ok(
              widgets.some(
                widget => widget.type === 'MetricsTable' && widget.props?.type === 'path',
              ),
            );
          }
          phase.validDrafts++;
          return true;
        }),
      );
      phase.failureCategories = results.filter(result => result.status === 'rejected').map(result => {
        const message = String(result.reason?.message);
        return /^(live-http-\d{3}|live-message-without-draft)$/.test(message) ? message : 'response-assertion-or-transport';
      });
    } finally { measuring = false; await sampling; }
    assert.equal(snapshot(), before, 'persistence-changed');
    phase.persistenceUnchanged = true;
  }
  evidence.status = evidence.phases.every(
    phase => phase.validDrafts + (phase.helpfulMessages || 0) === phase.turns,
  )
    ? 'passed'
    : 'failed';
} catch (error) {
  // Only fixed categories or numeric HTTP statuses, never exception text from a provider/child.
  evidence.status = 'failed';
  const message = String(error.message);
  evidence.category = /^(live-http-\d{3}|live-message-without-draft|docker-operation-failed|app-readiness-failed|persistence-changed)$/.test(message) ? message : 'harness-assertion-or-transport';
} finally {
  if (process.env.RELEASE_SMOKE_DIAGNOSTIC === '1') {
    const logs = spawnSync('docker', ['logs', app], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    evidence.diagnostics = (logs.stdout || '').split('\n').filter(line => line.startsWith('RELEASE_SMOKE_DIAGNOSTIC ')).map(line => {
      try { return JSON.parse(line.slice('RELEASE_SMOKE_DIAGNOSTIC '.length)); } catch { return { invalidDiagnostic: true }; }
    });
  }
  for (const name of [app, db]) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  rmSync(temp, { recursive: true, force: true });
}
console.log(JSON.stringify(evidence));
process.exitCode = evidence.status === 'passed' ? 0 : 1;
