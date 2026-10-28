'use client';
import { Button } from '@umami/react-zen';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBoard } from '@/components/hooks';
import { validateBoardDraft } from '@/lib/ai/board-draft';
import { AI_LIMITS, type AiPhase, type AiQuestion, validateAiResult } from '@/lib/ai/rpc/contract';
import { getApiUrl } from '@/lib/api-url';
import { getClientAuthToken } from '@/lib/client';
import { getBoardEntityIds, getBoardType } from '@/lib/boards';
import type { BoardParameters } from '@/lib/types';
import styles from './BoardAiChat.module.css';
import { readAiStream } from './ai-stream';

type Message = { role: 'user' | 'assistant'; content: string; questions?: AiQuestion[] };
const phaseLabels: Record<AiPhase, string> = {
  start: 'Starting your request',
  check: 'Checking available context',
  read: 'Reading authorized analytics',
  prepare: 'Preparing a response',
  validate: 'Validating the draft',
  complete: 'Checks complete · waiting for the result',
};

/** Manual boards remain unrestricted. Only the AI boundary uses this strict subset. */
export function getAiInput(board: Parameters<typeof getBoardType>[0]): {
  draft?: BoardParameters;
  reason?: string;
} {
  if (!['mixed', 'dashboard', 'website'].includes(getBoardType(board))) {
    return { reason: 'AI supports website boards only. Continue editing this board manually.' };
  }
  const ids = getBoardEntityIds(board);
  if (ids.pixelIds.length || ids.linkIds.length) {
    return {
      reason: 'AI supports website data only. Pixel and link boards can still be edited manually.',
    };
  }
  const parameters = board.parameters;
  const empty = !parameters?.rows?.some(row => row.columns.some(column => column.component));
  if (empty && !parameters?.websiteId) return {};
  try {
    return { draft: validateBoardDraft(parameters) };
  } catch {
    return {
      reason:
        'This layout or website selection is not supported by AI. You can keep editing it manually. AI supports website summaries, charts, maps, tables and text only.',
    };
  }
}

export function BoardAiChat() {
  const { board, updateBoard, isPending, aiPending, setAiPending, registerAiCancel } = useBoard();
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState('');
  const [notice, setNotice] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [phase, setPhase] = useState<AiPhase>('start');
  const active = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { draft, reason } = getAiInput(board);

  const cancel = useCallback(() => {
    if (!active.current) return;
    active.current.abort();
    active.current = null;
    setAiPending(false);
    setNotice('AI request cancelled. Your draft is unchanged.');
    inputRef.current?.focus();
  }, [setAiPending]);

  useEffect(() => {
    registerAiCancel(cancel);
    return () => {
      registerAiCancel(null);
      active.current?.abort();
      active.current = null;
      setAiPending(false);
    };
  }, [cancel, registerAiCancel, setAiPending]);

  useEffect(() => {
    cancel();
    setMessages([]);
    setPrompt('');
    setNotice('');
    setUnavailable(false);
  }, [board.id, cancel]);

  const send = async () => {
    if (active.current || isPending || unavailable || reason || !prompt.trim()) return;
    const next: Message[] = [...messages, { role: 'user' as const, content: prompt.trim() }].slice(
      -23,
    );
    const requestBody = () =>
      JSON.stringify({
        boardId: board.id,
        messages: next.map(({ role, content }) => ({ role, content })),
        draft,
      });
    let body = requestBody();
    while (new TextEncoder().encode(body).byteLength > AI_LIMITS.inputBytes) {
      if (next.length === 1) {
        setMessages([]);
        setNotice(
          'This prompt and draft exceed the AI request size limit. Shorten your request or simplify the board manually. Older chat was cleared; your prompt and draft are unchanged.',
        );
        return;
      }
      next.shift();
      body = requestBody();
    }
    const controller = new AbortController();
    active.current = controller;
    setMessages(next);
    setPrompt('');
    setNotice('');
    setAiPending(true);
    setPhase('start');
    try {
      const response = await fetch(getApiUrl('/ai/boards/chat', { apiUrl: '' }), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          authorization: `Bearer ${getClientAuthToken()}`,
        },
        body,
        signal: controller.signal,
      });
      if (active.current !== controller || controller.signal.aborted) return;
      if (!response.ok) {
        if (response.status === 503) setUnavailable(true);
        const errors: Record<number, string> = {
          401: 'Sign in again to use AI board assistance.',
          403: 'You do not have access to this board or website. Check your selection.',
          400: 'This board or website selection is not supported. Continue editing manually.',
          429: 'AI is busy. Try again shortly.',
          503: 'AI board assistance is disabled. You can still edit and save manually.',
        };
        throw new Error(errors[response.status] || 'AI could not complete the request. Try again.');
      }
      const streamed = response.headers?.get('content-type')?.includes('text/event-stream');
      const data = validateAiResult(
        streamed && response.body
          ? await readAiStream(response.body, controller.signal, value => {
              if (active.current === controller && !controller.signal.aborted) setPhase(value);
            })
          : await response.json(),
      );
      if (active.current !== controller || controller.signal.aborted) return;
      const candidate = data.draft;
      if (
        candidate &&
        getBoardType(board) === 'website' &&
        candidate.websiteId !== board.parameters?.websiteId
      ) {
        throw new Error('AI changed the website selection. Your draft is unchanged.');
      }
      // Clear before updateBoard: provider cancels requests on every manual update.
      active.current = null;
      if (candidate) updateBoard({ parameters: candidate });
      setMessages(
        [...next, { role: 'assistant', content: data.message, questions: data.questions }].slice(
          -24,
        ) as Message[],
      );
      setNotice(
        candidate
          ? 'Draft preview updated. Review it, then choose Save to keep changes.'
          : 'AI replied. Your draft is unchanged.',
      );
    } catch (error) {
      if (active.current !== controller || controller.signal.aborted) return;
      setNotice(
        error instanceof Error &&
          /^(AI |Sign in again|You do not have access|This board or website selection)/.test(
            error.message,
          )
          ? error.message
          : 'AI returned an unsupported response. Your draft is unchanged.',
      );
    } finally {
      if (active.current === controller) active.current = null;
      if (!active.current) setAiPending(false);
      if (!active.current && !controller.signal.aborted) inputRef.current?.focus();
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="board-ai-title">
      <div className={styles.heading}>
        <h2 id="board-ai-title">AI board assistant</h2>
        <span>Draft preview only</span>
      </div>
      <p id="board-ai-help" className={styles.help}>
        Start with a goal. The assistant can check available analytics and ask when something is
        unclear. Review the local preview, then choose Save to keep it. Chat clears when you leave.
      </p>
      <div className={styles.context}>
        <strong>Working context</strong>
        <p>
          {board.parameters?.websiteId
            ? 'Website selected in this board.'
            : 'No website selected. Tell the assistant which website to use.'}
        </p>
        <p>
          Date range and event meanings are not confirmed here. The assistant must check authorized
          data, not infer what an event means.
        </p>
      </div>
      {!messages.length && (
        <p className={styles.help}>
          What would you like to understand? Try “Help me understand how visitors reach my most
          popular pages.”
        </p>
      )}
      {reason && <p role="status">{reason}</p>}
      {messages.length > 0 && (
        <div
          className={styles.messages}
          role="log"
          aria-label="Board AI conversation"
          aria-live="polite"
        >
          {messages.map((message, index) => (
            <div key={index} className={styles.message}>
              <strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong>
              <p>{message.content}</p>
              {message.questions?.map(question => (
                <fieldset
                  key={question.id}
                  className={styles.question}
                  disabled={aiPending || isPending || unavailable}
                >
                  <legend>{question.question}</legend>
                  <div className={styles.options}>
                    {question.options?.map(option => (
                      <Button
                        key={option.value}
                        type="button"
                        variant="outline"
                        onPress={() => {
                          setPrompt(`${question.question}\n${option.label}: ${option.value}`);
                          inputRef.current?.focus();
                        }}
                      >
                        {option.label}
                      </Button>
                    ))}
                    <Button
                      type="button"
                      variant="quiet"
                      onPress={() => {
                        setPrompt(`${question.question}\n`);
                        inputRef.current?.focus();
                      }}
                    >
                      Write my own answer
                    </Button>
                  </div>
                </fieldset>
              ))}
            </div>
          ))}
        </div>
      )}
      {aiPending && (
        <div className={styles.progress} role="status" aria-live="polite">
          <strong>{phaseLabels[phase]}</strong>
          <p>
            No changes are applied until a validated result arrives. Cancel or edit manually to
            stop.
          </p>
        </div>
      )}
      <form
        aria-busy={aiPending}
        onSubmit={event => {
          event.preventDefault();
          void send();
        }}
      >
        <label htmlFor="board-ai-prompt">Describe your board or a change</label>
        <textarea
          ref={inputRef}
          id="board-ai-prompt"
          className={styles.input}
          value={prompt}
          onChange={event => setPrompt(event.target.value)}
          maxLength={4000}
          rows={2}
          placeholder="Show daily pageviews and top pages for my website"
          aria-describedby="board-ai-help"
          disabled={!!reason || unavailable || isPending}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className={styles.actions}>
          <Button
            type="submit"
            variant="primary"
            isDisabled={aiPending || isPending || !!reason || unavailable || !prompt.trim()}
          >
            {aiPending ? 'Generating…' : 'Ask AI'}
          </Button>
          {aiPending && (
            <Button type="button" variant="outline" onPress={cancel}>
              Cancel AI
            </Button>
          )}
          <Button
            type="button"
            variant="quiet"
            isDisabled={aiPending || !messages.length}
            onPress={() => {
              setMessages([]);
              setNotice('Chat cleared. Your draft is unchanged.');
            }}
          >
            Clear chat
          </Button>
        </div>
      </form>
      <p className={styles.status} role="status" aria-live="polite">
        {aiPending ? '' : notice}
      </p>
    </section>
  );
}
