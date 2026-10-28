// Shared contract between the global assistant backend and UI.
// Pure types + tiny helpers only: no server imports, safe in the browser.

import type { BoardComponentConfig } from '@/lib/types';

/** REST + stream endpoints (all require the normal Umami auth). */
export const ASSISTANT_API = {
  /** GET → AssistantChatSummary[] (newest first). POST {title?} → AssistantChatSummary */
  chats: '/ai/assistant/chats',
  /** GET → AssistantChat, PATCH {title} → AssistantChatSummary, DELETE → {ok:true} */
  chat: (chatId: string) => `/ai/assistant/chats/${chatId}`,
  /**
   * POST {message, context?} with `Accept: text/event-stream` → SSE of AssistantStreamEvent.
   * One active turn per chat. The user message is persisted before streaming starts and the
   * assistant message is persisted when the turn settles (done, error or cancel).
   */
  turn: (chatId: string) => `/ai/assistant/chats/${chatId}/turn`,
  /** POST AssistantReply → {ok:true}; answers a pending confirm/question of the running turn. */
  reply: (chatId: string) => `/ai/assistant/chats/${chatId}/reply`,
  /** POST → {ok:true}; aborts the running turn (closing the stream also aborts). */
  cancel: (chatId: string) => `/ai/assistant/chats/${chatId}/cancel`,
} as const;

export interface AssistantChatSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantChat extends AssistantChatSummary {
  messages: AssistantMessage[];
}

/** Optional page context the UI sends with a turn (e.g. the website being viewed). */
export interface AssistantTurnContext {
  websiteId?: string;
  boardId?: string;
  startAt?: number;
  endAt?: number;
  timezone?: string;
}

export type AssistantMessage =
  | { id: string; role: 'user'; createdAt: string; text: string }
  | {
      id: string;
      role: 'assistant';
      createdAt: string;
      parts: AssistantPart[];
      status: 'done' | 'error' | 'cancelled';
      error?: string;
    };

/** Ordered blocks of one assistant message, rendered like a Pi/Paseo timeline. */
export type AssistantPart =
  | { type: 'text'; id: string; text: string }
  | { type: 'thinking'; id: string; text: string; durationMs?: number }
  | {
      type: 'tool';
      id: string;
      name: string;
      /** Short human label, e.g. "GET /websites/…/stats" or "Create board “Apps”". */
      title: string;
      args: unknown;
      status: 'running' | 'done' | 'error' | 'denied';
      /** Truncated JSON/text result for the expandable details view. */
      result?: string;
      durationMs?: number;
    }
  | { type: 'chart'; id: string; title?: string; component: BoardComponentConfig }
  | { type: 'link'; id: string; label: string; href: string }
  | {
      type: 'confirm';
      id: string;
      title: string;
      message: string;
      state: 'pending' | 'confirmed' | 'rejected' | 'expired';
    }
  | {
      type: 'question';
      id: string;
      question: string;
      options?: string[];
      allowText: boolean;
      state: 'pending' | 'answered' | 'expired';
      answer?: string;
    };

/**
 * SSE frames: `event: <type>\ndata: <json>\n\n`. Deltas append to the part with the same id;
 * `part` inserts or replaces a whole part by id. Exactly one terminal event (done | error).
 */
export type AssistantStreamEvent =
  | { type: 'start'; chatId: string; messageId: string }
  | { type: 'text_delta'; partId: string; delta: string }
  | { type: 'thinking_delta'; partId: string; delta: string }
  | { type: 'part'; part: AssistantPart }
  | { type: 'title'; chatId: string; title: string }
  | { type: 'done'; message: AssistantMessage }
  | { type: 'error'; error: string; message?: AssistantMessage };

export type AssistantReply =
  | { partId: string; kind: 'confirm'; confirmed: boolean }
  | { partId: string; kind: 'question'; answer: string };

export const ASSISTANT_STREAM_EVENTS = [
  'start',
  'text_delta',
  'thinking_delta',
  'part',
  'title',
  'done',
  'error',
] as const;

/** Applies one stream event to an in-progress assistant message (pure; used by UI and tests). */
export function applyAssistantEvent(
  parts: AssistantPart[],
  event: AssistantStreamEvent,
): AssistantPart[] {
  switch (event.type) {
    case 'text_delta':
    case 'thinking_delta': {
      const kind = event.type === 'text_delta' ? 'text' : 'thinking';
      const index = parts.findIndex(part => part.id === event.partId);
      if (index === -1) return [...parts, { type: kind, id: event.partId, text: event.delta }];
      const existing = parts[index];
      if (existing.type !== kind) return parts;
      const next = parts.slice();
      next[index] = { ...existing, text: existing.text + event.delta };
      return next;
    }
    case 'part': {
      const index = parts.findIndex(part => part.id === event.part.id);
      if (index === -1) return [...parts, event.part];
      const next = parts.slice();
      next[index] = event.part;
      return next;
    }
    case 'done':
      return event.message.role === 'assistant' ? event.message.parts : parts;
    default:
      return parts;
  }
}
