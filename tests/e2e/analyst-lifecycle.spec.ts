import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { loginPage } from './helpers';

// Runs only against the synthetic analyst fixture (scripts/ai/analyst-fixture/app.mjs), e.g.
// PLAYWRIGHT_SKIP_WEB_SERVER=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:3341. Offline provider only.
const base = process.env.PLAYWRIGHT_BASE_URL ?? '';
test.skip(
  !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || /:(3000|3317)$/.test(base),
  'analyst fixture origin required',
);
test.describe.configure({ mode: 'serial', timeout: 300_000 });

// Keep browser/request evidence on failures: a loading widget alone cannot distinguish a
// pending API, navigation failure, or a dev compiler stall.
const browserEvents = new WeakMap<TestInfo, string[]>();
test.beforeAll(async ({ request }, testInfo) => {
  // Startup compilation has its own budget, not the UI assertion deadline.
  testInfo.setTimeout(900_000);
  // Webpack's dev on-demand entries expire between cases. A listening socket or `/`
  // says nothing about dynamic route readiness. Compile the real routes first, using
  // GET probes that cannot create resources; all acceptance writes still run normally.
  const id = '00000000-0000-4000-8000-000000000000';
  const paths = process.env.ANALYST_FLAGS_OFF_PHASE === '1' ? [] : ['/assistant', `/boards/${id}`];
  for (const path of paths) {
    // Next may replace its dev worker at the heap safety threshold. Retry transport
    // loss only during startup, at most once; assertion/runtime failures never retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await request.get(`${base}${path}`, { timeout: 120_000 });
        expect([200, 401, 403, 404, 405]).toContain(response.status());
        break;
      } catch (error) {
        if (attempt || !/ECONNRESET|ECONNREFUSED|socket hang up/.test(String(error))) throw error;
        await testInfo.attach('startup-worker-restart', {
          contentType: 'text/plain',
          body: Buffer.from(`${path}: ${String(error)}`),
        });
      }
    }
  }
});
test.beforeEach(async ({ page }, testInfo) => {
  const events: string[] = [];
  const started = Date.now();
  const log = (value: string) => events.push(`${Date.now() - started}ms ${value}`);
  page.on('console', message => log(`console ${message.type()} ${message.text()}`));
  page.on('pageerror', error => log(`pageerror ${error.message}`));
  page.on('request', request => log(`request ${request.method()} ${request.url()}`));
  page.on('response', response => log(`response ${response.status()} ${response.url()}`));
  page.on('requestfailed', request =>
    log(`failed ${request.url()} ${request.failure()?.errorText}`),
  );
  browserEvents.set(testInfo, events);
});
test.afterEach(async ({ page }, testInfo) => {
  browserEvents.get(testInfo)?.push(`final URL ${page.url()}`);
  await testInfo.attach('browser-events', {
    contentType: 'text/plain',
    body: Buffer.from((browserEvents.get(testInfo) ?? []).join('\n')),
  });
});

async function runTurn(page: Page) {
  await page.goto('/assistant');
  await expect(page.getByText('what do you want to know?')).toBeVisible({
    timeout: 60_000,
  });
  const input = page.getByPlaceholder('Ask anything about your analytics…');
  await input.fill('Build a synthetic pageviews board');
  await input.press('Enter');
  const task = page.getByLabel('Analyst task');
  await expect(task).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Offline fixture turn complete; render status: /)).toBeVisible({
    timeout: 120_000,
  });
  return task;
}

test('create → readback → repair → render via real SSE task events, then live board', async ({
  page,
  request,
}) => {
  const auth = await loginPage(page, request);
  const task = await runTurn(page);
  // Host-derived phase from the authoritative SSE `task` event; never complete-by-inference.
  await expect(task).toHaveAttribute('data-task-phase', 'render');
  await expect(task).toHaveAttribute('data-task-status', 'complete');
  const receipts = task.getByLabel('Render receipts');
  await expect(receipts).toContainText('Rendered, not visually verified');
  await expect(receipts.locator('[data-receipt-status="inspected"]')).toHaveCount(0);
  const href = await receipts.getByRole('link', { name: 'Board' }).getAttribute('href');
  const boardId = href!.split('/').at(-1)!;

  const board = await (
    await request.get(`/api/boards/${boardId}`, {
      headers: { authorization: auth.authorization },
    })
  ).json();
  const column = board.parameters.rows[0].columns[0];
  expect(column.component.type).toBe('AnalysisWidget');
  const analysisId = column.component.props.analysisId;
  const analysis = await (
    await request.get(`/api/analyses/${analysisId}`, {
      headers: { authorization: auth.authorization },
    })
  ).json();
  // Repair committed a new board revision bound to the repaired definition.
  expect(board.revision).toBe(2);
  expect(analysis.definition.semanticBinding.label).toBe('Synthetic pageviews (repaired label)');

  await page.goto(`/boards/${boardId}`);
  const widget = page.locator(`[data-widget-id="${column.id}"]`);
  await expect(widget).toHaveAttribute('data-analysis-state', 'rendered', {
    timeout: 60_000,
  });
  await expect(widget).toHaveAttribute('data-definition-hash', analysis.definitionHash);
  await expect(widget.getByRole('table')).toContainText('42');
  await expect(widget.getByText('Fixed range')).toBeVisible();
  await expect(widget).toHaveAttribute('aria-label', 'Synthetic pageviews (repaired label)');

  // Reopen/refresh re-executes the stored definition: new execution, same fixed result.
  const first = await widget.getAttribute('data-execution-id');
  await widget.getByRole('button', { name: /^Refresh / }).click();
  await expect(widget).not.toHaveAttribute('data-execution-id', first!);
  await page.reload();
  await expect(widget).toHaveAttribute('data-analysis-state', 'rendered', {
    timeout: 60_000,
  });
  await expect(widget).not.toHaveAttribute('data-execution-id', first!);
  await expect(widget.getByRole('table')).toContainText('42');
});

test('mobile: keyboard-only turn and narrow board without horizontal overflow', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginPage(page, request);
  await page.goto('/assistant');
  await expect(page.getByText('what do you want to know?')).toBeVisible({
    timeout: 60_000,
  });
  const input = page.getByPlaceholder('Ask anything about your analytics…');
  await input.focus();
  await page.keyboard.type('Build a synthetic pageviews board');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Offline fixture turn complete/)).toBeVisible({
    timeout: 120_000,
  });
  const link = page.getByLabel('Render receipts').getByRole('link', { name: 'Board' });
  await link.focus();
  await page.keyboard.press('Enter');
  const widget = page.locator('[data-widget-id]').first();
  await expect(widget).toHaveAttribute('data-analysis-state', 'rendered', {
    timeout: 60_000,
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('cancel: Stop ends the turn and the task never shows complete', async ({ page, request }) => {
  await loginPage(page, request);
  await page.goto('/assistant');
  await expect(page.getByText('what do you want to know?')).toBeVisible({
    timeout: 60_000,
  });
  const input = page.getByPlaceholder('Ask anything about your analytics…');
  await input.fill('Build a synthetic pageviews board');
  await input.press('Enter');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('Stopped')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Offline fixture turn complete/)).toHaveCount(0);
  const task = page.getByLabel('Analyst task');
  if (await task.count())
    await expect(task).not.toHaveAttribute('data-task-status', /complete|running/, {
      timeout: 30_000,
    });
});

test('screens: task panel and live board, light/dark/narrow', async ({ page, request }) => {
  await loginPage(page, request);
  for (const [name, theme, width] of [
    ['light', 'light', 1280],
    ['dark', 'dark', 1280],
    ['narrow', 'light', 390],
  ] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(t => {
      localStorage.setItem('theme', t);
      localStorage.setItem('umami.theme', t);
    }, theme);
    await page.setViewportSize({ width, height: 900 });
    await runTurn(page);
    await page.screenshot({
      path: `shots/assistant-task-${name}.png`,
      fullPage: true,
    });
    const href = await page
      .getByLabel('Render receipts')
      .getByRole('link', { name: 'Board' })
      .getAttribute('href');
    await page.goto(href!);
    const widget = page.locator('[data-widget-id]').first();
    await expect(widget).toHaveAttribute('data-analysis-state', 'rendered', {
      timeout: 60_000,
    });
    await page.screenshot({
      path: `shots/board-analysis-${name}.png`,
      fullPage: true,
    });
  }
});

async function freshBoard(page: Page) {
  await runTurn(page);
  const href = await page
    .getByLabel('Render receipts')
    .getByRole('link', { name: 'Board' })
    .getAttribute('href');
  return href!.split('/').at(-1)!;
}

async function requestChange(page: Page, boardId: string) {
  // A persisted conversation may itself be titled "New chat". Target the action,
  // not a history-row title; repeated serial runs intentionally retain prior chats.
  await page
    .getByRole('button', { name: 'New chat', exact: true })
    .and(page.locator('[data-slot="button"]'))
    .click();
  const input = page.getByPlaceholder('Ask anything about your analytics…');
  await input.fill(`Change board ${boardId}`);
  await input.press('Enter');
  const card = page.getByRole('region', { name: /Edit board/ });
  await expect(card.getByLabel('Proposed changes')).toContainText('at revision 2', {
    timeout: 60_000,
  });
  // Safe default: keyboard focus starts on Reject.
  await expect(card.getByRole('button', { name: 'Reject' })).toBeFocused();
  return card;
}

test('existing board: rejected change writes nothing; confirmed change applies', async ({
  page,
  request,
}) => {
  const auth = await loginPage(page, request);
  const boardId = await freshBoard(page);
  // Sequential flags-off phase reopens this real RPC-created persisted draft.
  const phaseFile = process.env.ANALYST_PHASE_FILE;
  if (phaseFile) {
    const board = await (
      await request.get(`/api/boards/${boardId}`, {
        headers: { authorization: auth.authorization },
      })
    ).json();
    const analysisId = board.parameters.rows[0].columns[0].component.props.analysisId;
    const analysis = await (
      await request.get(`/api/analyses/${analysisId}`, {
        headers: { authorization: auth.authorization },
      })
    ).json();
    const createBody = {
      operationKey: `flags-on-${Date.now()}`,
      name: 'Flags off probe',
      status: 'ready',
      definition: analysis.definition,
    };
    const accepted = await request.post('/api/analyses', {
      headers: { authorization: auth.authorization },
      data: createBody,
    });
    expect(accepted.status()).toBe(200);
    writeFileSync(
      phaseFile,
      JSON.stringify({ boardId, createBody, acceptedStatus: accepted.status() }),
    );
  }
  const revision = async () =>
    (
      await (
        await request.get(`/api/boards/${boardId}`, {
          headers: { authorization: auth.authorization },
        })
      ).json()
    ).revision;

  let card = await requestChange(page, boardId);
  await page.keyboard.press('Enter');
  await expect(page.getByText('Offline change not applied: denied')).toBeVisible({
    timeout: 60_000,
  });
  expect(await revision()).toBe(2);

  card = await requestChange(page, boardId);
  await card.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Offline change applied; board revision 3')).toBeVisible({
    timeout: 60_000,
  });
  expect(await revision()).toBe(3);
  await page.goto(`/boards/${boardId}`);
  const widget = page.locator('[data-widget-id]').first();
  await expect(widget).toHaveAttribute('data-analysis-state', 'rendered', {
    timeout: 60_000,
  });
  await expect(widget).toHaveAttribute('aria-label', 'Synthetic pageviews (confirmed change)');
});

// Second fixture instance on the same synthetic DB started with ANALYST_FIXTURE_FLAGS=off.
const flagsOff = process.env.ANALYST_FLAGS_OFF_ORIGIN;
test('flags off: creation disabled, existing saved widget still executes', async ({
  page,
  request,
}) => {
  test.skip(!flagsOff || !/^http:\/\/127\.0\.0\.1:\d+$/.test(flagsOff), 'flags-off origin');
  const phaseFile = process.env.ANALYST_PHASE_FILE;
  expect(phaseFile, 'phase-one real persisted board evidence required').toBeTruthy();
  const { boardId, createBody, acceptedStatus } = JSON.parse(readFileSync(phaseFile!, 'utf8'));
  expect(acceptedStatus).toBe(200);
  const login = await (
    await request.post(`${flagsOff}/api/auth/login`, {
      data: { username: 'admin', password: 'umami' },
    })
  ).json();
  const headers = { authorization: `Bearer ${login.token}` };
  // A fully valid create body: only the flag may refuse it.
  const body = {
    operationKey: `flags-off-${Date.now()}`,
    name: 'Flags off probe',
    status: 'ready',
    definition: {
      schemaVersion: 1,
      source: { websiteId: 'a11a1a00-0000-4000-8000-000000000001' },
      operation: 'totals',
      metric: 'pageviews',
      datePolicy: {
        type: 'fixed',
        startAt: Date.UTC(2026, 9, 1),
        endAt: Date.UTC(2026, 9, 15),
      },
      timezone: 'UTC',
      semanticBinding: {
        label: 'Flags off probe',
        unit: 'pageviews',
        population: 'all synthetic visitors',
        meaningSource: 'observed_only',
      },
    },
  };
  expect(createBody.definition).toMatchObject({
    operation: body.definition.operation,
    metric: body.definition.metric,
  });
  const created = await request.post(`${flagsOff}/api/analyses`, {
    headers,
    data: { ...createBody, operationKey: body.operationKey },
  });
  // The identical create shape is exercised successfully in the flags-on phase;
  // this phase runs with that server stopped, never concurrent dev instances.
  expect(created.status()).toBe(404);
  expect((await created.json()).error.code).toBe('feature_disabled');
  const board = await (await request.get(`${flagsOff}/api/boards/${boardId}`, { headers })).json();
  const analysisId = board.parameters.rows[0].columns[0].component.props.analysisId;
  const executed = await request.post(`${flagsOff}/api/analyses/${analysisId}/execute`, {
    headers,
    data: {},
  });
  expect(executed.status()).toBe(200);
  expect((await executed.json()).rows[0].value).toBe(42);

  await page.addInitScript(
    token => localStorage.setItem('umami.auth', JSON.stringify(token)),
    login.token,
  );
  await page.goto(`${flagsOff}/boards/${boardId}`);
  const widget = page.locator('[data-widget-id]').first();
  await expect(widget).toHaveAttribute('data-analysis-state', 'rendered', {
    timeout: 120_000,
  });
  await expect(widget.getByRole('table')).toContainText('42');
});
