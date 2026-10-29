import { expect, test } from 'vitest';
import { allowedRequest } from './worker.mjs';
import { createCapabilityStore } from './capability.mjs';

test('verifier rejects ambient API endpoints and malformed authority', () => {
  expect(allowedRequest('http://127.0.0.1:4319/api/auth', 'http://127.0.0.1:4319')).toBe(false);
  expect(allowedRequest('http://169.254.169.254/canvas', 'http://127.0.0.1:4319')).toBe(false);
  const store = createCapabilityStore({ authorize: () => false });
  expect(() => store.issue({ userId: 'fixture' })).toThrow('invalid_scope');
});
