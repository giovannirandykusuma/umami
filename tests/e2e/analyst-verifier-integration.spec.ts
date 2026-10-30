import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

// B3 is a direct isolated port proof against a production build. It never invokes Pi or
// enables the development offline provider. D2's native-Pi dev-RPC proof is a separate suite.
const build = process.env.ANALYST_VERIFIER_BUILD;
test.skip(!build, 'ANALYST_VERIFIER_BUILD sanitized production build required');
test.describe.configure({ mode: 'serial', timeout: 180_000 });

test('built actual native + AnalysisWidget path: exact receipts; stale/failed/direct HTTP denied', async () => {
  const require = createRequire(`${build}/package.json`);
  const next = require('next');
  const { createVerifierPort, createBuiltRenderer } = await import(
    '../../src/lib/analyst-verifier/port.mjs'
  );
  const { createDockerLauncher } = await import('../../src/lib/analyst-verifier/launcher.mjs');
  const app = next({ dev: false, dir: build });
  await app.prepare();
  const server = createServer(app.getRequestHandler());
  await new Promise<void>(resolve => server.listen(3351, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:3351';
  let port;
  let boardId;
  let analysisId;
  try {
    const login = await fetch(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'umami' }),
    });
    expect(login.ok).toBe(true);
    const auth = await login.json();
    const headers = { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' };
    const api = async (path: string, body?: any) => {
      const response = await fetch(`${origin}/api${path}`, {
        headers,
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      });
      const value = await response.json();
      expect(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`).toBe(true);
      return value;
    };
    const websiteId = 'a11a1a00-0000-4000-8000-000000000001';
    const definition = {
      schemaVersion: 1,
      source: { websiteId },
      operation: 'totals',
      metric: 'pageviews',
      timezone: 'UTC',
      datePolicy: { type: 'fixed', startAt: Date.UTC(2026, 9, 1), endAt: Date.UTC(2026, 9, 15) },
      semanticBinding: {
        label: 'Built synthetic views',
        unit: 'pageviews',
        population: 'all synthetic visitors',
        meaningSource: 'observed_only',
      },
    };
    const { analysis } = await api('/analyses', {
      operationKey: `built-proof-${Date.now()}`,
      name: 'Built synthetic views',
      status: 'ready',
      definition,
    });
    analysisId = analysis.id;
    const board = await api('/boards', {
      name: 'Built real renderer proof',
      type: 'mixed',
      parameters: {
        rows: [
          {
            id: 'row',
            columns: [
              {
                id: 'analysis-widget',
                component: {
                  type: 'AnalysisWidget',
                  props: { analysisId, visualization: 'table' },
                },
              },
              {
                id: 'native-widget',
                component: {
                  type: 'WebsiteMetricsBar',
                  entityType: 'website',
                  entityId: websiteId,
                },
              },
            ],
          },
        ],
      },
    });
    boardId = board.id;
    const scope = {
      userId: auth.user.id,
      taskId: 'direct-built-render-proof',
      boardId,
      boardRevision: board.revision,
      analysisRevisions: { [analysisId]: analysis.revision },
    };
    const envelope = await api(`/analyses/${analysisId}/execute`, {});
    const range = { startAt: Date.UTC(2026, 9, 1), endAt: Date.UTC(2026, 9, 15), timezone: 'UTC' };
    const params = new URLSearchParams(Object.entries(range).map(([k, v]) => [k, String(v)]));
    const stats = await api(`/websites/${websiteId}/stats?${params}`);
    const nativeHash = createHash('sha256')
      .update(JSON.stringify({ websiteId, range, type: 'WebsiteMetricsBar' }))
      .digest('hex');
    let live = true;
    let mode = 'ok';
    const prepared = [
      {
        id: 'analysis-widget',
        analysisId,
        revision: analysis.revision,
        executionId: envelope.executionId,
        definitionHash: envelope.definitionHash,
        envelope,
        board,
      },
      {
        id: 'native-widget',
        executionId: 'native-prepared-execution',
        definitionHash: nativeHash,
        native: { websiteId, range, data: stats },
        board,
      },
    ];
    const authorize = async captured => {
      if (!live || captured.boardId !== boardId || captured.boardRevision !== board.revision)
        return false;
      const current = await api(`/boards/${boardId}`);
      const saved = await api(`/analyses/${analysisId}`);
      return (
        current.revision === captured.boardRevision &&
        saved.revision === captured.analysisRevisions[analysisId]
      );
    };
    const renderer = await createBuiltRenderer({ root: build, port: 3351 });
    port = createVerifierPort({
      enabled: true,
      launcher: createDockerLauncher(),
      authorize,
      prepare: async () => {
        const copy = structuredClone(prepared);
        if (mode === 'failed') copy[0].envelope = undefined;
        if (mode === 'stale') copy[0].executionId = 'stale-execution';
        return copy;
      },
      renderer,
    });
    const expectedWidgets = prepared.map(({ id, executionId, definitionHash }) => ({
      id,
      executionId,
      definitionHash,
    }));
    // App Router may stream its not-found boundary with HTTP 200 under the root Suspense.
    // No unauthorized response may contain prepared data or the renderer tree.
    for (const denied of [
      await fetch(`${origin}/verifier-canvas`),
      await fetch(`${origin}/verifier-canvas`, {
        headers: { 'x-verifier-transport': 'A'.repeat(43) },
      }),
    ]) {
      const body = await denied.text();
      expect(body).not.toContain('data-verifier-canvas');
      expect(body).not.toContain(envelope.executionId);
      expect(body).toContain('NEXT_HTTP_ERROR_FALLBACK;404');
    }
    const rendered = await port.render({ scope, expectedWidgets });
    expect(rendered.receipt.status).toBe('rendered_not_inspected');
    expect(rendered.receipt.views.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rendered.receipt.views.map(view => view.viewport.width))).toEqual(
      new Set([1440, 390]),
    );
    for (const view of rendered.receipt.views) {
      expect(view.widgets).toEqual(
        expect.arrayContaining(expectedWidgets.map(w => ({ ...w, state: 'rendered' }))),
      );
    }
    mode = 'stale';
    await expect(port.render({ scope, expectedWidgets })).rejects.toThrow();
    mode = 'failed';
    await expect(port.render({ scope, expectedWidgets })).rejects.toThrow();
    live = false;
    await expect(port.render({ scope, expectedWidgets })).rejects.toThrow();
    port.discard(rendered.artifactId);
  } finally {
    port?.cleanup({ boardId });
    await new Promise<void>(resolve => server.close(() => resolve()));
    await app.close();
  }
});
