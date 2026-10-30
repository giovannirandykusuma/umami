import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

// pi-ai is resolved from the pinned Pi install (AI_PI_ROOT) at runtime, not the app's deps.
const root = process.env.AI_PI_ROOT;
if (!root) throw new Error('AI_PI_ROOT (pinned Pi install) required');
register(
  `data:text/javascript,export async function resolve(s,c,n){return s==='@earendil-works/pi-ai'?n(${JSON.stringify(
    `${root}/node_modules/@earendil-works/pi-ai/dist/index.js`,
  )},c):n(s,c)}`,
);
const { nextStep } = await import('./offline-provider.mjs');

const BOARD = '11111111-1111-4111-8111-111111111111';
const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
const result = (toolName, value) => ({
  role: 'toolResult',
  toolName,
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

test('existing-board scenario reads back, then requests a confirmed change at that revision', () => {
  const prompt = user(`Change board ${BOARD}`);
  assert.deepEqual(nextStep([prompt]), { tool: 'analyst_readback', args: { boardId: BOARD } });
  const step = nextStep([
    prompt,
    result('analyst_readback', { ok: true, data: { board: { id: BOARD, revision: 3 } } }),
  ]);
  assert.equal(step.tool, 'analyst_request_change');
  assert.equal(step.args.boardId, BOARD);
  assert.equal(step.args.expectedRevision, 3);
  // Never the create path: request_change is the only write tool for an existing board.
  assert.equal('operationKey' in step.args, false);
});

test('existing-board scenario reports rejection honestly', () => {
  const prompt = user(`Change board ${BOARD}`);
  const step = nextStep([
    prompt,
    result('analyst_readback', { ok: true, data: { board: { id: BOARD, revision: 3 } } }),
    result('analyst_request_change', { ok: false, code: 'denied' }),
  ]);
  assert.equal(step.text, 'Offline change not applied: denied');
});

test('default prompt keeps the create/repair script', () => {
  assert.equal(nextStep([user('Build a synthetic pageviews board')]).tool, 'analyst_discover');
});
