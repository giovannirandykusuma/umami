import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isAnalystEnabled } from '@/lib/analyst/flags';
import prisma from '@/lib/prisma';
import { gatewayConfig, permissionArgs, reasoningLevel } from '../rpc/confinement.mjs';
import { sanitize, sanitizeSession } from './analyst/sanitize';
import { ANALYST_TOOLS } from './analyst/tools';
import { assistantPrompt } from './prompt';
import type { AssistantPart, AssistantStreamEvent, AssistantTurnContext } from './protocol';
import { boundedSession } from './store';
import { truncate } from './tools';

export interface RuntimeInput {
  message: string;
  session: string | null;
  context?: AssistantTurnContext;
  signal: AbortSignal;
  emit: (event: AssistantStreamEvent) => void;
  tool: (name: string, args: unknown) => Promise<unknown>;
  /** Trusted host decision (feature flag), never derived from request fields. */
  analyst?: boolean;
}
export const BASE_TOOLS = [
  'umami_api',
  'ask_user',
  'show_chart',
  'open_link',
  'analytics_schema',
  'find_people',
  'query_series',
  'query_breakdown',
  'query_totals',
];
/** Encoded transport budget for each image-bearing verification response (spec §4.2). */
export const IMAGE_TRANSPORT_BYTES = 32 * 1024 * 1024;
const OUTPUT_BYTES = 8 * 1024 * 1024;
/**
 * Host-created image result. Only validated verifier images reach this class; the runtime sends
 * them on a dedicated envelope that the extension converts into Pi image blocks.
 */
export class ImageToolResult {
  constructor(
    readonly json: unknown,
    readonly images: { mime: string; data: string; hash: string }[],
  ) {}
}
export interface RuntimeOptions {
  env: Record<string, string>;
  bridge: string;
  timeoutMs?: number;
  /** Allowed tool names; defaults to the legacy assistant set. */
  tools?: string[];
  /** Trusted, verified synthetic fixture provider extension (offlineFixtureRuntime only). */
  offlineProvider?: string;
}
/** The only database the offline fixture may run against (synthetic engine, owned schema). */
export const OFFLINE_FIXTURE_DATABASE =
  'postgresql://ai_synthetic@127.0.0.1:25432/ai_synthetic?schema=analyst_fixture';
const OFFLINE_FIXTURE_MODE = 'analyst-synthetic-v1';
const LIVE_KEYS = [
  'AI_ENABLED',
  'AI_PROVIDER',
  'AI_MODEL',
  'AI_BASE_URL',
  'AI_PROVIDER_KEY',
  'AI_EGRESS_ORIGINS',
];
/** Receipts older than this are stale: each launcher run writes a fresh one. */
export const OFFLINE_FIXTURE_RECEIPT_MS = 12 * 60 * 60_000;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/**
 * Synthetic-only deterministic runtime selector. Server env only (never request/model input).
 * Returns null when not requested; throws (fail closed, never a live fallback) when requested
 * outside a positively verified fixture context: the exact synthetic database, no live provider
 * configuration or credential at all, and a fresh launcher-written receipt in the launcher's own
 * sanitized project root that binds the env nonce (by hash), that root and the packaged provider
 * file hash. NODE_ENV=production is accepted only when the receipt also binds the BUILD_ID of the
 * Next build the launcher made inside that same root; ordinary deployments have no such receipt.
 * The database's own synthetic marker is checked separately (fixtureDatabaseVerified).
 */
export function offlineFixtureRuntime(
  env: Record<string, string | undefined>,
  cwd: string,
  now = Date.now(),
) {
  if (env.AI_OFFLINE_FIXTURE === undefined) return null;
  const fail = () => {
    throw new Error('Offline fixture runtime refused outside the verified synthetic fixture');
  };
  if (env.AI_OFFLINE_FIXTURE !== OFFLINE_FIXTURE_MODE) fail();
  if (env.DATABASE_URL !== OFFLINE_FIXTURE_DATABASE) fail();
  if (LIVE_KEYS.some(key => env[key] !== undefined)) fail();
  if (Object.keys(env).some(key => /(_API_KEY|_ACCESS_TOKEN)$/.test(key))) fail();
  const nonce = env.AI_OFFLINE_FIXTURE_NONCE;
  if (!nonce || !/^[0-9a-f]{64}$/.test(nonce)) fail();
  const provider = resolve(cwd, 'scripts/ai/analyst-fixture/offline-provider.mjs');
  let receipt: any;
  let root = '';
  let providerHash = '';
  let buildId: string | undefined;
  try {
    root = realpathSync(cwd);
    const receiptPath = join(root, '.analyst-fixture-receipt.json');
    // Only the launcher-written regular file counts; a planted symlink does not.
    if (!lstatSync(receiptPath).isFile()) fail();
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (!lstatSync(provider).isFile()) fail();
    providerHash = sha256(readFileSync(provider));
    if (env.NODE_ENV === 'production')
      buildId = readFileSync(join(root, '.next/BUILD_ID'), 'utf8').trim();
  } catch {
    fail();
  }
  if (
    receipt?.mode !== OFFLINE_FIXTURE_MODE ||
    receipt.nonceSha256 !== sha256(nonce!) ||
    receipt.root !== root ||
    !basename(root).startsWith('umami-analyst-fixture-') ||
    receipt.providerSha256 !== providerHash ||
    !Number.isFinite(receipt.issuedAt) ||
    receipt.issuedAt > now ||
    now - receipt.issuedAt > OFFLINE_FIXTURE_RECEIPT_MS
  )
    fail();
  if (env.NODE_ENV === 'production' && (!buildId || receipt.buildId !== buildId)) fail();
  return {
    provider,
    env: {
      AI_PROVIDER: 'umami-offline-fixture',
      AI_MODEL: 'analyst-script-v1',
      AI_BASE_URL: 'https://offline-fixture.invalid',
      AI_EGRESS_ORIGINS: 'https://offline-fixture.invalid',
      AI_PROVIDER_KEY: 'offline-fixture-no-credential',
    },
  };
}

/** Independent database-side marker: the owned synthetic engine and this fixture's schema. */
export async function fixtureDatabaseVerified(
  query: (sql: string) => Promise<any[]> = sql => prisma.client.$queryRawUnsafe(sql),
) {
  try {
    const [row] = await query(
      "select (select owner from public.ai_synthetic_owner) as engine, obj_description('analyst_fixture'::regnamespace) as schema",
    );
    return row?.engine === 'umami-ai-synthetic-r3' && row?.schema === 'umami-analyst-fixture-r1';
  } catch {
    return false;
  }
}

export async function runAssistant(input: RuntimeInput) {
  const offline = offlineFixtureRuntime(process.env, process.cwd());
  if (offline) {
    if (!input.analyst || !isAnalystEnabled()) throw new Error('Offline fixture is analyst-only');
    if (!(await fixtureDatabaseVerified()))
      throw new Error('Offline fixture runtime refused outside the verified synthetic fixture');
    const root = process.env.AI_PI_ROOT;
    if (!root || !isAbsolute(root)) throw new Error('AI installation must be absolute');
    return runAssistantProcess(input, {
      env: {
        ...offline.env,
        AI_PI_ROOT: root,
        AI_REASONING_LEVEL: 'off',
        AI_ANALYST_ENABLED: 'true',
      },
      bridge: resolve('scripts/ai/native.mjs'),
      offlineProvider: offline.provider,
      tools: [...BASE_TOOLS, ...ANALYST_TOOLS],
      timeoutMs: 24 * 60 * 60_000,
    });
  }
  if (process.env.AI_ENABLED !== 'true') throw new Error('AI is disabled');
  const env: Record<string, string> = {};
  for (const key of [
    'AI_PI_ROOT',
    'AI_PROVIDER',
    'AI_MODEL',
    'AI_BASE_URL',
    'AI_PROVIDER_KEY',
    'AI_EGRESS_ORIGINS',
  ]) {
    if (!process.env[key]) throw new Error('AI configuration incomplete');
    env[key] = process.env[key]!;
  }
  env.AI_REASONING_LEVEL = reasoningLevel(process.env);
  const analyst = !!input.analyst && isAnalystEnabled();
  if (analyst) env.AI_ANALYST_ENABLED = 'true';
  if (!isAbsolute(env.AI_PI_ROOT)) throw new Error('AI installation must be absolute');
  gatewayConfig(env);
  return runAssistantProcess(input, {
    env,
    bridge: resolve('scripts/ai/native.mjs'),
    ...(analyst
      ? {
          tools: [...BASE_TOOLS, ...ANALYST_TOOLS],
          // User-wait time is excluded from the task window; the handler owns that deadline.
          timeoutMs: 24 * 60 * 60_000,
        }
      : {}),
  });
}

/** Injection seam for offline child-process tests; not selectable through a request. */
export async function runAssistantProcess(input: RuntimeInput, options: RuntimeOptions) {
  const directory = await mkdtemp(join(tmpdir(), 'umami-assistant-'));
  let session: string | null = null;
  let failure: unknown;
  try {
    const agent = join(directory, 'agent');
    const sessions = join(directory, 'sessions');
    await mkdir(agent);
    await mkdir(sessions);
    const allowed = options.tools ?? BASE_TOOLS;
    const restored = boundedSession(sanitizeSession(input.session));
    const sessionPath = join(sessions, 'restored.jsonl');
    if (restored) {
      // Pi validates the header cwd before loading a session. Each turn has a new
      // scratch directory; the previous turn's directory has already been removed.
      const newline = restored.indexOf('\n');
      const header = JSON.parse(newline < 0 ? restored : restored.slice(0, newline));
      if (header.type !== 'session') throw new Error('Invalid assistant session header');
      await writeFile(
        sessionPath,
        JSON.stringify({ ...header, cwd: directory }) +
          (newline < 0 ? '\n' : restored.slice(newline)),
        { mode: 0o600 },
      );
    }
    const native = options.bridge === resolve('scripts/ai/native.mjs');
    const extension = resolve('scripts/ai/assistant-tools.mjs');
    if (native)
      await writeFile(
        join(agent, 'models.json'),
        // Offline: no gateway provider exists at all, so nothing can reach a network endpoint.
        JSON.stringify(options.offlineProvider ? { providers: {} } : gatewayConfig(options.env)),
        { mode: 0o600 },
      );
    const args = [
      ...(native
        ? permissionArgs({
            root: options.env.AI_PI_ROOT,
            scratch: directory,
            bridge: options.bridge,
            extension,
          })
        : []),
      ...(native && options.offlineProvider
        ? [`--allow-fs-read=${resolve(options.offlineProvider)}`]
        : []),
      options.bridge,
      '--mode',
      'rpc',
      '--session-dir',
      sessions,
      ...(restored ? ['--session', sessionPath] : []),
      '--offline',
      '--no-approve',
      '--no-extensions',
      '--no-mcp',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--no-builtin-tools',
      '--extension',
      extension,
      ...(options.offlineProvider ? ['--extension', options.offlineProvider] : []),
      '--provider',
      options.env.AI_PROVIDER,
      '--model',
      options.env.AI_MODEL,
      '--thinking',
      reasoningLevel(options.env),
      '--system-prompt',
      assistantPrompt(
        input.context,
        allowed.some(name => name.startsWith('analyst_')),
      ),
    ];
    const child = spawn(process.execPath, args, {
      cwd: directory,
      env: {
        ...options.env,
        HOME: directory,
        TMPDIR: directory,
        XDG_CONFIG_HOME: directory,
        XDG_CACHE_HOME: directory,
        PI_CODING_AGENT_DIR: agent,
        PI_CODING_AGENT_SESSION_DIR: sessions,
        LANG: 'C.UTF-8',
        NODE_ENV: 'production',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let closed = false;
    const exited = new Promise<void>(resolveExit =>
      child.once('close', () => {
        closed = true;
        resolveExit();
      }),
    );
    try {
      await new Promise<void>((resolveRun, reject) => {
        let finished = false;
        let acknowledged = false;
        let settled = false;
        let messageIndex = 0;
        let tools = 0;
        let bridges = 0;
        let bytes = 0;
        let imageBytes = 0;
        let imageAllowance = 0;
        let stderrBytes = 0;
        let diagnostics = '';
        let buffer = '';
        const seen = new Set<string>();
        const pending = new Set<string>();
        const toolParts = new Map<string, Extract<AssistantPart, { type: 'tool' }>>();
        const decoder = new StringDecoder('utf8');
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          input.signal.removeEventListener('abort', abort);
          error ? reject(error) : resolveRun();
        };
        const abort = () => finish(new Error('Cancelled'));
        const timer = setTimeout(
          () => finish(new Error('Assistant timeout')),
          options.timeoutMs ?? 300000,
        );
        input.signal.addEventListener('abort', abort, { once: true });
        const send = (record: unknown) => {
          if (!finished)
            child.stdin.write(`${JSON.stringify(record)}\n`, error => {
              if (error) finish(new Error('Assistant transport failed'));
            });
        };
        child.on('error', () => finish(new Error('Assistant process failed')));
        child.stdin.on('error', () => finish(new Error('Assistant transport failed')));
        child.once('close', code => {
          // Only expose known startup diagnostics, never arbitrary child output
          // (which can contain credentials, prompts, or tool data).
          const detail = diagnostics.includes('Stored session working directory does not exist:')
            ? ': Stored session working directory does not exist'
            : '';
          finish(new Error(`Assistant exited before settlement (exit ${code})${detail}`));
        });
        child.stderr.on('data', (chunk: Buffer) => {
          diagnostics = (diagnostics + chunk.toString('utf8')).slice(0, 4096);
          stderrBytes += chunk.length;
          if (stderrBytes > 1024 * 1024) finish(new Error('Assistant diagnostics exceeded limit'));
        });
        const complete = () => {
          if (acknowledged && settled && !pending.size) finish();
        };
        const record = (value: any) => {
          if (!value || typeof value !== 'object') throw new Error('Invalid RPC record');
          if (value.type === 'response') {
            if (
              value.id !== 'turn-1' ||
              value.command !== 'prompt' ||
              value.success !== true ||
              acknowledged
            )
              throw new Error('Assistant prompt rejected');
            acknowledged = true;
            if (value.data?.disposition === 'handled') settled = true;
            complete();
          } else if (value.type === 'message_start' && value.message?.role === 'assistant') {
            messageIndex++;
          } else if (value.type === 'message_update') {
            const update = value.assistantMessageEvent;
            if (['text_delta', 'thinking_delta'].includes(update?.type)) {
              if (typeof update.delta !== 'string' || !Number.isInteger(update.contentIndex))
                throw new Error('Invalid delta');
              input.emit({
                type: update.type,
                partId: `message-${messageIndex}-${update.contentIndex}`,
                delta: update.delta,
              });
            }
          } else if (
            value.type === 'message_end' &&
            ['error', 'aborted'].includes(value.message?.stopReason)
          ) {
            throw new Error(
              value.message.stopReason === 'aborted' ? 'Cancelled' : 'Assistant model failed',
            );
          } else if (value.type === 'tool_execution_start') {
            if (
              ++tools > 40 ||
              typeof value.toolCallId !== 'string' ||
              toolParts.has(value.toolCallId) ||
              !allowed.includes(value.toolName)
            )
              throw new Error('Assistant tool limit or name denied');
            const part: Extract<AssistantPart, { type: 'tool' }> = {
              type: 'tool',
              id: value.toolCallId,
              name: value.toolName,
              title:
                value.toolName === 'umami_api'
                  ? `${value.args?.method} ${value.args?.path}`.slice(0, 200)
                  : {
                      ask_user: 'Ask a question',
                      show_chart: 'Show chart',
                      open_link: 'Open link',
                    }[value.toolName as string] || value.toolName,
              args: sanitize(value.args),
              status: 'running',
            };
            toolParts.set(part.id, part);
            input.emit({ type: 'part', part });
          } else if (value.type === 'tool_execution_end') {
            const part = toolParts.get(value.toolCallId);
            if (!part) throw new Error('Unknown tool completion');
            input.emit({
              type: 'part',
              part: {
                ...part,
                status: value.isError
                  ? 'error'
                  : JSON.stringify(value.result).includes('User denied')
                    ? 'denied'
                    : 'done',
                // Redact image blocks before serialization, never after truncation.
                result: truncate(sanitize(value.result), 8192),
                durationMs: value.durationMs,
              },
            });
          } else if (value.type === 'extension_ui_request') {
            if (
              value.method !== 'input' ||
              value.title !== 'umami-assistant-tool' ||
              typeof value.id !== 'string' ||
              seen.has(value.id) ||
              typeof value.placeholder !== 'string' ||
              Buffer.byteLength(value.placeholder) > 32768 ||
              ++bridges > 40
            )
              throw new Error('Invalid host tool request');
            seen.add(value.id);
            const request = JSON.parse(value.placeholder);
            if (!allowed.includes(request.name)) throw new Error('Invalid host tool name');
            pending.add(value.id);
            Promise.resolve()
              .then(() => input.tool(request.name, request.args))
              .then(
                result => {
                  if (
                    result instanceof ImageToolResult &&
                    request.name === 'analyst_verify_render'
                  ) {
                    imageAllowance += IMAGE_TRANSPORT_BYTES;
                    send({
                      type: 'extension_ui_response',
                      id: value.id,
                      value: JSON.stringify({
                        umamiImageEnvelope: 1,
                        text: truncate(result.json, 32768),
                        images: result.images.map(i => ({ mimeType: i.mime, data: i.data })),
                      }),
                    });
                  } else
                    send({
                      type: 'extension_ui_response',
                      id: value.id,
                      value: truncate(
                        result instanceof ImageToolResult ? result.json : result,
                        32768,
                      ),
                    });
                },
                () =>
                  send({
                    type: 'extension_ui_response',
                    id: value.id,
                    value: 'Tool failed or denied',
                  }),
              )
              .finally(() => {
                pending.delete(value.id);
                complete();
              });
          } else if (value.type === 'agent_settled') {
            if (value.aborted) throw new Error('Cancelled');
            settled = true;
            complete();
          } else if (value.type === 'extension_error')
            throw new Error('Assistant extension failed');
        };
        child.stdout.on('data', (chunk: Buffer) => {
          if (finished) return;
          buffer += decoder.write(chunk);
          // Meter complete records: image-bearing records (repeated encoded bytes included) use the
          // separate per-attempt image budget; everything else keeps the 8 MiB stream ceiling.
          if (buffer.length > OUTPUT_BYTES + imageAllowance)
            return finish(new Error('Assistant output exceeded limit'));
          try {
            while (!finished && buffer.includes('\n')) {
              const newline = buffer.indexOf('\n');
              const line = buffer.slice(0, newline).replace(/\r$/, '');
              buffer = buffer.slice(newline + 1);
              const size = Buffer.byteLength(line) + 1;
              if (line.includes('"type":"image"')) {
                imageBytes += size;
                if (imageBytes > imageAllowance)
                  return finish(new Error('Assistant image transport exceeded limit'));
              } else {
                bytes += size;
                if (bytes > OUTPUT_BYTES)
                  return finish(new Error('Assistant output exceeded limit'));
              }
              if (line) record(JSON.parse(line));
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error('Invalid RPC stream'));
          }
        });
        if (input.signal.aborted) abort();
        else send({ id: 'turn-1', type: 'prompt', message: input.message });
      });
    } catch (error) {
      failure = error;
    } finally {
      child.stdin.end();
      if (!closed) {
        child.kill('SIGTERM');
        const kill = setTimeout(() => child.kill('SIGKILL'), 1000);
        await exited;
        clearTimeout(kill);
      }
    }
    const files = (await readdir(sessions)).filter(name => name.endsWith('.jsonl'));
    if (files.length)
      session = boundedSession(
        sanitizeSession(
          await readFile(
            join(sessions, files.includes('restored.jsonl') ? 'restored.jsonl' : files[0]),
            'utf8',
          ),
        ),
      );
    return {
      session,
      error: failure instanceof Error ? failure.message : failure ? 'Assistant failed' : undefined,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
