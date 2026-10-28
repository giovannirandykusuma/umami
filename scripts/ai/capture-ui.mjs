import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const baseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3317';
let origin;
try {
  origin = new URL(baseUrl).origin;
} catch {
  throw new Error('PLAYWRIGHT_BASE_URL must be an absolute URL');
}
const series = Array.from({ length: 30 }, (_, index) => ({
  x: new Date(Date.now() - (29 - index) * 86400000).toISOString().slice(0, 10),
  y: 40 + index * 3 + (index % 5) * 12,
}));
const summary = {
  id: 'chat-1',
  title: 'An overview of your audience',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const parts = [
  {
    type: 'thinking',
    id: 'think',
    text: 'I compared all websites over the last 30 days, checked traffic sources, and looked for meaningful changes.',
    durationMs: 12000,
  },
  {
    type: 'tool',
    id: 'tool',
    name: 'get_website_stats',
    title: 'Read website analytics',
    args: { period: 'Last 30 days' },
    status: 'done',
    result: '{"uniqueVisitors":2400,"change":18}',
    durationMs: 850,
  },
  {
    type: 'text',
    id: 'text',
    text: '## Your audience is growing\n\nYou welcomed **2,400 unique visitors** in the last 30 days — **18% more** than the previous period.\n\nOrganic search continues to lead the way. Here’s how your websites compare:',
  },
  {
    type: 'chart',
    id: 'chart',
    title: 'Unique visitors · Last 30 days',
    component: {
      type: 'WebsiteCompareChart',
      props: { websiteIds: ['site-1', 'site-2'], metric: 'visitors', dateRange: '30day' },
    },
  },
  { type: 'link', id: 'link', label: 'Explore your websites', href: '/websites' },
];
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
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
  response.write(frame({ type: 'start', chatId: summary.id, messageId: 'answer' }));
  if (request.url === '/confirm') {
    response.write(
      frame({
        type: 'part',
        part: {
          type: 'confirm',
          id: 'confirm',
          title: 'Create an audience board?',
          message:
            'This will create a private board with the website comparison and traffic summary. You can edit it later.',
          state: 'pending',
        },
      }),
    );
    return;
  }
  response.write(frame({ type: 'part', part: parts[0] }));
  response.write(
    frame({ type: 'part', part: { ...parts[1], status: 'running', durationMs: undefined } }),
  );
  response.write(
    frame({
      type: 'text_delta',
      partId: 'text',
      delta: 'I’m comparing your websites and checking the latest traffic trends…',
    }),
  );
});
server.on('connection', socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ args: ['--remote-debugging-port=19337'] });
const session = `assistant-${process.pid}`;
execFileSync('agent-browser', ['--session', session, 'connect', '19337']);
await mkdir('shots', { recursive: true });
try {
  for (const [size, width, height, dark] of [
    ['desktop', 1280, 800, false],
    ['narrow', 390, 844, false],
    ['desktop-dark', 1280, 800, true],
  ]) {
    for (const state of dark
      ? ['done']
      : size === 'desktop'
        ? ['empty', 'streaming', 'done', 'confirm']
        : ['empty', 'streaming', 'done']) {
      const name = `assistant-${size}-${state}`;
      const page = await browser.newPage({
        viewport: { width, height },
        colorScheme: dark ? 'dark' : 'light',
      });
      const consoleErrors = [],
        pageErrors = [];
      page.on('console', message => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.addInitScript(dark => {
        localStorage.setItem('umami.theme', dark ? 'dark' : 'light');
        localStorage.setItem('theme', dark ? 'dark' : 'light');
      }, dark);
      await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        const method = route.request().method();
        let body = {};
        if (path === '/api/auth/verify')
          body = { id: 'user-1', username: 'Alex', role: 'admin', isAdmin: true };
        else if (path === '/api/config')
          body = { cloudMode: false, updatesDisabled: true, telemetryDisabled: true };
        else if (path === '/api/ai/assistant/chats')
          body =
            method === 'POST'
              ? summary
              : [
                  summary,
                  {
                    ...summary,
                    id: 'chat-2',
                    title: 'A board for the launch',
                    updatedAt: new Date(Date.now() - 86400000).toISOString(),
                  },
                ];
        else if (path.endsWith('/turn')) {
          if (state === 'streaming' || state === 'confirm')
            return route.continue({
              url: `http://127.0.0.1:${server.address().port}/${state === 'confirm' ? 'confirm' : 'stream'}`,
            });
          return route.fulfill({
            contentType: 'text/event-stream',
            body: [
              { type: 'start', chatId: summary.id, messageId: 'answer' },
              ...parts.map(part => ({ type: 'part', part })),
              {
                type: 'done',
                message: {
                  id: 'answer',
                  role: 'assistant',
                  createdAt: summary.createdAt,
                  parts,
                  status: 'done',
                },
              },
            ]
              .map(frame)
              .join(''),
          });
        } else if (path.includes('/websites/') && path.endsWith('/stats'))
          body = {
            visitors: { value: path.includes('site-1') ? 1600 : 800, prev: 1000 },
            pageviews: { value: 4000, prev: 3000 },
          };
        else if (path.includes('/websites/') && path.endsWith('/pageviews'))
          body = {
            pageviews: series,
            sessions: series.map(point => ({
              ...point,
              y: path.includes('site-1') ? point.y : Math.round(point.y * 0.6),
            })),
          };
        else if (path.includes('/websites/'))
          body = {
            id: path.split('/')[3],
            name: path.includes('site-1') ? 'Main website' : 'Product blog',
            domain: 'example.com',
          };
        else if (path.endsWith('/websites') || path.endsWith('/teams'))
          body = { data: [], count: 0 };
        await route.fulfill({ json: body });
      });
      await page.goto(`${baseUrl}/assistant?date=30day&unit=day`);
      await page.getByRole('heading', { name: 'Hi Alex, what do you want to know?' }).waitFor();
      const before = await page.locator('body').ariaSnapshot();
      if (state !== 'empty') {
        await page
          .getByLabel('Message Assistant')
          .fill('Compare unique visitors across my websites for the last 30 days');
        await page.getByLabel('Message Assistant').press('Enter');
        await page
          .getByText(
            state === 'confirm'
              ? 'Create an audience board?'
              : state === 'streaming'
                ? 'I’m comparing your websites and checking the latest traffic trends…'
                : 'Your audience is growing',
            { exact: true },
          )
          .waitFor();
        if (state === 'done')
          await page.getByRole('link', { name: 'Explore your websites' }).waitFor();
      }
      await page.evaluate(() => document.fonts.ready);
      if (state === 'done') {
        await page.locator('canvas').waitFor();
        await page.waitForTimeout(2500);
        await page.getByText('Main website', { exact: true }).waitFor();
        await page.getByText('Product blog', { exact: true }).waitFor();
        await page.waitForFunction(() => {
          const canvas = document.querySelector('canvas');
          return (
            canvas &&
            canvas.getBoundingClientRect().width > canvas.closest('section').clientWidth * 0.75
          );
        });
        await page.evaluate(() => {
          const log = document.querySelector('[role="log"]');
          log.scrollTop = log.scrollHeight;
        });
      }
      const snapshot = await page.locator('body').ariaSnapshot();
      const measurements = await page.evaluate(() => {
        const log = document.querySelector('[role="log"]');
        const composer = document.querySelector('textarea').getBoundingClientRect();
        return {
          visibleConversationHeight: log.clientHeight,
          messageColumn: log.firstElementChild.getBoundingClientRect().toJSON(),
          composerColumn: document
            .querySelector('textarea')
            .closest('form')
            .getBoundingClientRect()
            .toJSON(),
          canvasWidth: log.querySelector('canvas')?.getBoundingClientRect().width ?? null,
          plotWidth: log.querySelector('canvas')?.dataset.plotWidth ?? null,
          legendVisible: ['Main website', 'Product blog'].every(label =>
            [...log.querySelectorAll('span, button')].some(node => {
              const rect = node.getBoundingClientRect();
              const viewport = log.getBoundingClientRect();
              return (
                node.textContent === label &&
                rect.width > 0 &&
                rect.top >= viewport.top &&
                rect.bottom <= viewport.bottom
              );
            }),
          ),
          chartFullyVisible: (() => {
            const chart = log.querySelector('canvas');
            if (!chart) return null;
            const rect = chart.closest('section').getBoundingClientRect();
            const viewport = log.getBoundingClientRect();
            return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
          })(),
          viewportWidth: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth),
          conversationOverflowPx: Math.max(0, log.scrollWidth - log.clientWidth),
          composer: composer.toJSON(),
          theme: document.documentElement.getAttribute('data-theme'),
        };
      });
      await page.bringToFront();
      execFileSync('agent-browser', ['--session', session, 'connect', '19337']);
      const agentSnapshot = execFileSync(
        'agent-browser',
        ['--session', session, 'snapshot', '--compact'],
        { encoding: 'utf8' },
      );
      if (!agentSnapshot.includes('Assistant conversation'))
        throw new Error('Agent attached to wrong page');
      execFileSync('agent-browser', [
        '--session',
        session,
        'screenshot',
        `${process.cwd()}/shots/${name}.png`,
      ]);
      const baselinePath = `/Users/randy/Developer/work/umami/.shikumi/assistant-ui-r1-shots/${name}.png`;
      const baseline = baselinePath;
      const diffPercentage = Number(
        execFileSync(
          'python3',
          [
            '-c',
            `
from PIL import Image, ImageChops
import sys
before = Image.open(sys.argv[1]).convert('RGB')
after = Image.open(sys.argv[2]).convert('RGB')
if before.size != after.size:
    raise ValueError('Baseline dimensions differ')
diff = ImageChops.difference(before, after)
changed = sum(1 for pixel in diff.getdata() if max(pixel) > 16)
print(changed * 100 / (before.width * before.height))
`,
            baselinePath,
            `shots/${name}.png`,
          ],
          { encoding: 'utf8' },
        ),
      );
      await writeFile(
        `shots/${name}.report.json`,
        JSON.stringify(
          {
            route: '/assistant',
            state,
            viewport: { width, height },
            screenshot: `shots/${name}.png`,
            baseline,
            diffPercentage,
            baselineReason:
              'Approved round-1 capture; percentage of pixels with RGB channel delta > 16.',
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
      if (
        pageErrors.length ||
        consoleErrors.length ||
        measurements.horizontalOverflowPx ||
        measurements.conversationOverflowPx ||
        (size === 'desktop' && measurements.visibleConversationHeight < 560) ||
        (state === 'done' &&
          (measurements.chartFullyVisible !== true || !measurements.legendVisible)) ||
        measurements.messageColumn.width > 761 ||
        Math.abs(measurements.messageColumn.x - measurements.composerColumn.x) > 1
      )
        throw new Error(`${name}: capture failed checks`);
      await page.close();
    }
  }
} finally {
  execFileSync('agent-browser', ['--session', session, 'close']);
  await browser.close();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
