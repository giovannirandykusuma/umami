import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

// Synthetic HTTP only, exercising the production route and fetch/stream consumer.
const baseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3317';
let origin;
try {
  origin = new URL(baseUrl).origin;
} catch {
  throw new Error('PLAYWRIGHT_BASE_URL must be an absolute URL');
}
const boardId = '22222222-2222-4222-8222-222222222222';
const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const sockets = new Set();
const server = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
  if (request.method === 'OPTIONS') {
    response.end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.flushHeaders();
  response.write(frame('progress', { type: 'progress', phase: 'read' }));
  // Deliberately stays pending until the capture closes the page, with no final draft.
});
server.on('connection', socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ args: ['--remote-debugging-port=19337'] });
const session = `ai-board-discovery-${process.pid}`;
execFileSync('agent-browser', ['--session', session, 'connect', '19337']);
await mkdir('shots', { recursive: true });
try {
  for (const [size, width, height] of [
    ['desktop', 1280, 800],
    ['narrow', 390, 844],
  ]) {
    for (const state of ['questions', 'progress']) {
      const name = `boards-design-${size}-${state}`;
      const page = await browser.newPage({ viewport: { width, height } });
      const consoleErrors = [],
        pageErrors = [];
      page.on('console', message => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', error => pageErrors.push(error.message));
      let turns = 0;
      await page.route('**/api/**', async route => {
        let path;
        try {
          path = new URL(route.request().url()).pathname;
        } catch {
          await route.abort();
          return;
        }
        let body = {};
        if (path === '/api/auth/verify')
          body = {
            id: '33333333-3333-4333-8333-333333333333',
            username: 'Synthetic editor',
            role: 'admin',
            isAdmin: true,
          };
        else if (path === '/api/config')
          body = { cloudMode: false, updatesDisabled: true, telemetryDisabled: true };
        else if (path === '/api/auth/2fa/status') body = { isRequired: false, isEnabled: false };
        else if (path === `/api/boards/${boardId}`)
          body = {
            id: boardId,
            type: 'mixed',
            name: 'Synthetic board',
            parameters: {
              rows: [{ id: 'manual-row', columns: [{ id: 'manual-col', component: null }] }],
            },
          };
        else if (path.endsWith('/websites') || path.endsWith('/teams') || path.endsWith('/boards'))
          body = { data: [], count: 0, page: 1, pageSize: 20 };
        else if (path === '/api/ai/boards/chat') {
          if (++turns > 1)
            return route.continue({ url: `http://127.0.0.1:${server.address().port}/stream` });
          return route.fulfill({
            contentType: 'text/event-stream',
            body: frame('result', {
              type: 'result',
              result: {
                message:
                  'Before building a login summary, confirm the website and what counts as a successful login. An event name alone does not establish its meaning.',
                questions: [
                  { id: 'website', question: 'Which website should this board use?' },
                  {
                    id: 'meaning',
                    question: 'What counts as a successful login?',
                    options: [
                      { label: 'Confirmed login event', value: 'confirmed_login' },
                      {
                        label: 'I need help checking',
                        value: 'Check available event metadata first',
                      },
                    ],
                  },
                ],
              },
            }),
          });
        }
        await route.fulfill({ json: body });
      });
      await page.goto(`${baseUrl}/boards/${boardId}/design`);
      const panel = page.getByRole('region', { name: 'AI board assistant' });
      await panel.waitFor();
      const before = await page.locator('body').ariaSnapshot();
      await page
        .getByLabel('Describe your board or a change')
        .fill('Help me understand successful logins on my website.');
      await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
      await page.getByRole('button', { name: 'Confirmed login event', exact: true }).waitFor();
      if (state === 'progress') {
        await page.getByRole('button', { name: 'I need help checking', exact: true }).click();
        await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
        await page.getByText('Reading authorized analytics', { exact: true }).waitFor();
      }
      await page.evaluate(() => document.fonts.ready);
      const snapshot = await page.locator('body').ariaSnapshot();
      const measurements = await page.evaluate(() => {
        const panel = document.querySelector('section[aria-labelledby="board-ai-title"]');
        const input = panel.querySelector('textarea').getBoundingClientRect();
        const buttons = [...panel.querySelectorAll('button')].map(el => ({
          text: el.textContent,
          disabled: el.disabled,
          rect: el.getBoundingClientRect().toJSON(),
        }));
        const overlappingButtons = buttons.flatMap((a, i) =>
          buttons
            .slice(i + 1)
            .filter(
              b =>
                a.rect.x < b.rect.right &&
                a.rect.right > b.rect.x &&
                a.rect.y < b.rect.bottom &&
                a.rect.bottom > b.rect.y,
            )
            .map(b => [a.text, b.text]),
        );
        return {
          viewportWidth: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth),
          panelWidth: panel.getBoundingClientRect().width,
          inputWidth: input.width,
          inputRight: input.right,
          conversationOverflowPx: Math.max(
            0,
            panel.querySelector('[role="log"]').scrollWidth -
              panel.querySelector('[role="log"]').clientWidth,
          ),
          questionCount: panel.querySelectorAll('fieldset').length,
          progressText: panel.querySelector('[role="status"] strong')?.textContent || null,
          focusedElement: document.activeElement?.id || document.activeElement?.tagName,
          buttons,
          overlappingButtons,
        };
      });
      const agentSnapshot = execFileSync(
        'agent-browser',
        ['--session', session, 'snapshot', '--compact'],
        { encoding: 'utf8' },
      );
      if (!agentSnapshot.includes('AI board assistant'))
        throw new Error('Agent attached to wrong route');
      execFileSync('agent-browser', [
        '--session',
        session,
        'screenshot',
        '--full',
        `${process.cwd()}/shots/${name}.png`,
      ]);
      await writeFile(`shots/${name}.snapshot.txt`, snapshot);
      await writeFile(
        `shots/${name}.report.json`,
        JSON.stringify(
          {
            route: `/boards/${boardId}/design`,
            state,
            viewport: { width, height },
            screenshot: `shots/${name}.png`,
            baseline: null,
            diffPercentage: null,
            diffPng: null,
            baselineReason:
              'No actual base-commit synthetic server supplied. Additive discovery assistant intent; no fabricated baseline or percentage.',
            snapshotDelta: { before, after: snapshot },
            agentSnapshot,
            consoleErrors,
            pageErrors,
            measurements,
          },
          null,
          2,
        ),
      );
      console.log(name, JSON.stringify({ consoleErrors, pageErrors, measurements }));
      await page.close();
    }
  }
} finally {
  execFileSync('agent-browser', ['--session', session, 'close']);
  await browser.close();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
