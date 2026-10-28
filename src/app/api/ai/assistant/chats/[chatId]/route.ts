export {
  deleteChat as DELETE,
  getChat as GET,
  renameChat as PATCH,
} from '@/lib/ai/assistant/handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
