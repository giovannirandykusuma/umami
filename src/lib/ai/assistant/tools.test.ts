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
    expect(await result).toContain(confirmed ? '200' : 'User denied');
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
    ).toBe('User denied');
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
      { component: { type: 'WebsiteCompareChart', props: { websiteIds: ['a', 'b'] } } },
      input,
    );
    await executeTool('open_link', { label: 'Board', href: '/boards/123' }, input);
    expect(events.map(part => part.type)).toEqual(['chart', 'link']);
    await expect(
      executeTool('show_chart', { component: { type: 'Script' } }, input),
    ).rejects.toThrow('Chart type denied');
    await expect(
      executeTool('open_link', { label: 'Bad', href: '//evil.com' }, input),
    ).rejects.toThrow('Invalid link');
    await expect(
      executeTool('umami_api', { method: 'GET', path: '/api/auth/login' }, input),
    ).rejects.toThrow('API path or method denied');
  });
  it('preserves an explicit comparison range through show_chart', async () => {
    const events: any[] = [];
    const component = {
      type: 'WebsiteCompareChart',
      props: {
        websiteIds: ['a', 'b'],
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
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(32768);
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
