// Host-side VerifierPort over the isolated dispatcher. Trusted host code registers the launcher
// and the internal canvas origin; nothing here is selectable from requests, env URLs or model
// input. Without a registered isolated launcher the port does not exist (deps.verifier = null),
// so there is no host-browser fallback.
import { createCapabilityStore } from './capability.mjs';
import { createDispatcher } from './dispatch.mjs';
import { createArtifactStore } from './images.mjs';
import { createCanvasHandler } from './canvas.mjs';
import { isRestrictedLauncher } from './launcher.mjs';
import { randomUUID, randomBytes } from 'node:crypto';
import { realpath, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

// Only canonical build artifacts are served; never a general app/HTTP proxy.
export async function createBuiltRenderer({ root, port }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid_port');
  const staticRoot = await realpath(resolve(root, '.next/static'));
  return async ({ path, credential }) => {
    if (path === '/canvas') {
      const job = await resolvePrivateRender(credential);
      const native = job.widgets.find(w => w.native)?.native;
      const query = native ? `?date=range:${native.range.startAt}:${native.range.endAt}` : '';
      const response = await fetch(`http://127.0.0.1:${port}/verifier-canvas${query}`, {
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { 'x-verifier-transport': credential },
      });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/html'))
        throw new Error('renderer_denied');
      const body = await response.text();
      if (Buffer.byteLength(body) > 3_000_000) throw new Error('renderer_payload_too_large');
      return {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        body,
      };
    }
    if (
      !/^\/_next\/static\/(?:[A-Za-z0-9_()-]+\/)*[A-Za-z0-9_.-]+\.(?:js|css|woff2?)$/.test(path) ||
      path.includes('..')
    )
      throw new Error('asset_denied');
    await resolvePrivateRender(credential);
    const file = resolve(staticRoot, path.slice('/_next/static/'.length));
    if ((await realpath(file)) !== file || !file.startsWith(`${staticRoot}${sep}`))
      throw new Error('asset_denied');
    const bytes = await readFile(file);
    if (bytes.length > 4_000_000) throw new Error('asset_too_large');
    const font = /\.woff2?$/.test(path);
    return {
      status: 200,
      headers: {
        'Content-Type': font
          ? 'font/woff2'
          : path.endsWith('.css')
            ? 'text/css'
            : 'application/javascript',
        'Cache-Control': 'no-store',
        ...(font ? { 'X-Verifier-Encoding': 'base64' } : {}),
      },
      body: bytes.toString(font ? 'base64' : 'utf8'),
    };
  };
}

// Server-only, process-local, per-job transport authority. Never passed to the model/worker.
const privateJobsKey = Symbol.for('umami.verifier.privateJobs');
if (!globalThis[privateJobsKey]) globalThis[privateJobsKey] = new Map();
const privateJobs = globalThis[privateJobsKey];
export async function resolvePrivateRender(credential) {
  const job = privateJobs.get(credential);
  if (!job || !(await job.authorize(job.scope))) throw new Error('revoked');
  return job;
}

/**
 * @param {{ enabled: boolean, launcher: { launch: () => any, origin: string },
 *   authorize: (scope: any) => Promise<boolean>,
 *   prepare: (scope: any, expected: any[], signal?: AbortSignal) => Promise<any[]> }} options
 * `authorize` re-checks the principal's current authority and exact revisions on every use;
 * `prepare` runs trusted saved executions whose ids/hashes the receipt must match exactly.
 */
export function createVerifierPort({ enabled, launcher, authorize, prepare, renderer }) {
  if (!enabled || typeof authorize !== 'function' || typeof prepare !== 'function') return null;
  // Isolation is a property of the trusted launcher implementation, never of a callback shape.
  if (!isRestrictedLauncher(launcher)) return null;
  const { launch, origin } = launcher;
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.protocol !== 'http:') throw new Error('invalid_origin');
  } catch {
    throw new Error('invalid_origin');
  }
  const capabilities = createCapabilityStore({ authorize });
  const artifacts = createArtifactStore({ authorize });
  const jobs = new Map();
  const dispatcher = createDispatcher({
    enabled: true,
    isolated: true,
    origin,
    authorize,
    artifacts,
    launch,
    serve: createCanvasHandler({ capabilities, jobs, renderer }),
  });
  return {
    capabilities,
    async render({ scope, expectedWidgets, signal }) {
      // Trusted host execution of each saved analysis at the captured revision; the receipt must
      // then match these exact execution ids and definition hashes (no wildcard).
      const widgets = await prepare(scope, expectedWidgets, signal);
      const jobId = randomUUID();
      const credential = randomBytes(32).toString('base64url');
      privateJobs.set(credential, { widgets, scope, authorize });
      jobs.set(jobId, { widgets, credential });
      try {
        const { token } = capabilities.issue({ ...scope, jobId });
        return await dispatcher.run({
          capability: token,
          scope,
          expectedWidgets: widgets.map(w => ({
            id: w.id,
            executionId: w.executionId,
            definitionHash: w.definitionHash,
          })),
          signal,
        });
      } finally {
        jobs.delete(jobId);
        privateJobs.delete(credential);
      }
    },
    fetch: (artifactId, principal) => artifacts.get(artifactId, principal),
    discard: artifactId => artifacts.discard(artifactId),
    cleanup(scope) {
      capabilities.revoke(scope);
      artifacts.cleanup(scope);
    },
  };
}

let registered = null;
/** Called once by trusted bootstrap with a restricted launcher built by launcher.mjs. */
export function registerIsolatedLauncher(launcher) {
  if (registered) throw new Error('launcher_already_registered');
  if (!isRestrictedLauncher(launcher)) throw new Error('invalid_launcher');
  registered = launcher;
}
export const isolatedLauncher = () => registered;
