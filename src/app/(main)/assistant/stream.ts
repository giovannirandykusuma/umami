import { ASSISTANT_STREAM_EVENTS, type AssistantStreamEvent } from '@/lib/ai/assistant/protocol';

/** Decode UTF-8 and SSE incrementally; publish each event before the stream closes. */
export async function readAssistantStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: AssistantStreamEvent) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let terminal = false;
  const abort = () => void reader.cancel();
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const lines = frame.split('\n');
        const name = lines
          .find(line => line.startsWith('event:'))
          ?.slice(6)
          .trim();
        const data = lines
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue; // SSE comments/heartbeats.
        // Named extensions are forward-compatible, including payloads we cannot decode.
        if (!ASSISTANT_STREAM_EVENTS.includes(name as AssistantStreamEvent['type'])) continue;
        const event = JSON.parse(data) as AssistantStreamEvent;
        if (terminal || event.type !== name) {
          throw new Error('Invalid assistant stream.');
        }
        terminal = event.type === 'done' || event.type === 'error';
        onEvent(event);
      }
      if (chunk.done) {
        if (!signal.aborted && (!terminal || buffer.trim()))
          throw new Error('Assistant connection interrupted. Please try again.');
        return;
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
