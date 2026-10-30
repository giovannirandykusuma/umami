// Host-side VerifierPort over the isolated dispatcher. Trusted host code registers the launcher
// and the internal canvas origin; nothing here is selectable from requests, env URLs or model
// input. Without a registered isolated launcher the port does not exist (deps.verifier = null),
// so there is no host-browser fallback.
import { createCapabilityStore } from './capability.mjs';
import { createDispatcher } from './dispatch.mjs';
import { createArtifactStore } from './images.mjs';
import { createCanvasHandler } from './canvas.mjs';
import { isRestrictedLauncher } from './launcher.mjs';
import { randomUUID } from 'node:crypto';

/**
 * @param {{ enabled: boolean, launcher: { launch: () => any, origin: string },
 *   authorize: (scope: any) => Promise<boolean>,
 *   prepare: (scope: any, expected: any[], signal?: AbortSignal) => Promise<any[]> }} options
 * `authorize` re-checks the principal's current authority and exact revisions on every use;
 * `prepare` runs trusted saved executions whose ids/hashes the receipt must match exactly.
 */
export function createVerifierPort({ enabled, launcher, authorize, prepare }) {
  if (!enabled || typeof authorize !== 'function' || typeof prepare !== 'function') return null;
  // Isolation is a property of the trusted launcher implementation, never of a callback shape.
  if (!isRestrictedLauncher(launcher)) return null;
  const { launch, origin } = launcher;
  const parsed = new URL(origin);
  if (parsed.origin !== origin || parsed.protocol !== 'http:') throw new Error('invalid_origin');
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
    serve: createCanvasHandler({ capabilities, jobs }),
  });
  return {
    capabilities,
    async render({ scope, expectedWidgets, signal }) {
      // Trusted host execution of each saved analysis at the captured revision; the receipt must
      // then match these exact execution ids and definition hashes (no wildcard).
      const widgets = await prepare(scope, expectedWidgets, signal);
      const jobId = randomUUID();
      jobs.set(jobId, { widgets });
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
