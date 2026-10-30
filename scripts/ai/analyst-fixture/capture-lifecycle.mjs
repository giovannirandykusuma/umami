// Authenticated synthetic lifecycle capture. No API mocking and no model/provider fallback.
// Usage: PLAYWRIGHT_BASE_URL=http://127.0.0.1:3341 node scripts/ai/analyst-fixture/capture-lifecycle.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, request } from '@playwright/test';

const origin = process.env.PLAYWRIGHT_BASE_URL;
assert.match(origin ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
assert.ok(!/:(3000|3317)$/.test(origin), 'synthetic fixture only');
const api = await request.newContext({ baseURL: origin });
const login = await api.post('/api/auth/login', { data: { username: 'admin', password: 'umami' } });
assert.equal(login.status(), 200);
const { token } = await login.json();
const browser = await chromium.launch();
await mkdir('shots', { recursive: true });
try {
  for (const [name, theme, width] of [
    ['light', 'light', 1280],
    ['dark', 'dark', 1280],
    ['narrow', 'light', 390],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    const consoleErrors = [],
      pageErrors = [];
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(
      ({ token, theme }) => {
        localStorage.setItem('umami.auth', JSON.stringify(token));
        localStorage.setItem('theme', theme);
        localStorage.setItem('umami.theme', theme);
      },
      { token, theme },
    );
    await page.goto(`${origin}/assistant`);
    await page.getByText('what do you want to know?').waitFor({ timeout: 60_000 });
    await page
      .getByPlaceholder('Ask anything about your analytics…')
      .fill('Build a synthetic pageviews board');
    await page.getByPlaceholder('Ask anything about your analytics…').press('Enter');
    await page
      .getByText(/Offline fixture turn complete; render status:/)
      .waitFor({ timeout: 180_000 });
    const href = await page
      .getByLabel('Render receipts')
      .getByRole('link', { name: 'Board' })
      .getAttribute('href');
    for (const [route, state, filename] of [
      ['/assistant', 'completed-task-rendered-not-inspected', `assistant-task-${name}`],
      [href, 'live-saved-analysis-rendered', `board-analysis-${name}`],
    ]) {
      if (route !== '/assistant') {
        await page.goto(`${origin}${route}`);
        await page.locator('[data-widget-id]').first().waitFor();
        await page.waitForFunction(
          () =>
            document.querySelector('[data-widget-id]')?.getAttribute('data-analysis-state') ===
            'rendered',
          null,
          { timeout: 60_000 },
        );
      }
      const snapshot = await page.locator('body').ariaSnapshot();
      const measurements = await page.evaluate(() => {
        const measure = element => {
          const box = element.getBoundingClientRect();
          return {
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            horizontalOverflow: Math.max(0, element.scrollWidth - element.clientWidth),
            visible: box.width > 0 && box.height > 0,
            width: box.width,
            height: box.height,
          };
        };
        const task = document.querySelector('[aria-label="Analyst task"]');
        const conversation =
          document.querySelector('[role="log"]') ?? document.querySelector('main');
        return {
          document: measure(document.documentElement),
          conversation: conversation ? measure(conversation) : null,
          widgets: [...document.querySelectorAll('[data-widget-id]')].map(el => ({
            ...measure(el),
            id: el.getAttribute('data-widget-id'),
            state: el.getAttribute('data-analysis-state'),
            executionId: el.getAttribute('data-execution-id'),
            definitionHash: el.getAttribute('data-definition-hash'),
            tables: [...el.querySelectorAll('table')].map(table => ({
              ...measure(table),
              text: table.innerText,
              total: [...table.querySelectorAll('tbody td')]
                .map(cell => cell.textContent)
                .filter(text => /^\d+$/.test(text ?? ''))
                .map(Number)
                .reduce((a, b) => a + b, 0),
            })),
          })),
          canvas: [...document.querySelectorAll('canvas')].map(measure),
          task: task
            ? {
                ...measure(task),
                phase: task.getAttribute('data-task-phase'),
                text: task.textContent,
                receiptStatuses: [...task.querySelectorAll('[data-receipt-status]')].map(el =>
                  el.getAttribute('data-receipt-status'),
                ),
              }
            : null,
        };
      });
      assert.equal(measurements.document.horizontalOverflow, 0, `${filename}: document overflow`);
      for (const widget of measurements.widgets) {
        assert.equal(widget.horizontalOverflow, 0, `${filename}: widget overflow`);
        assert.equal(widget.state, 'rendered');
        assert.ok(widget.visible);
        assert.ok(
          widget.tables.some(table => table.total === 42),
          'seeded analysis total',
        );
      }
      if (measurements.task) assert.equal(measurements.task.phase, 'render');
      await page.screenshot({ path: `shots/${filename}.png`, fullPage: true });
      await writeFile(
        `shots/${filename}.report.json`,
        JSON.stringify(
          {
            route,
            state,
            viewport: { width, height: 900 },
            theme,
            baseline: null,
            diffPercentage: null,
            snapshotDelta: null,
            baselineReason: 'new lifecycle state; no equivalent seeded baseline',
            consoleErrors: [...consoleErrors],
            pageErrors: [...pageErrors],
            a11ySnapshot: snapshot,
            measurements,
            evidence:
              'authenticated offline native-Pi dev-RPC lifecycle; not built-widget B3 proof',
          },
          null,
          2,
        ),
      );
      assert.deepEqual(pageErrors, [], `${filename}: page errors`);
      assert.deepEqual(consoleErrors, [], `${filename}: console errors`);
      console.log(
        JSON.stringify({
          shot: filename,
          route,
          width,
          theme,
          horizontalOverflow: measurements.document.horizontalOverflow,
        }),
      );
    }
    await page.close();
  }
} finally {
  await browser.close();
  await api.dispose();
}
