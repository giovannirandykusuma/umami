import { handleAiChat } from '@/lib/ai/server';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return handleAiChat(request);
}
