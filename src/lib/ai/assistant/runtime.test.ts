// @vitest-environment node
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('@/lib/prisma', () => ({ default: {} }));
import { runAssistantProcess } from './runtime';

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
  const second = await runAssistantProcess(
    { ...input, message: 'next', session: first.session },
    options,
  );
  expect(second.session).toContain('hello');
  expect(second.session).toContain('next');
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
