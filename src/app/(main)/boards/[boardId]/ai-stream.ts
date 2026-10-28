import { AI_LIMITS, type AiPhase, type AiResult, validateAiResult } from '@/lib/ai/rpc/contract';

const invalid = () =>
  new Error('AI returned an incomplete or invalid response. Your draft is unchanged.');
const phases: AiPhase[] = ['start', 'check', 'read', 'prepare', 'validate', 'complete'];

/** Incremental UTF-8/framing only. Nothing is applied until the entire stream closes cleanly. */
export async function readAiStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onProgress: (phase: AiPhase) => void,
): Promise<AiResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let bytes = 0;
  let progress = 0;
  let result: AiResult | undefined;
  const abort = () => void reader.cancel();
  signal.addEventListener('abort', abort, { once: true });
  const frame = (value: string) => {
    if (!value || result) throw invalid();
    const lines = value.split('\n');
    if (lines.length !== 2 || !lines[0].startsWith('event: ') || !lines[1].startsWith('data: '))
      throw invalid();
    const event = lines[0].slice(7);
    let data: any;
    try {
      data = JSON.parse(lines[1].slice(6));
    } catch {
      throw invalid();
    }
    if (!data || typeof data !== 'object' || data.type !== event) throw invalid();
    if (event === 'progress') {
      if (Object.keys(data).length !== 2 || !phases.includes(data.phase) || ++progress > 21)
        throw invalid();
      onProgress(data.phase);
    } else if (event === 'result') {
      if (Object.keys(data).length !== 2) throw invalid();
      result = validateAiResult(data.result);
    } else if (event === 'error') {
      // Never display upstream data, even if a proxy supplies a different error shape.
      throw new Error('AI could not complete the request. Your draft is unchanged. Try again.');
    } else throw invalid();
  };
  try {
    while (true) {
      if (signal.aborted) throw invalid();
      const chunk = await reader.read();
      if (signal.aborted) throw invalid();
      if (chunk.done) {
        buffer += decoder.decode();
        if (buffer || !result) throw invalid();
        return result;
      }
      bytes += chunk.value.byteLength;
      if (bytes > AI_LIMITS.outputBytes) throw invalid();
      buffer += decoder.decode(chunk.value, { stream: true });
      // A CR at a chunk boundary must survive until its LF arrives.
      buffer = buffer.replace(/\r\n/g, '\n');
      let end = buffer.indexOf('\n\n');
      while (end !== -1) {
        if (new TextEncoder().encode(buffer.slice(0, end)).byteLength > AI_LIMITS.toolBytes + 256)
          throw invalid();
        frame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf('\n\n');
      }
      if (new TextEncoder().encode(buffer).byteLength > AI_LIMITS.toolBytes + 256) throw invalid();
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof Error && error.message.startsWith('AI could not') ? error : invalid();
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
