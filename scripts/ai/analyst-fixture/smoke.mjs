// Fixture readiness: real login (seeded admin/umami), real saved analysis create through the
// authenticated API, then native saved execution. Loopback synthetic app only.
import assert from 'node:assert/strict';

const origin = process.env.ANALYST_FIXTURE_ORIGIN ?? 'http://127.0.0.1:3327';
const url = new URL(origin);
if (url.hostname !== '127.0.0.1' || ['3000', '3317'].includes(url.port))
  throw new Error('Refusing non-fixture origin');
const WEBSITE = 'a11a1a00-0000-4000-8000-000000000001';

async function call(path, { token, body } = {}) {
  const res = await fetch(`${origin}/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

assert.equal((await call('/analyses')).status, 401, 'unauthenticated access must be denied');
const login = await call('/auth/login', { body: { username: 'admin', password: 'umami' } });
assert.equal(login.status, 200);
const { token } = login.body;
const definition = {
  schemaVersion: 1,
  source: { websiteId: WEBSITE },
  operation: 'totals',
  metric: 'pageviews',
  datePolicy: { type: 'fixed', startAt: Date.UTC(2026, 9, 1), endAt: Date.UTC(2026, 9, 15) },
  timezone: 'UTC',
  semanticBinding: {
    label: 'Synthetic pageviews',
    unit: 'pageviews',
    population: 'all synthetic visitors',
    meaningSource: 'observed_only',
  },
};
const created = await call('/analyses', {
  token,
  body: { operationKey: 'fixture-smoke', name: 'Fixture pageviews', status: 'ready', definition },
});
assert.equal(created.status, 200, JSON.stringify(created.body));
const { analysis } = created.body;
const executed = await call(`/analyses/${analysis.id}/execute`, { token, body: {} });
assert.equal(executed.status, 200, JSON.stringify(executed.body));
assert.equal(executed.body.definitionHash, analysis.definitionHash);
assert.equal(executed.body.rows.length, 1);
console.log(
  JSON.stringify({
    origin,
    analysisId: analysis.id,
    revision: analysis.revision,
    definitionHash: analysis.definitionHash,
    executionId: executed.body.executionId,
    rows: executed.body.rows,
  }),
);

// Real authenticated offline analyst turn (synthetic provider through native Pi RPC): create,
// readback, repair and verify against the real database and, when built, the Docker verifier.
const chat = await call('/ai/assistant/chats', { token, body: { title: 'Offline fixture' } });
assert.equal(chat.status, 200, JSON.stringify(chat.body));
const turn = await fetch(`${origin}/api/ai/assistant/chats/${chat.body.id}/turn`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ message: 'Build a synthetic pageviews board' }),
});
assert.equal(turn.status, 200);
const frames = (await turn.text())
  .split('\n\n')
  .filter(Boolean)
  .map(frame => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)));
const tools = frames
  .filter(f => f.type === 'part' && f.part?.type === 'tool' && f.part.status !== 'running')
  .map(f => ({ name: f.part.name, status: f.part.status }));
const text = frames.filter(f => f.type === 'text_delta').map(f => f.delta).join('');
const tasks = frames.filter(f => f.type === 'task');
assert.deepEqual(
  tools.map(t => t.name),
  ['analyst_discover', 'analyst_commit_draft', 'analyst_readback', 'analyst_commit_draft', 'analyst_verify_render'],
  JSON.stringify(frames.filter(f => f.type !== 'text_delta')).slice(0, 4000),
);
assert.ok(!frames.some(f => f.type === 'error'), JSON.stringify(frames.at(-1)));
assert.match(text, /^Offline fixture turn complete; render status: /);
console.log(JSON.stringify({ turnTools: tools, finalText: text, lastTask: tasks.at(-1) }));
