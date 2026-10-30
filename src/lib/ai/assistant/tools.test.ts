import { describe, expect, it, vi } from 'vitest';
import { executeTool, Interaction, validApiPath, validLink } from './tools';

describe('assistant host tools', () => {
  it('rejects traversal, encoded paths, auth, AI, hosts and redirects', () => {
    for (const path of [
      '/api/../auth',
      '/api/%61uth',
      '/api/auth',
      '/api/auth/login',
      '/api/ai/boards',
      '//host/api/x',
      'https://host/api/x',
      '/api//websites',
      '/api/websites?x=1',
    ])
      expect(validApiPath(path)).toBe(false);
    expect(validApiPath('/api/websites/123/stats')).toBe(true);
    for (const path of ['//host', '/%2fhost', '/a/../b', 'javascript:alert(1)'])
      expect(validLink(path)).toBe(false);
  });
  it.each([true, false])('requires explicit delete confirmation (%s)', async confirmed => {
    const events: any[] = [];
    const interaction = new Interaction(p => events.push(p), new AbortController().signal);
    const fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
    const result = executeTool(
      'umami_api',
      { method: 'DELETE', path: '/api/websites/123' },
      { credentials: new Headers({ authorization: 'Bearer user' }), interaction, fetch },
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(interaction.reply({ kind: 'confirm', partId: events[0].id, confirmed })).toBe(true);
    expect(await result).toEqual(
      confirmed
        ? { ok: true, data: { ok: true } }
        : { ok: false, code: 'denied', message: 'User denied', retryable: false, isError: true },
    );
    expect(fetch).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    if (confirmed) expect(fetch.mock.calls[0][1].headers.get('authorization')).toBe('Bearer user');
    expect(events[1].state).toBe(confirmed ? 'confirmed' : 'rejected');
  });
  it('expires confirmation without dispatch', async () => {
    const events: any[] = [];
    const interaction = new Interaction(p => events.push(p), new AbortController().signal, 1);
    const fetch = vi.fn();
    expect(
      await executeTool(
        'umami_api',
        { method: 'POST', path: '/api/websites/123/reset' },
        { credentials: new Headers(), interaction, fetch },
      ),
    ).toMatchObject({ ok: false, code: 'denied', isError: true });
    expect(events[1].state).toBe('expired');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('emits allowlisted charts and relative links but rejects unsafe output', async () => {
    const events: any[] = [];
    const input = {
      credentials: new Headers(),
      interaction: new Interaction(part => events.push(part), new AbortController().signal),
    };
    await executeTool(
      'show_chart',
      {
        component: {
          type: 'WebsiteCompareChart',
          props: {
            websiteIds: [
              '11111111-1111-4111-8111-111111111111',
              '22222222-2222-4222-8222-222222222222',
            ],
            metric: 'visitors',
          },
        },
      },
      input,
    );
    await executeTool('open_link', { label: 'Board', href: '/boards/123' }, input);
    expect(events.map(part => part.type)).toEqual(['chart', 'link']);
    await expect(
      executeTool('show_chart', { component: { type: 'Script' } }, input),
    ).resolves.toMatchObject({ ok: false, code: 'invalid_chart' });
    await expect(
      executeTool('open_link', { label: 'Bad', href: '//evil.com' }, input),
    ).rejects.toThrow('Invalid link');
    await expect(
      executeTool('umami_api', { method: 'GET', path: '/api/auth/login' }, input),
    ).resolves.toMatchObject({ ok: false, code: 'invalid_arguments' });
  });
  it('preserves an explicit comparison range through show_chart', async () => {
    const events: any[] = [];
    const component = {
      type: 'WebsiteCompareChart',
      props: {
        websiteIds: [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
        ],
        metric: 'visitors',
        unit: 'day',
        startAt: Date.parse('2026-01-01T00:00:00Z'),
        endAt: Date.parse('2026-01-14T23:59:59Z'),
      },
    };
    await executeTool(
      'show_chart',
      { title: 'Last 14 days', component },
      {
        credentials: new Headers(),
        interaction: new Interaction(part => events.push(part), new AbortController().signal),
      },
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'chart', title: 'Last 14 days', component }),
    ]);
  });

  it('bounds API output and forbids redirects', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('x'.repeat(100000)));
    const result = await executeTool(
      'umami_api',
      { method: 'GET', path: '/api/websites', query: { includeTeams: true } },
      {
        credentials: new Headers(),
        fetch,
        interaction: new Interaction(vi.fn(), new AbortController().signal),
      },
    );
    expect(result).toMatchObject({ ok: false, code: 'result_too_large', isError: true });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32768);
    expect(fetch.mock.calls[0][0].search).toBe('?includeTeams=true');
    expect(fetch.mock.calls[0][1].redirect).toBe('error');
  });
  it('asks questions and validates choice replies', async () => {
    const events: any[] = [];
    const interaction = new Interaction(p => events.push(p), new AbortController().signal);
    const result = executeTool(
      'ask_user',
      { question: 'Which?', options: ['A'], allowText: false },
      { credentials: new Headers(), interaction },
    );
    expect(interaction.reply({ kind: 'question', partId: events[0].id, answer: 'B' })).toBe(false);
    expect(interaction.reply({ kind: 'question', partId: events[0].id, answer: 'A' })).toBe(true);
    expect(await result).toBe('A');
    expect(events[1].state).toBe('answered');
  });
});

describe('analyst-mode generic API authority', () => {
  const input = (fetch: any, events: any[] = []) => ({
    credentials: new Headers(),
    interaction: new Interaction(p => events.push(p), new AbortController().signal),
    fetch,
    analyst: true,
  });
  it.each([
    ['POST', '/api/boards'],
    ['POST', '/api/boards/1'],
    ['PUT', '/api/boards/1'],
    ['PATCH', '/api/analyses/1'],
    ['POST', '/api/analyses'],
    ['POST', '/api/boards/bundle'],
    ['POST', '/api/websites/1/shares'],
    ['POST', '/api/teams/1/boards'],
    ['DELETE', '/api/boards/1'],
  ])('denies lifecycle write %s %s without asking or fetching', async (method, path) => {
    const fetch = vi.fn();
    const events: any[] = [];
    const result = await executeTool('umami_api', { method, path }, input(fetch, events));
    expect(result).toMatchObject({ ok: false, code: 'denied' });
    expect(fetch).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
  it('requires confirmation for other writes (POST is not harmless) and allows GET', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    const events: any[] = [];
    const pending = executeTool(
      'umami_api',
      { method: 'POST', path: '/api/websites' },
      input(fetch, events),
    );
    await vi.waitFor(() => expect(events[0]?.type).toBe('confirm'));
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await executeTool('umami_api', { method: 'GET', path: '/api/boards' }, input(fetch)),
    ).toMatchObject({ ok: true });
    pending.catch(() => undefined);
  });
  it('legacy (flag-off) behavior is unchanged: POST /api/boards is fetched without confirmation', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    const interaction = new Interaction(vi.fn(), new AbortController().signal);
    expect(
      await executeTool(
        'umami_api',
        { method: 'POST', path: '/api/boards' },
        { credentials: new Headers(), interaction, fetch },
      ),
    ).toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('pauses only while a validated interaction is pending', async () => {
    const calls: string[] = [];
    const events: any[] = [];
    const interaction = new Interaction(p => events.push(p), new AbortController().signal, 300000, {
      pause: async () => calls.push('pause'),
      resume: async () => calls.push('resume'),
    });
    const pending = interaction.wait({
      type: 'question',
      id: 'q',
      question: 'Which?',
      allowText: true,
      state: 'pending',
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(calls).toEqual(['pause']);
    expect(interaction.reply({ kind: 'question', partId: 'forged', answer: 'x' })).toBe(false);
    expect(calls).toEqual(['pause']);
    expect(interaction.reply({ kind: 'question', partId: 'q', answer: 'A' })).toBe(true);
    await pending;
    expect(calls).toEqual(['pause', 'resume']);
  });
});
