import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { gatewayConfig, permissionArgs, reasoningLevel } from '../rpc/confinement.mjs';
import { assistantPrompt } from './prompt';
import { boundedSession } from './store';
import type { AssistantPart, AssistantStreamEvent, AssistantTurnContext } from './protocol';
import { truncate } from './tools';

export interface RuntimeInput {
  message: string;
  session: string | null;
  context?: AssistantTurnContext;
  signal: AbortSignal;
  emit: (event: AssistantStreamEvent) => void;
  tool: (name: string, args: unknown) => Promise<string>;
}
export interface RuntimeOptions {
  env: Record<string, string>;
  bridge: string;
  timeoutMs?: number;
}
export function runAssistant(input: RuntimeInput) {
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
  if (!isAbsolute(env.AI_PI_ROOT)) throw new Error('AI installation must be absolute');
  gatewayConfig(env);
  return runAssistantProcess(input, { env, bridge: resolve('scripts/ai/native.mjs') });
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
    const restored = boundedSession(input.session);
    const sessionPath = join(sessions, 'restored.jsonl');
    if (restored) await writeFile(sessionPath, restored, { mode: 0o600 });
    const native = options.bridge === resolve('scripts/ai/native.mjs');
    const extension = resolve('scripts/ai/assistant-tools.mjs');
    if (native)
      await writeFile(join(agent, 'models.json'), JSON.stringify(gatewayConfig(options.env)), {
        mode: 0o600,
      });
    const args = [
      ...(native
        ? permissionArgs({
            root: options.env.AI_PI_ROOT,
            scratch: directory,
            bridge: options.bridge,
            extension,
          })
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
      '--provider',
      options.env.AI_PROVIDER,
      '--model',
      options.env.AI_MODEL,
      '--thinking',
      reasoningLevel(options.env),
      '--system-prompt',
      assistantPrompt(input.context),
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
        let stderrBytes = 0;
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
        child.once('close', () => finish(new Error('Assistant exited before settlement')));
        child.stderr.on('data', (chunk: Buffer) => {
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
              !['umami_api', 'ask_user', 'show_chart', 'open_link'].includes(value.toolName)
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
              args: value.args,
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
                result: truncate(value.result, 8192),
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
            pending.add(value.id);
            Promise.resolve()
              .then(() => input.tool(request.name, request.args))
              .then(
                result =>
                  send({
                    type: 'extension_ui_response',
                    id: value.id,
                    value: truncate(result, 32768),
                  }),
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
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024) return finish(new Error('Assistant output exceeded limit'));
          buffer += decoder.write(chunk);
          try {
            while (!finished && buffer.includes('\n')) {
              const newline = buffer.indexOf('\n');
              const line = buffer.slice(0, newline).replace(/\r$/, '');
              buffer = buffer.slice(newline + 1);
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
        await readFile(
          join(sessions, files.includes('restored.jsonl') ? 'restored.jsonl' : files[0]),
          'utf8',
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
