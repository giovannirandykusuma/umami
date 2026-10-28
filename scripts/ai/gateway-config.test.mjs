import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGateway } from './gateway-config.mjs';
test('canonical gateway API path exactly once with fixed model/reasoning and unchanged key', () => {
  for (const suffix of ['', '/', '/v1', '/v1/']) {
    const result = resolveGateway(
      { baseUrl: 'https://synthetic.invalid' + suffix, apiKey: 'invented-key' },
      'invented-key',
    );
    assert.equal(result.AI_BASE_URL, 'https://synthetic.invalid/v1');
    assert.equal(result.AI_MODEL, 'cx/gpt-6.1-sol');
    assert.equal(result.AI_REASONING_LEVEL, 'medium');
    assert.equal(result.AI_PROVIDER_KEY === 'invented-key', true);
  }
});
test('rejects arbitrary endpoint paths, query, userinfo, wrong route/reasoning and missing/mismatched key', () => {
  for (const baseUrl of [
    'https://synthetic.invalid/other',
    'https://synthetic.invalid/v1/v1',
    'https://synthetic.invalid/?x=1',
    'https://a@synthetic.invalid',
    'http://synthetic.invalid',
  ])
    assert.throws(() => resolveGateway({ baseUrl, apiKey: 'invented-key' }));
  const input = { baseUrl: 'https://synthetic.invalid', apiKey: 'invented-key' };
  assert.throws(() => resolveGateway({ ...input, AI_MODEL: 'gpt-6.1-sol' }));
  assert.throws(() => resolveGateway({ ...input, AI_REASONING_LEVEL: 'high' }));
  assert.throws(() => resolveGateway({ ...input, apiKey: '' }));
  assert.throws(() => resolveGateway(input, 'different-key'));
});
