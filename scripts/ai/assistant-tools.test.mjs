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
