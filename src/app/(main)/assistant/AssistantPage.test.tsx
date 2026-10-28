import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { applyAssistantEvent } from '@/lib/ai/assistant/protocol';
import { historyGroup, Part } from './AssistantPage';
import { readAssistantStream } from './stream';

vi.mock('../boards/[boardId]/BoardComponentRenderer', () => ({
  BoardComponentRenderer: ({ config }: any) => <div>{config.type}</div>,
}));

describe('assistant timeline', () => {
  it('groups history by local calendar day', () => {
    const now = new Date(2026, 9, 28, 12);
    expect(historyGroup(new Date(2026, 9, 28).toISOString(), now)).toBe('Today');
    expect(historyGroup(new Date(2026, 9, 27).toISOString(), now)).toBe('Yesterday');
    expect(historyGroup(new Date(2026, 9, 25).toISOString(), now)).toBe('Earlier');
  });
  it('renders markdown, full collapsible thinking, tool details and the real chart boundary', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(700);
    const reply = vi.fn();
    render(
      <>
        <Part
          part={{ type: 'text', id: 'a', text: '**Hello** [unsafe](javascript:alert(1))' }}
          active={false}
          reply={reply}
        />
        <Part
          part={{ type: 'thinking', id: 'b', text: 'Full reasoning', durationMs: 12000 }}
          active={false}
          reply={reply}
        />
        <Part
          part={{
            type: 'tool',
            id: 'c',
            title: 'Get stats',
            name: 'stats',
            args: { site: 'a' },
            status: 'denied',
            result: 'Denied',
          }}
          active={false}
          reply={reply}
        />
        <Part
          part={{ type: 'chart', id: 'd', component: { type: 'TextBlock' } }}
          active={false}
          reply={reply}
        />
      </>,
    );
    expect(screen.getByText('Hello').tagName).toBe('STRONG');
    expect(screen.getByText('Thought for 12s')).toBeTruthy();
    expect(screen.getByText('Full reasoning')).toBeTruthy();
    expect(screen.getByText('Denied')).toBeTruthy();
    expect(await screen.findByText('TextBlock')).toBeTruthy();
    width.mockRestore();
  });
  it.each([
    '/boards/one?tab=stats#chart',
    '/',
    'https://example.com',
    '/\\example.com',
    '//example.com',
  ])('restricts link parts to app paths: %s', href => {
    const { container } = render(
      <Part
        part={{ type: 'link', id: 'link', href, label: 'Destination' }}
        active={false}
        reply={vi.fn()}
      />,
    );
    expect(container.querySelector('a')?.getAttribute('href') ?? null).toBe(
      href === '/' || href.startsWith('/boards/') ? href : null,
    );
  });
  it('renders external markdown links as plain text and retains app navigation', () => {
    const { container } = render(
      <Part
        part={{
          type: 'text',
          id: 'links',
          text: '[App](/boards/one) [External](https://example.com) [Network](//example.com) <script>alert(1)</script>',
        }}
        active={false}
        reply={vi.fn()}
      />,
    );
    expect([...container.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual([
      '/boards/one',
    ]);
    expect(container.textContent).toContain('External');
    expect(container.querySelector('script')).toBeNull();
  });
  it('posts confirmation and question replies once', async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    render(
      <Part
        part={{ type: 'confirm', id: 'c', title: 'Create?', message: 'A board', state: 'pending' }}
        active
        reply={reply}
      />,
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Confirm' })));
    expect(reply).toHaveBeenCalledWith({ partId: 'c', kind: 'confirm', confirmed: true });
    expect(screen.getByText('Reply sent')).toBeTruthy();
  });
  it('does not offer stale pending actions', () => {
    render(
      <Part
        part={{
          type: 'question',
          id: 'q',
          question: 'Which site?',
          allowText: true,
          state: 'pending',
        }}
        active={false}
        reply={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('Your answer')).toBeNull();
  });
});

describe('SSE reader', () => {
  it('publishes split UTF-8 deltas immediately and applies the committed reducer', async () => {
    const events: any[] = [];
    let parts: any[] = [];
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const reading = readAssistantStream(body, new AbortController().signal, event => {
      events.push(event);
      parts = applyAssistantEvent(parts, event);
    });
    const delta = encoder.encode(
      'event: text_delta\r\ndata: {"type":"text_delta","partId":"t","delta":"Hi 🌏"}\r\n\r\n',
    );
    for (const byte of delta) streamController!.enqueue(new Uint8Array([byte]));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(parts[0].text).toBe('Hi 🌏');
    expect(events).toHaveLength(1);
    streamController!.enqueue(
      encoder.encode(
        'event: done\ndata: {"type":"done","message":{"id":"m","role":"assistant","createdAt":"now","parts":[],"status":"done"}}\n\n',
      ),
    );
    streamController!.close();
    await reading;
    expect(events).toHaveLength(2);
  });
  it('skips unknown named events before a valid terminal event', async () => {
    const onEvent = vi.fn();
    await readAssistantStream(
      new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'event: future\ndata: not even JSON\n\nevent: done\ndata: {"type":"done","message":{"id":"m","role":"assistant","createdAt":"now","parts":[],"status":"done"}}\n\n',
            ),
          );
          c.close();
        },
      }),
      new AbortController().signal,
      onEvent,
    );
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0].type).toBe('done');
  });
  it.each([
    'event: done\ndata: {"type":"error"}\n\n',
    'event: done\ndata: {"type":"done"}\n\nevent: done\ndata: {"type":"done"}\n\n',
  ])('rejects invalid recognised events or duplicate terminals', async frames => {
    await expect(
      readAssistantStream(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(frames));
            c.close();
          },
        }),
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow('Invalid assistant stream');
  });
  it('rejects an interrupted stream', async () => {
    await expect(
      readAssistantStream(
        new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow('interrupted');
  });
});
