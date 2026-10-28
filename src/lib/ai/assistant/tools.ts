import { randomUUID } from 'node:crypto';
import type { AssistantPart, AssistantReply } from './protocol';

type Pending = { part: AssistantPart; resolve: (reply?: AssistantReply) => void };
export class Interaction {
  pending = new Map<string, Pending>();
  constructor(
    readonly emit: (part: AssistantPart) => void,
    readonly signal: AbortSignal,
    readonly timeoutMs = 300000,
  ) {}
  wait(part: AssistantPart): Promise<AssistantReply | undefined> {
    if (this.signal.aborted) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const finish = (reply?: AssistantReply) => {
        clearTimeout(timer);
        this.signal.removeEventListener('abort', abort);
        this.pending.delete(part.id);
        resolve(reply);
      };
      const abort = () => finish();
      const timer = setTimeout(abort, this.timeoutMs);
      this.pending.set(part.id, { part, resolve: finish });
      this.signal.addEventListener('abort', abort, { once: true });
      this.emit(part);
    });
  }
  reply(reply: AssistantReply) {
    const pending = this.pending.get(reply?.partId);
    if (!pending || pending.part.type !== reply.kind) return false;
    if (reply.kind === 'confirm' && typeof reply.confirmed !== 'boolean') return false;
    if (reply.kind === 'question') {
      if (typeof reply.answer !== 'string' || !reply.answer.trim() || reply.answer.length > 4000)
        return false;
      const part = pending.part;
      if (part.type !== 'question' || (!part.allowText && !part.options?.includes(reply.answer)))
        return false;
    }
    pending.resolve(reply);
    return true;
  }
}
export function validApiPath(path: unknown): path is string {
  if (typeof path !== 'string' || !/^\/api\/[a-zA-Z0-9/_-]+$/.test(path)) return false;
  return !path.includes('//') && !/^\/api\/(auth|ai)(\/|$)/i.test(path);
}
export function validLink(href: unknown): href is string {
  return (
    typeof href === 'string' &&
    /^\/(?!\/)[a-zA-Z0-9/_?=&%#.-]*$/.test(href) &&
    !/%(?:2f|5c|0[ad])/i.test(href) &&
    !href.includes('..')
  );
}
export function truncate(value: unknown, bytes: number) {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  const buffer = Buffer.from(text);
  return buffer.length <= bytes
    ? text
    : buffer.subarray(0, bytes - 20).toString('utf8') + '\n[truncated]';
}
export async function executeTool(
  name: string,
  args: any,
  input: {
    credentials: Headers;
    interaction: Interaction;
    fetch?: typeof fetch;
  },
) {
  const { interaction } = input;
  const id = randomUUID();
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Invalid arguments');
  if (name === 'umami_api') {
    if (
      !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(args.method) ||
      !validApiPath(args.path)
    )
      throw new Error('API path or method denied');
    if (
      args.method === 'DELETE' ||
      (args.method === 'POST' && /\/(delete|reset)\/?$/.test(args.path))
    ) {
      const part: AssistantPart = {
        type: 'confirm',
        id,
        title: `${args.method} ${args.path}`,
        message: `Allow ${args.method} ${args.path}?`,
        state: 'pending',
      };
      const answer = await interaction.wait(part);
      const accepted = answer?.kind === 'confirm' && answer.confirmed;
      interaction.emit({
        ...part,
        state: accepted ? 'confirmed' : answer ? 'rejected' : 'expired',
      });
      if (!accepted) return 'User denied';
    }
    if (interaction.signal.aborted) throw new Error('Cancelled');
    const port = process.env.PORT || '3000';
    if (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535)
      throw new Error('Invalid loopback port');
    const base = process.env.BASE_PATH || '';
    if (base && !/^\/[a-zA-Z0-9/_-]+$/.test(base)) throw new Error('Invalid base path');
    const url = new URL(`http://127.0.0.1:${port}${base}${args.path}`);
    if (args.query !== undefined) {
      if (!args.query || typeof args.query !== 'object' || Array.isArray(args.query))
        throw new Error('Invalid query');
      for (const [key, value] of Object.entries(args.query)) {
        if (!['string', 'number', 'boolean'].includes(typeof value))
          throw new Error('Invalid query value');
        url.searchParams.set(key, String(value));
      }
    }
    const headers = new Headers(input.credentials);
    headers.set('content-type', 'application/json');
    const response = await (input.fetch || fetch)(url, {
      method: args.method,
      headers,
      body:
        args.method === 'GET' || args.body === undefined ? undefined : JSON.stringify(args.body),
      redirect: 'error',
      signal: interaction.signal,
    });
    // Bound the response while reading, not after buffering arbitrarily large API bodies.
    const reader = response.body?.getReader();
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      while (reader && length < 32768) {
        const item = await reader.read();
        if (item.done) break;
        const chunk = Buffer.from(item.value).subarray(0, 32768 - length);
        chunks.push(chunk);
        length += chunk.length;
      }
    } finally {
      await reader?.cancel();
    }
    return truncate(`${response.status} ${Buffer.concat(chunks).toString('utf8')}`, 32768);
  }
  if (name === 'ask_user') {
    if (
      typeof args.question !== 'string' ||
      !args.question.trim() ||
      args.question.length > 2000 ||
      (args.options !== undefined &&
        (!Array.isArray(args.options) ||
          args.options.length > 20 ||
          args.options.some((s: unknown) => typeof s !== 'string' || !s || s.length > 500))) ||
      (args.allowText !== undefined && typeof args.allowText !== 'boolean') ||
      (args.allowText === false && !args.options?.length)
    )
      throw new Error('Invalid question');
    const part: Extract<AssistantPart, { type: 'question' }> = {
      type: 'question',
      id,
      question: args.question,
      options: args.options,
      allowText: args.allowText !== false,
      state: 'pending',
    };
    const answer = await interaction.wait(part);
    interaction.emit({
      ...part,
      state: answer ? 'answered' : 'expired',
      answer: answer?.kind === 'question' ? answer.answer : undefined,
    });
    return answer?.kind === 'question' ? answer.answer : 'User did not answer';
  }
  if (name === 'show_chart') {
    if (
      ![
        'WebsiteCompareChart',
        'WebsiteChart',
        'WebsiteMetricsBar',
        'MetricsTable',
        'WorldMap',
      ].includes(args.component?.type)
    )
      throw new Error('Chart type denied');
    interaction.emit({ type: 'chart', id, title: args.title, component: args.component });
    return 'Chart displayed';
  }
  if (name === 'open_link') {
    if (
      !validLink(args.href) ||
      typeof args.label !== 'string' ||
      !args.label ||
      args.label.length > 200
    )
      throw new Error('Invalid link');
    interaction.emit({ type: 'link', id, label: args.label, href: args.href });
    return 'Link displayed';
  }
  throw new Error('Tool denied');
}
