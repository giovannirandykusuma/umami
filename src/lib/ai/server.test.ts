// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({ checkAuth: vi.fn() }));
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
vi.mock('@/queries/prisma', () => ({ getBoard: vi.fn(), getWebsite: vi.fn() }));
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
import { getBoard, getWebsite } from '@/queries/prisma';
import { getPageviewMetrics, getPageviewStats, getWebsiteStats } from '@/queries/sql';
import type { AiTurn } from './runtime';
import { handleAiChat } from './server';
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
    await input.executeTool(name as Parameters<AiTurn['executeTool']>[0], values);
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
      expect(Object.keys(input).sort()).toEqual(['draft', 'executeTool', 'messages', 'signal']);
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
