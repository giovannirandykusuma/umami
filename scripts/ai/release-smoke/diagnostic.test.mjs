import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { loadSharedContract, readSmokeStream } from './run.mjs';

const encodeFrame = (type, value) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
function streamResponse(text, chunkSize = 7) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('SSE accepts bounded progress, optional questions, fragmented UTF-8 and EOF', async () => {
  const result = { message: 'Please clarify café login.', questions: [{ id: 'event', question: 'Which event?', options: [{ value: 'login', label: 'Login' }, { value: 'page', label: 'Login page' }] }] };
  const { validateAiResult } = await loadSharedContract();
  const expected = validateAiResult(result);
  const response = await readSmokeStream(streamResponse(encodeFrame('progress', { phase: 'read' }) + encodeFrame('result', { result }), 1));
  assert.deepEqual(response.result, expected);
  assert.deepEqual(response.phases, ['read']);
  assert.equal(response.eof, true);
  assert.deepEqual(validateAiResult({ message: 'No draft.' }), { message: 'No draft.' });
});

test('SSE rejects malformed, duplicate, missing, oversized or post-terminal frames', async () => {
  const final = encodeFrame('result', { result: { message: 'Done.' } });
  for (const text of [
    '', final + final, final + encodeFrame('progress', { phase: 'read' }), final.slice(0, -1),
    'event: result\ndata: not-json\n\n',
    encodeFrame('error', { message: 'upstream secret' }),
    encodeFrame('result', { result: { message: 'Unsafe', questions: [{ id: 'q', question: 'Run?', command: 'execute' }] } }),
    encodeFrame('progress', { phase: 'invented' }),
    encodeFrame('progress', { phase: 'read' }).repeat(22) + final,
    'x'.repeat(33_100),
  ]) await assert.rejects(readSmokeStream(streamResponse(text)));
});

test('preserves the exact advertised model ID including both hyphens', () => {
  const advertised = { id: 'cx/gpt-6.1-sol' };
  for (const file of ['run.mjs', 'direct.mjs', 'metadata.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const contract = source.includes('resolveGateway')
      ? readFileSync(new URL('../gateway-config.mjs', import.meta.url), 'utf8')
      : source;
    assert.ok(contract.includes(`'${advertised.id}'`));
    assert.ok(!source.includes('cx/gpt6.1sol'));
  }
});

test('ordinary and unsupported probes use natural language rather than scripted tool JSON', () => {
  const source = readFileSync(new URL('run.mjs', import.meta.url), 'utf8');
  assert.ok(
    source.includes("? 'Create a dashboard showing visits and popular pages for my website'"),
  );
  assert.ok(source.includes("? 'I want you to create like the number of usernames"));
  assert.ok(source.includes('const body = validateAiResult(stream.result)'));
  assert.ok(source.includes("assert.equal(body.draft, undefined)"));
});

function fixture() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => true };
  const cp = { spawn: () => child };
  const output = [];
  vm.runInNewContext(readFileSync(new URL('./diagnostic.cjs', import.meta.url), 'utf8'), {
    require: () => cp,
    console: { log: line => output.push(line) },
  });
  cp.spawn('node', ['/app/scripts/ai/native.mjs'], {});
  return { child, output };
}

test('discovery observation and fragmented canary detection expose only categories and booleans', () => {
  const { child, output } = fixture();
  assert.equal(child.stdin.write('CANARY_INVENTED_'), true);
  assert.equal(child.stdin.write('USERNAME_NEVER_EXPOSE'), true);
  child.stdout.emit('data', JSON.stringify({ type: 'extension_ui_request', method: 'input', title: 'umami-host-tool', placeholder: JSON.stringify({ name: 'analytics_discover', args: { websiteId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', startAt: 1, endAt: 2 } }) }) + '\n');
  child.emit('close', 0, null);
  const report = JSON.parse(output[0].slice('RELEASE_SMOKE_DIAGNOSTIC '.length));
  assert.equal(report.categories.analytics_discover, 1);
  assert.equal(report.modelInputObserved, true);
  assert.equal(report.modelInputCanary, true);
  assert.equal(report.modelOutputCanary, false);
  assert.ok(!output[0].includes('CANARY_INVENTED'));
});

test('classifies model errors without disclosing error strings or payloads', () => {
  const { child, output } = fixture();
  const secret = 'invented-secret-marker';
  child.stdout.emit(
    'data',
    Buffer.from(
      JSON.stringify({
        type: 'message_end',
        message: {
          stopReason: 'error',
          errorMessage: `401 unauthorized ${secret}`,
          content: secret,
        },
      }) + '\n',
    ),
  );
  child.stderr.emit('data', Buffer.from(`ERR_ACCESS_DENIED ${secret}`));
  child.emit('close', 1, null);
  assert.equal(output.length, 1);
  assert.ok(!output[0].includes(secret));
  const result = JSON.parse(output[0].slice('RELEASE_SMOKE_DIAGNOSTIC '.length));
  assert.equal(result.categories['model-auth-error'], 1);
  assert.equal(result.categories['permission-denied'], 1);
  assert.equal(result.exit, 1);
});

test('categorizes malformed analytics arguments without revealing values or unknown keys', () => {
  const { child, output } = fixture();
  const secret = 'invented-private-marker';
  const record = {
    type: 'extension_ui_request',
    method: 'input',
    title: 'umami-host-tool',
    placeholder: JSON.stringify({
      name: 'analytics_breakdown',
      args: {
        websiteId: secret,
        startAt: secret,
        endAt: secret,
        dimension: secret,
        limit: secret,
        [secret]: secret,
      },
    }),
  };
  child.stdout.emit('data', Buffer.from(JSON.stringify(record) + '\n'));
  child.emit('close', null, 'SIGTERM');
  assert.ok(!output[0].includes(secret));
  const result = JSON.parse(output[0].slice('RELEASE_SMOKE_DIAGNOSTIC '.length));
  for (const category of [
    'read-request',
    'analytics_breakdown',
    'website-invalid',
    'dates-invalid',
    'unknown-argument',
    'dimension-invalid',
    'limit-invalid',
  ]) {
    assert.equal(result.categories[category], 1);
  }
});

test('recognizes proposal object shape without emitting its content', () => {
  const { child, output } = fixture();
  const secret = 'invented-payload-marker';
  const record = {
    type: 'extension_ui_request',
    method: 'input',
    title: 'umami-host-tool',
    placeholder: JSON.stringify({
      name: 'propose_board',
      args: { message: secret, draft: { rows: [] } },
    }),
  };
  const line = JSON.stringify(record) + '\n';
  child.stdout.emit('data', Buffer.from(line.slice(0, 12)));
  child.stdout.emit('data', Buffer.from(line.slice(12)));
  child.emit('close', null, 'SIGTERM');
  assert.ok(!output[0].includes(secret));
  const result = JSON.parse(output[0].slice('RELEASE_SMOKE_DIAGNOSTIC '.length));
  assert.equal(result.categories.proposal, 1);
  assert.equal(result.categories['draft-object'], 1);
  assert.equal(result.signal, true);
});
