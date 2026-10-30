// @vitest-environment node
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { crc32, deflateSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { createDockerLauncher, dockerArgs, VERIFIER_ORIGIN } from './launcher.mjs';
import { createVerifierPort, isolatedLauncher, registerIsolatedLauncher } from './port.mjs';
import { VERIFIER_AUDIENCE } from './capability.mjs';

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const content = Buffer.concat([Buffer.from(type), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(content));
  return Buffer.concat([length, content, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(1, 0);
header.writeUInt32BE(1, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 255]))),
  chunk('IEND', Buffer.alloc(0)),
]);
const scope = {
  userId: 'u',
  taskId: 't',
  boardId: 'b',
  boardRevision: 3,
  analysisRevisions: { a: 2 },
};
const widgets = [{ id: 'w', executionId: 'e1', definitionHash: 'h'.repeat(64) }];

/**
 * Simulated container behind the REAL docker launcher (spawn seam): it speaks the stdio protocol,
 * performs the capability exchange and canvas GET over the private channel, then answers.
 */
function fakeLaunch(result: (job: any, canvas: string) => any) {
  const jobs: any[] = [];
  const argv: string[][] = [];
  const spawn = (_cmd: string, args: string[]) => {
    argv.push(args);
    const proc: any = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stdin = new PassThrough();
    proc.kill = () => undefined;
    const pending = new Map<number, (m: any) => void>();
    let id = 0;
    const ask = (m: any) =>
      new Promise<any>(r => {
        pending.set(++id, r);
        proc.stdout.write(`${JSON.stringify({ ...m, id })}\n`);
      });
    createInterface({ input: proc.stdin }).on('line', async line => {
      const m = JSON.parse(line);
      if (m.type === 'http' || m.type === 'authority') return pending.get(m.id)?.(m);
      if (m.type !== 'job') return;
      jobs.push(m);
      const exchange = await ask({
        type: 'http',
        method: 'POST',
        path: '/exchange',
        body: JSON.stringify({ capability: m.capability }),
      });
      const canvas =
        exchange.status === 204
          ? await ask({ type: 'http', method: 'GET', path: '/canvas' })
          : { body: '' };
      proc.stdout.write(`${JSON.stringify(result(m, canvas.body))}\n`);
    });
    return proc;
  };
  return { launcher: createDockerLauncher({ spawn: spawn as any }), jobs, argv };
}
/** Trusted host execution double: returns the exact ids/hashes the receipt must match. */
const prepare = async (_scope: any, expected: any[]) =>
  expected.map(w => ({
    id: w.id,
    executionId: 'e1',
    definitionHash: w.definitionHash,
    columns: [{ key: 'value', label: 'Value', type: 'number' }],
    rows: [{ value: 42 }],
  }));
const view = (width: number, height: number, w = widgets) => ({
  viewport: { width, height },
  hash: createHash('sha256').update(png).digest('hex'),
  offset: 0,
  widgets: w.map(x => ({ ...x, state: 'rendered' })),
});
const good = (job: any, canvas = '') => ({
  type: 'result',
  receipt: {
    boardId: job.scope.boardId,
    boardRevision: job.scope.boardRevision,
    analysisRevisions: job.scope.analysisRevisions,
    status: 'rendered_not_inspected',
    views: [view(1440, 1000), view(390, 844)],
    errors: [],
  },
  images: [0, 1].map(() => ({ mime: 'image/png', data: png.toString('base64') })),
});

it('fails closed: flag off, missing prepare, or a callback-shaped (non-restricted) launcher', () => {
  const { launcher } = fakeLaunch(good);
  const authorize = async () => true;
  expect(createVerifierPort({ enabled: false, launcher, authorize, prepare })).toBeNull();
  expect(
    createVerifierPort({ enabled: true, launcher, authorize, prepare: undefined as any }),
  ).toBeNull();
  // A mere {launch, origin} object no longer asserts isolation.
  const mock = { launch: launcher.launch, origin: VERIFIER_ORIGIN };
  expect(createVerifierPort({ enabled: true, launcher: mock, authorize, prepare })).toBeNull();
  expect(isolatedLauncher()).toBeNull();
  expect(() => registerIsolatedLauncher(mock)).toThrow('invalid_launcher');
});

it('docker argv: no network, non-root, cap-drop ALL, read-only, no-new-privileges, no mounts/env', () => {
  const args = dockerArgs('n');
  const pair = (flag: string) => args[args.indexOf(flag) + 1];
  expect(pair('--network')).toBe('none');
  expect(pair('--user')).toBe('10001:10001');
  expect(pair('--cap-drop')).toBe('ALL');
  expect(pair('--security-opt')).toBe('no-new-privileges');
  expect(args).toContain('--read-only');
  for (const forbidden of [
    '-v',
    '--volume',
    '--mount',
    '-e',
    '--env',
    '--env-file',
    '-p',
    '--publish',
    '--privileged',
    '--cap-add',
  ])
    expect(args).not.toContain(forbidden);
});

it('render: capability exchange over the private channel, canvas from trusted executions, exact binding', async () => {
  let page = '';
  const { launcher, jobs, argv } = fakeLaunch((job, canvas) => {
    page = canvas;
    return good(job);
  });
  const port = createVerifierPort({
    enabled: true,
    launcher,
    authorize: async () => true,
    prepare,
  })!;
  const rendered = await port.render({ scope, expectedWidgets: widgets, signal: undefined });
  expect(argv[0]).toEqual(expect.arrayContaining(['--network', 'none']));
  expect(page).toContain('data-execution-id="e1"');
  expect(page).toContain(`data-definition-hash="${'h'.repeat(64)}"`);
  expect(page).toContain('pre-B3 data table');
  expect(rendered.receipt.views[0].widgets[0]).toMatchObject({
    executionId: 'e1',
    definitionHash: 'h'.repeat(64),
  });
  // The capability was consumed by the in-channel exchange; it cannot be replayed.
  await expect(port.capabilities.exchange(jobs[0].capability, VERIFIER_AUDIENCE)).rejects.toThrow(
    'invalid_capability',
  );
  await expect(port.fetch(rendered.artifactId, { userId: 'x', taskId: 't' })).rejects.toThrow(
    'out_of_scope',
  );
  expect(await port.fetch(rendered.artifactId, { userId: 'u', taskId: 't' })).toHaveLength(2);
  port.cleanup({ userId: 'u', taskId: 't' });
  await expect(port.fetch(rendered.artifactId, { userId: 'u', taskId: 't' })).rejects.toThrow();
});

it('canvas is denied without the exchanged session', async () => {
  let page = 'unset';
  const { launcher } = fakeLaunch((job, canvas) => {
    page = canvas;
    return { type: 'failure', code: 'x' };
  });
  const port = createVerifierPort({
    enabled: true,
    launcher,
    authorize: async () => false,
    prepare,
  })!;
  await expect(
    port.render({ scope, expectedWidgets: widgets, signal: undefined }),
  ).rejects.toThrow();
  expect(page).toBe('');
});

it('rejects stale revision, foreign/empty execution, foreign hash and revoked authority', async () => {
  for (const mutate of [
    (r: any) => (r.receipt.boardRevision = 2),
    (r: any) => (r.receipt.views[0].widgets[0].executionId = 'other'),
    (r: any) => (r.receipt.views[0].widgets[0].executionId = ''),
    (r: any) => (r.receipt.views[1].widgets[0].definitionHash = 'x'.repeat(64)),
  ]) {
    const { launcher } = fakeLaunch(job => {
      const r = good(job);
      mutate(r);
      return r;
    });
    const port = createVerifierPort({
      enabled: true,
      launcher,
      authorize: async () => true,
      prepare,
    })!;
    await expect(
      port.render({ scope, expectedWidgets: widgets, signal: undefined }),
    ).rejects.toThrow('render_unavailable');
  }
  const { launcher } = fakeLaunch(good);
  const revoked = createVerifierPort({
    enabled: true,
    launcher,
    authorize: async () => false,
    prepare,
  })!;
  await expect(
    revoked.render({ scope, expectedWidgets: widgets, signal: undefined }),
  ).rejects.toThrow();
});

it('registration accepts only a restricted launcher, once', () => {
  const { launcher } = fakeLaunch(good);
  registerIsolatedLauncher(launcher);
  expect(isolatedLauncher()).toBe(launcher);
  expect(() => registerIsolatedLauncher(fakeLaunch(good).launcher)).toThrow(
    'launcher_already_registered',
  );
});

it('canvas handler: no session, forged session, or reused capability is denied', async () => {
  const { createCanvasHandler } = await import('./canvas.mjs');
  const { createCapabilityStore } = await import('./capability.mjs');
  const capabilities = createCapabilityStore({ authorize: async () => true });
  const jobs = new Map([['j', { widgets: [] }]]);
  const serve = createCanvasHandler({ capabilities, jobs });
  expect((await serve({ method: 'GET', path: '/canvas', cookie: '' })).status).toBe(403);
  expect((await serve({ method: 'GET', path: '/canvas', cookie: 'verifier=forged' })).status).toBe(
    403,
  );
  const { token } = capabilities.issue({ ...scope, jobId: 'j' });
  const body = JSON.stringify({ capability: token });
  const exchanged = await serve({ method: 'POST', path: '/exchange', body });
  expect(exchanged.status).toBe(204);
  expect((await serve({ method: 'POST', path: '/exchange', body })).status).toBe(403);
  const ok = await serve({
    method: 'GET',
    path: '/canvas',
    cookie: `verifier=${exchanged.session}`,
  });
  expect(ok.status).toBe(200);
  expect(
    (await serve({ method: 'POST', path: '/canvas', cookie: `verifier=${exchanged.session}` }))
      .status,
  ).toBe(403);
});
