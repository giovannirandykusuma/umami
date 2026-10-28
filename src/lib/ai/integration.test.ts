// @vitest-environment node
// TEST composition intercepts only native launch argv; all application/CLI behavior stays real.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const launch = vi.hoisted(() => ({
  count: 0,
  homes: [] as string[],
  reads: [] as string[],
  onLaunch: undefined as undefined | (() => void),
  closed: [] as Promise<void>[],
  baseline: undefined as any,
  invocation: undefined as any,
  evidence: [] as {
    ready: boolean;
    read: boolean;
    proposed: boolean;
    waiting: boolean;
    failed: boolean;
    modelError: boolean;
  }[],
}));
vi.mock('node:child_process', async importOriginal => {
  const real: typeof import('node:child_process') = await importOriginal();
  const { permissionArgs } = await import('./rpc/confinement.mjs');
  const { UMAMI_GUIDANCE } = await import('./guidance');
  return {
    ...real,
    spawn: (
      command: string,
      args: string[],
      options: import('node:child_process').SpawnOptions,
    ) => {
      assert.equal(command, process.execPath);
      assert.ok(Array.isArray(args));
      const native = resolve('scripts/ai/native.mjs');
      const provider = resolve('scripts/ai/integration/provider.mjs');
      const home = String(options?.cwd);
      assert.ok(home.startsWith(join(process.env.TMPDIR || '/tmp', 'umami-ai-')));
      assert.deepEqual(options, {
        cwd: home,
        env: {
          AI_PI_ROOT: process.env.AI_PI_ROOT,
          AI_PROVIDER: 'umami-synthetic',
          AI_MODEL: 'offline',
          AI_BASE_URL: 'https://synthetic.invalid',
          AI_PROVIDER_KEY: 'synthetic-not-a-credential',
          AI_EGRESS_ORIGINS: 'https://synthetic.invalid',
          AI_REASONING_LEVEL: 'medium',
          HOME: home,
          TMPDIR: home,
          XDG_CONFIG_HOME: home,
          XDG_CACHE_HOME: home,
          PI_CODING_AGENT_DIR: join(home, 'agent'),
          PI_CODING_AGENT_SESSION_DIR: join(home, 'sessions'),
          LANG: 'C.UTF-8',
          NODE_ENV: 'production',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
      assert.deepEqual(args, [
        ...permissionArgs({
          root: process.env.AI_PI_ROOT,
          scratch: home,
          bridge: native,
          extension: resolve('scripts/ai/host-tools.mjs'),
        }),
        native,
        '--mode',
        'rpc',
        '--no-session',
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
        resolve('scripts/ai/host-tools.mjs'),
        '--provider',
        'umami-synthetic',
        '--model',
        'offline',
        '--thinking',
        'medium',
        '--system-prompt',
        UMAMI_GUIDANCE,
      ]);
      launch.invocation = { command, args: [...args], options };
      const appended = [...args];
      appended.splice(appended.indexOf(native), 0, `--allow-fs-read=${provider}`);
      appended.push('--extension', provider);
      // Preserve command, cwd, stdio, isolated environment and every original argument.
      const child = real.spawn(command, appended, options);
      const evidence = {
        ready: false,
        read: false,
        proposed: false,
        waiting: false,
        failed: false,
        modelError: false,
      };
      launch.evidence.push(evidence);
      let output = '';
      child.stdout!.on('data', chunk => {
        output += chunk.toString();
        while (output.includes('\n')) {
          const index = output.indexOf('\n');
          const line = output.slice(0, index);
          output = output.slice(index + 1);
          try {
            const record = JSON.parse(line);
            if (record.type === 'extension_ui_request' && record.title === 'umami-host-tool') {
              const tool = JSON.parse(record.placeholder);
              if (tool.name === 'analytics_summary') launch.reads.push(tool.args.websiteId);
            }
          } catch {
            /* Runtime owns protocol validation; no payload is logged. */
          }
        }
      });
      let diagnostics = '';
      child.stderr!.on('data', chunk => {
        diagnostics = (diagnostics + chunk.toString()).slice(-4096);
        for (const key of Object.keys(evidence) as (keyof typeof evidence)[])
          evidence[key] ||= diagnostics.includes(`LEGACY_TEST:${key}\n`);
        if (evidence.waiting) launch.onLaunch?.();
      });
      launch.closed.push(
        new Promise<void>(resolveClose => child.once('close', () => resolveClose())),
      );
      launch.count++;
      launch.homes.push(String(options?.cwd));
      return child;
    },
  };
});

const enabled = !!process.env.AI_PI_ROOT && process.env.AI_INTEGRATION === '1';
const database = 'postgresql://ai_synthetic@127.0.0.1:25432/ai_synthetic?schema=integration';
let client: any;
let POST: (request: Request) => Promise<Response>;
let createSecureToken: any;
let secret: any;
const owner = randomUUID();
const outsider = randomUUID();
const websiteId = randomUUID();
const deniedId = randomUUID();
const draft = {
  websiteId,
  rows: [
    {
      id: 'row',
      columns: [{ id: 'col', component: { type: 'TextBlock', props: { text: 'Original' } } }],
    },
  ],
};
const users: string[] = [];

async function request(
  mode = 'success',
  body: any = {},
  signal?: AbortSignal,
  authenticated = true,
  readId = websiteId,
) {
  const userId = randomUUID();
  users.push(userId);
  await client.user.create({
    data: { id: userId, username: userId, password: 'synthetic', role: 'user' },
  });
  // Each actual session user owns this fixture website; no admin/alltrue authorization shortcut.
  await client.website.update({ where: { id: websiteId }, data: { userId } });
  const token = createSecureToken({ userId }, secret());
  return POST(
    new Request('http://localhost/api/ai/boards/chat', {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: JSON.stringify({ mode, websiteId: readId, deniedId }) },
        ],
        ...body,
      }),
    }),
  );
}

beforeAll(async () => {
  if (!enabled) return;
  vi.stubEnv('DATABASE_URL', database);
  vi.stubEnv('DATABASE_REPLICA_URL', '');
  vi.stubEnv('APP_SECRET', 'offline-integration-only');
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('CLICKHOUSE_URL', '');
  vi.stubEnv('AI_ENABLED', 'true');
  vi.stubEnv('AI_PROVIDER', 'umami-synthetic');
  vi.stubEnv('AI_MODEL', 'offline');
  vi.stubEnv('AI_BASE_URL', 'https://synthetic.invalid');
  vi.stubEnv('AI_REASONING_LEVEL', 'medium');
  vi.stubEnv('AI_PROVIDER_KEY', 'synthetic-not-a-credential');
  vi.stubEnv('AI_EGRESS_ORIGINS', 'https://synthetic.invalid');
  const prisma = await import('@/lib/prisma');
  client = await prisma.default.client;
  const marker = await client.$queryRawUnsafe('select owner from public.ai_synthetic_owner');
  expect(marker).toEqual([{ owner: 'umami-ai-synthetic-r3' }]);
  launch.baseline = {
    boards: await client.board.findMany(),
    reports: await client.report.findMany(),
  };
  ({ POST } = await import('@/app/api/ai/boards/chat/route'));
  ({ createSecureToken } = await import('@/lib/jwt'));
  ({ secret } = await import('@/lib/crypto'));
  await client.user.createMany({
    data: [owner, outsider].map(id => ({ id, username: id, password: 'synthetic', role: 'user' })),
  });
  await client.website.createMany({
    data: [
      { id: websiteId, name: 'Synthetic authorized', userId: owner },
      { id: deniedId, name: 'Synthetic denied', userId: outsider },
    ],
  });
  const sessionId = randomUUID();
  await client.session.create({
    data: { id: sessionId, websiteId, createdAt: new Date(Date.now() - 60_000) },
  });
  await client.websiteEvent.create({
    data: {
      id: randomUUID(),
      websiteId,
      sessionId,
      visitId: randomUUID(),
      eventType: 1,
      urlPath: '/',
      createdAt: new Date(Date.now() - 60_000),
    },
  });
});
afterAll(async () => {
  if (client) {
    await Promise.all(launch.closed);
    expect(launch.evidence.every(e => !e.failed)).toBe(true);
    await vi.waitFor(() => expect(launch.homes.every(home => !existsSync(home))).toBe(true));
    expect({
      boards: await client.board.findMany(),
      reports: await client.report.findMany(),
    }).toEqual(launch.baseline);
    await client.websiteEvent.deleteMany({ where: { websiteId } });
    await client.session.deleteMany({ where: { websiteId } });
    await client.website.deleteMany({ where: { id: { in: [websiteId, deniedId] } } });
    await client.user.deleteMany({ where: { id: { in: [owner, outsider, ...users] } } });
    await client.$disconnect();
  }
  vi.unstubAllEnvs();
});

describe.skipIf(!enabled)(
  'actual POST + session/RBAC/SQL + native Pi RPC (test launch extension)',
  () => {
    it('authenticates real encrypted session tokens, reads analytics and proposes from an empty new baseline; refines without persistence', async () => {
      const before = {
        boards: await client.board.findMany(),
        reports: await client.report.findMany(),
      };
      const first = await request();
      expect(first.status).toBe(200);
      const result = await first.json();
      expect(result.draft.rows[0].columns[0].component.props.text).toBe('One authorized pageview');
      const refined = await request('success', { draft });
      expect(refined.status).toBe(200);
      expect((await refined.json()).draft.rows[0].columns[0].component.props.text).toBe(
        'Refined after one pageview',
      );
      expect(draft.rows[0].columns[0].component.props.text).toBe('Original');
      expect({
        boards: await client.board.findMany(),
        reports: await client.report.findMany(),
      }).toEqual(before);
      expect(launch.count).toBe(2);
      expect(launch.evidence).toEqual(
        [0, 1].map(() => ({
          ready: true,
          read: true,
          proposed: true,
          waiting: false,
          failed: false,
          modelError: false,
        })),
      );
      expect(launch.homes.every(home => !existsSync(home))).toBe(true);
    }, 30000);
    it('rejects unexpected launch paths and arguments without starting a child', async () => {
      const { spawn } = await import('node:child_process');
      const before = launch.count;
      expect(() => spawn('unexpected', [])).toThrow();
      expect(() => spawn(process.execPath, [resolve('scripts/ai/native.mjs')])).toThrow();
      const { command, args, options } = launch.invocation;
      // Keep permissionArgs' realpath precondition valid: failures must be guard assertions,
      // not ENOENT from an already-removed turn HOME.
      mkdirSync(options.cwd);
      try {
        for (const [flag, value] of [
          ['--extension', '/tmp/untrusted.mjs'],
          ['--provider', 'injected'],
          ['--model', 'injected'],
          ['--thinking', 'off'],
        ]) {
          const changed = [...args];
          changed[changed.indexOf(flag) + 1] = value;
          expect(() => spawn(command, changed, options)).toThrow(assert.AssertionError);
        }
        expect(() => spawn(command, [...args, '--allow-child-process'], options)).toThrow(
          assert.AssertionError,
        );
        expect(() =>
          spawn(
            command,
            args.filter((a: string) => a !== '--permission'),
            options,
          ),
        ).toThrow(assert.AssertionError);
        expect(() =>
          spawn(command, args, { ...options, env: { ...options.env, NODE_OPTIONS: '--inspect' } }),
        ).toThrow(assert.AssertionError);
        expect(() => spawn(command, args, { ...options, shell: true })).toThrow(
          assert.AssertionError,
        );
        expect(launch.count).toBe(before);
      } finally {
        rmSync(options.cwd, { recursive: true });
      }
    });
    it('rejects missing authentication and unauthorized draft references before launch', async () => {
      const before = launch.count;
      expect((await request('success', {}, undefined, false)).status).toBe(401);
      const deniedDraft = {
        websiteId: deniedId,
        rows: [{ id: 'r', columns: [{ id: 'c', component: { type: 'WebsiteChart' } }] }],
      };
      expect((await request('success', { draft: deniedDraft })).status).toBe(403);
      expect(launch.count).toBe(before);
      expect((await request('success', {}, undefined, true, deniedId)).status).toBe(502);
      expect(launch.count).toBe(before + 1);
      expect(launch.evidence.at(-1)).toMatchObject({
        ready: true,
        read: false,
        proposed: false,
        failed: false,
      });
      expect(launch.reads.at(-1)).toBe(deniedId);
      expect((await request('denied-proposal')).status).toBe(403);
      expect(launch.count).toBe(before + 2);
      expect(launch.evidence.at(-1)).toMatchObject({ read: true, proposed: true, failed: false });
      expect((await request('success', { provider: 'injected' })).status).toBe(400);
      expect((await request('success', { model: 'injected' })).status).toBe(400);
      expect(launch.count).toBe(before + 2);
    });
    it('fails closed on actual synthetic model errors and cancels a native turn', async () => {
      const before = launch.count;
      expect((await request('error')).status).toBe(502);
      expect(launch.count).toBe(before + 1);
      const controller = new AbortController();
      expect(launch.evidence.at(-1)).toMatchObject({
        ready: true,
        modelError: true,
        failed: false,
      });
      launch.onLaunch = () => controller.abort();
      try {
        expect((await request('wait', {}, controller.signal)).status).toBe(499);
        expect(launch.count).toBe(before + 2);
        expect(launch.evidence.at(-1)).toMatchObject({ ready: true, waiting: true, failed: false });
      } finally {
        launch.onLaunch = undefined;
      }
    }, 15000);
  },
);
