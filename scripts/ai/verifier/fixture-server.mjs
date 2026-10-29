// Synthetic fixture adapter ONLY. Never import into application authentication.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  createCapabilityStore,
  VERIFIER_AUDIENCE,
} from '../../../src/lib/analyst-verifier/capability.mjs';

export const FIXTURE_SCOPE = Object.freeze({
  userId: 'synthetic-user',
  taskId: 'synthetic-task',
  boardId: 'synthetic-board',
  boardRevision: 1,
  analysisRevisions: { synthetic: 1 },
});

export function createFixtureServer() {
  let enabled = true;
  let mode = 'normal';
  const capabilities = createCapabilityStore({
    authorize: scope =>
      enabled &&
      scope.boardId === FIXTURE_SCOPE.boardId &&
      scope.boardRevision === FIXTURE_SCOPE.boardRevision &&
      JSON.stringify(scope.analysisRevisions) === JSON.stringify(FIXTURE_SCOPE.analysisRevisions),
  });
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    try {
      if (req.url !== '/exchange') {
        if (req.method !== 'GET' || !['/canvas', '/receipt'].includes(req.url)) {
          res.writeHead(403).end();
          return;
        }
        const session = /(?:^|; )verifier=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];
        await capabilities.resolve(session, {
          method: req.method,
          boardId: FIXTURE_SCOPE.boardId,
          boardRevision: FIXTURE_SCOPE.boardRevision,
        });
      } else {
        if (req.method !== 'POST') {
          res.writeHead(403).end();
          return;
        }
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1024) {
            res.writeHead(413).end();
            return;
          }
        }
        const exchanged = await capabilities.exchange(
          JSON.parse(body).capability,
          VERIFIER_AUDIENCE,
        );
        res.setHeader(
          'Set-Cookie',
          `verifier=${exchanged.sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=30`,
        );
        res.writeHead(204).end();
        return;
      }
      const widgets = [
        {
          id: 'metric',
          state: ['error', 'denied', 'unsupported', 'loading', 'empty'].includes(mode)
            ? mode
            : 'rendered',
          executionId: mode === 'foreign-execution' ? 'foreign' : 'synthetic-execution',
          definitionHash: mode === 'foreign-hash' ? 'b'.repeat(64) : 'a'.repeat(64),
        },
      ];
      const receipt = {
        boardId: FIXTURE_SCOPE.boardId,
        boardRevision: mode === 'stale' ? 2 : 1,
        analysisRevisions: FIXTURE_SCOPE.analysisRevisions,
        widgets,
        complete: mode !== 'loading',
      };
      if (req.url === '/receipt') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(receipt));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Synthetic verifier</title><style>
        * {box-sizing:border-box} body {margin:0;font:16px sans-serif}
        main {width:${mode === 'clipped' ? '1600px' : '100%'};height:${mode === 'tall' ? '4000px' : '600px'};padding:24px;background:#fff}
        article {border:1px solid #888;padding:20px;overflow-wrap:anywhere}
        </style></head><body><main data-verifier-canvas><article><h1>Identified synthetic staff</h1>
        <p>Daily occurrences · UTC · fixed synthetic fixture</p><strong>12</strong>
        <p>Long deterministic label for narrow viewport readability</p></article></main>
        <script>window.__verifierReceipt=${JSON.stringify(receipt)};
        ${mode === 'console' ? "console.error('synthetic error')" : ''}
        ${mode === 'pageerror' ? "throw new Error('synthetic page error')" : ''}
        </script></body></html>`);
    } catch {
      res.writeHead(403).end();
    }
  });
  return {
    server,
    capabilities,
    issue() {
      return capabilities.issue(FIXTURE_SCOPE).token;
    },
    setMode(value) {
      mode = value;
    },
    revoke() {
      enabled = false;
      capabilities.revoke({ taskId: FIXTURE_SCOPE.taskId });
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = createFixtureServer();
  fixture.server.listen(Number(process.env.PORT ?? 4319), '127.0.0.1');
}
