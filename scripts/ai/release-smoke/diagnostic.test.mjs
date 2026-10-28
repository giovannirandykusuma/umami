import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('preserves the exact advertised model ID including both hyphens', () => {
  const advertised = { id: 'cx/gpt-6.1-sol' };
  for (const file of ['run.mjs', 'direct.mjs', 'metadata.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(source.includes(`'${advertised.id}'`));
    assert.ok(!source.includes('cx/gpt6.1sol'));
  }
});

test('ordinary and unsupported probes use natural language rather than scripted tool JSON', () => {
  const source = readFileSync(new URL('run.mjs', import.meta.url), 'utf8');
  assert.ok(
    source.includes("? 'Create a dashboard showing visits and popular pages for my website'"),
  );
  assert.ok(source.includes("? 'I want you to create like the number of usernames"));
  assert.ok(source.includes("assert.deepEqual(Object.keys(body), ['message'])"));
});

function fixture() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const cp = { spawn: () => child };
  const output = [];
  vm.runInNewContext(readFileSync(new URL('./diagnostic.cjs', import.meta.url), 'utf8'), {
    require: () => cp,
    console: { log: line => output.push(line) },
  });
  cp.spawn('node', ['/app/scripts/ai/native.mjs'], {});
  return { child, output };
}

test('classifies model errors without disclosing error strings or payloads', () => {
  const { child, output } = fixture();
  const secret = 'invented-secret-marker';
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'message_end', message: { stopReason: 'error', errorMessage: `401 unauthorized ${secret}`, content: secret } }) + '\n'));
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
  const record = { type: 'extension_ui_request', method: 'input', title: 'umami-host-tool', placeholder: JSON.stringify({ name: 'propose_board', args: { message: secret, draft: { rows: [] } } }) };
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
