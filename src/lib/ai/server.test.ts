// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({ checkAuth: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ default: {} }));
vi.mock('@/lib/entity', () => ({ getEntity: vi.fn() }));
vi.mock('./discovery', () => ({ discoverAnalytics: vi.fn() }));
// Endpoint tests isolate DB plumbing; query.test.ts exercises scoped clients separately.
const dbScope = vi.hoisted(() => ({ active: 0 }));
vi.mock('./query', () => ({
  withAiRead: async (work: () => Promise<unknown>) => {
    dbScope.active++;
    try {
      return await work();
    } finally {
      dbScope.active--;
    }
  },
}));
vi.mock('@/lib/request', () => ({
  getQueryFilters: vi.fn(async () => ({
    startDate: new Date(0),
    endDate: new Date(1),
    unit: 'day',
  })),
}));
vi.mock('@/permissions/board', () => ({ canUpdateBoard: vi.fn(), canViewBoardEntities: vi.fn() }));
vi.mock('@/permissions/website', () => ({ canViewWebsite: vi.fn() }));
vi.mock('@/queries/prisma', () => ({
  getBoard: vi.fn(),
  getWebsite: vi.fn(),
  getTeamUser: vi.fn(),
}));
vi.mock('@/queries/sql', () => ({
  getWebsiteStats: vi.fn(),
  getPageviewMetrics: vi.fn(),
  getPageviewStats: vi.fn(),
}));
vi.mock('./runtime', async () => ({
  ...(await vi.importActual('./rpc/contract')),
  runAiTurn: vi.fn(() => {
    throw new Error('No provider calls');
  }),
}));

import { checkAuth } from '@/lib/auth';
import { canUpdateBoard, canViewBoardEntities } from '@/permissions/board';
import { canViewWebsite } from '@/permissions/website';
import { getBoard, getWebsite, getTeamUser } from '@/queries/prisma';
import { getEntity } from '@/lib/entity';
import { getPageviewMetrics, getPageviewStats, getWebsiteStats } from '@/queries/sql';
import type { AiTurn } from './runtime';
import { handleAiChat } from './server';
import { discoverAnalytics } from './discovery';
import { POST } from '@/app/api/ai/boards/chat/route';

const site = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const boardId = '33333333-3333-4333-8333-333333333333';
const draft = {
  websiteId: site,
  rows: [{ id: 'row', columns: [{ id: 'col', component: { type: 'WebsiteChart' } }] }],
};
const messages = [{ role: 'user', content: 'Show traffic' }];
const args = { websiteId: site, startAt: 1, endAt: 86_400_000 };
const ok = async () => ({ message: 'Suggested board', draft });
function request(body: unknown = { messages, draft }, signal?: AbortSignal) {
  return new Request('http://localhost/api/ai/boards/chat', {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  });
}
async function tool(name = 'analytics_summary', values: Record<string, unknown> = args) {
  return handleAiChat(request(), async input => {
    await input.executeTool(
      name as Parameters<AiTurn['executeTool']>[0],
      name === 'analytics_discover' && values === args
        ? { ...args, startAt: Date.now() - 1000, endAt: Date.now() - 1 }
        : values,
    );
    return ok();
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('AI_ENABLED', 'true');
  vi.mocked(checkAuth).mockResolvedValue({
    user: { id: crypto.randomUUID() },
    authType: 'session',
  } as any);
  vi.mocked(canUpdateBoard).mockResolvedValue(true);
  vi.mocked(canViewBoardEntities).mockResolvedValue(true);
  vi.mocked(canViewWebsite).mockResolvedValue(true);
  vi.mocked(getWebsite).mockResolvedValue({ id: site } as any);
  vi.mocked(getBoard).mockResolvedValue({ id: boardId, type: 'website', parameters: draft } as any);
  vi.mocked(getWebsiteStats).mockResolvedValue({ pageviews: 5 } as any);
  vi.mocked(getPageviewMetrics).mockResolvedValue([{ x: '/hello', y: 2 }]);
  vi.mocked(getPageviewStats).mockResolvedValue([{ x: '2020-01-01', y: 2 }]);
});

describe('permission-safe AI board staging', () => {
  it('discovers only through scoped authorization and rechecks before delivery', async () => {
    vi.mocked(discoverAnalytics).mockImplementation(async () => {
      expect(dbScope.active).toBeGreaterThan(0);
      return {
        events: [],
        properties: [],
        truncated: { events: false, properties: false },
        coverage: 'unavailable',
      };
    });
    expect((await tool('analytics_discover')).status).toBe(200);
    expect(discoverAnalytics).toHaveBeenCalledOnce();
    expect(canViewWebsite).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.anything() }),
      site,
    );
  });
  it.each([
    ['other user', { userId: 'someone-else' }, false],
    ['team without membership', { teamId: 'team' }, false],
    ['team member', { teamId: 'team' }, true],
  ])(
    'uses real user-only website permissions for discovery: %s',
    async (_label, entity, allowed) => {
      const real =
        await vi.importActual<typeof import('@/permissions/website')>('@/permissions/website');
      vi.mocked(canViewWebsite).mockImplementation(real.canViewWebsite);
      vi.mocked(getEntity).mockResolvedValue(entity as any);
      vi.mocked(getTeamUser).mockResolvedValue(allowed ? ({ id: 'member' } as any) : null);
      vi.mocked(discoverAnalytics).mockResolvedValue({ events: [], properties: [] } as any);
      expect((await tool('analytics_discover')).status).toBe(allowed ? 200 : 403);
      expect(discoverAnalytics).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );
  it('denies nonexistent sites even with real administrator permission', async () => {
    const real =
      await vi.importActual<typeof import('@/permissions/website')>('@/permissions/website');
    vi.mocked(canViewWebsite).mockImplementation(real.canViewWebsite);
    vi.mocked(checkAuth).mockResolvedValue({
      user: { id: crypto.randomUUID(), isAdmin: true },
      authType: 'session',
    } as any);
    vi.mocked(getWebsite).mockResolvedValue(null);
    expect((await tool('analytics_discover')).status).toBe(403);
    expect(discoverAnalytics).not.toHaveBeenCalled();
  });
  it('denies revocation immediately after discovery', async () => {
    vi.mocked(discoverAnalytics).mockImplementation(async () => {
      vi.mocked(canViewWebsite).mockResolvedValue(false);
      return { events: [], properties: [] } as any;
    });
    expect((await tool('analytics_discover')).status).toBe(403);
  });
  it('denies revocation between discovery and final delivery', async () => {
    vi.mocked(discoverAnalytics).mockResolvedValue({ events: [], properties: [] } as any);
    const res = await handleAiChat(request(), async input => {
      await input.executeTool('analytics_discover', {
        ...args,
        startAt: Date.now() - 1000,
        endAt: Date.now() - 1,
      });
      vi.mocked(canViewWebsite).mockResolvedValue(false);
      return { message: 'Do not deliver this.' };
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('Do not deliver');
  });
  it('rejects discovery outside the selected context and its date bounds', async () => {
    expect((await tool('analytics_discover', { ...args })).status).toBe(400);
    vi.mocked(checkAuth).mockResolvedValue({
      user: { id: crypto.randomUUID() },
      authType: 'session',
    } as any);
    expect(
      (
        await tool('analytics_discover', {
          ...args,
          websiteId: other,
          startAt: Date.now() - 1000,
          endAt: Date.now() - 1,
        })
      ).status,
    ).toBe(400);
    expect(discoverAnalytics).not.toHaveBeenCalled();
  });
  it('returns validated questions to JSON clients', async () => {
    const questions = [{ id: 'login', question: 'Which event means a successful login?' }];
    const res = await handleAiChat(request(), async () => ({
      message: 'Please clarify.',
      questions,
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Please clarify.', questions });
  });
  it('streams only fixed progress and one validated terminal result after authorization', async () => {
    const req = request();
    req.headers.set('accept', 'text/event-stream');
    const res = await handleAiChat(req, async input => {
      input.onEvent?.({ type: 'progress', phase: 'start' });
      input.onEvent?.({ type: 'progress', phase: 'complete' });
      input.onEvent?.({ type: 'result', result: { message: 'secret premature' } });
      return {
        message: 'Choose a login event.',
        questions: [{ id: 'event', question: 'Which event?' }],
      };
    });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const frames = (await res.text())
      .trim()
      .split('\n\n')
      .map(frame => JSON.parse(frame.split('\ndata: ')[1]));
    expect(frames).toEqual([
      { type: 'progress', phase: 'start' },
      { type: 'progress', phase: 'complete' },
      {
        type: 'result',
        result: {
          message: 'Choose a login event.',
          questions: [{ id: 'event', question: 'Which event?' }],
        },
      },
    ]);
  });
  it('streams a safe error for malformed questions without a result', async () => {
    const req = request();
    req.headers.set('accept', 'text/event-stream');
    const res = await handleAiChat(req, async () => ({
      message: 'test',
      questions: [{ id: '__proto__', question: 'secret' }],
    }));
    const body = await res.text();
    expect(body).toContain('event: error');
    expect(body).not.toContain('event: result');
    expect(body).not.toContain('secret');
  });
  it('bounds progress floods and oversized UTF-8 stream output', async () => {
    const req = request();
    req.headers.set('accept', 'text/event-stream');
    const res = await handleAiChat(req, async input => {
      for (let n = 0; n < 1000; n++) input.onEvent?.({ type: 'progress', phase: 'read' });
      return { message: '😀'.repeat(40000) };
    });
    const body = await res.text();
    expect(Buffer.byteLength(body)).toBeLessThan(2000);
    expect(body).toContain('event: error');
    expect(body).not.toContain('event: result');
    expect(body.match(/event: progress/g)?.length ?? 0).toBeLessThanOrEqual(20);
  });
  it('forwards request disconnection to streaming runtime without late writes', async () => {
    const controller = new AbortController();
    const req = request(undefined, controller.signal);
    req.headers.set('accept', 'text/event-stream');
    let stopped: Promise<void>;
    const res = await handleAiChat(req, async input => {
      stopped = new Promise(resolve =>
        input.signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
      await stopped;
      input.onEvent?.({ type: 'progress', phase: 'read' });
      return { message: 'late' };
    });
    controller.abort();
    await stopped!;
    expect(await res.text()).toBe('');
  });
  it('keeps oversized streaming bodies as JSON before headers', async () => {
    const req = request({ messages: [{ role: 'user', content: 'a'.repeat(40000) }] });
    req.headers.set('accept', 'text/event-stream');
    const res = await handleAiChat(req);
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toBe('application/json');
  });
  it('reauthorizes again after backpressure before emitting complete or result', async () => {
    const req = request();
    req.headers.set('accept', 'text/event-stream');
    let generated = () => {};
    const ready = new Promise<void>(resolve => {
      generated = resolve;
    });
    const res = await handleAiChat(req, async input => {
      input.onEvent?.({ type: 'progress', phase: 'start' });
      generated();
      return { message: 'withhold' };
    });
    await ready;
    await new Promise(resolve => setImmediate(resolve));
    vi.mocked(canViewWebsite).mockResolvedValue(false);
    const body = await res.text();
    expect(body).toContain('event: error');
    expect(body).not.toContain('event: result');
    expect(body).not.toContain('"phase":"complete"');
    expect(body).not.toContain('withhold');
  });
  it('delivers exactly one safe host-deadline error, including under backpressure, and releases admission', async () => {
    vi.mocked(checkAuth).mockImplementation(
      async () => ({ user: { id: crypto.randomUUID() }, authType: 'session' }) as any,
    );
    let stopped = 0;
    const pending = async (input: AiTurn) => {
      await new Promise<void>(resolve =>
        input.signal!.addEventListener(
          'abort',
          () => {
            stopped++;
            resolve();
          },
          { once: true },
        ),
      );
      throw new Error('private runtime failure');
    };
    const req = request();
    req.headers.set('accept', 'text/event-stream');
    const reading = await handleAiChat(req, pending);
    const bodyPromise = reading.text();
    const slowReq = request();
    slowReq.headers.set('accept', 'text/event-stream');
    let slowDeadline: Promise<void> = Promise.resolve();
    const slow = await handleAiChat(slowReq, async input => {
      slowDeadline = new Promise(resolve =>
        input.signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
      input.onEvent?.({ type: 'progress', phase: 'start' });
      return { message: 'Never deliver after deadline.' };
    });
    const body = await bodyPromise; // Real 45-second host deadline, no timer/limit mocks.
    await slowDeadline;
    const slowBody = await slow.text();
    for (const text of [body, slowBody]) {
      expect(text.match(/event: error/g)).toHaveLength(1);
      expect(text).not.toContain('event: result');
      expect(text).not.toContain('private');
    }
    expect(stopped).toBe(1);
    await new Promise(resolve => setImmediate(resolve));
    expect((await handleAiChat(request(), ok)).status).toBe(200);
    expect(dbScope.active).toBe(0);
  }, 55000);
  it('keeps unauthenticated stream requests as JSON before headers', async () => {
    vi.mocked(checkAuth).mockResolvedValue(null);
    const req = request();
    req.headers.set('accept', 'text/event-stream');
    const res = await handleAiChat(req);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/json');
  });
  it('propagates stream cancellation to the runtime', async () => {
    const req = request();
    req.headers.set('accept', 'text/event-stream');
    let stopped: Promise<void>;
    const res = await handleAiChat(req, async input => {
      stopped = new Promise(resolve =>
        input.signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
      await stopped;
      throw new Error('cancelled');
    });
    await res.body!.cancel();
    await stopped!;
  });
  it('passes authorized board-only context and host date bounds without trusting user text', async () => {
    const before = Date.now();
    const runtime = vi.fn(async (input: AiTurn) => {
      expect(input.draft).toEqual(draft);
      expect(input.context?.websiteIds).toEqual([site]);
      expect(input.context?.now).toBeGreaterThanOrEqual(before);
      expect(input.context?.endAt).toBe(input.context?.now);
      expect(input.context!.endAt - input.context!.startAt).toBe(30 * 86_400_000);
      return ok();
    });
    expect((await handleAiChat(request({ boardId, messages }), runtime)).status).toBe(200);
    expect(runtime).toHaveBeenCalledOnce();
  });
  it('passes no fabricated website or draft when no selection exists', async () => {
    const runtime = vi.fn(async (input: AiTurn) => {
      expect(input.context?.websiteIds).toEqual([]);
      expect(input.draft).toBeUndefined();
      return { message: 'Select a website first.' };
    });
    expect((await handleAiChat(request({ messages }), runtime)).status).toBe(200);
  });
  it('denies revoked board references on the pre-egress authorization', async () => {
    vi.mocked(canViewWebsite).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const runtime = vi.fn(ok);
    expect((await handleAiChat(request({ boardId, messages }), runtime)).status).toBe(403);
    expect(runtime).not.toHaveBeenCalled();
  });
  it('returns useful disabled status from the real route without native calls', async () => {
    vi.stubEnv('AI_ENABLED', 'false');
    expect((await POST(request())).status).toBe(503);
    expect(checkAuth).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { shareToken: { websiteId: site } },
    { user: { id: 'api' }, authType: 'api-key' },
  ])('denies non-session authority %j', async auth => {
    vi.mocked(checkAuth).mockResolvedValue(auth as any);
    expect((await handleAiChat(request(), ok)).status).toBe(401);
  });
  it.each(['userId', 'teamId', 'credentials', 'system'])('rejects forged %s', async key => {
    expect((await handleAiChat(request({ messages, [key]: 'forged' }), ok)).status).toBe(400);
  });
  it('rejects system messages and message extra keys', async () => {
    expect(
      (await handleAiChat(request({ messages: [{ role: 'system', content: 'admin' }] }), ok))
        .status,
    ).toBe(400);
  });
  it('rejects raw oversized bodies, even without Content-Length', async () => {
    expect((await handleAiChat(request({ messages, padding: 'x'.repeat(33000) }), ok)).status).toBe(
      413,
    );
  });
  it('denies cross-team board editing', async () => {
    vi.mocked(canUpdateBoard).mockResolvedValue(false);
    expect((await handleAiChat(request({ messages, draft, boardId }), ok)).status).toBe(403);
  });
  it('checks existence even with admin permission bypass', async () => {
    vi.mocked(getBoard).mockResolvedValue(null);
    expect((await handleAiChat(request({ messages, boardId }), ok)).status).toBe(403);
  });
  it('uses only user authority, discarding authenticated share context', async () => {
    const user = { id: crypto.randomUUID() };
    vi.mocked(checkAuth).mockResolvedValue({ user, shareToken: { websiteId: site } } as any);
    expect((await handleAiChat(request(), ok)).status).toBe(200);
    expect(canViewWebsite).toHaveBeenCalledWith({ user }, site);
  });
  it('denies unauthorized input references without invoking runtime', async () => {
    vi.mocked(canViewWebsite).mockResolvedValue(false);
    const runtime = vi.fn(ok);
    expect((await handleAiChat(request(), runtime)).status).toBe(403);
    expect(runtime).not.toHaveBeenCalled();
  });
  it('checks existence of websites even if permissions return true', async () => {
    vi.mocked(getWebsite).mockResolvedValue(null);
    expect((await tool()).status).toBe(403);
    expect(getWebsiteStats).not.toHaveBeenCalled();
  });
  it.each([
    ['analytics_summary', { ...args, userId: 'admin' }],
    ['analytics_summary', { ...args, filter: 'raw sql' }],
    ['analytics_summary', { ...args, endAt: 40 * 86_400_000 }],
    ['analytics_summary', { ...args, startAt: '0' }],
    ['analytics_breakdown', { ...args, dimension: 'path; drop', limit: 5 }],
    ['analytics_breakdown', { ...args, dimension: 'path', limit: 500 }],
    ['analytics_timeseries', { ...args, metric: 'revenue', unit: 'minute' }],
    ['save_board', args],
  ])('rejects strict tool arguments %s %j', async (name, values) => {
    expect((await tool(name, values)).status).toBe(400);
    expect(getWebsiteStats).not.toHaveBeenCalled();
    expect(getPageviewMetrics).not.toHaveBeenCalled();
  });
  it('dispatches bounded breakdown and daily timeseries', async () => {
    expect(
      (await tool('analytics_breakdown', { ...args, dimension: 'path', limit: 5 })).status,
    ).toBe(200);
    expect(getPageviewMetrics).toHaveBeenCalledWith(
      site,
      { type: 'path', limit: 5, offset: 0 },
      expect.anything(),
    );
    vi.mocked(checkAuth).mockResolvedValue({ user: { id: crypto.randomUUID() } } as any);
    expect(
      (await tool('analytics_timeseries', { ...args, metric: 'pageviews', unit: 'day' })).status,
    ).toBe(200);
    expect(getPageviewStats).toHaveBeenCalled();
  });
  it('reauthorizes every tool website independently of draft scope', async () => {
    vi.mocked(canViewWebsite).mockImplementation(async (_, id) => id === site);
    expect((await tool('analytics_summary', { ...args, websiteId: other })).status).toBe(403);
    expect(getWebsiteStats).not.toHaveBeenCalled();
  });
  it('withholds read data if permission revoked during query', async () => {
    vi.mocked(getWebsiteStats).mockImplementation(async () => {
      vi.mocked(canViewWebsite).mockResolvedValue(false);
      return { secret: 'never release' } as any;
    });
    const result = await tool();
    expect(result.status).toBe(403);
    expect(await result.text()).not.toContain('never release');
  });
  it('reauthorizes current board on each read', async () => {
    const result = await handleAiChat(request({ boardId, messages, draft }), async input => {
      vi.mocked(canUpdateBoard).mockResolvedValue(false);
      await input.executeTool('analytics_summary', args);
      return ok();
    });
    expect(result.status).toBe(403);
    expect(getWebsiteStats).not.toHaveBeenCalled();
  });
  it('reauthorizes final draft and current board', async () => {
    const result = await handleAiChat(request({ boardId, messages, draft }), async () => {
      vi.mocked(canUpdateBoard).mockResolvedValue(false);
      return ok();
    });
    expect(result.status).toBe(403);
  });
  it('reauthorizes previously read websites even when absent from final draft', async () => {
    vi.mocked(canViewWebsite).mockResolvedValue(true);
    const result = await handleAiChat(request(), async input => {
      await input.executeTool('analytics_summary', { ...args, websiteId: other });
      vi.mocked(canViewWebsite).mockImplementation(async (_, id) => id !== other);
      return ok();
    });
    expect(result.status).toBe(403);
  });
  it('denies newly introduced final references', async () => {
    vi.mocked(canViewWebsite).mockImplementation(async (_, id) => id === site);
    expect(
      (
        await handleAiChat(request(), async () => ({
          message: 'Proposal',
          draft: { ...draft, websiteId: other },
        }))
      ).status,
    ).toBe(403);
  });
  it.each(['pixel', 'link'])('explicitly denies %s board types', async type => {
    vi.mocked(getBoard).mockResolvedValue({ type, parameters: {} } as any);
    expect((await handleAiChat(request({ boardId, messages }), ok)).status).toBe(400);
  });
  it.each(['mixed', 'dashboard'])('supports website-only drafts for %s boards', async type => {
    vi.mocked(getBoard).mockResolvedValue({ type, parameters: {} } as any);
    expect((await handleAiChat(request({ boardId, messages, draft }), ok)).status).toBe(200);
  });
  it('prevents changing website board root selection', async () => {
    expect(
      (
        await handleAiChat(request({ boardId, messages, draft }), async () => ({
          message: 'Proposal',
          draft: { ...draft, websiteId: other },
        }))
      ).status,
    ).toBe(400);
  });
  it('enforces output bounds and safe errors', async () => {
    vi.mocked(getWebsiteStats).mockResolvedValue({ x: 'secret'.repeat(6000) } as any);
    const result = await tool();
    expect(result.status).toBe(502);
    expect(await result.text()).not.toContain('secret');
  });
  it('cannot swallow denied tools to return a partial proposal', async () => {
    const result = await handleAiChat(request(), async input => {
      await input.executeTool('analytics_summary', { ...args, userId: 'forged' }).catch(() => {});
      return ok();
    });
    expect(result.status).toBe(400);
  });
  it('passes cancellation and exposes no persistence callbacks', async () => {
    const controller = new AbortController();
    const result = await handleAiChat(request(undefined, controller.signal), async input => {
      expect(Object.keys(input).sort()).toEqual([
        'context',
        'draft',
        'executeTool',
        'messages',
        'onEvent',
        'signal',
      ]);
      controller.abort();
      expect(input.signal.aborted).toBe(true);
      return ok();
    });
    expect(result.status).toBe(499);
  });
  it('enforces the eight-read budget', async () => {
    const result = await handleAiChat(request(), async input => {
      for (let i = 0; i < 9; i++) await input.executeTool('analytics_summary', args);
      return ok();
    });
    expect(result.status).toBe(429);
    expect(getWebsiteStats).toHaveBeenCalledTimes(8);
  });
  it('rejects concurrent reads without leaking a partial proposal', async () => {
    const result = await handleAiChat(request(), async input => {
      await Promise.allSettled([
        input.executeTool('analytics_summary', args),
        input.executeTool('analytics_summary', args),
      ]);
      return ok();
    });
    expect(result.status).toBe(429);
    expect(getWebsiteStats).toHaveBeenCalledTimes(1);
  });
  it('enforces a host deadline for queries and discards late results', async () => {
    let resolveQuery: (value: any) => void;
    vi.mocked(getWebsiteStats).mockImplementation(
      () =>
        new Promise(resolve => {
          resolveQuery = resolve;
        }),
    );
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(ms => nativeTimeout(ms === 10_000 ? 50 : ms));
    try {
      const result = await tool();
      expect(result.status).toBe(504);
      expect(await result.text()).not.toContain('pageviews');
      resolveQuery!({ pageviews: 5 });
      // Let the abandoned work settle and release its held query admission slot.
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      timeout.mockRestore();
    }
  });
  it('scopes auth, permissions, helper filters and SQL but never model generation', async () => {
    const assertScoped = async () => {
      expect(dbScope.active).toBe(1);
      return true;
    };
    vi.mocked(canViewWebsite).mockImplementation(assertScoped);
    vi.mocked(canViewBoardEntities).mockImplementation(assertScoped);
    vi.mocked(getWebsiteStats).mockImplementation(async () => {
      expect(dbScope.active).toBe(1);
      return { pageviews: 1 } as any;
    });
    const result = await handleAiChat(request(), async input => {
      expect(dbScope.active).toBe(0);
      await input.executeTool('analytics_summary', args);
      expect(dbScope.active).toBe(0);
      return ok();
    });
    expect(result.status).toBe(200);
    expect(dbScope.active).toBe(0);
  });
  it('bounds serialized UTF-8 output rather than draft code units', async () => {
    const proposal = {
      rows: Array.from({ length: 7 }, (_, i) => ({
        id: `r${i}`,
        columns: [
          {
            id: `c${i}`,
            component: {
              type: 'TextBlock',
              props: { text: '界'.repeat(4000) },
            },
          },
        ],
      })),
    };
    const result = await handleAiChat(request({ messages }), async () => ({
      message: '好',
      draft: proposal,
    }));
    expect(result.status).toBe(502);
    expect(Buffer.byteLength(await result.text())).toBeLessThanOrEqual(32768);
  });
  it.each([32767, 32768, 32769])(
    'bounds exact serialized multibyte message/draft bytes %i',
    async bytes => {
      const proposal = {
        rows: Array.from({ length: 8 }, (_, i) => ({
          id: `r${i}`,
          columns: [
            {
              id: `c${i}`,
              component: {
                type: 'TextBlock',
                props: { text: 'a'.repeat(3700) },
              },
            },
          ],
        })),
      };
      const message = '界'.repeat(500);
      const base = Buffer.byteLength(JSON.stringify({ message, draft: proposal }));
      let padding = bytes - base;
      for (const row of proposal.rows) {
        const add = Math.min(padding, 300);
        row.columns[0].component.props.text += 'x'.repeat(add);
        padding -= add;
      }
      expect(padding).toBe(0);
      const result = await handleAiChat(request({ messages }), async () => ({
        message,
        draft: proposal,
      }));
      expect(result.status).toBe(bytes <= 32768 ? 200 : 502);
      const body = await result.text();
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(32768);
      if (result.status === 200) expect(Buffer.byteLength(body)).toBe(bytes);
    },
  );
  it('rate limits per authenticated user', async () => {
    expect((await handleAiChat(request(), ok)).status).toBe(200);
    expect((await handleAiChat(request(), ok)).status).toBe(429);
  });
});
