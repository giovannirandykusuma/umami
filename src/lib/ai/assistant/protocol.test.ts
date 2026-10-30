import { expect, it } from 'vitest';
import { ASSISTANT_STREAM_EVENTS, analystToolPhase, applyAssistantEvent } from './protocol';

it('task is a recognized stream event that does not mutate parts', () => {
  expect(ASSISTANT_STREAM_EVENTS).toContain('task');
  const parts = [{ type: 'text' as const, id: 'a', text: 'x' }];
  expect(
    applyAssistantEvent(parts, { type: 'task', taskId: 't', status: 'running', phase: 'query' }),
  ).toBe(parts);
});

it('phases derive only from host analyst tool names', () => {
  expect(analystToolPhase('analyst_verify_render')).toBe('render');
  expect(analystToolPhase('analyst_commit_draft')).toBe('save_draft');
  expect(analystToolPhase('query_metrics')).toBeNull();
});
