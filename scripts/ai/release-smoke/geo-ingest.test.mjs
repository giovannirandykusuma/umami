import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { ingestGate } from './assistant-live.mjs';
import { create } from 'tar';
import { dirname, basename } from 'node:path';

const script = resolve('scripts/build-geo.js');
const run = (cwd, args = [], env = {}) => spawnSync(process.execPath, [script, ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, SKIP_BUILD_GEO: '1', ...env },
});

test('missing and corrupt geo fail closed, including skip flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-negative-'));
  try {
    assert.equal(run(dir).status, 1);
    assert.equal(run(dir, ['--check']).status, 1);
    const invalid = join(dir, 'invalid.mmdb');
    writeFileSync(invalid, 'not a database');
    assert.equal(run(dir, ['--check', invalid]).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('canonical real asset validates and download is awaited', async () => {
  const file = process.env.GEO_TEST_DB;
  assert.ok(file, 'GEO_TEST_DB must point to real GeoLite2-City.mmdb');
  const dir = mkdtempSync(join(tmpdir(), 'geo-positive-'));
  const chunks = [];
  for await (const chunk of create({ gzip: true, cwd: dirname(file) }, [basename(file)])) chunks.push(chunk);
  const archive = Buffer.concat(chunks);
  const server = createServer((req, res) => {
    setTimeout(() => { res.end(req.url.endsWith('.mmdb') ? readFileSync(file) : archive); }, 50);
  });
  try {
    assert.equal(run(dir, ['--check', file]).status, 0);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    for (const suffix of ['city.mmdb', 'city.tar.gz']) {
    const status = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], { cwd: dir, stdio: 'pipe', env: {
        ...process.env, SKIP_BUILD_GEO: '', VERCEL: '',
        GEO_DATABASE_URL: `http://127.0.0.1:${server.address().port}/${suffix}`,
      } });
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.equal(status, 0);
    assert.equal(run(dir).status, 0);
    assert.equal(run(dir, ['--check']).status, 0);
    }
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

const website = '11111111-1111-4111-8111-111111111111';
function fixture(status = 200, rows = '1|1|2') {
  const sent = [];
  let query;
  return {
    sent, get query() { return query; },
    args: { origin: 'http://synthetic.invalid', website,
      request: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status }; },
      sql: async q => { query = q; return rows; },
    },
  };
}
test('gate sends pageview and named event with public IP then verifies persisted rows', async () => {
  const f = fixture();
  assert.deepEqual((await ingestGate(f.args)).statuses, [200, 200]);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].payload.name, undefined);
  assert.ok(f.sent[1].payload.name.startsWith('release-ingest-'));
  for (const event of f.sent) {
    assert.equal(event.payload.website, website);
    assert.equal(event.payload.ip, '8.8.8.8');
  }
  assert.ok(f.query.includes(`e.website_id='${website}'`));
  assert.ok(f.query.includes(f.sent[0].payload.url));
});
test('HTTP failure fails gate before DB check', async () => {
  const f = fixture(500);
  await assert.rejects(ingestGate(f.args), /HTTP 200/);
  assert.equal(f.query, undefined);
});
test('HTTP 200 alone is insufficient: missing pageview, event or geo fails', async () => {
  for (const rows of ['0|1|1', '1|0|1', '1|1|0', '0|0|0']) {
    await assert.rejects(ingestGate(fixture(200, rows).args), /must persist/);
  }
});

test('Docker build includes mandatory validated runtime geo', () => {
  const docker = readFileSync('Dockerfile', 'utf8');
  assert.ok(!docker.includes('ARG SKIP_BUILD_GEO'));
  assert.match(docker, /pnpm build:docker && node scripts\/build-geo.js --check/);
  assert.match(docker, /COPY --from=builder --chown=nextjs:nodejs \/app\/geo .\/geo/);
  assert.match(JSON.parse(readFileSync('package.json')).scripts['build:docker'], /\bbuild:geo\b/);
});
