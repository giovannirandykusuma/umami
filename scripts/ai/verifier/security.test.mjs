import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import {
  createCapabilityStore,
  VERIFIER_AUDIENCE,
} from '../../../src/lib/analyst-verifier/capability.mjs';
import {
  createArtifactStore,
  validateImage,
  IMAGE_LIMIT,
} from '../../../src/lib/analyst-verifier/images.mjs';
import { allowedRequest } from '../../../src/lib/analyst-verifier/worker.mjs';
import { createQueue } from '../../../src/lib/analyst-verifier/queue.mjs';
import { FIXTURE_SCOPE as scope } from './fixture-server.mjs';
test('large worker result flushes completely before clean exit', () => {
  // Exercise the exact final-write implementation without launching a browser or exposing data.
  const source = readFileSync(new URL('./container-worker.mjs', import.meta.url), 'utf8');
  const finish = source.slice(
    source.indexOf('async function finish('),
    source.indexOf('const waiting ='),
  );
  const payloadBytes = 2 * 1024 * 1024;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `${finish}\nawait finish({type:'result',data:'x'.repeat(${payloadBytes})});process.exit(0);`,
    ],
    { maxBuffer: 4 * 1024 * 1024, timeout: 10_000 },
  );
  assert.equal(child.status, 0);
  assert.equal(
    child.stdout.length,
    payloadBytes + Buffer.byteLength('{"type":"result","data":""}\n'),
  );
  assert.equal(JSON.parse(child.stdout).data.length, payloadBytes);
});

function chunk(type, data) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const content = Buffer.concat([Buffer.from(type), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(content));
  return Buffer.concat([header, content, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(1, 0);
header.writeUInt32BE(1, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 255]))),
  chunk('IEND', Buffer.alloc(0)),
]);

test('capability one use, audience, expiry, scope and revocation', async () => {
  let now = 0;
  let allowed = true;
  const store = createCapabilityStore({ now: () => now, authorize: () => allowed });
  const issue = () => store.issue(scope).token;
  const used = issue();
  const session = await store.exchange(used, VERIFIER_AUDIENCE);
  await assert.rejects(store.exchange(used, VERIFIER_AUDIENCE), /invalid_capability/);
  await assert.rejects(store.exchange(issue(), 'foreign'), /wrong_audience/);
  for (const request of [
    { method: 'POST' },
    {},
    { method: 'GET', boardId: 'foreign' },
    { method: 'GET', boardRevision: 2 },
    { method: 'GET', analysisId: 'toString' },
  ])
    await assert.rejects(store.resolve(session.sessionId, request));
  assert.deepEqual(await store.resolve(session.sessionId, { method: 'GET' }), scope);
  allowed = false;
  await assert.rejects(store.resolve(session.sessionId, { method: 'GET' }), /revoked/);
  await assert.rejects(store.exchange(issue(), VERIFIER_AUDIENCE), /revoked/);
  allowed = true;
  const expired = issue();
  now = 60_001;
  await assert.rejects(store.exchange(expired, VERIFIER_AUDIENCE));
  const revoked = issue();
  store.revoke({ taskId: scope.taskId });
  await assert.rejects(store.exchange(revoked, VERIFIER_AUDIENCE));
  assert.equal(store.size(), 0);
  assert.throws(() => store.issue({ ...scope, analysisRevisions: [] }));
});

test('image signatures, MIME, byte/count limits, release authority and retention', async () => {
  let now = 0;
  let allowed = true;
  const store = createArtifactStore({ now: () => now, authorize: () => allowed });
  const image = { bytes: png, mime: 'image/png' };
  assert.equal(validateImage(png, 'image/png').length, 64);
  for (const [bytes, mime] of [
    [Buffer.from('<html>private</html>'), 'image/png'],
    [png, 'text/html'],
    [Buffer.alloc(IMAGE_LIMIT + 1), 'image/png'],
    [Buffer.alloc(0), 'image/png'],
    [Buffer.concat([png, Buffer.from('<html>')]), 'image/png'],
    [png.subarray(0, 20), 'image/png'],
  ])
    assert.throws(() => validateImage(bytes, mime));
  await assert.rejects(store.put(scope, []));
  await assert.rejects(store.put(scope, Array(7).fill(image)));
  const artifact = await store.put(scope, [image]);
  await assert.rejects(store.get(artifact.id, { userId: 'foreign', taskId: scope.taskId }));
  assert.equal((await store.get(artifact.id, scope)).length, 1);
  allowed = false;
  await assert.rejects(store.get(artifact.id, scope), /revoked/);
  assert.equal(store.size(), 0);
  allowed = true;
  const expired = await store.put(scope, [image]);
  now = 60_001;
  await assert.rejects(store.get(expired.id, scope), /expired_artifact/);
  now = 900_001;
  assert.equal(store.size(), 0);
  await store.put(scope, [image]);
  store.cleanup({ taskId: scope.taskId });
  assert.equal(store.size(), 0);
});

test('revocation during asynchronous exchange cannot resurrect a session', async () => {
  let finish;
  const store = createCapabilityStore({
    authorize: () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  });
  const pending = store.exchange(store.issue(scope).token, VERIFIER_AUDIENCE);
  store.revoke({ taskId: scope.taskId });
  finish(true);
  await assert.rejects(pending, /revoked/);
  assert.equal(store.size(), 0);
});

test('exact origin and endpoint allowlist rejects metadata, redirects and credentials', () => {
  const origin = 'http://127.0.0.1:4319';
  assert.equal(allowedRequest(`${origin}/canvas`, origin), true);
  assert.equal(
    allowedRequest(
      `${origin}/_next/static/chunks/app/(verifier)/verifier-canvas/page-abc.js`,
      origin,
    ),
    true,
  );
  assert.equal(allowedRequest(`${origin}/_next/static/media/font.woff2`, origin), true);
  for (const url of [
    'http://169.254.169.254/latest',
    'http://localhost:4319/canvas',
    'https://example.com/canvas',
    `${origin}/api/auth`,
    `${origin}/canvas?token=secret`,
    'http://user:pass@127.0.0.1:4319/canvas',
    'file:///etc/passwd',
    `${origin}/exchange#secret`,
    `${origin}/_next/static/../secret.js`,
    `${origin}/_next/static/%2e%2e/secret.js`,
    `${origin}/_next/static/chunks/app.js?url=http://evil`,
    `${origin}/_next/static/chunks/evil.html`,
    `${origin}/_next/static/chunks/%2fsecret.js`,
  ])
    assert.equal(allowedRequest(url, origin), false);
});

test('queue enforces per-user/global concurrency and queued cancellation/deadline', async () => {
  const queue = createQueue({ queueTimeoutMs: 25 });
  const releases = [];
  let running = 0;
  let max = 0;
  const run = () =>
    new Promise(resolve => {
      running++;
      max = Math.max(max, running);
      releases.push(() => {
        running--;
        resolve();
      });
    });
  const first = queue.submit('a', run);
  const second = queue.submit('b', run);
  const timeout = assert.rejects(queue.submit('a', run), /queue_cancelled_or_timeout/);
  const controller = new AbortController();
  const cancelled = assert.rejects(
    queue.submit('c', run, controller.signal),
    /queue_cancelled_or_timeout/,
  );
  controller.abort();
  await timeout;
  await cancelled;
  assert.equal(max, 2);
  for (const release of releases) release();
  await Promise.all([first, second]);
});
