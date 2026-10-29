import { test, expect } from '@playwright/test';
import { createFixtureServer, FIXTURE_SCOPE } from '../../scripts/ai/verifier/fixture-server.mjs';
import { renderJob } from '../../src/lib/analyst-verifier/worker.mjs';
import { createArtifactStore } from '../../src/lib/analyst-verifier/images.mjs';
import { createDispatcher, launchFixtureWorker } from '../../src/lib/analyst-verifier/dispatch.mjs';

test.describe.configure({ mode: 'serial' });
const expectedWidgets = [
  { id: 'metric', executionId: 'synthetic-execution', definitionHash: 'a'.repeat(64) },
];

test('isolated fixture: real desktop/narrow images, provenance and negative states', async ({
  browser,
}) => {
  const fixture = createFixtureServer();
  await new Promise<void>(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
  const address = fixture.server.address();
  if (!address || typeof address === 'string') throw new Error('missing_fixture');
  const origin = `http://127.0.0.1:${address.port}`;
  const artifacts = createArtifactStore({ authorize: () => true });
  const capture = (options = {}) =>
    renderJob({
      browser,
      origin,
      capability: fixture.issue(),
      scope: FIXTURE_SCOPE,
      expectedWidgets,
      authorize: () => true,
      artifacts,
      ...options,
    });
  const contextsBefore = browser.contexts().length;
  try {
    const result = await capture();
    expect(result.receipt.status).toBe('rendered_not_inspected');
    expect(result.receipt.views.map(v => v.viewport)).toEqual([
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]);
    expect(
      result.receipt.views.every(v => v.widgets[0].executionId === 'synthetic-execution'),
    ).toBe(true);
    const images = await artifacts.get(result.artifactId, FIXTURE_SCOPE);
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.mime).toBe('image/png');
      expect(image.bytes.length).toBeGreaterThan(1000);
      expect(image.hash).toMatch(/^[a-f0-9]{64}$/);
      // The normal canvas is 600px high; no page pixels below it may escape.
      expect(image.bytes.readUInt32BE(20)).toBe(600);
    }
    artifacts.discard(result.artifactId);
    // Separate Node process with no inherited app environment. This proves IPC,
    // not container egress; deployment network policy is a separate release gate.
    const dispatcher = createDispatcher({
      enabled: true,
      isolated: true,
      origin,
      authorize: () => true,
      artifacts,
      launch: launchFixtureWorker,
    });
    const childResult = await dispatcher.run({
      capability: fixture.issue(),
      scope: FIXTURE_SCOPE,
      expectedWidgets,
    });
    expect(childResult.receipt.views).toHaveLength(2);
    expect(await artifacts.get(childResult.artifactId, FIXTURE_SCOPE)).toHaveLength(2);
    artifacts.discard(childResult.artifactId);
    for (const mode of [
      'error',
      'denied',
      'unsupported',
      'stale',
      'foreign-hash',
      'foreign-execution',
      'clipped',
      'console',
      'pageerror',
      'tall',
    ]) {
      fixture.setMode(mode);
      await expect(capture()).rejects.toThrow();
      expect(artifacts.size()).toBe(0);
      expect(browser.contexts()).toHaveLength(contextsBefore);
    }
    fixture.setMode('loading');
    await expect(capture({ timeoutMs: 150 })).rejects.toThrow('cancelled_or_timeout');
    const controller = new AbortController();
    const cancelled = capture({ signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toThrow('cancelled_or_timeout');
    fixture.setMode('normal');
    let checks = 0;
    await expect(capture({ authorize: () => ++checks < 2 })).rejects.toThrow('revoked');
    fixture.revoke();
    await expect(capture()).rejects.toThrow('exchange_denied');
    expect(artifacts.size()).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      fixture.server.close(error => (error ? reject(error) : resolve())),
    );
  }
});

test('injected overflow clipping is rejected instead of capturing outside the canvas', async ({
  browser,
}) => {
  const fixture = createFixtureServer();
  const listener = fixture.server.listeners('request')[0];
  fixture.server.removeAllListeners('request');
  fixture.server.on('request', (req, res) => {
    const end = res.end;
    res.end = function (body, ...args) {
      if (req.url === '/canvas' && typeof body === 'string')
        body = body.replace(
          '</style>',
          'main {height:100px!important;overflow:hidden} article {height:600px}</style>',
        );
      return end.call(this, body, ...args);
    };
    listener(req, res);
  });
  await new Promise<void>(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
  const address = fixture.server.address();
  if (!address || typeof address === 'string') throw new Error('missing_fixture');
  const artifacts = createArtifactStore({ authorize: () => true });
  try {
    await expect(
      renderJob({
        browser,
        origin: `http://127.0.0.1:${address.port}`,
        capability: fixture.issue(),
        scope: FIXTURE_SCOPE,
        expectedWidgets,
        authorize: () => true,
        artifacts,
      }),
    ).rejects.toThrow('clipped_canvas');
    expect(artifacts.size()).toBe(0);
  } finally {
    artifacts.cleanup({ taskId: FIXTURE_SCOPE.taskId });
    await new Promise<void>(resolve => fixture.server.close(() => resolve()));
  }
});

test('verifier session is HttpOnly, read only and has no reusable user credentials', async ({
  browser,
}) => {
  const fixture = createFixtureServer();
  await new Promise<void>(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
  const address = fixture.server.address();
  if (!address || typeof address === 'string') throw new Error('missing_fixture');
  const origin = `http://127.0.0.1:${address.port}`;
  const context = await browser.newContext();
  try {
    expect((await context.request.get(`${origin}/canvas`)).status()).toBe(403);
    const token = fixture.issue();
    expect(
      (await context.request.post(`${origin}/exchange`, { data: { capability: token } })).status(),
    ).toBe(204);
    expect(
      (await context.request.post(`${origin}/exchange`, { data: { capability: token } })).status(),
    ).toBe(403);
    const cookies = await context.cookies();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: 'verifier', httpOnly: true, sameSite: 'Strict' });
    expect((await context.request.post(`${origin}/canvas`)).status()).toBe(403);
    expect((await context.request.get(`${origin}/api/auth`)).status()).toBe(403);
    const page = await context.newPage();
    await page.goto(`${origin}/canvas`);
    expect(await page.evaluate(() => document.cookie)).toBe('');
    expect(page.url()).not.toContain(token);
    fixture.revoke();
    expect((await context.request.get(`${origin}/receipt`)).status()).toBe(403);
  } finally {
    await context.close();
    await new Promise<void>(resolve => fixture.server.close(() => resolve()));
  }
});
