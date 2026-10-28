'use client';

import { Button, Column, Dialog, Modal, Row, Text, TextField } from '@umami/react-zen';
import { useEffect, useRef, useState } from 'react';
import ChartJS from 'chart.js/auto';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PageBody } from '@/components/common/PageBody';
import { useLoginQuery } from '@/components/hooks';
import { ArrowUp, Check, History, Plus, Sparkles, Square, X } from '@/components/icons';
import {
  ASSISTANT_API,
  applyAssistantEvent,
  type AssistantChat,
  type AssistantChatSummary,
  type AssistantPart,
  type AssistantReply,
} from '@/lib/ai/assistant/protocol';
import { getApiUrl } from '@/lib/api-url';
import { getClientAuthToken } from '@/lib/client';
import { BoardComponentRenderer } from '../boards/[boardId]/BoardComponentRenderer';
import { readAssistantStream } from './stream';
import styles from './AssistantPage.module.css';

// Streaming inserts charts during layout; avoid animating from their initial narrow measurement.
ChartJS.register({
  id: 'assistantChartLayout',
  beforeInit(chart) {
    if (chart.canvas.closest('[data-assistant-chart]')) chart.options.animation = false;
  },
  beforeUpdate(chart) {
    if (chart.canvas.closest('[data-assistant-chart]')) chart.options.animation = false;
  },
});

async function request(path: string, method = 'GET', data?: unknown, signal?: AbortSignal) {
  const response = await fetch(getApiUrl(path), {
    method,
    signal,
    headers: {
      authorization: `Bearer ${getClientAuthToken()}`,
      'Content-Type': 'application/json',
      Accept: path.endsWith('/turn') ? 'text/event-stream' : 'application/json',
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (!response.ok)
    throw new Error(`Assistant request failed (${response.status}). Please try again.`);
  return response;
}

export function historyGroup(date: string, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return new Date(date) >= today ? 'Today' : new Date(date) >= yesterday ? 'Yesterday' : 'Earlier';
}

export function AssistantPage() {
  const { user } = useLoginQuery();
  const [chats, setChats] = useState<AssistantChatSummary[]>([]);
  const [chat, setChat] = useState<AssistantChat | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [history, setHistory] = useState(false);
  const [edit, setEdit] = useState<{
    chat: AssistantChatSummary;
    kind: 'rename' | 'delete';
  } | null>(null);
  const [title, setTitle] = useState('');
  const controller = useRef<AbortController | null>(null);
  const selection = useRef(0);
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let mounted = true;
    request(ASSISTANT_API.chats)
      .then(r => r.json())
      .then(data => {
        if (mounted) setChats(data);
      })
      .catch(e => {
        if (mounted) setError(e.message);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (follow.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [chat]);
  useEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
  }, [draft]);

  function updateSummary(summary: AssistantChatSummary) {
    setChats(list => [summary, ...list.filter(item => item.id !== summary.id)]);
  }
  async function openChat(id: string) {
    const version = ++selection.current;
    setLoading(true);
    setError('');
    setHistory(false);
    try {
      const data = await (await request(ASSISTANT_API.chat(id))).json();
      if (version === selection.current) {
        setChat(data);
        follow.current = true;
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (version === selection.current) setLoading(false);
    }
  }
  async function stop() {
    const id = chat?.id;
    controller.current?.abort();
    if (id)
      try {
        await request(ASSISTANT_API.cancel(id), 'POST');
      } catch (e) {
        setError((e as Error).message);
      }
  }
  async function send() {
    if (!draft.trim() || busy || loading) return;
    const text = draft.trim();
    setBusy(true);
    setError('');
    follow.current = true;
    const abort = new AbortController();
    controller.current = abort;
    let active = chat;
    let messageId = `pending-${Date.now()}`;
    try {
      if (!active) {
        const summary = await (await request(ASSISTANT_API.chats, 'POST', {}, abort.signal)).json();
        updateSummary(summary);
        active = { ...summary, messages: [] };
      }
      const id = active!.id;
      setChat({
        ...active!,
        messages: [
          ...active!.messages,
          { id: `user-${Date.now()}`, role: 'user', text, createdAt: new Date().toISOString() },
          {
            id: messageId,
            role: 'assistant',
            parts: [],
            status: 'done',
            createdAt: new Date().toISOString(),
          },
        ],
      });
      setDraft('');
      const response = await request(
        ASSISTANT_API.turn(id),
        'POST',
        { message: text, context: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } },
        abort.signal,
      );
      if (!response.body) throw new Error('Assistant stream unavailable.');
      await readAssistantStream(response.body, abort.signal, event => {
        if (event.type === 'title') {
          setChats(list =>
            list.map(item => (item.id === event.chatId ? { ...item, title: event.title } : item)),
          );
          setChat(value =>
            value && value.id === event.chatId ? { ...value, title: event.title } : value,
          );
        }
        if (event.type === 'error') setError(event.error);
        const previousId = messageId;
        if (event.type === 'start') messageId = event.messageId;
        setChat(value =>
          !value || value.id !== id
            ? value
            : {
                ...value,
                messages: value.messages.map(message => {
                  if (message.id !== previousId || message.role !== 'assistant') return message;
                  if (event.type === 'done' || (event.type === 'error' && event.message))
                    return event.message!;
                  return {
                    ...message,
                    id: messageId,
                    parts: applyAssistantEvent(message.parts, event),
                    ...(event.type === 'error'
                      ? { status: 'error' as const, error: event.error }
                      : {}),
                  };
                }),
              },
        );
      });
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
      setChat(
        value =>
          value && {
            ...value,
            messages: value.messages.map(message =>
              message.id === messageId && message.role === 'assistant'
                ? { ...message, status: abort.signal.aborted ? 'cancelled' : 'error' }
                : message,
            ),
          },
      );
    } finally {
      if (abort.signal.aborted)
        setChat(
          value =>
            value && {
              ...value,
              messages: value.messages.map(message =>
                message.id === messageId && message.role === 'assistant'
                  ? { ...message, status: 'cancelled' }
                  : message,
              ),
            },
        );
      controller.current = null;
      setBusy(false);
      input.current?.focus();
    }
  }
  async function reply(value: AssistantReply) {
    if (!chat) return;
    await request(ASSISTANT_API.reply(chat.id), 'POST', value);
  }
  async function saveEdit() {
    if (!edit || (edit.kind === 'rename' && !title.trim())) return;
    try {
      if (edit.kind === 'delete') {
        await request(ASSISTANT_API.chat(edit.chat.id), 'DELETE');
        setChats(list => list.filter(item => item.id !== edit.chat.id));
        if (chat?.id === edit.chat.id) setChat(null);
      } else {
        const summary = await (
          await request(ASSISTANT_API.chat(edit.chat.id), 'PATCH', { title: title.trim() })
        ).json();
        setChats(list => list.map(item => (item.id === summary.id ? summary : item)));
        setChat(value => (value?.id === summary.id ? { ...value, ...summary } : value));
      }
      setEdit(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <PageBody>
      <Column className={styles.page}>
        <div className={styles.workspace}>
          <aside
            aria-label="Chat history"
            className={`${styles.history} ${history ? styles.historyOpen : ''}`}
          >
            <Button
              isDisabled={busy}
              onPress={() => {
                ++selection.current;
                setChat(null);
                setLoading(false);
                setError('');
                setHistory(false);
                input.current?.focus();
              }}
            >
              <Plus size={16} /> New chat
            </Button>
            <Text color="muted" size="sm">
              Your private conversations
            </Text>
            {['Today', 'Yesterday', 'Earlier'].map(group => {
              const items = chats.filter(item => historyGroup(item.updatedAt) === group);
              return (
                items.length > 0 && (
                  <section key={group}>
                    <h2>{group}</h2>
                    {items.map(item => (
                      <div
                        key={item.id}
                        className={`${styles.chatRow} ${chat?.id === item.id ? styles.selected : ''}`}
                      >
                        <button
                          disabled={busy}
                          className={styles.chatTitle}
                          onClick={() => openChat(item.id)}
                        >
                          {item.title}
                        </button>
                        <details className={styles.chatMenu}>
                          <summary aria-label={`Actions for ${item.title}`}>···</summary>
                          <div>
                            <button
                              disabled={busy}
                              onClick={event => {
                                event.currentTarget.closest('details')?.removeAttribute('open');
                                setEdit({ chat: item, kind: 'rename' });
                                setTitle(item.title);
                              }}
                            >
                              Rename
                            </button>
                            <button
                              disabled={busy}
                              onClick={event => {
                                event.currentTarget.closest('details')?.removeAttribute('open');
                                setEdit({ chat: item, kind: 'delete' });
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        </details>
                      </div>
                    ))}
                  </section>
                )
              );
            })}
          </aside>
          <main
            className={styles.conversation}
            aria-label="Assistant conversation"
            onKeyDown={event => {
              if (event.key === 'Escape' && busy) {
                event.preventDefault();
                void stop();
              }
            }}
          >
            <div className={styles.conversationTitle}>
              <Button aria-label="Chat history" onPress={() => setHistory(!history)}>
                <History size={16} />
              </Button>
              <strong>{chat?.title || 'Assistant'}</strong>
              <span>Only you can see this chat</span>
            </div>
            <div
              ref={log}
              role="log"
              aria-label="Messages"
              aria-busy={busy}
              className={styles.timeline}
              onScroll={() => {
                const node = log.current!;
                follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
              }}
            >
              <div className={styles.messageColumn}>
                {loading ? (
                  <p className={styles.muted}>Loading conversations…</p>
                ) : !chat?.messages.length ? (
                  <div className={styles.empty}>
                    <Sparkles size={28} strokeWidth={1.3} />
                    <h1>Hi {user?.username || 'there'}, what do you want to know?</h1>
                    <p>Ask about your analytics. Explore an idea. Build something useful.</p>
                    <div className={styles.suggestions}>
                      {[
                        'Compare unique visitors of all my websites last 30 days',
                        'Create a board for my website',
                        'What changed in my traffic this week?',
                      ].map(text => (
                        <button
                          key={text}
                          onClick={() => {
                            setDraft(text);
                            input.current?.focus();
                          }}
                        >
                          {text}
                          <span>↗</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  chat.messages.map(message => (
                    <article
                      key={message.id}
                      className={message.role === 'user' ? styles.user : styles.assistant}
                    >
                      {message.role === 'user' ? (
                        message.text
                      ) : (
                        <>
                          {message.parts.map(part => (
                            <Part
                              key={part.id}
                              part={part}
                              active={busy && message === chat.messages.at(-1)}
                              reply={reply}
                            />
                          ))}
                          {message.status === 'cancelled' && (
                            <p className={styles.muted}>Stopped</p>
                          )}
                          {message.error && <p role="alert">{message.error}</p>}
                        </>
                      )}
                    </article>
                  ))
                )}
                {busy && (
                  <div role="status" className={styles.muted}>
                    Working<span className={styles.pulse}> ···</span>
                  </div>
                )}
              </div>
            </div>
            <div className={styles.composerWrap}>
              {error && (
                <p role="alert" className={styles.error}>
                  {error}
                </p>
              )}
              <form
                className={styles.composer}
                onSubmit={event => {
                  event.preventDefault();
                  void send();
                }}
              >
                <textarea
                  ref={input}
                  aria-label="Message Assistant"
                  placeholder="Ask anything about your analytics…"
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  rows={1}
                  onKeyDown={event => {
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <Row justifyContent="space-between" alignItems="center">
                  {busy ? (
                    <Button aria-label="Stop" onPress={() => void stop()}>
                      <Square size={16} />
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      aria-label="Send message"
                      isDisabled={!draft.trim() || loading}
                    >
                      <ArrowUp size={18} />
                    </Button>
                  )}
                </Row>
              </form>
              <p className={styles.disclaimer}>
                Assistant can make mistakes. Review important changes.
              </p>
            </div>
          </main>
        </div>
        {edit && (
          <Modal
            isOpen
            onOpenChange={open => {
              if (!open) setEdit(null);
            }}
          >
            <Dialog
              aria-label={edit.kind === 'delete' ? 'Delete chat' : 'Rename chat'}
              title={edit.kind === 'delete' ? 'Delete this conversation?' : 'Rename conversation'}
              style={{ width: '440px', maxWidth: 'calc(100vw - 40px)', padding: '24px' }}
            >
              <Column gap="4">
                {edit.kind === 'delete' ? (
                  <p>This permanently deletes “{edit.chat.title}”. This cannot be undone.</p>
                ) : (
                  <TextField autoFocus aria-label="Chat title" value={title} onChange={setTitle} />
                )}
                <Row gap="2">
                  <Button onPress={() => setEdit(null)}>Cancel</Button>
                  <Button onPress={() => void saveEdit()}>
                    {edit.kind === 'delete' ? 'Delete chat' : 'Save'}
                  </Button>
                </Row>
              </Column>
            </Dialog>
          </Modal>
        )}
      </Column>
    </PageBody>
  );
}

/** Board charts mount inside an already measured chat column, including their HTML legend. */
function InlineChart({ children }: { children: React.ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let frame = 0;
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!node.clientWidth) return;
        setReady(true);
        node.querySelectorAll('canvas').forEach(canvas => {
          const chart = ChartJS.getChart(canvas);
          if (chart) {
            const container = canvas.parentElement!;
            chart.options.animation = false;
            chart.stop();
            chart.resize(container.clientWidth, container.clientHeight);
            chart.update('none');
            canvas.dataset.plotWidth = String(chart.chartArea.width);
          }
        });
      });
    };
    const observer = new ResizeObserver(resize);
    // Board charts animate their initial layout; remeasure once that layout has settled.
    const settled = setTimeout(resize, 500);
    const mutations = new MutationObserver(records => {
      if (
        [...node.querySelectorAll('canvas')].some(
          canvas => ChartJS.getChart(canvas)?.options.animation !== false,
        )
      ) {
        resize();
        return;
      }
      if (
        records.some(
          record =>
            record.type === 'attributes' &&
            record.target instanceof HTMLCanvasElement &&
            (() => {
              const chart = ChartJS.getChart(record.target);
              return (
                chart &&
                chart.chartArea &&
                chart.chartArea.width < record.target.parentElement!.clientWidth * 0.5
              );
            })(),
        ) ||
        records.some(record =>
          [...record.addedNodes].some(
            node =>
              node instanceof Element && (node.matches('canvas') || node.querySelector('canvas')),
          ),
        )
      )
        resize();
    });
    observer.observe(node);
    mutations.observe(node, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['width', 'height'],
    });
    resize();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settled);
      observer.disconnect();
      mutations.disconnect();
    };
  }, []);
  return (
    <div ref={host} className={styles.chartBody} data-assistant-chart>
      {ready ? <div>{children}</div> : null}
    </div>
  );
}

// Model-generated navigation is restricted to same-origin app paths, not external URLs.
function isAppPath(href: string) {
  if (!href.startsWith('/') || href.startsWith('//') || href.includes('\\')) return false;
  try {
    return new URL(href, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

export function Part({
  part,
  active,
  reply,
}: {
  part: AssistantPart;
  active: boolean;
  reply: (value: AssistantReply) => Promise<void>;
}) {
  const [answer, setAnswer] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function respond(value: AssistantReply) {
    if (pending || submitted) return;
    setPending(true);
    setError('');
    try {
      await reply(value);
      setSubmitted(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  switch (part.type) {
    case 'text':
      return (
        <div className={styles.markdown}>
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) =>
                href && isAppPath(href) ? <a href={href}>{children}</a> : <>{children}</>,
            }}
          >
            {part.text}
          </Markdown>
        </div>
      );
    case 'thinking':
      return (
        <details className={styles.thinking}>
          <summary>
            {part.durationMs === undefined
              ? 'Thinking'
              : `Thought for ${Math.round(part.durationMs / 1000)}s`}
          </summary>
          <div>{part.text}</div>
        </details>
      );
    case 'tool':
      return (
        <details className={styles.tool}>
          <summary>
            <span aria-label={part.status}>
              {part.status === 'done' ? (
                <Check size={14} />
              ) : part.status === 'running' ? (
                '◌'
              ) : (
                <X size={14} />
              )}
            </span>
            <strong>{part.title || part.name}</strong>
            <span>
              {part.status}
              {part.durationMs === undefined ? '' : ` · ${(part.durationMs / 1000).toFixed(1)}s`}
            </span>
          </summary>
          <p>{part.name}</p>
          <pre>{JSON.stringify(part.args, null, 2)}</pre>
          {part.result && <pre>{part.result}</pre>}
        </details>
      );
    case 'chart':
      return (
        <section className={styles.chart}>
          <h3>{part.title || part.component.title || 'Analytics'}</h3>
          <InlineChart>
            <BoardComponentRenderer
              config={part.component}
              websiteId={part.component.websiteId || part.component.entityId}
              entityType={part.component.entityType}
            />
          </InlineChart>
        </section>
      );
    case 'link':
      return isAppPath(part.href) ? (
        <a className={styles.link} href={part.href}>
          {part.label} ↗
        </a>
      ) : (
        <Text>{part.label}</Text>
      );
    case 'confirm':
      return (
        <section className={styles.card}>
          <h3>{part.title}</h3>
          <p>{part.message}</p>
          {part.state === 'pending' && active && !submitted ? (
            <Row gap="2">
              <Button
                isDisabled={pending}
                onPress={() => void respond({ partId: part.id, kind: 'confirm', confirmed: true })}
              >
                Confirm
              </Button>
              <Button
                isDisabled={pending}
                onPress={() => void respond({ partId: part.id, kind: 'confirm', confirmed: false })}
              >
                Reject
              </Button>
            </Row>
          ) : (
            <Text color="muted">
              {submitted
                ? 'Reply sent'
                : part.state === 'pending'
                  ? 'No longer active'
                  : part.state}
            </Text>
          )}
          {error && <p role="alert">{error}</p>}
        </section>
      );
    case 'question':
      return (
        <section className={styles.card}>
          <h3>{part.question}</h3>
          {part.state === 'pending' && active && !submitted ? (
            <>
              <div className={styles.options}>
                {part.options?.map(option => (
                  <Button
                    key={option}
                    isDisabled={pending}
                    onPress={() =>
                      void respond({ partId: part.id, kind: 'question', answer: option })
                    }
                  >
                    {option}
                  </Button>
                ))}
              </div>
              {part.allowText && (
                <form
                  onSubmit={event => {
                    event.preventDefault();
                    if (answer.trim())
                      void respond({ partId: part.id, kind: 'question', answer: answer.trim() });
                  }}
                >
                  <input
                    aria-label="Your answer"
                    value={answer}
                    onChange={e => setAnswer(e.target.value)}
                  />
                  <Button type="submit" isDisabled={pending || !answer.trim()}>
                    Reply
                  </Button>
                </form>
              )}
            </>
          ) : (
            <Text color="muted">
              {submitted
                ? 'Reply sent'
                : part.answer || (part.state === 'pending' ? 'No longer active' : part.state)}
            </Text>
          )}
          {error && <p role="alert">{error}</p>}
        </section>
      );
  }
}
