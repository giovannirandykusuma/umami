import { describe, expect, it, vi } from 'vitest';
import { readAiStream } from './ai-stream';

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const final = frame('result', { type: 'result', result: { message: 'Ready 界' } });
function stream(text: string, width = 1) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += width)
        controller.enqueue(bytes.slice(index, index + width));
      controller.close();
    },
  });
}
const read = (text: string) => readAiStream(stream(text), new AbortController().signal, vi.fn());

describe('production incremental SSE reader', () => {
  it.each([1, 2, 7, 4096])('decodes split UTF-8 and frames with chunk width %s', async width => {
    const progress = vi.fn();
    const text =
      frame('progress', { type: 'progress', phase: 'read' }) +
      frame('progress', { type: 'progress', phase: 'complete' }) +
      final;
    expect(await readAiStream(stream(text, width), new AbortController().signal, progress)).toEqual(
      { message: 'Ready 界' },
    );
    expect(progress.mock.calls).toEqual([['read'], ['complete']]);
  });
  it('accepts CRLF split across chunks', async () => {
    expect(await read(final.replaceAll('\n', '\r\n'))).toEqual({ message: 'Ready 界' });
  });
  it.each([
    '',
    final.slice(0, -1),
    final + final,
    final + frame('progress', { type: 'progress', phase: 'read' }),
    frame('progress', { type: 'progress', phase: 'complete' }),
    'event: result\ndata: {bad}\n\n',
    frame('progress', { type: 'progress', phase: 'private-tool-name' }),
    frame('progress', { type: 'progress', phase: 'read', websiteId: 'private' }),
    frame('result', {
      type: 'result',
      result: { message: 'Ready', questions: Array(4).fill({ id: 'x', question: 'Why?' }) },
    }),
    frame('result', { type: 'result', result: { message: '<script>bad</script>' } }),
    frame('error', { type: 'error', error: 'private database error' }),
    'x'.repeat(33025),
    frame('progress', { type: 'progress', phase: 'read' }).repeat(22) + final,
  ])('fails closed on malformed, oversized, unsafe or incomplete input %#', async text => {
    await expect(read(text)).rejects.toThrow(/AI .*Your draft is unchanged/);
  });
  it('enforces the total byte limit independently of frame limits', async () => {
    const huge = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(262145));
        controller.close();
      },
    });
    await expect(readAiStream(huge, new AbortController().signal, vi.fn())).rejects.toThrow();
  });
  it('rejects invalid UTF-8', async () => {
    const bytes = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xc3, 0x28]));
        controller.close();
      },
    });
    await expect(readAiStream(bytes, new AbortController().signal, vi.fn())).rejects.toThrow();
  });
  it('cancels a pending read without accepting an earlier result', async () => {
    const cancelled = vi.fn();
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const result = readAiStream(body, controller.signal, vi.fn());
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
