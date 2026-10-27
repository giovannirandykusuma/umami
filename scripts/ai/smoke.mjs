// Credential-free actual pinned CLI protocol/resource smoke. Never sends a prompt.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { gatewayConfig, permissionArgs } from '../../src/lib/ai/rpc/confinement.mjs';
const home = await mkdtemp(join(tmpdir(), 'pi-native-smoke-'));
const gateway = {
  AI_PROVIDER: 'smoke-gateway',
  AI_MODEL: 'synthetic-model',
  AI_BASE_URL: 'https://gateway.invalid/v1',
  AI_EGRESS_ORIGINS: 'https://gateway.invalid',
};
await mkdir(join(home, 'agent'));
await writeFile(join(home, 'agent/models.json'), JSON.stringify(gatewayConfig(gateway)), {
  mode: 0o600,
});
// Synthetic adjacent file is outside the per-turn writable/readable scratch.
const adjacentSecret = home + '-secret';
await writeFile(adjacentSecret, 'synthetic-not-a-credential');
const probe = spawnSync(
  process.execPath,
  [
    ...permissionArgs({
      root: process.env.AI_PI_ROOT,
      scratch: home,
      bridge: resolve('scripts/ai/native.mjs'),
      extension: resolve('scripts/ai/host-tools.mjs'),
    }),
    '--input-type=module',
  ],
  {
    cwd: home,
    env: {},
    input: `import { readFileSync, writeFileSync } from 'node:fs';
      import assert from 'node:assert/strict';
      for (const path of ${JSON.stringify([adjacentSecret, resolve('package.json')])}) {
        assert.throws(() => readFileSync(path), { code: 'ERR_ACCESS_DENIED' });
        assert.throws(() => writeFileSync(path, 'forbidden'), { code: 'ERR_ACCESS_DENIED' });
      }
      console.log('Adjacent secret and application manifest denied');`,
    encoding: 'utf8',
    timeout: 5000,
  },
);
await rm(adjacentSecret, { force: true });
assert.equal(probe.status, 0, probe.stderr);
console.log(probe.stdout.trim());
const child = spawn(
  process.execPath,
  [
    ...permissionArgs({
      root: process.env.AI_PI_ROOT,
      scratch: home,
      bridge: resolve('scripts/ai/native.mjs'),
      extension: resolve('scripts/ai/host-tools.mjs'),
    }),
    resolve('scripts/ai/native.mjs'),
    '--mode',
    'rpc',
    '--offline',
    '--no-session',
    '--no-approve',
    '--no-extensions',
    '--no-mcp',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-builtin-tools',
    '--extension',
    resolve('scripts/ai/host-tools.mjs'),
    '--provider',
    gateway.AI_PROVIDER,
    '--model',
    gateway.AI_MODEL,
  ],
  {
    cwd: home,
    env: {
      HOME: home,
      PI_CODING_AGENT_DIR: join(home, 'agent'),
      AI_PI_ROOT: process.env.AI_PI_ROOT,
      PI_OFFLINE: '1',
      AI_NATIVE_SMOKE: '1',
      ...gateway,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
let stderr = '';
child.stderr.on('data', b => {
  stderr += b;
});
let buffer = '';
let toolProof = false;
const closed = new Promise(resolve => child.on('close', resolve));
try {
  await new Promise((resolveDone, reject) => {
    const timer = setTimeout(() => reject(new Error('Smoke timeout: ' + stderr)), 15000);
    child.on('error', reject);
    child.on('close', () => reject(new Error('Early exit: ' + stderr)));
    child.stdout.on('data', b => {
      buffer += b.toString();
      while (buffer.includes('\n')) {
        const n = buffer.indexOf('\n');
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        try {
          const value = JSON.parse(line);
          if (value.type === 'extension_ui_request' && value.method === 'notify') {
            assert.deepEqual(JSON.parse(value.message).sort(), [
              'analytics_breakdown',
              'analytics_summary',
              'analytics_timeseries',
              'propose_board',
            ]);
            toolProof = true;
          }
          if (value.type !== 'response') continue;
          assert.equal(value.id, 'smoke-state');
          assert.equal(value.command, 'get_state');
          assert.equal(value.success, true);
          assert.equal(value.data.isStreaming, false);
          clearTimeout(timer);
          resolveDone();
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      }
    });
    child.stdin.write(JSON.stringify({ id: 'smoke-state', type: 'get_state' }) + '\n');
  });
  assert.equal(stderr, '', 'No extension loading failures');
  assert.equal(toolProof, true, 'Trusted extension loaded and only four host tools active');
  console.log('Pinned Pi 1.4.0 native RPC get_state correlated; no prompt/provider call.');
} finally {
  child.kill('SIGKILL');
  await closed;
  await rm(home, { recursive: true, force: true });
}
