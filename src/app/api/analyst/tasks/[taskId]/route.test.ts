// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFakeDb } from '@/lib/ai/assistant/analyst/fake-db';
const mocks = vi.hoisted(() => ({ db: null as any, parse: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  default: new Proxy({}, { get: (_t, key) => mocks.db.prisma[key] }),
}));
vi.mock('@/lib/request', () => ({ parseRequest: mocks.parse }));
import { ensureTask } from '@/lib/ai/assistant/analyst/task';
import { GET } from './route';

const USER = '11111111-1111-4111-8111-111111111111';
const CHAT = '33333333-3333-4333-8333-333333333333';
const call = (taskId: string) =>
  GET(new Request('http://localhost/api/analyst/tasks/x'), {
    params: Promise.resolve({ taskId }),
  });

beforeEach(() => {
  mocks.db = createFakeDb();
  mocks.db.chats.push({ id: CHAT, userId: USER });
  mocks.parse.mockResolvedValue({ auth: { user: { id: USER } } });
  process.env.AI_ANALYST_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.AI_ANALYST_ENABLED;
});

it('returns sanitized budgets to the owner only', async () => {
  const task = await ensureTask(USER, CHAT, 'goal');
  const response = await call(task.id);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ id: task.id, status: 'running', consumed: { toolCalls: 0 } });
  expect(JSON.stringify(body)).not.toMatch(/goal|image|capability/);
  mocks.parse.mockResolvedValue({ auth: { user: { id: '22222222-2222-4222-8222-222222222222' } } });
  expect((await call(task.id)).status).toBe(404);
});

it('is 404 when the flag is off or the id is malformed', async () => {
  const task = await ensureTask(USER, CHAT, 'goal');
  expect((await call('not-a-uuid')).status).toBe(404);
  delete process.env.AI_ANALYST_ENABLED;
  expect((await call(task.id)).status).toBe(404);
});
