import { expect, type Page, test } from '@playwright/test';
import { createServer } from 'node:http';

// Synthetic browser HTTP only: never authenticates against a database or model provider.
const boardId = '22222222-2222-4222-8222-222222222222';
const websiteId = '11111111-1111-4111-8111-111111111111';
const draft = (text: string) => ({
  websiteId,
  rows: [
    {
      id: 'ai-row',
      columns: [{ id: 'ai-col', component: { type: 'TextBlock', props: { text } } }],
    },
  ],
});
async function fixture(page: Page, type = 'mixed', create = false) {
  const writes: any[] = [];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/ai/boards/chat') return route.fallback();
    let body: unknown = {};
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
    else if (path === '/api/boards' && route.request().method() === 'POST') {
      writes.push(route.request().postDataJSON());
      body = { ...writes.at(-1), id: boardId };
    } else if (path === `/api/boards/${boardId}`) {
      if (route.request().method() === 'POST') writes.push(route.request().postDataJSON());
      body = {
        id: boardId,
        type,
        name: 'Synthetic board',
        parameters: writes.at(-1)?.parameters ?? {
          rows: [{ id: 'manual-row', columns: [{ id: 'manual-col', component: null }] }],
        },
      };
    } else if (path.includes('/websites/'))
      body = { id: websiteId, name: 'Synthetic website', domain: 'synthetic.invalid' };
    else if (path.endsWith('/websites') || path.endsWith('/teams') || path.endsWith('/boards'))
      body = { data: [], count: 0, page: 1, pageSize: 20 };
    await route.fulfill({ json: body });
  });
  await page.goto(create ? '/boards' : `/boards/${boardId}/design`);
  if (create) {
    await page.getByRole('button', { name: 'Add board', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Synthetic board');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: 'AI board assistant' })).toBeVisible();
  return writes;
}
async function ask(page: Page, text = 'Summarize my website') {
  await page.getByLabel('Describe your board or a change').fill(text);
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
}

test('create and refine stay local until the existing Save is pressed', async ({ page }) => {
  const requests: any[] = [];
  await page.route('**/api/ai/boards/chat', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        message: `Preview ${requests.length}`,
        draft: draft(`Local preview ${requests.length}`),
      },
    });
  });
  const writes = await fixture(page);
  await ask(page);
  await expect(page.getByText('Local preview 1', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  expect(requests[0].boardId).toBe(boardId);
  await ask(page, 'Refine the summary');
  await expect(page.getByText('Local preview 2', { exact: true })).toBeVisible();
  expect(requests[1].draft).toEqual(draft('Local preview 1'));
  expect(requests[1].messages).toHaveLength(3);
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].parameters.rows[0].columns[0].component.props.text).toBe('Local preview 2');
});

test('ordinary Add board flow opens a blank design that accepts an AI preview', async ({
  page,
}) => {
  await page.route('**/api/ai/boards/chat', route =>
    route.fulfill({ json: { message: 'New board preview', draft: draft('New board summary') } }),
  );
  const writes = await fixture(page, 'mixed', true);
  expect(writes).toHaveLength(1); // Explicit creation form Save, not AI persistence.
  await ask(page);
  await expect(page.getByText('New board summary', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
});

test('pending can be cancelled without applying a late preview or persisting', async ({ page }) => {
  let release: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  await page.route('**/api/ai/boards/chat', async route => {
    await gate;
    await route
      .fulfill({ json: { message: 'Too late', draft: draft('Must not appear') } })
      .catch(() => {});
  });
  const writes = await fixture(page);
  await ask(page);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel AI' }).click();
  release();
  await expect(page.getByText(/AI request cancelled/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(page.getByText('Must not appear')).toHaveCount(0);
  expect(writes).toHaveLength(0);
});

test('disabled AI leaves existing manual editing and Save available', async ({ page }) => {
  await page.route('**/api/ai/boards/chat', route =>
    route.fulfill({ status: 503, json: { error: 'AI board assistance is disabled.' } }),
  );
  const writes = await fixture(page);
  await ask(page);
  await expect(page.getByText(/AI board assistance is disabled. You can still edit/)).toBeVisible();
  await expect(page.getByLabel('Describe your board or a change')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].parameters.rows[0].columns[0].component).toBeNull();
});

test('HTTP errors preserve manual layout and allow retry', async ({ page }) => {
  await page.route('**/api/ai/boards/chat', route =>
    route.fulfill({ status: 403, json: { error: 'Access denied' } }),
  );
  const writes = await fixture(page);
  await ask(page);
  await expect(page.getByText(/You do not have access to this board or website/)).toBeVisible();
  await page.getByLabel('Describe your board or a change').fill('Try another website');
  await expect(page.getByRole('button', { name: 'Ask AI', exact: true })).toBeEnabled();
  expect(writes).toHaveLength(0);
});

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

// Real incremental HTTP bytes, not a mock component or an injected browser fetch.
async function streamingFixture(
  page: Page,
  run: (send: (text: string) => void, end: () => void) => void,
) {
  const connections = new Set<any>();
  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:3317');
    response.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
    if (request.method === 'OPTIONS') {
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.flushHeaders();
    run(
      text => response.write(text),
      () => response.end(),
    );
  });
  server.on('connection', socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  await page.route('**/api/ai/boards/chat', route =>
    route.continue({
      url: `http://127.0.0.1:${address.port}/stream`,
    }),
  );
  return async () => {
    for (const socket of connections) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
}

test('discovery questions send selected and free answers as ordinary bounded messages', async ({
  page,
}) => {
  const requests: any[] = [];
  await page.route('**/api/ai/boards/chat', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: 'text/event-stream',
      body: sse('result', {
        type: 'result',
        result:
          requests.length < 3
            ? {
                message: 'An event name alone does not confirm successful login.',
                questions: [
                  {
                    id: 'meaning',
                    question: 'Which event means successful login?',
                    options: [{ label: 'Confirmed login', value: 'confirmed_login' }],
                  },
                ],
              }
            : {
                message: 'Review this preview, then Save.',
                draft: draft('Confirmed login summary'),
              },
      }),
    });
  });
  const writes = await fixture(page);
  await expect(page.getByText(/No website selected/)).toBeVisible();
  await ask(page, 'How many people logged in?');
  await page.getByRole('button', { name: 'Confirmed login', exact: true }).click();
  await expect(page.getByLabel('Describe your board or a change')).toBeFocused();
  await expect(page.getByLabel('Describe your board or a change')).toHaveValue(/confirmed_login/);
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  await page.getByRole('button', { name: 'Write my own answer' }).last().click();
  await page
    .getByLabel('Describe your board or a change')
    .fill('Use confirmed_login; only success=true means successful login.');
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  await expect(page.getByText('Confirmed login summary', { exact: true })).toBeVisible();
  expect(requests[1].messages.at(-1).content).toContain('confirmed_login');
  expect(requests[2].messages.at(-1).content).toContain('success=true');
  expect(
    requests[2].messages.every(
      (message: any) => Object.keys(message).sort().join(',') === 'content,role',
    ),
  ).toBe(true);
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
});

for (const action of ['cancel', 'truncate', 'manual edit'] as const) {
  test(`real streaming progress and ${action} never applies an incomplete or stale draft`, async ({
    page,
  }) => {
    let finish = () => {};
    const close = await streamingFixture(page, (send, end) => {
      send(sse('progress', { type: 'progress', phase: 'read' }));
      finish = () => {
        send(sse('progress', { type: 'progress', phase: 'complete' }));
        if (action !== 'truncate')
          send(
            sse('result', {
              type: 'result',
              result: { message: 'Late', draft: draft('Must not appear') },
            }),
          );
        end();
      };
    });
    try {
      const writes = await fixture(page);
      await ask(page);
      await expect(page.getByText('Reading authorized analytics', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
      if (action === 'cancel') await page.getByRole('button', { name: 'Cancel AI' }).click();
      if (action === 'manual edit') {
        await page.getByRole('button', { name: 'Add row', exact: true }).click();
      }
      finish();
      await expect(
        page.getByText(
          action === 'truncate' ? /incomplete or invalid response/ : /AI request cancelled/,
        ),
      ).toBeVisible();
      await expect(page.getByText('Must not appear', { exact: true })).toHaveCount(0);
      expect(writes).toHaveLength(0);
    } finally {
      await close();
    }
  });
}

test('unsupported board types explain the website-only boundary', async ({ page }) => {
  await fixture(page, 'pixel');
  await expect(page.getByText(/AI supports website boards only/)).toBeVisible();
  await expect(page.getByLabel('Describe your board or a change')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
});
