import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { chromium } from '@playwright/test';
import { renderJob, allowedRequest } from '../../../src/lib/analyst-verifier/worker.mjs';
import { createArtifactStore } from '../../../src/lib/analyst-verifier/images.mjs';
import { FIXTURE_SCOPE } from './fixture-server.mjs';

assert.equal(process.getuid(), 10001);
const targets = [
  '1.1.1.1',
  'example.com',
  '169.254.169.254',
  '169.254.1.1',
  process.env.PROOF_GATEWAY,
  'host.docker.internal',
];
assert.ok(targets.every(Boolean));
async function blocked(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('timeout');
    }, 1500);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`egress_allowed:${host}:${port}`));
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve('denied');
    });
  });
}
const probes = [];
for (const host of targets)
  for (const port of [80, 443]) probes.push({ host, port, result: await blocked(host, port) });
await new Promise((resolve, reject) => {
  const request = http.get('http://1.1.1.1/', response => {
    response.resume();
    reject(new Error('http_egress_allowed'));
  });
  request.setTimeout(1500, () => {
    request.destroy();
    resolve();
  });
  request.on('error', resolve);
});
const browser = await chromium.launch({ headless: true });
const artifacts = createArtifactStore({ authorize: () => true });
try {
  const result = await renderJob({
    browser,
    origin: 'http://fixture:4319',
    capability: 'synthetic-container-once',
    scope: FIXTURE_SCOPE,
    expectedWidgets: [
      { id: 'metric', executionId: 'synthetic-execution', definitionHash: 'a'.repeat(64) },
    ],
    authorize: () => true,
    artifacts,
  });
  assert.equal(result.receipt.views.length, 2);
  assert.equal((await artifacts.get(result.artifactId, FIXTURE_SCOPE)).length, 2);
  artifacts.discard(result.artifactId);
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const denied = [];
  await context.route('**/*', route => {
    if (
      (allowedRequest(route.request().url(), 'http://fixture:4319') ||
        route.request().url() === 'http://fixture:4319/redirect') &&
      !route.request().redirectedFrom()
    )
      return route.continue();
    denied.push('external_request_denied');
    return route.abort();
  });
  const page = await context.newPage();
  await assert.rejects(page.goto('http://1.1.1.1/'));
  const resourcePage = await context.newPage();
  await resourcePage.setContent('<img src="http://169.254.169.254/latest">');
  await resourcePage.waitForTimeout(100);
  const redirectResponse = await context.request.get('http://fixture:4319/redirect', {
    maxRedirects: 0,
  });
  assert.equal(redirectResponse.status(), 302);
  assert.equal(redirectResponse.headers().location, 'http://1.1.1.1/');
  const redirectPage = await context.newPage();
  await assert.rejects(redirectPage.goto('http://fixture:4319/redirect', { timeout: 3000 }));
  assert.ok(denied.length >= 2);
  await context.close();
  console.log(
    JSON.stringify({
      uid: process.getuid(),
      probes,
      captures: result.receipt.views.map(v => ({ viewport: v.viewport, hash: v.hash })),
      externalResourceDenials: denied.length,
    }),
  );
} finally {
  await browser.close();
}
