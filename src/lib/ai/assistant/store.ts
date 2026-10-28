import { randomUUID } from 'node:crypto';
import prisma from '@/lib/prisma';
import type { AssistantMessage } from './protocol';
import type { Prisma } from '@/generated/prisma/client';

export const SESSION_BYTES = 2 * 1024 * 1024;
export function boundedSession(session: string | null) {
  return session && Buffer.byteLength(session) <= SESSION_BYTES ? session : null;
}
export function summary(chat: any) {
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  };
}
export const store = {
  list: (userId: string) =>
    prisma.client.aiChat.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' } }),
  get: (userId: string, id: string) =>
    prisma.client.aiChat.findFirst({
      where: { id, userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    }),
  create: (userId: string, title: string) =>
    prisma.client.aiChat.create({ data: { id: randomUUID(), userId, title } }),
  rename: (userId: string, id: string, title: string) =>
    prisma.client.aiChat.updateMany({ where: { id, userId }, data: { title } }),
  delete: (userId: string, id: string) =>
    prisma.client.aiChat.deleteMany({ where: { id, userId } }),
  async append(userId: string, chatId: string, message: AssistantMessage, session?: string | null) {
    // Keep message insertion and ownership check in one transaction, including races with deletion.
    return prisma.transaction(async (tx: Prisma.TransactionClient) => {
      const owned = await tx.aiChat.updateMany({
        where: { id: chatId, userId },
        data: {
          updatedAt: new Date(),
          ...(session !== undefined ? { piSession: boundedSession(session) } : {}),
        },
      });
      if (!owned.count) throw new Error('Chat not found');
      await tx.aiChatMessage.create({
        data: {
          id: message.id,
          chatId,
          role: message.role,
          content: JSON.parse(JSON.stringify(message)),
        },
      });
    });
  },
};
