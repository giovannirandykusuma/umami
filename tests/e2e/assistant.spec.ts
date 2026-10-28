import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';

const summary = {
  id: 'chat-1',
  title: 'Traffic overview',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const parts = [
  {
    type: 'thinking',
    id: 'think',
    text: 'I checked the websites and compared the last 30 days.',
    durationMs: 12000,
  },
  {
    type: 'tool',
    id: 'tool',
    name: 'get_stats',
    title: 'Read website analytics',
    args: { period: '30 days' },
    status: 'done',
    result: '{"visitors":2400}',
    durationMs: 850,
  },
  {
    type: 'text',
    id: 'text',
    text: '## Your audience is growing\n\nYou welcomed **2,400 unique visitors** in the last 30 days. Organic search continues to lead the way.\n\n- Traffic increased **18%** over the previous period.\n- Your homepage is the most popular entry point.',
  },
  {
    type: 'chart',
    id: 'chart',
    title: 'A closer look',
    component: {
      type: 'TextBlock',
      websiteId: 'site-1',
      props: { text: 'Organic search brings your most engaged visitors.' },
    },
  },
  { type: 'link', id: 'link', label: 'Open websites', href: '/websites' },
];
const frame = (event: any) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

test('global assistant: history, markdown, rename and delete', async ({ page }) => {
  const replies: any[] = [];
  let chats = [summary];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let body: any = {};
    if (path === '/api/auth/verify')
      body = { id: 'user-1', username: 'Alex', role: 'admin', isAdmin: true };
    else if (path === '/api/config')
      body = { cloudMode: false, updatesDisabled: true, telemetryDisabled: true };
    else if (path === '/api/ai/assistant/chats') body = method === 'POST' ? summary : chats;
    else if (path.endsWith('/reply')) {
      replies.push(route.request().postDataJSON());
      body = { ok: true };
    } else if (path.endsWith('/turn'))
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
    else if (path === '/api/ai/assistant/chats/chat-1') {
      if (method === 'DELETE') {
        chats = [];
        body = { ok: true };
      } else if (method === 'PATCH') {
        chats = [{ ...summary, title: route.request().postDataJSON().title }];
        body = chats[0];
      } else body = { ...summary, messages: [] };
    } else if (path.endsWith('/websites') || path.endsWith('/teams')) body = { data: [], count: 0 };
    await route.fulfill({ json: body });
  });
  await page.goto('/assistant');
  await expect(
    page.getByRole('heading', { name: 'Hi Alex, what do you want to know?' }),
  ).toBeVisible();
  await page.getByLabel('Message Assistant').fill('Compare my traffic');
  await page.getByLabel('Message Assistant').press('Shift+Enter');
  await expect(page.getByLabel('Message Assistant')).toHaveValue('Compare my traffic\n');
  await page.getByLabel('Message Assistant').press('Enter');
  await expect(page.getByRole('heading', { name: 'Your audience is growing' })).toBeVisible();
  await page.getByText('Thought for 12s').click();
  await expect(
    page.getByText('I checked the websites and compared the last 30 days.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Traffic overview' }).count();
  await page.getByLabel('Actions for Traffic overview').click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByLabel('Chat title').fill('Renamed chat');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Renamed chat', exact: true })).toBeVisible();
  await page.getByLabel('Actions for Renamed chat').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Delete this conversation?' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete chat', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Hi Alex, what do you want to know?' }),
  ).toBeVisible();
});

test('live deltas, confirm/question POSTs and Escape cancellation', async ({ page }) => {
  const replies: any[] = [];
  let cancelled = false;
  let response: any;
  const sockets = new Set<any>();
  const server = createServer((request, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:3317');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
    if (request.method === 'OPTIONS') {
      res.end();
      return;
    }
    response = res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
    res.write(frame({ type: 'start', chatId: summary.id, messageId: 'live' }));
    res.write(frame({ type: 'text_delta', partId: 'text', delta: '**Live answer**' }));
    res.write(
      frame({
        type: 'part',
        part: {
          type: 'confirm',
          id: 'c',
          title: 'Create a board?',
          message: 'Save this analysis.',
          state: 'pending',
        },
      }),
    );
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let body: any = {};
      if (path === '/api/auth/verify')
        body = { id: 'user-1', username: 'Alex', role: 'admin', isAdmin: true };
      else if (path === '/api/config')
        body = { cloudMode: false, updatesDisabled: true, telemetryDisabled: true };
      else if (path === '/api/ai/assistant/chats')
        body = route.request().method() === 'POST' ? summary : [];
      else if (path.endsWith('/turn'))
        return route.continue({ url: `http://127.0.0.1:${(server.address() as any).port}/stream` });
      else if (path.endsWith('/reply')) {
        const value = route.request().postDataJSON();
        replies.push(value);
        if (value.kind === 'confirm')
          response.write(
            frame({
              type: 'part',
              part: {
                type: 'question',
                id: 'q',
                question: 'Which website?',
                options: ['Main website'],
                allowText: true,
                state: 'pending',
              },
            }),
          );
        body = { ok: true };
      } else if (path.endsWith('/cancel')) {
        cancelled = true;
        body = { ok: true };
      } else if (path.endsWith('/websites') || path.endsWith('/teams'))
        body = { data: [], count: 0 };
      await route.fulfill({ json: body });
    });
    await page.goto('/assistant');
    await page.getByLabel('Message Assistant').fill('Build a board');
    await page.getByLabel('Message Assistant').press('Enter');
    await expect(page.getByText('Live answer', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await page.getByRole('button', { name: 'Main website', exact: true }).click();
    await expect.poll(() => replies.length).toBe(2);
    expect(replies).toEqual([
      { partId: 'c', kind: 'confirm', confirmed: true },
      { partId: 'q', kind: 'question', answer: 'Main website' },
    ]);
    await page.getByLabel('Message Assistant').press('Escape');
    await expect.poll(() => cancelled).toBe(true);
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
    await expect(page.getByText('Stopped', { exact: true })).toBeVisible();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
