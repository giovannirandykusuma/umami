// Env-canary: Next's own loader must find nothing in the sanitized fixture project even when the
// checkout holds every .env variant Next auto-loads.
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fixtureEnv, sanitizedProject, systemTemp, writeReceipt } from './app.mjs';

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
    const config = readFileSync(join(project, 'next.config.ts'), 'utf8');
    assert.match(config, /config\.cache = false; config\.parallelism = 1/);
    assert.doesNotMatch(config, /config\.devtool = false/);
    assert.doesNotMatch(
      readFileSync(join(checkout, 'next.config.ts'), 'utf8'),
      /config\.devtool = false/,
    );
    assert.doesNotMatch(config, /onDemandEntries/);
    assert.doesNotMatch(readFileSync(join(checkout, 'next.config.ts'), 'utf8'), /onDemandEntries/);
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
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=2048');
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

test('flags-off mode leaves analyst, offline runtime and verifier flags unset', () => {
  const env = fixtureEnv({
    dir: '/fixture',
    port: '3327',
    nonce: 'ab'.repeat(32),
    piRoot: '/pi',
    verifier: true,
    flagsOff: true,
  });
  for (const key of [
    'AI_ANALYST_ENABLED',
    'AI_OFFLINE_FIXTURE',
    'AI_OFFLINE_FIXTURE_NONCE',
    'AI_PI_ROOT',
    'AI_ANALYST_VERIFIER_ENABLED',
    'AI_ANALYST_VERIFIER_LAUNCHER',
    'AI_PROVIDER',
  ])
    assert.equal(env[key], undefined, key);
  assert.equal(env.DATABASE_URL.endsWith('schema=analyst_fixture'), true);
});

test('launcher receipt binds root, nonce hash, provider hash and BUILD_ID; never the nonce', () => {
  const checkout = fakeCheckout();
  const nonce = 'ab'.repeat(32);
  const project = sanitizedProject(checkout, nonce);
  try {
    assert.ok(basename(project).startsWith('umami-analyst-fixture-'));
    writeReceipt(project, nonce, 'build-1');
    const raw = readFileSync(join(project, '.analyst-fixture-receipt.json'), 'utf8');
    const receipt = JSON.parse(raw);
    assert.equal(raw.includes(nonce), false);
    assert.equal(receipt.root, realpathSync(project));
    assert.equal(receipt.buildId, 'build-1');
    assert.match(receipt.providerSha256, /^[0-9a-f]{64}$/);
    assert.ok(Date.now() - receipt.issuedAt < 60_000);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test('built mode runs NODE_ENV=production with the same allowlist', () => {
  const env = fixtureEnv({
    dir: '/f',
    port: '3341',
    nonce: 'ab'.repeat(32),
    piRoot: '/pi',
    built: true,
  });
  assert.equal(env.NODE_ENV, 'production');
  for (const key of ['AI_PROVIDER', 'AI_PROVIDER_KEY', 'AI_ENABLED'])
    assert.equal(env[key], undefined);
});
