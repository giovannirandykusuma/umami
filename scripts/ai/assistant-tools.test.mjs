import assert from 'node:assert/strict';
import { globSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Production Pi resolves its own TypeBox; use the lockfile-installed copy offline.
const [typebox] = globSync(
  'node_modules/.pnpm/@sinclair+typebox@*/node_modules/@sinclair/typebox/build/esm/index.mjs',
);
assert.ok(typebox, 'Install the locked workspace dependencies before testing');
const source = (await readFile(new URL('./assistant-tools.mjs', import.meta.url), 'utf8')).replace(
  "'@sinclair/typebox'",
  JSON.stringify(pathToFileURL(typebox).href),
);
const extension = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);
test('registers exactly the assistant tool allowlist and blocks every other tool', () => {
  const tools = [];
  const handlers = {};
  extension.default({
    registerTool: tool => tools.push(tool),
    on: (name, fn) => {
      handlers[name] = fn;
    },
  });
  assert.deepEqual(
    tools.map(t => t.name),
    [
      'umami_api',
      'ask_user',
      'show_chart',
      'open_link',
      'analytics_schema',
      'find_people',
      'query_series',
      'query_breakdown',
      'query_totals',
    ],
  );
  assert.deepEqual(handlers.tool_call({ toolName: 'bash' }), {
    block: true,
    reason: 'Tool denied',
  });
  for (const name of extension.names)
    assert.equal(handlers.tool_call({ toolName: name }), undefined);
  for (const name of ['unknown_tool', 'query_sql', '', undefined])
    assert.deepEqual(handlers.tool_call({ toolName: name }), {
      block: true,
      reason: 'Tool denied',
    });
});
test('bridges input with the exact host title and returns host text', async () => {
  const tools = [];
  extension.default({ registerTool: tool => tools.push(tool), on() {} });
  const tool = tools[0];
  const args = { method: 'GET', path: '/api/websites' };
  const result = await tool.execute('id', args, new AbortController().signal, null, {
    ui: {
      async input(title, payload) {
        assert.equal(title, 'umami-assistant-tool');
        assert.deepEqual(JSON.parse(payload), { name: 'umami_api', args });
        return 'authorized result';
      },
    },
  });
  assert.equal(result.content[0].text, 'authorized result');
});
test('rejects cancelled calls and oversized input before bridging', async () => {
  const tools = [];
  extension.default({ registerTool: tool => tools.push(tool), on() {} });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(tools[0].execute('id', {}, controller.signal, null, {}), /Cancelled/);
  await assert.rejects(
    tools[0].execute('id', { body: 'x'.repeat(32769) }, undefined, null, {}),
    /Arguments too large/,
  );
});
test('analyst tools register only when the server flag is exactly true; schemas carry no authority', () => {
  for (const [value, expected] of [
    [undefined, false],
    ['1', false],
    ['TRUE', false],
    ['true', true],
  ]) {
    if (value === undefined) delete process.env.AI_ANALYST_ENABLED;
    else process.env.AI_ANALYST_ENABLED = value;
    const tools = [];
    const handlers = {};
    extension.default({ registerTool: t => tools.push(t), on: (n, fn) => (handlers[n] = fn) });
    const names = tools.map(t => t.name);
    assert.equal(names.includes('analyst_verify_render'), expected);
    assert.equal(names.length, expected ? 17 : 9);
    assert.deepEqual(
      handlers.tool_call({ toolName: 'analyst_commit_draft' }),
      expected ? undefined : { block: true, reason: 'Tool denied' },
    );
    for (const tool of tools.filter(t => t.name.startsWith('analyst_'))) {
      const schema = JSON.stringify(tool.parameters);
      for (const field of ['taskId', 'userId', 'url', 'capability', 'cookie', 'token', 'teamId'])
        assert.ok(!schema.includes(`"${field}"`), `${tool.name} exposes ${field}`);
    }
  }
  delete process.env.AI_ANALYST_ENABLED;
});
test('converts only the host image envelope for analyst_verify_render into image blocks', async () => {
  process.env.AI_ANALYST_ENABLED = 'true';
  const tools = [];
  extension.default({ registerTool: t => tools.push(t), on() {} });
  delete process.env.AI_ANALYST_ENABLED;
  const verify = tools.find(t => t.name === 'analyst_verify_render');
  const data = Buffer.alloc(1024 * 1024, 1).toString('base64');
  const envelope = images => JSON.stringify({ umamiImageEnvelope: 1, text: '{"ok":true}', images });
  const call = (tool, value) =>
    tool.execute('id', { boardId: '55555555-5555-4555-8555-555555555555' }, undefined, null, {
      ui: { input: async () => value },
    });
  const max = Array.from({ length: 6 }, () => ({ mimeType: 'image/png', data }));
  const result = await call(verify, envelope(max));
  assert.equal(result.content.filter(c => c.type === 'image').length, 6);
  assert.equal(result.content[0].type, 'text');
  assert.ok(!result.content[0].text.includes(data.slice(0, 64)));
  // Negative controls: over-count, oversize, foreign MIME and non-base64 are rejected.
  for (const bad of [
    [...max, max[0]],
    [{ mimeType: 'image/png', data: data + 'AAAA' }],
    [{ mimeType: 'image/svg+xml', data: 'AAAA' }],
    [{ mimeType: 'image/png', data: 'not base64!' }],
  ])
    await assert.rejects(call(verify, envelope(bad)), /Invalid host image result/);
  // Another tool cannot smuggle an envelope into image blocks.
  const api = tools.find(t => t.name === 'umami_api');
  await assert.rejects(call(api, envelope(max.slice(0, 1))), /Invalid host image result/);
});
test('analyst schemas expose the exact nested definition/widget/repair contracts before the call', async () => {
  const { Value } = await import(
    pathToFileURL(typebox.replace('index.mjs', 'value/index.mjs')).href
  );
  const { FormatRegistry } = await import(pathToFileURL(typebox).href);
  FormatRegistry.Set('uuid', v => /^[0-9a-f-]{36}$/i.test(v));
  process.env.AI_ANALYST_ENABLED = 'true';
  const tools = [];
  extension.default({ registerTool: t => tools.push(t), on() {} });
  delete process.env.AI_ANALYST_ENABLED;
  const schema = name => tools.find(t => t.name === name).parameters;
  const registeredDefinition = schema('analyst_preview').properties.definition;
  assert.equal(
    registeredDefinition.description,
    'unit is required for series and forbidden otherwise; groupBy only for breakdown. No visualization field (that is a widget prop).',
  );
  assert.equal(registeredDefinition.additionalProperties, false);
  const site = '8991b2f4-f857-4264-b911-e502f2eba3e2';
  const definition = {
    schemaVersion: 1,
    source: { websiteId: site },
    operation: 'series',
    metric: 'pageviews',
    datePolicy: { type: 'fixed', startAt: 0, endAt: 1 },
    unit: 'hour',
    timezone: 'UTC',
    semanticBinding: { label: 'L', unit: 'u', population: 'p', meaningSource: 'user_confirmed' },
  };
  assert.ok(Value.Check(schema('analyst_preview'), { definition }));
  // First guesses from the production run are rejected by the schema, not after a host round trip.
  for (const bad of [
    { websiteId: site, type: 'series', metric: 'pageviews', startAt: 0, endAt: 1 },
    { ...definition, visualization: 'line' },
    { ...definition, datePolicy: { type: 'absolute', startAt: 0, endAt: 1 } },
    { ...definition, semanticBinding: { label: 'L' } },
  ])
    assert.ok(!Value.Check(schema('analyst_preview'), { definition: bad }));
  const commit = component => ({
    board: {
      type: 'mixed',
      name: 'B',
      parameters: { rows: [{ id: 'r', columns: [{ id: 'w', component }] }] },
    },
    analyses: [{ ref: 'a', name: 'A', definition }],
    operationKey: 'k',
  });
  const good = { type: 'AnalysisWidget', props: { analysisRef: 'a', visualization: 'line' } };
  assert.ok(Value.Check(schema('analyst_commit_draft'), commit(good)));
  assert.ok(
    !Value.Check(
      schema('analyst_commit_draft'),
      commit({ type: 'SavedAnalysis', analysisRef: 'a', props: { chartType: 'line' } }),
    ),
  );
});
