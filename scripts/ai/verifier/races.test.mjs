import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { createArtifactStore } from '../../../src/lib/analyst-verifier/images.mjs';
import { createCapabilityStore, VERIFIER_AUDIENCE } from '../../../src/lib/analyst-verifier/capability.mjs';
import { FIXTURE_SCOPE as scope } from './fixture-server.mjs';

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const content = Buffer.concat([Buffer.from(type), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(content));
  return Buffer.concat([length, content, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(1, 0);
header.writeUInt32BE(1, 4);
header[8] = 8;
header[9] = 6;
const images = [{ mime: 'image/png', bytes: Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 255]))),
  chunk('IEND', Buffer.alloc(0)),
]) }];

function gate() {
  let finish;
  let deferred = false;
  return {
    authorize: () => deferred ? new Promise(resolve => { finish = resolve; }) : true,
    defer() { deferred = true; },
    release() { finish(true); },
  };
}

test('cleanup invalidates pending artifact puts and does not resurrect pixels', async () => {
  for (const selector of [{ taskId: scope.taskId }, { userId: scope.userId }]) {
    const authority = gate();
    const store = createArtifactStore({ authorize: authority.authorize });
    authority.defer();
    const pending = store.put(scope, images);
    store.cleanup(selector);
    authority.release();
    await assert.rejects(pending, /revoked/);
    assert.equal(store.size(), 0);
  }
});

test('pending artifact reads recheck membership and both expiry bounds', async () => {
  for (const action of ['cleanup', 'discard', 'fetch-expiry', 'retention-expiry']) {
    let now = 0;
    const authority = gate();
    const store = createArtifactStore({ authorize: authority.authorize, now: () => now });
    const entry = await store.put(scope, images);
    assert.equal((await store.get(entry.id, scope)).length, 1);
    authority.defer();
    const pending = store.get(entry.id, scope);
    if (action === 'cleanup') store.cleanup({ taskId: scope.taskId });
    if (action === 'discard') store.discard(entry.id);
    if (action === 'fetch-expiry') now = 60_000;
    if (action === 'retention-expiry') now = 900_000;
    authority.release();
    await assert.rejects(pending, /revoked|expired_artifact/);
    store.cleanup({ taskId: scope.taskId });
    assert.equal(store.size(), 0);
  }
});

test('capability exchange rechecks original expiry after authority await', async () => {
  let now = 0;
  const authority = gate();
  const store = createCapabilityStore({ now: () => now, authorize: authority.authorize });
  authority.defer();
  const pending = store.exchange(store.issue(scope).token, VERIFIER_AUDIENCE);
  now = 60_000;
  authority.release();
  await assert.rejects(pending, /expired_capability/);
  assert.equal(store.size(), 0);
});

test('session resolve rechecks expiry and revocation after authority await', async () => {
  for (const action of ['expiry', 'revoke', 'sweep']) {
    let now = 0;
    const authority = gate();
    const store = createCapabilityStore({ now: () => now, authorize: authority.authorize });
    const session = await store.exchange(store.issue(scope).token, VERIFIER_AUDIENCE);
    assert.deepEqual(await store.resolve(session.sessionId, { method: 'GET' }), scope);
    authority.defer();
    const pending = store.resolve(session.sessionId, { method: 'GET' });
    if (action === 'revoke') store.revoke({ taskId: scope.taskId });
    else now = 30_000;
    if (action === 'sweep') assert.equal(store.size(), 0);
    authority.release();
    await assert.rejects(pending, /expired_session|revoked/);
    assert.equal(store.size(), 0);
  }
});
