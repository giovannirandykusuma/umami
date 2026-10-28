// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { validateBoardDraft } from './board-draft';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_LIMITS, runAiTurn, runIsolatedTurn, type AiEvent } from './runtime';
import { gatewayConfig, permissionArgs, reasoningLevel } from './rpc/confinement.mjs';
import { validateAiResult, validateAnalyticsDiscoverArgs } from './rpc/contract';

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

describe('model-facing tool contracts', () => {
  it('publishes concrete strict arguments and supported widget schemas', () => {
    const require = createRequire(resolve('package.json'));
    // Native Pi resolves this same locked TypeBox version for extension imports.
    const {
      Type,
    } = require('./node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox');
    const {
      Value,
    } = require('./node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/cjs/value/index.js');
    const tools: Record<string, any> = {};
    const source = readFileSync('scripts/ai/host-tools.mjs', 'utf8')
      .replace("import { Type } from '@sinclair/typebox';", '')
      .replace('export default function', 'function register');
    vm.runInNewContext(source + '\nregister(pi);', {
      Type,
      pi: {
        registerTool: (tool: any) => {
          tools[tool.name] = tool;
        },
        on: () => {},
      },
    });
    const websiteId = '11111111-1111-4111-8111-111111111111';
    const dates = { websiteId, startAt: 0, endAt: 1000 };
    expect(Value.Check(tools.analytics_summary.parameters, dates)).toBe(true);
    expect(Value.Check(tools.analytics_discover.parameters, dates)).toBe(true);
    for (const args of [
      { ...dates, values: true },
      { ...dates, startAt: -1 },
      { ...dates, endAt: 1.5 },
      {},
    ])
      expect(Value.Check(tools.analytics_discover.parameters, args)).toBe(false);
    expect(
      Value.Check(tools.propose_board.parameters, {
        message: 'Clarify',
        questions: [
          { id: 'event', question: 'Which event?', options: [{ label: 'Other', value: 'other' }] },
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(tools.propose_board.parameters, {
        message: 'Clarify',
        questions: [{ id: 'event', question: 'Which event?', action: 'execute' }],
      }),
    ).toBe(false);
    expect(Value.Check(tools.analytics_summary.parameters, { ...dates, userId: 'forged' })).toBe(
      false,
    );
    expect(Value.Check(tools.analytics_summary.parameters, {})).toBe(false);
    expect(
      Value.Check(tools.analytics_breakdown.parameters, {
        ...dates,
        dimension: 'username',
        limit: 10,
      }),
    ).toBe(false);
    expect(
      Value.Check(tools.analytics_timeseries.parameters, {
        ...dates,
        metric: 'logins',
        unit: 'day',
      }),
    ).toBe(false);
    const draft = {
      websiteId,
      rows: [
        {
          id: 'row',
          columns: [
            { id: 'visits', component: { type: 'WebsiteMetricsBar' } },
            {
              id: 'pages',
              component: { type: 'MetricsTable', props: { type: 'path', limit: 10 } },
            },
          ],
        },
      ],
    };
    expect(
      Value.Check(tools.propose_board.parameters, { message: 'Visits and popular pages', draft }),
    ).toBe(true);
    expect(validateBoardDraft(draft)).toEqual(draft);
    expect(Value.Check(tools.propose_board.parameters, { message: 'Not supported' })).toBe(true);
    expect(
      Value.Check(tools.propose_board.parameters, {
        message: 'x',
        draft: { ...draft, script: 'no' },
      }),
    ).toBe(false);
    expect(
      Value.Check(tools.propose_board.parameters, {
        message: 'x',
        draft: {
          websiteId,
          rows: [{ id: 'r', columns: [{ id: 'c', component: { type: 'LoginChart' } }] }],
        },
      }),
    ).toBe(false);
  });
});

describe('strict clarification and discovery boundaries', () => {
  const question = {
    id: 'event',
    question: 'Which event means a successful login?',
    options: [{ label: 'Unknown', value: 'unknown' }],
  };
  it('returns detached display-only questions and preserves message-only JSON compatibility', () => {
    const input = { message: 'Please clarify.', questions: [question] };
    const result = validateAiResult(input);
    expect(result).toEqual(input);
    expect(result.questions).not.toBe(input.questions);
    expect(result.questions![0].options).not.toBe(question.options);
    expect(validateAiResult({ message: 'Not supported.' })).toEqual({ message: 'Not supported.' });
  });
  it.each([
    [],
    [question, question],
    Array(4).fill(question),
    [{ ...question, id: '__proto__' }],
    [{ ...question, id: 'constructor' }],
    [{ ...question, question: '' }],
    [{ ...question, question: 'x'.repeat(501) }],
    [{ ...question, question: '<script>execute()</script>' }],
    [{ ...question, action: 'save' }],
    [{ ...question, options: [] }],
    [{ ...question, options: Array(7).fill({ label: 'a', value: 'b' }) }],
    [
      {
        ...question,
        options: [
          { label: 'a', value: 'same' },
          { label: 'b', value: 'same' },
        ],
      },
    ],
    [{ ...question, options: [{ label: 'a', value: 'x'.repeat(121) }] }],
    [{ ...question, options: [{ label: 'a', value: 'b', action: { url: 'https://invalid' } }] }],
  ])('rejects malformed questions %#', questions => {
    expect(() => validateAiResult({ message: 'Clarify', questions })).toThrow();
  });
  it('rejects inherited objects, accessors, prototype keys and oversized UTF-8 results', () => {
    const getter = vi.fn(() => 'secret');
    for (const value of [
      Object.assign(Object.create({ authority: true }), { message: 'x' }),
      {
        get message() {
          return getter();
        },
      },
      JSON.parse('{"message":"x","__proto__":{}}'),
      {
        message: 'x',
        questions: [
          { ...question, options: [JSON.parse('{"label":"a","value":"b","prototype":{}}')] },
        ],
      },
      { message: 'x', draft: { text: '😀'.repeat(10_000) } },
    ])
      expect(() => validateAiResult(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('matches strict host UUID/date/cost bounds without granting identity authority', () => {
    const args = { websiteId: '11111111-1111-4111-8111-111111111111', startAt: 0, endAt: 1000 };
    expect(validateAnalyticsDiscoverArgs(args, 1000)).toEqual(args);
    expect(validateAnalyticsDiscoverArgs({ ...args, endAt: 0 }, 1000)).toHaveProperty('endAt', 0);
    for (const value of [
      { ...args, userId: 'forged' },
      { ...args, websiteId: 'invalid' },
      { ...args, startAt: -1 },
      { ...args, endAt: 1.5 },
      { ...args, startAt: 1001 },
      { ...args, endAt: 1001 },
      { ...args, endAt: 32 * 86_400_000 },
    ])
      expect(() => validateAnalyticsDiscoverArgs(value, 1000)).toThrow();
  });
  it('validates native proposals before output, correlates discovery, and suppresses late reads after cancel', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-clarification-'));
    const path = join(directory, 'fixture.mjs');
    await writeFile(
      path,
      `
      import { createInterface } from 'node:readline';
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      createInterface({ input: process.stdin }).on('line', line => {
        const value = JSON.parse(line);
        if (value.type === 'prompt') {
          const mode = JSON.parse(value.message.split('\\n').slice(1).join('\\n')).messages[0].content;
          globalThis.mode = mode;
          send({ type: 'response', id: 'turn-1', command: 'prompt', success: true, data: { disposition: 'started' } });
          send({ type: 'message_update', secret: 'private reasoning' });
          send({ type: 'extension_ui_request', method: 'input', title: 'umami-host-tool', id: 'read-1', placeholder: JSON.stringify({ name: 'analytics_discover', args: { websiteId: '11111111-1111-4111-8111-111111111111', startAt: 0, endAt: 1000 } }) });
        } else if (value.id === 'read-1') {
          const proposal = { message: 'Clarify.', questions: [{ id: 'event', question: 'Which event?' }] };
          if (globalThis.mode === 'invalid') proposal.questions[0].action = 'save';
          if (globalThis.mode === 'oversize') proposal.questions[0].question = 'x'.repeat(501);
          send({ type: 'extension_ui_request', method: 'input', title: 'umami-host-tool', id: 'final-1', placeholder: JSON.stringify({ name: 'propose_board', args: proposal }) });
          if (globalThis.mode === 'duplicate') send({ type: 'extension_ui_request', method: 'input', title: 'umami-host-tool', id: 'final-2', placeholder: JSON.stringify({ name: 'propose_board', args: proposal }) });
          send({ type: 'agent_settled', aborted: false });
        }
      });
    `,
    );
    const events: AiEvent[] = [];
    const run = (mode: string, extra = {}) =>
      runIsolatedTurn(
        {
          messages: [{ role: 'user', content: mode }],
          executeTool,
          onEvent: event => events.push(event),
          ...extra,
        },
        { bridge: path, env: {}, timeoutMs: 1000 },
      );
    try {
      await expect(run('valid')).resolves.toEqual({
        message: 'Clarify.',
        questions: [{ id: 'event', question: 'Which event?' }],
      });
      expect(executeTool).toHaveBeenCalledWith('analytics_discover', {
        websiteId: '11111111-1111-4111-8111-111111111111',
        startAt: 0,
        endAt: 1000,
      });
      expect(events).toEqual(
        ['start', 'check', 'read', 'prepare', 'validate', 'complete'].map(phase => ({
          type: 'progress',
          phase,
        })),
      );
      for (const mode of ['invalid', 'oversize', 'duplicate'])
        await expect(run(mode)).rejects.toThrow('protocol');
      const controller = new AbortController();
      let release!: (value: unknown) => void;
      const pending = run('valid', {
        signal: controller.signal,
        executeTool: () => {
          controller.abort();
          return new Promise(resolve => {
            release = resolve;
          });
        },
      });
      await expect(pending).rejects.toThrow('cancelled');
      const snapshot = [...events];
      release({ private: 'late metadata' });
      await Promise.resolve();
      expect(events).toEqual(snapshot);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('confinement', () => {
  it('constructs only a fixed env-key gateway schema and rejects unknown endpoints/models', () => {
    const env = {
      AI_PROVIDER: 'gateway',
      AI_MODEL: 'test-model',
      AI_BASE_URL: 'https://gateway.invalid/v1',
      AI_EGRESS_ORIGINS: 'https://gateway.invalid',
    };
    expect(gatewayConfig(env)).toEqual({
      providers: {
        gateway: {
          baseUrl: env.AI_BASE_URL,
          api: 'openai-completions',
          apiKey: '$AI_PROVIDER_KEY',
          authHeader: true,
          models: [
            {
              id: 'test-model',
              input: ['text'],
              reasoning: true,
              thinkingLevelMap: {
                off: 'none',
                minimal: null,
                low: 'low',
                medium: 'medium',
                high: 'high',
                xhigh: 'xhigh',
              },
              compat: {
                supportsStore: false,
                supportsDeveloperRole: false,
                supportsReasoningEffort: true,
                maxTokensField: 'max_tokens',
                thinkingFormat: 'openai',
              },
            },
          ],
        },
      },
    });
    for (const extra of [
      { AI_BASE_URL: 'http://gateway.invalid/v1' },
      { AI_BASE_URL: 'https://user:pass@gateway.invalid/v1' },
      { AI_BASE_URL: 'https://elsewhere.invalid/v1' },
      { AI_BASE_URL: 'https://gateway.invalid/v1?key=secret' },
      { AI_MODEL: '!command' },
      { AI_MODEL: '' },
      { AI_PROVIDER: '../file' },
      { AI_EGRESS_ORIGINS: 'https://gateway.invalid,https://elsewhere.invalid' },
    ])
      expect(() => gatewayConfig({ ...env, ...extra })).toThrow();
  });
  it('defaults to medium and rejects unsupported server reasoning before launch', async () => {
    expect(reasoningLevel({})).toBe('medium');
    for (const level of ['off', 'low', 'medium', 'high', 'xhigh'])
      expect(reasoningLevel({ AI_REASONING_LEVEL: level })).toBe(level);
    for (const level of ['', 'minimal', 'max', 'MEDIUM', 'medium ', '--help']) {
      expect(() => reasoningLevel({ AI_REASONING_LEVEL: level })).toThrow('reasoning level');
      await expect(
        runIsolatedTurn(
          { messages: [{ role: 'user', content: 'test' }], executeTool },
          { bridge: '/nonexistent-must-not-launch.mjs', env: { AI_REASONING_LEVEL: level } },
        ),
      ).rejects.toThrow('Invalid AI reasoning level');
    }
  });
  it('rejects planted ancestor credentials and extensions before granting discovery access', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ai-ancestor-'));
    const scratch = join(parent, 'scratch');
    await mkdir(scratch);
    try {
      for (const resource of ['.pi', '.agents/skills']) {
        const directory = join(parent, resource);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'auth.json'), 'secret');
        await writeFile(join(directory, 'models.json'), 'secret');
        await writeFile(join(directory, 'extension.mjs'), 'throw new Error("must not load")');
        expect(() =>
          permissionArgs({ root: undefined, scratch, bridge, extension: bridge }),
        ).toThrow('AI discovery probe must not exist');
        await rm(directory, { recursive: true, force: true });
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
  it('denies secret/repository/home reads, outside writes, subprocesses and workers', async () => {
    const { execFileSync } = await import('node:child_process');
    const scratch = await mkdtemp(join(tmpdir(), 'ai-permission-'));
    try {
      const args = permissionArgs({
        root: undefined,
        scratch,
        bridge,
        extension: resolve('scripts/ai/host-tools.mjs'),
      });
      const script = `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        for (const path of ${JSON.stringify([resolve('.env'), resolve('package.json'), join(process.env.HOME!, '.ssh/id_rsa')])})
          assert.throws(() => fs.readFileSync(path), {code:'ERR_ACCESS_DENIED'});
        assert.throws(() => fs.writeFileSync(${JSON.stringify(join(tmpdir(), 'outside-ai-write'))}, 'x'), {code:'ERR_ACCESS_DENIED'});
        assert.throws(() => require('node:child_process').spawn(process.execPath), {code:'ERR_ACCESS_DENIED'});
        assert.throws(() => new (require('node:worker_threads').Worker)('0', {eval:true}), {code:'ERR_ACCESS_DENIED'});
        console.log('denials verified');`;
      expect(
        execFileSync(process.execPath, [...args, '-e', script], {
          env: { NODE_ENV: 'test' },
        }).toString(),
      ).toContain('denials verified');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
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
      { type: 'progress', phase: 'start' },
      { type: 'progress', phase: 'check' },
      { type: 'progress', phase: 'prepare' },
      { type: 'progress', phase: 'validate' },
      { type: 'progress', phase: 'complete' },
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
        TMPDIR: tmpdir(),
        AI_PI_ROOT:
          process.env.AI_PI_ROOT ||
          `${process.env.HOME}/.local/lib/node_modules/@earendil-works/pi-coding-agent`,
      },
      timeout: 20000,
    }).toString();
    expect(output).toContain('native RPC get_state correlated');
    expect(output).toContain('reasoning_effort=medium, stream=true offline');
  }, 25000);
  it('enforces concurrency and recovers slots after timeout', async () => {
    const requests = [turn('timeout', {}, 100), turn('timeout', {}, 100)];
    await expect(turn()).rejects.toThrow('busy');
    await Promise.all(requests.map(request => expect(request).rejects.toThrow('timeout')));
    await expect(turn()).resolves.toHaveProperty('message');
  });
});
