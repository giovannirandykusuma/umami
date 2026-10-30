// @vitest-environment node
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ default: {} }));

import { ANALYST_TOOLS } from './analyst/tools';
import {
  BASE_TOOLS,
  fixtureDatabaseVerified,
  OFFLINE_FIXTURE_DATABASE,
  OFFLINE_FIXTURE_RECEIPT_MS,
  offlineFixtureRuntime,
  runAssistantProcess,
} from './runtime';

const options = {
  env: { AI_PROVIDER: 'test', AI_MODEL: 'test', AI_REASONING_LEVEL: 'off' },
  bridge: resolve('src/lib/ai/assistant/fixtures/fake-pi.mjs'),
};
it('streams ordered deltas and saves/restores native session JSONL', async () => {
  const events: any[] = [];
  const input = {
    message: 'hello',
    session: null,
    signal: new AbortController().signal,
    emit: (event: any) => events.push(event),
    tool: vi.fn(),
  };
  const first = await runAssistantProcess(input, options);
  expect(first.error).toBeUndefined();
  expect(events.map(e => e.type)).toEqual(['thinking_delta', 'text_delta', 'text_delta']);
  expect(events[1].partId).toBe(events[2].partId);
  expect(first.session).toContain('hello');
  const firstHeader = JSON.parse(first.session!.split('\n')[0]);
  expect(existsSync(firstHeader.cwd)).toBe(false);
  const second = await runAssistantProcess(
    { ...input, message: 'next', session: first.session },
    options,
  );
  expect(second.error).toBeUndefined();
  const secondHeader = JSON.parse(second.session!.split('\n')[0]);
  expect(secondHeader.cwd).not.toBe(firstHeader.cwd);
  expect(secondHeader.id).toBe(firstHeader.id);
  expect(second.session).toContain('hello');
  expect(second.session).toContain('next');
});
it('reports bounded safe startup diagnostics without exposing arbitrary stderr', async () => {
  const outcome = await runAssistantProcess(
    {
      message: 'startup-error',
      session: null,
      signal: new AbortController().signal,
      emit: vi.fn(),
      tool: vi.fn(),
    },
    options,
  );
  expect(outcome.error).toBe(
    'Assistant exited before settlement (exit 1): Stored session working directory does not exist',
  );
  expect(outcome.error).not.toContain('secret-token');
  expect(outcome.error).not.toContain('/private/path');
});
it('bridges tool calls and forwards start/end', async () => {
  const events: any[] = [];
  const tool = vi.fn().mockResolvedValue('Authorized websites');
  const outcome = await runAssistantProcess(
    {
      message: 'tool',
      session: null,
      signal: new AbortController().signal,
      emit: e => events.push(e),
      tool,
    },
    options,
  );
  expect(outcome.error).toBeUndefined();
  expect(tool).toHaveBeenCalledWith('umami_api', { method: 'GET', path: '/api/websites' });
  expect(events.filter(e => e.type === 'part').map(e => e.part.status)).toEqual([
    'running',
    'done',
  ]);
});
it.each([
  'analytics_schema',
  'find_people',
  'query_series',
  'query_breakdown',
  'query_totals',
  'unknown_tool',
])('bridges only approved analytics names (%s)', async name => {
  const dir = mkdtempSync(resolve(tmpdir(), 'assistant-runtime-test-'));
  const bridge = resolve(dir, 'bridge.mjs');
  writeFileSync(
    bridge,
    readFileSync(options.bridge, 'utf8').replaceAll("'umami_api'", JSON.stringify(name)),
  );
  const tool = vi.fn().mockResolvedValue({ ok: true, data: {} });
  try {
    const outcome = await runAssistantProcess(
      { message: 'tool', session: null, signal: new AbortController().signal, emit: vi.fn(), tool },
      { ...options, bridge },
    );
    if (name === 'unknown_tool') {
      expect(outcome.error).toBeDefined();
      expect(tool).not.toHaveBeenCalled();
    } else {
      expect(outcome.error).toBeUndefined();
      expect(tool).toHaveBeenCalledWith(name, { method: 'GET', path: '/api/websites' });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('denies an unknown bridge name even after an allowed execution start', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'assistant-runtime-denial-'));
  const bridge = resolve(dir, 'bridge.mjs');
  writeFileSync(
    bridge,
    readFileSync(options.bridge, 'utf8').replace("name: 'umami_api'", "name: 'unknown_tool'"),
  );
  const tool = vi.fn();
  try {
    const outcome = await runAssistantProcess(
      { message: 'tool', session: null, signal: new AbortController().signal, emit: vi.fn(), tool },
      { ...options, bridge },
    );
    expect(outcome.error).toBeDefined();
    expect(tool).not.toHaveBeenCalled();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('aborts a running child and returns its saved session', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  const outcome = await runAssistantProcess(
    { message: 'hang', session: null, signal: controller.signal, emit: vi.fn(), tool: vi.fn() },
    options,
  );
  clearTimeout(timer);
  expect(outcome.error).toBe('Cancelled');
  expect(outcome.session).toContain('hang');
});
it('enforces the wall-clock deadline', async () => {
  const outcome = await runAssistantProcess(
    {
      message: 'hang',
      session: null,
      signal: new AbortController().signal,
      emit: vi.fn(),
      tool: vi.fn(),
    },
    { ...options, timeoutMs: 100 },
  );
  expect(outcome.error).toBe('Assistant timeout');
});

// Synthetic analyst bridge: loads the real assistant-tools extension, executes its registered
// analyst_verify_render tool (ctx.ui.input over native RPC), and replays the extension's converted
// content `REPEAT` times in tool/message events and session JSONL, as native Pi does. No model calls.
const imageBridge = (repeat: number, extension: string) => `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const ext = await import(${JSON.stringify(extension)});
const tools = [];
ext.default({ registerTool: t => tools.push(t), on() {}, setActiveTools() {} });
const verify = tools.find(t => t.name === 'analyst_verify_render');
const args = process.argv.slice(2);
const dir = args[args.indexOf('--session-dir') + 1];
const restored = args.includes('--session') ? args[args.indexOf('--session') + 1] : null;
const session = restored || join(dir, 'test.jsonl');
const emit = v => process.stdout.write(JSON.stringify(v) + '\\n');
const waiting = new Map();
const ui = { input: (title, placeholder) => new Promise(done => {
  const id = 'bridge-' + (waiting.size + 1);
  waiting.set(id, done);
  emit({ type: 'extension_ui_request', id, method: 'input', title, placeholder });
}) };
createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line);
  if (request.type === 'prompt') {
    if (restored && readFileSync(restored, 'utf8').includes('"type":"image"')) {
      emit({ type: 'extension_error' });
      return;
    }
    if (!restored) writeFileSync(session, JSON.stringify({ type: 'session', version: 3, id: 'img', cwd: process.cwd() }) + '\\n');
    emit({ type: 'response', id: request.id, command: 'prompt', success: true });
    emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'analyst_verify_render', args: { boardId: 'b' } });
    const { content } = await verify.execute('t1', { boardId: 'b' }, new AbortController().signal, null, { ui });
    if (!content.some(c => c.type === 'image')) { emit({ type: 'extension_error' }); return; }
    for (let i = 0; i < ${repeat}; i++) emit({ type: 'message_update', message: { role: 'toolResult', content } });
    appendFileSync(session, JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: 't1', content } }) + '\\n');
    emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'analyst_verify_render', result: { content }, isError: false });
    emit({ type: 'agent_settled' });
  } else if (request.type === 'extension_ui_response') {
    waiting.get(request.id)?.(request.value);
  }
});`;
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), 8 + data.length);
  return out;
};
/** Valid RGB PNG of random (incompressible) pixels, padded with an ancillary chunk to `size`. */
function syntheticPng(seed: number, size = 1024 * 1024) {
  const { deflateSync } = require('node:zlib') as typeof import('node:zlib');
  const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
  const width = 512;
  const height = 600;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.concat(
    Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), randomBytes(width * 3)])),
  );
  raw.writeUInt32BE(seed, 1);
  const head = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 0 })),
  ]);
  const end = chunk('IEND', Buffer.alloc(0));
  const pad = size - head.length - end.length - 12;
  if (pad < 0) throw new Error('synthetic PNG too large');
  return Buffer.concat([head, chunk('pdNg', randomBytes(pad)), end]);
}
/** Minimal decoder check: signature, chunk CRCs, IHDR, and IDAT inflating to the pixel size. */
function isValidPng(png: Buffer) {
  const { inflateSync } = require('node:zlib') as typeof import('node:zlib');
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return false;
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const body = png.subarray(at + 4, at + 8 + length);
    if (crc(body) !== png.readUInt32BE(at + 8 + length)) return false;
    const type = body.subarray(0, 4).toString('ascii');
    if (type === 'IHDR') [width, height] = [body.readUInt32BE(4), body.readUInt32BE(8)];
    if (type === 'IDAT') idat.push(body.subarray(4));
    at += 12 + length;
    if (type === 'IEND')
      return (
        at === png.length && inflateSync(Buffer.concat(idat)).length === height * (1 + width * 3)
      );
  }
  return false;
}
const MAX_IMAGES = Array.from({ length: 6 }, (_, i) => {
  const png = syntheticPng(i);
  return {
    mime: 'image/png',
    hash: String(i).repeat(64),
    // Exactly 1 MiB decoded each: the per-image maximum the extension accepts.
    data: png.toString('base64'),
  };
});
async function runImage(repeat: number, session: string | null = null) {
  const dir = mkdtempSync(resolve(tmpdir(), 'assistant-image-'));
  const bridge = resolve(dir, 'bridge.mjs');
  writeFileSync(bridge, imageBridge(repeat, extensionCopy(dir)));
  const events: any[] = [];
  const { ImageToolResult } = await import('./runtime');
  try {
    const outcome = await runAssistantProcess(
      {
        message: 'verify',
        session,
        signal: new AbortController().signal,
        emit: e => events.push(e),
        tool: async () => new ImageToolResult({ ok: true, receipt: 'r' }, MAX_IMAGES),
      },
      {
        ...options,
        env: { ...options.env, AI_ANALYST_ENABLED: 'true' },
        bridge,
        tools: ['analyst_verify_render'],
      },
    );
    return { outcome, events };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
/** Real extension source with its TypeBox import resolved to the locked install (offline). */
function extensionCopy(dir: string) {
  const [typebox] = globSync(
    'node_modules/.pnpm/@sinclair+typebox@*/node_modules/@sinclair/typebox/build/esm/index.mjs',
  );
  const target = resolve(dir, 'assistant-tools.mjs');
  writeFileSync(
    target,
    readFileSync(resolve('scripts/ai/assistant-tools.mjs'), 'utf8').replace(
      "'@sinclair/typebox'",
      JSON.stringify(pathToFileURL(resolve(typebox)).href),
    ),
  );
  return pathToFileURL(target).href;
}
const seeded = (text: string) =>
  MAX_IMAGES.some(i => text.includes(i.data.slice(200, 264))) || text.includes('data:image');
it('round-trips maximal 6×1 MiB images and keeps them out of session, parts and diagnostics', async () => {
  for (const i of MAX_IMAGES) {
    expect(Buffer.from(i.data, 'base64').length).toBe(1024 * 1024);
    expect(isValidPng(Buffer.from(i.data, 'base64'))).toBe(true);
  }
  const { outcome, events } = await runImage(2);
  expect(outcome.error).toBeUndefined();
  expect(seeded(outcome.session!)).toBe(false);
  expect(outcome.session).toContain('[screenshot omitted sha256=');
  expect(outcome.session).toContain('"toolCallId":"t1"');
  expect(seeded(JSON.stringify(events))).toBe(false);
});
it('aborts cleanly when repeated image events exhaust the 32 MiB transport budget', async () => {
  const { outcome } = await runImage(5);
  expect(outcome.error).toBe('Assistant image transport exceeded limit');
  expect(seeded(outcome.error!)).toBe(false);
});
it('legacy turns keep the 8 MiB ceiling: image-bearing output without a host grant fails', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'assistant-legacy-'));
  const bridge = resolve(dir, 'bridge.mjs');
  // Child emits image content (≈8.4 MiB) that the host never released through an image result.
  writeFileSync(
    bridge,
    `const data = ${JSON.stringify(MAX_IMAGES.map(i => i.data))};
process.stdin.on('data', () => {
  process.stdout.write(JSON.stringify({ type: 'response', id: 'turn-1', command: 'prompt', success: true }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'message_update', message: { content: data.map(d => ({ type: 'image', data: d, mimeType: 'image/png' })) } }) + '\\n');
});`,
  );
  try {
    const outcome = await runAssistantProcess(
      {
        message: 'x',
        session: null,
        signal: new AbortController().signal,
        emit: vi.fn(),
        tool: vi.fn(),
      },
      { ...options, bridge },
    );
    expect(outcome.error).toMatch(/exceeded limit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('sanitizes a restored session with image blocks before the child sees it', async () => {
  const header = JSON.stringify({ type: 'session', version: 3, id: 'img', cwd: '/gone' });
  const image = JSON.stringify({
    type: 'message',
    message: {
      role: 'toolResult',
      content: [{ type: 'image', data: MAX_IMAGES[0].data.slice(0, 4096), mimeType: 'image/png' }],
    },
  });
  const { outcome } = await runImage(1, `${header}\n${image}\n`);
  expect(outcome.error).toBeUndefined();
  expect(seeded(outcome.session!)).toBe(false);
});
it('does not bridge analyst tools for legacy (flag-off) turns', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'assistant-flagoff-'));
  const bridge = resolve(dir, 'bridge.mjs');
  writeFileSync(bridge, imageBridge(1, extensionCopy(dir)));
  const tool = vi.fn();
  try {
    const outcome = await runAssistantProcess(
      {
        message: 'verify',
        session: null,
        signal: new AbortController().signal,
        emit: vi.fn(),
        tool,
      },
      { ...options, bridge },
    );
    expect(outcome.error).toBeDefined();
    expect(tool).not.toHaveBeenCalled();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Synthetic offline fixture runtime: real native Pi RPC + packaged deterministic provider.
describe('offline fixture runtime selector', () => {
  const nonce = 'ab'.repeat(32);
  const fixtureEnv = {
    AI_OFFLINE_FIXTURE: 'analyst-synthetic-v1',
    AI_OFFLINE_FIXTURE_NONCE: nonce,
    NODE_ENV: 'development',
    DATABASE_URL: OFFLINE_FIXTURE_DATABASE,
  };
  const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
  const providerSource = 'scripts/ai/analyst-fixture/offline-provider.mjs';
  // Mirrors the launcher (app.mjs writeReceipt): root-, nonce-, provider- and time-bound.
  const project = (change: Record<string, unknown> = {}, prefix = 'umami-analyst-fixture-') => {
    const dir = realpathSync(mkdtempSync(resolve(tmpdir(), prefix)));
    mkdirSync(resolve(dir, 'scripts/ai/analyst-fixture'), { recursive: true });
    cpSync(providerSource, resolve(dir, providerSource));
    mkdirSync(resolve(dir, '.next'));
    writeFileSync(resolve(dir, '.next/BUILD_ID'), 'build-1');
    writeFileSync(
      resolve(dir, '.analyst-fixture-receipt.json'),
      JSON.stringify({
        mode: 'analyst-synthetic-v1',
        nonceSha256: sha(nonce),
        root: dir,
        providerSha256: sha(readFileSync(providerSource)),
        issuedAt: Date.now(),
        ...change,
      }),
    );
    return dir;
  };
  const refuses = (env: Record<string, string | undefined>, dir: string, now?: number) => {
    try {
      expect(() => offlineFixtureRuntime(env, dir, now)).toThrow('Offline fixture runtime refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  it('built production app: accepted only with the receipt-bound BUILD_ID', () => {
    const prod = { ...fixtureEnv, NODE_ENV: 'production' };
    const dir = project({ buildId: 'build-1' });
    try {
      expect(offlineFixtureRuntime(prod, dir)?.env.AI_PROVIDER).toBe('umami-offline-fixture');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    refuses(prod, project()); // ordinary dev receipt cannot authorize production
    refuses(prod, project({ buildId: 'other-build' }));
  });
  it.each([
    ['stale receipt', { issuedAt: Date.now() - OFFLINE_FIXTURE_RECEIPT_MS - 1 }],
    ['future receipt', { issuedAt: Date.now() + 60_000 }],
    ['forged nonce hash', { nonceSha256: sha('cd'.repeat(32)) }],
    ['plaintext nonce (legacy receipt)', { nonceSha256: undefined, nonce }],
    ['wrong root', { root: '/tmp/umami-analyst-fixture-elsewhere' }],
    ['tampered provider', { providerSha256: sha('other') }],
  ])('refuses forged receipt: %s', (_name, change) => refuses(fixtureEnv, project(change)));
  it('writable-attacker forgeries: a fully self-consistent receipt without the env nonce fails', () => {
    // Attacker can write any file in the root but does not hold the launcher's env nonce.
    const attacker = 'ef'.repeat(32);
    refuses({ ...fixtureEnv, AI_OFFLINE_FIXTURE_NONCE: attacker }, project());
    refuses(fixtureEnv, project({ nonceSha256: sha(attacker) }));
    // Rewriting the provider file after the launcher hashed it.
    const swapped = project();
    writeFileSync(resolve(swapped, providerSource), '// replaced');
    refuses(fixtureEnv, swapped);
    // Copying a valid receipt into another root.
    const source = project();
    const copy = project({}, 'umami-analyst-fixture-');
    cpSync(
      resolve(source, '.analyst-fixture-receipt.json'),
      resolve(copy, '.analyst-fixture-receipt.json'),
    );
    rmSync(source, { recursive: true, force: true });
    refuses(fixtureEnv, copy);
    // Planted symlink receipt (regular files only).
    const linked = project();
    const real = resolve(linked, 'real.json');
    cpSync(resolve(linked, '.analyst-fixture-receipt.json'), real);
    rmSync(resolve(linked, '.analyst-fixture-receipt.json'));
    symlinkSync(real, resolve(linked, '.analyst-fixture-receipt.json'));
    refuses(fixtureEnv, linked);
    // Rewriting BUILD_ID to match a forged buildId still needs the nonce; with the real nonce,
    // a receipt whose buildId differs from the root's build is refused.
    const build = project({ buildId: 'build-1' });
    writeFileSync(resolve(build, '.next/BUILD_ID'), 'build-2');
    refuses({ ...fixtureEnv, NODE_ENV: 'production' }, build);
  });
  it('refuses a receipt outside a launcher-owned root', () =>
    refuses(fixtureEnv, project({}, 'offline-fixture-')));
  it('database marker: requires both the synthetic engine and fixture schema receipts', async () => {
    const row = (engine: string, schema: string) => async () => [{ engine, schema }];
    expect(
      await fixtureDatabaseVerified(row('umami-ai-synthetic-r3', 'umami-analyst-fixture-r1')),
    ).toBe(true);
    expect(await fixtureDatabaseVerified(row('other', 'umami-analyst-fixture-r1'))).toBe(false);
    expect(await fixtureDatabaseVerified(row('umami-ai-synthetic-r3', 'other'))).toBe(false);
    expect(await fixtureDatabaseVerified(async () => Promise.reject(new Error('no table')))).toBe(
      false,
    );
  });
  it('is absent unless requested and accepts only the verified fixture context', () => {
    expect(offlineFixtureRuntime({ AI_ENABLED: 'true' }, process.cwd())).toBeNull();
    const dir = project();
    try {
      expect(offlineFixtureRuntime(fixtureEnv, dir)?.env.AI_PROVIDER).toBe('umami-offline-fixture');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each([
    ['production without build binding', { NODE_ENV: 'production' }],
    ['non-fixture database', { DATABASE_URL: 'postgresql://umami@db:5432/umami' }],
    ['wrong mode', { AI_OFFLINE_FIXTURE: 'true' }],
    ['missing nonce', { AI_OFFLINE_FIXTURE_NONCE: undefined }],
    ['foreign nonce', { AI_OFFLINE_FIXTURE_NONCE: 'cd'.repeat(32) }],
    ['live provider configured', { AI_PROVIDER: 'openai' }],
    ['live provider key present', { AI_PROVIDER_KEY: 'sk-live' }],
    ['live AI enabled', { AI_ENABLED: 'true' }],
    ['ambient vendor credential', { OPENAI_API_KEY: 'sk-live' }],
  ])('refuses (no live fallback): %s', (_name, change) => {
    const dir = project();
    try {
      expect(() => offlineFixtureRuntime({ ...fixtureEnv, ...change }, dir)).toThrow(
        'Offline fixture runtime refused',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses without the launcher receipt (e.g. a normal checkout)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'umami-analyst-fixture-'));
    try {
      expect(() => offlineFixtureRuntime(fixtureEnv, dir)).toThrow(
        'Offline fixture runtime refused',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('the provider module has no network-capable import or call', () => {
    const source = readFileSync('scripts/ai/analyst-fixture/offline-provider.mjs', 'utf8');
    expect(source.match(/^import .*$/gm)).toEqual([
      "import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';",
    ]);
    expect(source).not.toMatch(/fetch\(|node:(https?|net|tls|dgram|child_process)|WebSocket/);
  });
  const piRoot = '/Users/randy/.local/lib/node_modules/@earendil-works/pi-coding-agent';
  it.skipIf(!existsSync(piRoot))(
    'drives a create/readback/repair/verify turn through native Pi RPC under --permission',
    async () => {
      const calls: string[] = [];
      const events: any[] = [];
      const board = '11111111-1111-4111-8111-111111111111';
      const outcome = await runAssistantProcess(
        {
          message: 'Build a pageviews board',
          session: null,
          signal: new AbortController().signal,
          emit: event => events.push(event),
          analyst: true,
          tool: async name => {
            calls.push(name);
            return JSON.stringify(
              name === 'analyst_commit_draft'
                ? { ok: true, board: { id: board, revision: calls.length } }
                : name === 'analyst_verify_render'
                  ? { ok: false, code: 'verifier_unavailable', visualStatus: 'visual_pending' }
                  : { ok: true },
            );
          },
        },
        {
          env: {
            ...offlineFixtureRuntime(fixtureEnv, writeReceipt())!.env,
            AI_PI_ROOT: piRoot,
            AI_REASONING_LEVEL: 'off',
            AI_ANALYST_ENABLED: 'true',
          },
          bridge: resolve('scripts/ai/native.mjs'),
          offlineProvider: resolve('scripts/ai/analyst-fixture/offline-provider.mjs'),
          tools: [...BASE_TOOLS, ...ANALYST_TOOLS],
        },
      );
      expect(outcome.error).toBeUndefined();
      expect(calls).toEqual([
        'analyst_discover',
        'analyst_commit_draft',
        'analyst_readback',
        'analyst_commit_draft',
        'analyst_readback',
        'analyst_verify_render',
      ]);
      expect(
        events
          .filter(e => e.type === 'text_delta')
          .map(e => e.delta)
          .join(''),
      ).toBe('Offline fixture turn complete; render status: visual_pending');
      function writeReceipt() {
        const dir = project();
        onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
        return dir;
      }
    },
    60_000,
  );
});
