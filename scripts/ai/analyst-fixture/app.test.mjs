// Env-canary: Next's own loader must find nothing in the sanitized fixture project even when the
// checkout holds every .env variant Next auto-loads.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fixtureEnv, sanitizedProject, systemTemp } from './app.mjs';

const require = createRequire(import.meta.url);
const nextEnv = require(
  require.resolve('@next/env', { paths: [require.resolve('next/package.json')] }),
);
const CANARY = ['.env', '.env.local', '.env.development', '.env.development.local'];
const KEY = 'UMAMI_FIXTURE_ENV_CANARY';

function fakeCheckout() {
  const dir = mkdtempSync(join(tmpdir(), 'canary-checkout-'));
  for (const entry of [
    'next.config.ts',
    'package.json',
    'tsconfig.json',
    'postcss.config.js',
    'prisma.config.ts',
  ])
    cpSync(resolve(entry), join(dir, entry));
  for (const entry of ['prisma', 'scripts/ai/analyst-fixture'])
    cpSync(resolve(entry), join(dir, entry), { recursive: true });
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'public'));
  for (const name of CANARY) {
    writeFileSync(join(dir, name), `${KEY}=leaked\nAI_PROVIDER_KEY=sk-canary\n`);
    writeFileSync(join(dir, 'src', name), `${KEY}=leaked\n`);
  }
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'));
  return dir;
}

function load(dir) {
  delete process.env[KEY];
  delete process.env.AI_PROVIDER_KEY;
  delete process.env.__NEXT_PROCESSED_ENV;
  const { loadedEnvFiles } = nextEnv.loadEnvConfig(dir, true, { info() {}, error() {} }, true);
  return { loadedEnvFiles, canary: process.env[KEY], key: process.env.AI_PROVIDER_KEY };
}

test('control: Next auto-loads the canary from the checkout itself', () => {
  const checkout = fakeCheckout();
  try {
    const { loadedEnvFiles, canary, key } = load(checkout);
    assert.equal(canary, 'leaked');
    assert.equal(key, 'sk-canary');
    assert.equal(loadedEnvFiles.length, 4);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test('sanitized fixture project: no .env file copied, Next loads nothing', () => {
  const checkout = fakeCheckout();
  const project = sanitizedProject(checkout, 'ab'.repeat(32));
  try {
    for (const name of CANARY) {
      assert.equal(existsSync(join(project, name)), false);
      assert.equal(existsSync(join(project, 'src', name)), false);
    }
    const { loadedEnvFiles, canary, key } = load(project);
    assert.deepEqual(loadedEnvFiles, []);
    assert.equal(canary, undefined);
    assert.equal(key, undefined);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test('child env is an explicit allowlist with no live provider keys', () => {
  const env = fixtureEnv({
    dir: '/fixture',
    port: '3327',
    nonce: 'ab'.repeat(32),
    piRoot: '/pi',
    verifier: false,
  });
  for (const key of [
    'AI_PROVIDER',
    'AI_MODEL',
    'AI_BASE_URL',
    'AI_PROVIDER_KEY',
    'AI_ENABLED',
    'AI_ANALYST_VERIFIER_ENABLED',
  ])
    assert.equal(env[key], undefined);
  assert.equal(env.NODE_ENV, 'development');
  assert.equal(env.TMPDIR, '/fixture/.home');
  assert.equal(env.AI_OFFLINE_FIXTURE, 'analyst-synthetic-v1');
});

test('systemTemp ignores $TMPDIR (e.g. repo scratch) and refuses discovery ancestors', () => {
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = resolve('.');
  try {
    const root = systemTemp();
    assert.ok(!root.startsWith(realpathSync(resolve('.'))), root);
    for (let dir = root; dir !== dirname(dir); dir = dirname(dir))
      assert.equal(existsSync(join(dir, '.pi')), false);
  } finally {
    process.env.TMPDIR = saved;
  }
  const poisoned = mkdtempSync(join(systemTemp(), 'poisoned-'));
  mkdirSync(join(poisoned, '.pi'));
  mkdirSync(join(poisoned, 'tmp'));
  try {
    assert.throws(
      () => systemTemp({ platform: 'darwin', confstr: () => join(poisoned, 'tmp') }),
      /discovery ancestor/,
    );
  } finally {
    rmSync(poisoned, { recursive: true, force: true });
  }
});
