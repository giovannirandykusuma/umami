// Real end-to-end proof of the restricted launcher (local Docker only, synthetic data).
// Uses the production port + launcher + network-less container. The trusted `prepare` and
// `authorize` here are synthetic stand-ins for deps.ts (no database needed).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createVerifierPort } from '../../../src/lib/analyst-verifier/port.mjs';
import {
  createDockerLauncher,
  VERIFIER_IMAGE,
} from '../../../src/lib/analyst-verifier/launcher.mjs';
import { VERIFIER_AUDIENCE } from '../../../src/lib/analyst-verifier/capability.mjs';

const scope = {
  userId: 'u',
  taskId: 't',
  boardId: 'b',
  boardRevision: 3,
  analysisRevisions: { a: 2 },
};
const hash = 'c'.repeat(64);
let executions = 0;
const prepare = async (_scope, expected) =>
  expected.map(w => ({
    id: w.id,
    title: 'Synthetic pageviews',
    executionId: `exec-${++executions}`,
    definitionHash: w.definitionHash,
    columns: [
      { key: 'metric', label: 'Metric' },
      { key: 'value', label: 'Value' },
    ],
    rows: [{ metric: 'pageviews', value: 42 }],
  }));

let allowed = true;
const port = createVerifierPort({
  enabled: true,
  launcher: createDockerLauncher(),
  authorize: async () => allowed,
  prepare,
});
const rendered = await port.render({
  scope,
  expectedWidgets: [{ id: 'w1', executionId: '', definitionHash: hash }],
});
assert.equal(rendered.receipt.status, 'rendered_not_inspected');
assert.equal(rendered.receipt.views.length, 2);
for (const view of rendered.receipt.views)
  assert.deepEqual(
    view.widgets.map(w => [w.id, w.executionId, w.definitionHash, w.state]),
    [['w1', 'exec-1', hash, 'rendered']],
  );
const images = await port.fetch(rendered.artifactId, { userId: 'u', taskId: 't' });
assert.equal(images.length, 2);
await assert.rejects(port.capabilities.exchange('forged', VERIFIER_AUDIENCE), /invalid_capability/);

// Revoked authority mid-flight: render must fail closed.
allowed = false;
await assert.rejects(
  port.render({ scope, expectedWidgets: [{ id: 'w1', executionId: '', definitionHash: hash }] }),
);

// Raw egress from the same image under the same flags: no interface but loopback, no DNS, no TCP.
const probe = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--network',
    'none',
    '--user',
    '10001:10001',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    VERIFIER_IMAGE,
    'node',
    '-e',
    `const net=require('node:net');const os=require('node:os');
     const ifs=Object.keys(os.networkInterfaces());
     const tcp=h=>new Promise(r=>{const s=net.connect({host:h,port:80,timeout:2000});s.on('connect',()=>{s.destroy();r('open')});s.on('error',e=>r(e.code));s.on('timeout',()=>{s.destroy();r('timeout')})});
     require('node:dns').lookup('example.com',async e=>{console.log(JSON.stringify({ifs,dns:e?.code??'resolved',ip:await tcp('1.1.1.1'),metadata:await tcp('169.254.169.254'),hostGateway:await tcp('host.docker.internal')}))});`,
  ],
  { encoding: 'utf8' },
);
const egress = JSON.parse(probe.stdout.trim());
assert.deepEqual(egress.ifs, ['lo']);
for (const key of ['dns', 'ip', 'metadata', 'hostGateway']) assert.notEqual(egress[key], 'open');
assert.notEqual(egress.dns, 'resolved');
console.log(
  JSON.stringify({
    receipt: rendered.receipt.views.map(v => ({
      viewport: v.viewport,
      hash: v.hash,
      widgets: v.widgets,
    })),
    images: images.length,
    revokedRenderRejected: true,
    egress,
  }),
);
