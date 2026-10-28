// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  message: vi.fn(),
}));
vi.mock('@/lib/prisma', () => {
  const aiChat = {
    findMany: mocks.findMany,
    findFirst: mocks.findFirst,
    create: mocks.create,
    updateMany: mocks.updateMany,
    deleteMany: mocks.deleteMany,
  };
  return {
    default: {
      client: { aiChat },
      transaction: async (fn: any) => fn({ aiChat, aiChatMessage: { create: mocks.message } }),
    },
  };
});
import { boundedSession, SESSION_BYTES, store } from './store';
beforeEach(() => vi.clearAllMocks());
it('bounds session snapshots by bytes, dropping whole oversized sessions', () => {
  expect(boundedSession('x'.repeat(SESSION_BYTES))).toHaveLength(SESSION_BYTES);
  expect(boundedSession('é'.repeat(SESSION_BYTES))).toBeNull();
  expect(boundedSession(null)).toBeNull();
});
it('includes ownership constraints on reads and writes', async () => {
  await store.list('user');
  await store.get('user', 'chat');
  await store.rename('user', 'chat', 'Title');
  await store.delete('user', 'chat');
  expect(mocks.findMany.mock.calls[0][0].where).toEqual({ userId: 'user' });
  for (const mock of [mocks.findFirst, mocks.updateMany, mocks.deleteMany])
    expect(mock.mock.calls[0][0].where).toEqual({ id: 'chat', userId: 'user' });
});
it('does not insert a message into a foreign/deleted chat', async () => {
  mocks.updateMany.mockResolvedValue({ count: 0 });
  await expect(
    store.append('user', 'foreign', {
      id: 'message',
      role: 'user',
      text: 'hi',
      createdAt: new Date().toISOString(),
    }),
  ).rejects.toThrow('Chat not found');
  expect(mocks.message).not.toHaveBeenCalled();
});
it('inserts message and bounded session in an owned transaction', async () => {
  mocks.updateMany.mockResolvedValue({ count: 1 });
  await store.append(
    'user',
    'chat',
    { id: 'message', role: 'user', text: 'hi', createdAt: new Date().toISOString() },
    'session',
  );
  expect(mocks.updateMany.mock.calls[0][0]).toMatchObject({
    where: { id: 'chat', userId: 'user' },
    data: { piSession: 'session' },
  });
  expect(mocks.message.mock.calls[0][0].data.content.text).toBe('hi');
});
