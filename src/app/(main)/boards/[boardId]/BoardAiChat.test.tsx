import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardParameters } from '@/lib/types';
import type { BoardContextValue } from '../BoardProvider';
import { BoardAiChat, getAiInput } from './BoardAiChat';

const state = vi.hoisted(() => ({ value: null as BoardContextValue | null }));
vi.mock('@/components/hooks', () => ({ useBoard: () => state.value }));
vi.mock('@/lib/client', () => ({ getClientAuthToken: () => 'synthetic-session' }));
vi.mock('@umami/react-zen', () => ({
  Button: ({ children, onPress, isDisabled, variant: _variant, ...props }: any) => (
    <button {...props} onClick={onPress} disabled={isDisabled}>
      {children}
    </button>
  ),
}));
const websiteId = '11111111-1111-4111-8111-111111111111';
const draft = {
  websiteId,
  rows: [
    {
      id: 'row',
      columns: [
        {
          id: 'col',
          component: { type: 'TextBlock', props: { text: '<script>plain text</script>' } },
        },
      ],
    },
  ],
};
function setup(parameters: BoardParameters = { rows: [] }) {
  let cancel: () => void;
  const updateBoard = vi.fn<BoardContextValue['updateBoard']>(() => cancel?.());
  const registerAiCancel: BoardContextValue['registerAiCancel'] = fn => {
    cancel = fn;
  };
  function Harness() {
    const [aiPending, setAiPending] = useState(false);
    state.value = {
      board: {
        id: '22222222-2222-4222-8222-222222222222',
        type: 'mixed',
        parameters,
      },
      updateBoard,
      aiPending,
      setAiPending,
      registerAiCancel,
      editing: true,
      saveBoard: vi.fn(),
      isPending: false,
      registerLayoutGetter: vi.fn(),
    };
    return <BoardAiChat />;
  }
  render(<Harness />);
  return { updateBoard, cancel: () => cancel() };
}
function ask() {
  fireEvent.change(screen.getByLabelText('Describe your board or a change'), {
    target: { value: 'Make a summary' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
}
afterEach(() => vi.unstubAllGlobals());

describe('AI board draft preview', () => {
  it('applies only a validated local draft and includes the existing board ID', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Preview', draft }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const { updateBoard } = setup();
    ask();
    await screen.findByText('Preview');
    expect(updateBoard).toHaveBeenCalledWith({ parameters: draft });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).boardId).toBe(
      '22222222-2222-4222-8222-222222222222',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Review it, then choose Save/)).toBeVisible();
  });

  it.each(['x', '界'])('trims oldest history by serialized UTF-8 bytes (%s)', async character => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: 'y'.repeat(2000) }),
    });
    vi.stubGlobal('fetch', fetcher);
    const { updateBoard } = setup();
    for (let turn = 0; turn < 6; turn++) {
      fireEvent.change(screen.getByLabelText('Describe your board or a change'), {
        target: { value: character.repeat(4000) },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Cancel AI' })).not.toBeInTheDocument(),
      );
      const body = fetcher.mock.calls[turn][1].body;
      const payload = JSON.parse(body);
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(32768);
      expect(payload.boardId).toBe('22222222-2222-4222-8222-222222222222');
      expect(payload.draft).toBeUndefined();
      expect(payload.messages.at(-1)).toEqual({ role: 'user', content: character.repeat(4000) });
    }
    expect(JSON.parse(fetcher.mock.calls[5][1].body).messages.length).toBeLessThan(11);
    expect(updateBoard).not.toHaveBeenCalled();
  });

  it.each([32768, 32769])(
    'enforces the exact %s-byte boundary including the draft',
    async bytes => {
      const prompt = '界'.repeat(1000);
      const parameters = {
        rows: Array.from({ length: 8 }, (_, index) => ({
          id: `row${index}`,
          columns: [
            {
              id: `col${index}`,
              component: { type: 'TextBlock', props: { text: index < 7 ? 'x'.repeat(4000) : '' } },
            },
          ],
        })),
      };
      const serialized = () =>
        JSON.stringify({
          boardId: '22222222-2222-4222-8222-222222222222',
          messages: [{ role: 'user', content: prompt }],
          draft: parameters,
        });
      parameters.rows[7].columns[0].component.props.text = 'x'.repeat(
        bytes - new TextEncoder().encode(serialized()).byteLength,
      );
      expect(new TextEncoder().encode(serialized()).byteLength).toBe(bytes);
      const fetcher = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ message: 'Done' }) });
      vi.stubGlobal('fetch', fetcher);
      const { updateBoard } = setup(parameters);
      // Retain a prior exchange to prove that failure clears history, not the draft or prompt.
      ask();
      await screen.findByText('Done');
      fireEvent.change(screen.getByLabelText('Describe your board or a change'), {
        target: { value: prompt },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
      if (bytes === 32768) {
        await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        expect(fetcher.mock.calls[1][1].body).toBe(serialized());
        await waitFor(() =>
          expect(screen.queryByRole('button', { name: 'Cancel AI' })).not.toBeInTheDocument(),
        );
      } else {
        await screen.findByText(/Shorten your request or simplify the board manually/);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(screen.getByLabelText('Describe your board or a change')).toHaveValue(prompt);
        expect(screen.queryByRole('log')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Cancel AI' })).not.toBeInTheDocument();
        ask();
        await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        expect(JSON.parse(fetcher.mock.calls[1][1].body).messages).toEqual([
          { role: 'user', content: 'Make a summary' },
        ]);
      }
      expect(JSON.parse(fetcher.mock.calls[1][1].body).draft).toEqual(parameters);
      expect(updateBoard).not.toHaveBeenCalled();
    },
  );

  it('ignores a late response after cancellation', async () => {
    let resolve: (value: unknown) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise(done => {
            resolve = done;
          }),
      ),
    );
    const { updateBoard } = setup();
    ask();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel AI' }));
    resolve({ ok: true, json: async () => ({ message: 'Late', draft }) });
    await waitFor(() => expect(screen.getByText(/AI request cancelled/)).toBeVisible());
    expect(updateBoard).not.toHaveBeenCalled();
  });

  it('cancels on manual edits using the provider cancellation registration', async () => {
    let resolve: (value: unknown) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise(done => {
            resolve = done;
          }),
      ),
    );
    const { updateBoard } = setup();
    ask();
    updateBoard({ name: 'Manual edit' });
    resolve({ ok: true, json: async () => ({ message: 'Late', draft }) });
    await screen.findByText(/AI request cancelled/);
    expect(updateBoard).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429, 503, 502])('preserves the draft on HTTP %s', async status => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status,
        json: async () => ({ error: 'private upstream details' }),
      }),
    );
    const { updateBoard } = setup();
    ask();
    await waitFor(() =>
      expect(screen.queryByText(/Generating a local preview/)).not.toBeInTheDocument(),
    );
    expect(updateBoard).not.toHaveBeenCalled();
    expect(screen.queryByText('private upstream details')).not.toBeInTheDocument();
    if (status === 503)
      expect(screen.getByLabelText('Describe your board or a change')).toBeDisabled();
  });

  it('rejects malformed response drafts without changing local state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ message: 'Bad', draft: { rows: [] } }),
      }),
    );
    const { updateBoard } = setup();
    ask();
    await screen.findByText(/unsupported response/);
    expect(updateBoard).not.toHaveBeenCalled();
  });

  it('rejects unsafe assistant HTML under the shared result schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            message: '<script>bad</script>',
            draft,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const { updateBoard } = setup();
    ask();
    await screen.findByText(/unsupported response/);
    expect(document.querySelector('script')).toBeNull();
    expect(updateBoard).not.toHaveBeenCalled();
  });

  it('streams only fixed phases, then offers editable options without sending question metadata', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Thanks' })));
    vi.stubGlobal('fetch', fetcher);
    const { updateBoard } = setup();
    ask();
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    streamController.enqueue(
      new TextEncoder().encode('event: progress\ndata: {"type":"progress","phase":"read"}\n\n'),
    );
    await screen.findByText('Reading authorized analytics');
    expect(updateBoard).not.toHaveBeenCalled();
    const result = {
      message: 'Please confirm the meaning.',
      questions: [
        {
          id: 'meaning',
          question: 'Which event?',
          options: [{ label: 'Confirmed', value: 'confirmed_login' }],
        },
      ],
    };
    streamController.enqueue(
      new TextEncoder().encode(
        `event: result\ndata: ${JSON.stringify({ type: 'result', result })}\n\n`,
      ),
    );
    streamController.close();
    await screen.findByText('Please confirm the meaning.');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmed' }));
    expect(screen.getByLabelText('Describe your board or a change')).toHaveFocus();
    expect(screen.getByLabelText('Describe your board or a change')).toHaveValue(
      'Which event?\nConfirmed: confirmed_login',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    await screen.findByText('Thanks');
    const payload = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(payload.messages.at(-1)).toEqual({
      role: 'user',
      content: 'Which event?\nConfirmed: confirmed_login',
    });
    expect(payload.messages[1]).toEqual({ role: 'assistant', content: result.message });
    expect(fetcher.mock.calls[0][1].headers.Accept).toBe('text/event-stream');
    expect(updateBoard).not.toHaveBeenCalled();
  });

  it('keeps unsupported manual boards outside the AI boundary', () => {
    expect(getAiInput({ type: 'pixel' }).reason).toContain('website boards only');
    expect(getAiInput({ type: 'mixed', parameters: { rows: [] } })).toEqual({});
    expect(getAiInput({ type: 'mixed', parameters: draft }).draft).toEqual(draft);
  });
});
