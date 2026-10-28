#!/usr/bin/env node
// Generic synthetic-only runner. Provider secrets enter via environment, never argv/logs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGateway } from '../gateway-config.mjs';

// Compile only these checked-in public validators; provider output is JSON, never code.
export async function loadSharedContract() {
  const require = createRequire(import.meta.url);
  const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const draft = stripTypeScriptTypes(readFileSync(new URL('../../../src/lib/ai/board-draft.ts', import.meta.url), 'utf8'));
  const contract = stripTypeScriptTypes(readFileSync(new URL('../../../src/lib/ai/rpc/contract.ts', import.meta.url), 'utf8'))
    .replace("from 'zod'", `from '${pathToFileURL(require.resolve('zod'))}'`)
    .replace("from '../board-draft'", `from '${moduleUrl(draft)}'`);
  return import(moduleUrl(contract));
}

export async function readSmokeStream(response) {
  assert.match(response.headers.get('content-type') || '', /^text\/event-stream\b/);
  const { validateAiResult, AI_LIMITS } = await loadSharedContract();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', bytes = 0, terminal = false, result;
  const phases = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        assert.equal(buffer, '', 'incomplete-frame');
        assert.ok(terminal, 'missing-terminal');
        return { result, phases, bytes, eof: true };
      }
      bytes += chunk.value.byteLength;
      assert.ok(bytes <= AI_LIMITS.outputBytes, 'stream-too-large');
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      while (buffer.includes('\n\n')) {
        const end = buffer.indexOf('\n\n');
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        assert.ok(!terminal, 'frame-after-terminal');
        assert.ok(Buffer.byteLength(frame) <= AI_LIMITS.toolBytes + 256, 'frame-too-large');
        const lines = frame.split('\n');
        assert.equal(lines.length, 2);
        assert.ok(lines[0].startsWith('event: ') && lines[1].startsWith('data: '));
        const event = lines[0].slice(7), data = JSON.parse(lines[1].slice(6));
        assert.equal(data.type, event);
        assert.equal(Object.keys(data).length, 2);
        if (event === 'progress') {
          assert.ok(['start', 'check', 'read', 'prepare', 'validate', 'complete'].includes(data.phase));
          phases.push(data.phase);
          assert.ok(phases.length <= 21);
        } else if (event === 'result') {
          result = validateAiResult(data.result);
          terminal = true;
        } else if (event === 'error') {
          throw new Error('live-stream-error');
        } else throw new Error('invalid-stream-event');
      }
      assert.ok(Buffer.byteLength(buffer) <= AI_LIMITS.toolBytes + 256, 'frame-too-large');
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export async function runSmoke() {
const { validateAiResult } = await loadSharedContract();
assert.notEqual(process.env.RELEASE_SMOKE_SCENARIO, 'followup', 'followup-requires-discovery-history');
const image =
  process.env.RELEASE_SMOKE_IMAGE ||
  'sha256:e19f66d2fb480b7c3912662157e5530d6546f59a48745dc03e40c428b7b9d01a';
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
const analyticsSnapshot = () => sql(`SELECT md5(string_agg(t::text,'' ORDER BY t::text)) FROM (SELECT row_to_json(e) t FROM website_event e UNION ALL SELECT row_to_json(d) FROM event_data d UNION ALL SELECT row_to_json(s) FROM session s) a;`);
// Read only numeric resource data; never emit command lines, child output or payloads.
const meter = `const fs=require('fs');let pi=0,app=0,children=0;for(const p of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{const cmd=fs.readFileSync('/proc/'+p+'/cmdline','utf8');if(!cmd.startsWith('node\\0'))continue;const rss=Number(fs.readFileSync('/proc/'+p+'/status','utf8').match(/VmRSS:\\s+(\\d+)/)?.[1]||0)*1024;if(cmd.includes('scripts/ai/native.mjs')){pi+=rss;children++}else if(p==='1')app+=rss;}catch{}}console.log(JSON.stringify({cgroup:Number(fs.readFileSync('/sys/fs/cgroup/memory.current','utf8')),cgroupLifetimePeak:Number(fs.readFileSync('/sys/fs/cgroup/memory.peak','utf8')),appRss:app,piRss:pi,children}));`;
try {
  const gateway = resolveGateway(process.env);
  // Same resolver/key/origin as the app: one metadata GET, no completion retries or fallback.
  const preflight = await fetch(`${gateway.AI_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${gateway.AI_PROVIDER_KEY}` },
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(preflight.status, 200, 'gateway-preflight');
  const models = await preflight.json();
  assert.ok(models.data?.some(model => model.id === gateway.AI_MODEL));
  evidence.gateway = { status: preflight.status, exactModelFound: true, reasoning: 'medium' };
  const metadata = JSON.parse(docker(['image', 'inspect', image]));
  assert.equal(metadata[0].Architecture, 'amd64');
  assert.equal(metadata[0].Id, image);
  const publicFiles = ['src/lib/ai/rpc/contract.ts', 'src/lib/ai/board-draft.ts'];
  const hashes = JSON.parse(docker(['run', '--rm', '--platform', 'linux/amd64', '--entrypoint', 'node', image, '-e', `const fs=require('fs'),crypto=require('crypto');console.log(JSON.stringify(${JSON.stringify(publicFiles)}.map(p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))))`]));
  assert.deepEqual(hashes, publicFiles.map(path => createHash('sha256').update(readFileSync(path)).digest('hex')));
  evidence.publicContractBinding = { files: publicFiles, sha256: hashes, matches: true };
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
  const discovery = process.env.RELEASE_SMOKE_SCENARIO === 'discovery-question';
  if (discovery) {
    const session = randomUUID();
    sql(`INSERT INTO session (session_id,website_id) VALUES ('${session}','${websites[0]}');`);
    for (const name of ['login', 'login_page']) {
      const event = randomUUID();
      sql(`INSERT INTO website_event (event_id,website_id,session_id,visit_id,url_path,event_type,event_name) VALUES ('${event}','${websites[0]}','${session}','${randomUUID()}','/login',2,'${name}'); INSERT INTO event_data (event_data_id,website_id,website_event_id,data_key,string_value,data_type) VALUES ('${randomUUID()}','${websites[0]}','${event}','username','CANARY_INVENTED_USERNAME_NEVER_EXPOSE',1);`);
    }
  }
  const before = snapshot();
  const analyticsBefore = analyticsSnapshot();
  let followupMessages;
  let liveCalls = 0;
  let previousCallStarted = 0;
  const unauthorized = await fetch(`${origin}/api/ai/boards/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unauthorized.status, 401);
  evidence.unauthenticatedStatus = unauthorized.status;
  for (const count of discovery ? [1, 1, 1] : process.env.RELEASE_SMOKE_SINGLE_PROBE === '1' ? [1] : [1, 2]) {
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
          const scenario = discovery ? ['discovery-question', 'followup', 'ordinary'][liveCalls] : process.env.RELEASE_SMOKE_SCENARIO || 'scripted';
          assert.ok(['scripted', 'ordinary', 'unsupported', 'no-selection', 'discovery-question', 'followup'].includes(scenario));
          const prompt = scenario === 'discovery-question'
            ? 'Please check my tracked login events and make a dashboard showing how many times each username logged in. Ask me if you need to clarify which event means login.'
            : scenario === 'followup'
              ? 'I mean the login event, not login_page. Please show the login count grouped by username.'
              : ['ordinary', 'no-selection'].includes(scenario)
            ? 'Create a dashboard showing visits and popular pages for my website'
            : scenario === 'unsupported'
              ? 'I want you to create like the number of usernames of the umami app and thne show or plot like a dashboard showing how many times they have logged in'
              : scriptedPrompt;
          // Respect the app's per-user 60s admission window before the next planned turn.
          // This is scheduling, not an HTTP retry: each planned request is issued exactly once.
          if (discovery && previousCallStarted) await delay(Math.max(0, previousCallStarted + 61_000 - Date.now()));
          previousCallStarted = Date.now();
          assert.ok(++liveCalls <= 3, 'live-call-budget');
          const messages = [...(scenario === 'followup' ? followupMessages : []), { role: 'user', content: prompt }];
          const response = await fetch(`${origin}/api/ai/boards/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${token(users[i])}` },
            body: JSON.stringify({
              ...(scenario === 'no-selection' ? {} : { boardId: boards[i] }),
              messages,
            }),
            signal: AbortSignal.timeout(150000),
          });
          phase.httpStatuses.push(response.status);
          if (!response.ok) throw new Error(`live-http-${response.status}`);
          const stream = await readSmokeStream(response);
          const body = validateAiResult(stream.result);
          assert.ok(!JSON.stringify(body).includes('CANARY_INVENTED_USERNAME_NEVER_EXPOSE'));
          phase.stream = { phases: stream.phases, bytes: stream.bytes, eof: stream.eof, terminalResults: 1 };
          phase.scenario = scenario;
          if (['unsupported', 'no-selection', 'discovery-question', 'followup'].includes(scenario)) {
            assert.equal(body.draft, undefined);
            if (scenario === 'discovery-question') {
              assert.ok(stream.phases.includes('read'));
              assert.ok(body.questions?.length > 0);
              phase.questionCount = body.questions.length;
              followupMessages = [...messages, { role: 'assistant', content: [body.message, ...body.questions.map(question => question.question)].join('\n') }];
            }
            assert.equal(typeof body.message, 'string');
            assert.ok(body.message.length > 0);
            if (['unsupported', 'discovery-question', 'followup'].includes(scenario)) {
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
          // Shared schema permits optional bounded questions alongside supported drafts.
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
    assert.equal(analyticsSnapshot(), analyticsBefore, 'analytics-changed');
    phase.analyticsUnchanged = true;
    if (discovery) assert.equal(phase.failureCategories.length, 0, 'discovery-proof-failed');
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
  if (process.env.RELEASE_SMOKE_SCENARIO === 'discovery-question' && evidence.status === 'passed') {
    const reports = evidence.diagnostics || [];
    evidence.discoveryObserved = reports.some(report => report.categories?.analytics_discover > 0);
    evidence.canarySafe = reports.length === 3 && reports.every(report => report.modelInputObserved === true && report.modelInputCanary === false && report.modelOutputCanary === false);
    if (!evidence.discoveryObserved || !evidence.canarySafe) { evidence.status = 'failed'; evidence.category = 'diagnostic-proof-missing'; }
  }
  for (const name of [app, db]) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  rmSync(temp, { recursive: true, force: true });
}
console.log(JSON.stringify(evidence));
process.exitCode = evidence.status === 'passed' ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runSmoke();
