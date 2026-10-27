import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const boardId = '22222222-2222-4222-8222-222222222222';
const browser = await chromium.launch({ args: ['--remote-debugging-port=19337'] });
const session = `ai-board-r2-${process.pid}`;
execFileSync('agent-browser', ['--session', session, 'connect', '19337']);
await mkdir('shots', { recursive: true });
for (const [name, width, height] of [
  ['boards-design-desktop', 1280, 800],
  ['boards-design-narrow', 390, 844],
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  const consoleErrors = [],
    pageErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', error => pageErrors.push(error.message));
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
    else if (path === '/api/ai/boards/chat')
      body = {
        message: 'Added a summary to your local draft. Review the layout before saving.',
        draft: {
          rows: [
            {
              id: 'ai-row',
              columns: [
                {
                  id: 'ai-col',
                  component: {
                    type: 'TextBlock',
                    props: { text: 'Website summary — local draft preview' },
                  },
                },
              ],
            },
          ],
        },
      };
    await route.fulfill({ json: body });
  });
  await page.goto(`http://127.0.0.1:3317/boards/${boardId}/design`);
  const panel = page.getByRole('region', { name: 'AI board assistant' });
  await panel.waitFor();
  const before = await page.locator('body').ariaSnapshot();
  await page.getByLabel('Describe your board or a change').fill('Create a website summary');
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  await page.getByText('Website summary — local draft preview', { exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const snapshot = await page.locator('body').ariaSnapshot();
  const measurements = await page.evaluate(() => {
    const panel = document.querySelector('section[aria-labelledby="board-ai-title"]');
    const input = panel.querySelector('textarea').getBoundingClientRect();
    const buttons = [...panel.querySelectorAll('button')].map(el => ({
      text: el.textContent,
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
        viewport: { width, height },
        screenshot: `shots/${name}.png`,
        baseline: null,
        diffPercentage: null,
        diffPng: null,
        baselineReason:
          'No base-commit synthetic capture server supplied. This is an additive assistant, not a full route redesign; no invented baseline or percentage.',
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
await browser.close();
