import { createHash } from 'node:crypto';

const BASE64_RUN = /[A-Za-z0-9+/]{512,}={0,2}/g;
const DATA_URL = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*/gi;
const CAPABILITY = /\b(?:cap|capability|artifact|token)[-_]?[A-Za-z0-9_-]*=([A-Za-z0-9_-]{16,})/gi;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Validated text placeholder: hash (and receipt reference when known), never bytes. */
export function imagePlaceholder(data: string, receipt?: string) {
  const bytes = Buffer.from(data, 'base64');
  return `[screenshot omitted sha256=${digest(bytes.length ? (bytes as any) : data)}${receipt ? ` receipt=${receipt}` : ''}]`;
}

function scrubText(text: string) {
  return text
    .replace(DATA_URL, '[image data omitted]')
    .replace(CAPABILITY, (match, value) => match.replace(value, '[redacted]'))
    .replace(BASE64_RUN, '[binary omitted]');
}

/**
 * Deep copy with Pi image content blocks replaced by text placeholders and image-like strings
 * (data URLs, long base64 runs, capability parameters) redacted. Applied before persistence or
 * diagnostic serialization, never after truncation.
 */
export function sanitize<T>(value: T, receipt?: string): T {
  if (typeof value === 'string') return scrubText(value) as T;
  if (Array.isArray(value)) return value.map(item => sanitize(item, receipt)) as T;
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (
    record.type === 'image' &&
    (typeof record.data === 'string' || typeof record.url === 'string')
  )
    return {
      type: 'text',
      text: imagePlaceholder(String(record.data ?? record.url), receipt),
    } as T;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) result[key] = sanitize(item, receipt);
  return result as T;
}

/**
 * Sanitizes a native Pi JSONL session line by line, preserving message/tool-call structure and
 * the resumable non-image context. Unparseable lines are dropped individually, not the session.
 */
export function sanitizeSession(session: string | null | undefined): string | null {
  if (!session) return session ?? null;
  const lines = session.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      out.push(JSON.stringify(sanitize(JSON.parse(line))));
    } catch {
      /* Drop only the malformed line. */
    }
  }
  return out.length ? out.join('\n') + '\n' : null;
}

export function containsImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImage);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'image') return true;
  return Object.values(record).some(containsImage);
}
