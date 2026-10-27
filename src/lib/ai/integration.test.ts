// @vitest-environment node
// TEST composition intercepts only native launch argv; all application/CLI behavior stays real.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const launch = vi.hoisted(() => ({
  count: 0,
  homes: [] as string[],
  onLaunch: undefined as undefined | (() => void),
  closed: [] as Promise<void>[],
  baseline: undefined as any,
}));
vi.mock('node:child_process', async importOriginal => {
  const real: typeof import('node:child_process') = await importOriginal();
  return {
    ...real,
    spawn: (
      command: string,
      args: string[],
      options: import('node:child_process').SpawnOptions,
    ) => {
      assert.equal(command, process.execPath);
      assert.ok(Array.isArray(args));
      assert.equal(args[0], resolve('scripts/ai/native.mjs'));
      assert.equal(args.filter(a => a === '--extension').length, 1);
      assert.equal(args[args.indexOf('--extension') + 1], resolve('scripts/ai/host-tools.mjs'));
      assert.equal(options?.env?.AI_PROVIDER, 'umami-synthetic');
      assert.equal(options?.env?.NODE_ENV, 'production');
      assert.deepEqual(args.slice(1, 18), [
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
      ]);
      assert.equal(args[18], 'offline');
      assert.equal(args[19], '--system-prompt');
      assert.equal(args.length, 21);
      const appended = [...args, '--extension', resolve('scripts/ai/integration/provider.mjs')];
      // Preserve command, cwd, stdio, isolated environment and every original argument.
      const child = real.spawn(command, appended, options);
      launch.closed.push(
        new Promise<void>(resolveClose => child.once('close', () => resolveClose())),
      );
      launch.count++;
      launch.homes.push(String(options?.cwd));
      launch.onLaunch?.();
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
    data: { id: sessionId, websiteId, createdAt: new Date('2024-01-01T12:00:00Z') },
  });
  await client.websiteEvent.create({
    data: {
      id: randomUUID(),
      websiteId,
      sessionId,
      visitId: randomUUID(),
      eventType: 1,
      urlPath: '/',
      createdAt: new Date('2024-01-01T12:00:00Z'),
    },
  });
});
afterAll(async () => {
  if (client) {
    await Promise.all(launch.closed);
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
      expect(launch.homes.every(home => !existsSync(home))).toBe(true);
    }, 30000);
    it('rejects unexpected launch paths and arguments without starting a child', async () => {
      const { spawn } = await import('node:child_process');
      const before = launch.count;
      expect(() => spawn('unexpected', [])).toThrow();
      expect(() => spawn(process.execPath, [resolve('scripts/ai/native.mjs')])).toThrow();
      expect(launch.count).toBe(before);
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
      expect((await request('denied-proposal')).status).toBe(403);
      expect(launch.count).toBe(before + 2);
    });
    it('fails closed on actual synthetic model errors and cancels a native turn', async () => {
      const before = launch.count;
      expect((await request('error')).status).toBe(502);
      expect(launch.count).toBe(before + 1);
      const controller = new AbortController();
      launch.onLaunch = () => setTimeout(() => controller.abort(), 1000);
      try {
        expect((await request('wait', {}, controller.signal)).status).toBe(499);
      } finally {
        launch.onLaunch = undefined;
      }
    }, 15000);
  },
);
