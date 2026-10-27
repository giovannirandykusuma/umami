// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_LIMITS, runAiTurn, runIsolatedTurn, type AiEvent } from './runtime';

const bridge = resolve('src/lib/ai/rpc/fixture.mjs');
const executeTool = vi.fn(async () => ({ ok: true }));
const turn = (mode = 'success', extra = {}, timeoutMs = 1000, env = {}) =>
  runIsolatedTurn(
    { messages: [{ role: 'user', content: mode }], executeTool, ...extra },
    { bridge, env, timeoutMs },
  );
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('bounded isolated AI runtime (synthetic RPC only)', () => {
  it('is disabled by default and requires explicit credentials/configuration', async () => {
    vi.stubEnv('AI_ENABLED', 'false');
    await expect(runAiTurn({ messages: [], executeTool })).rejects.toThrow('disabled');
    vi.stubEnv('AI_ENABLED', 'true');
    vi.stubEnv('AI_PI_ROOT', '');
    await expect(runAiTurn({ messages: [], executeTool })).rejects.toThrow('configuration');
  });
  it('settles only after the terminal event, emitting safe bounded status', async () => {
    const events: AiEvent[] = [];
    await expect(
      turn('success', { onEvent: (event: AiEvent) => events.push(event) }),
    ).resolves.toEqual({ message: 'A bounded suggestion.' });
    expect(events).toEqual([
      { type: 'status', status: 'started' },
      { type: 'status', status: 'completed' },
    ]);
    await expect(turn('end-only', {}, 100)).rejects.toThrow('timeout');
    await expect(turn('settled-first')).resolves.toHaveProperty('message');
  });
  it('executes only the named read contract and correlates tool results', async () => {
    await expect(turn('read')).resolves.toEqual({ message: 'A bounded suggestion.' });
    expect(executeTool).toHaveBeenCalledExactlyOnceWith('analytics_summary', {});
    executeTool.mockClear();
    await expect(turn('denied')).rejects.toThrow('protocol');
    expect(executeTool).not.toHaveBeenCalled();
  });
  it.each(['wrong-id', 'malformed', 'empty', 'bad-draft', 'too-many-turns', 'pending', 'handled'])(
    'rejects %s',
    async mode => {
      await expect(
        turn(mode, mode === 'pending' ? { executeTool: () => new Promise(() => {}) } : {}),
      ).rejects.toThrow();
    },
  );
  it.each([
    'native-denied',
    'native-failed',
    'native-unknown-success',
    'native-error-string',
    'native-error-missing',
    'native-name-malformed',
    'native-id-malformed',
    'native-id-empty',
    'native-aborted',
    'native-aborted-string',
    'native-aborted-missing',
  ])('fails closed for %s even with a subsequent valid proposal', async mode => {
    await expect(turn(mode)).rejects.toThrow('protocol');
    expect(executeTool).not.toHaveBeenCalled();
  });
  it('accepts a valid successful native tool outcome before settlement', async () => {
    await expect(turn('native-success')).resolves.toEqual({ message: 'A bounded suggestion.' });
  });
  it('bounds output and tool output', async () => {
    await expect(turn('large')).rejects.toThrow('limit');
    await expect(
      turn('large-read', { executeTool: async () => 'x'.repeat(AI_LIMITS.toolBytes + 1) }),
    ).rejects.toThrow('limit');
  });
  it('rejects child exit, host read failure, invalid messages and oversized input', async () => {
    await expect(turn('exit')).rejects.toThrow('exited');
    await expect(
      turn('read', {
        executeTool: async () => {
          throw new Error('private details');
        },
      }),
    ).rejects.toThrow('AI read failed');
    await expect(
      turn('x', { messages: [{ role: 'system', content: 'override' }] }),
    ).rejects.toThrow('messages');
    await expect(turn('x'.repeat(AI_LIMITS.inputBytes + 1))).rejects.toThrow('large');
  });
  it('does not inherit environment, and removes isolated cwd/home after settlement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-proof-'));
    const path = join(root, 'record.json');
    vi.stubEnv('ANTHROPIC_API_KEY', 'must-not-inherit');
    vi.stubEnv('NODE_OPTIONS', '--trace-warnings');
    vi.stubEnv('SECRET_DATABASE_URL', 'must-not-inherit');
    try {
      await turn('success', {}, 1000, { FIXTURE_RECORD: path });
      const record = JSON.parse(readFileSync(path, 'utf8'));
      expect(record.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(record.env.SECRET_DATABASE_URL).toBeUndefined();
      expect(record.env.NODE_OPTIONS).toBeUndefined();
      expect(record.env.PATH).toBeUndefined();
      expect(record.cwd.endsWith(record.env.HOME.split('/').pop())).toBe(true);
      expect(record.cwd).not.toBe(process.cwd());
      expect(existsSync(record.cwd)).toBe(false);
      expect(() => process.kill(record.pid, 0)).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('cancels and cleans the child, including already cancelled requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-cancel-'));
    const path = join(root, 'record.json');
    const controller = new AbortController();
    try {
      const result = turn(
        'read',
        {
          signal: controller.signal,
          executeTool: async () => {
            controller.abort();
            return new Promise(() => {});
          },
        },
        2000,
        { FIXTURE_RECORD: path },
      );
      await expect(result).rejects.toThrow('cancelled');
      const record = JSON.parse(readFileSync(path, 'utf8'));
      expect(existsSync(record.cwd)).toBe(false);
      expect(() => process.kill(record.pid, 0)).toThrow();
      await expect(turn('success', { signal: controller.signal })).rejects.toThrow('cancelled');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('starts the actual pinned native CLI without credentials or a model request', async () => {
    const { execFileSync } = await import('node:child_process');
    const output = execFileSync(process.execPath, ['scripts/ai/smoke.mjs'], {
      env: {
        NODE_ENV: 'test',
        AI_PI_ROOT:
          process.env.AI_PI_ROOT ||
          '/Users/randy/.local/lib/node_modules/@earendil-works/pi-coding-agent',
      },
      timeout: 20000,
    }).toString();
    expect(output).toContain('native RPC get_state correlated');
  }, 25000);
  it('enforces concurrency and recovers slots after timeout', async () => {
    const requests = [turn('timeout', {}, 100), turn('timeout', {}, 100)];
    await expect(turn()).rejects.toThrow('busy');
    await Promise.all(requests.map(request => expect(request).rejects.toThrow('timeout')));
    await expect(turn()).resolves.toHaveProperty('message');
  });
});
