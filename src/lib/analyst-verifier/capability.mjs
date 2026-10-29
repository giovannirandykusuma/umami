// Short-lived, single-use, audience-bound verifier capabilities (spec §4.1).
// Only SHA-256 digests of token material are stored; tokens are never logged.
import { createHash, randomBytes } from 'node:crypto';

export const VERIFIER_AUDIENCE = 'analyst-verifier';
export const CAPABILITY_TTL_MS = 60_000;
export const SESSION_TTL_MS = 30_000;

const digest = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');

export class CapabilityError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function validScope(scope) {
  const ids = ['userId', 'taskId', 'boardId'];
  if (!scope || ids.some(k => typeof scope[k] !== 'string' || !scope[k])) return false;
  if (!Number.isInteger(scope.boardRevision) || scope.boardRevision < 1) return false;
  const analyses = scope.analysisRevisions;
  return (
    analyses !== null &&
    typeof analyses === 'object' &&
    !Array.isArray(analyses) &&
    Object.keys(analyses).length > 0 &&
    Object.values(analyses).every(r => Number.isInteger(r) && r >= 1)
  );
}

/**
 * @param {{ now?: () => number, authorize: (scope: object) => Promise<boolean> | boolean }} options
 * `authorize` re-checks current authority (permissions + exact revisions) on every use.
 */
export function createCapabilityStore({ now = Date.now, authorize }) {
  if (typeof authorize !== 'function') throw new Error('authorize callback required');
  const capabilities = new Map();
  const sessions = new Map();
  let revocationEpoch = 0;

  function sweep() {
    const t = now();
    for (const [k, v] of capabilities) if (v.expiresAt <= t) capabilities.delete(k);
    for (const [k, v] of sessions) if (v.expiresAt <= t) sessions.delete(k);
  }

  return {
    issue(scope) {
      if (!validScope(scope)) throw new CapabilityError('invalid_scope');
      sweep();
      const value = token();
      const frozen = Object.freeze({
        ...scope,
        analysisRevisions: Object.freeze({ ...(scope.analysisRevisions ?? {}) }),
      });
      capabilities.set(digest(value), {
        scope: frozen,
        audience: VERIFIER_AUDIENCE,
        expiresAt: now() + CAPABILITY_TTL_MS,
      });
      return { token: value, expiresAt: now() + CAPABILITY_TTL_MS };
    },

    // Single use: the capability is deleted before any other check can succeed or fail.
    async exchange(value, audience) {
      sweep();
      const key = typeof value === 'string' ? digest(value) : '';
      const cap = capabilities.get(key);
      capabilities.delete(key);
      if (!cap) throw new CapabilityError('invalid_capability');
      if (audience !== cap.audience) throw new CapabilityError('wrong_audience');
      const epoch = revocationEpoch;
      if (!(await authorize(cap.scope)) || epoch !== revocationEpoch)
        throw new CapabilityError('revoked');
      if (cap.expiresAt <= now()) throw new CapabilityError('expired_capability');
      const sessionId = token();
      sessions.set(digest(sessionId), { scope: cap.scope, expiresAt: now() + SESSION_TTL_MS });
      return { sessionId, scope: cap.scope, readOnly: true };
    },

    // Read-only, restricted session lookup: re-validates authority on every request.
    async resolve(sessionId, request) {
      sweep();
      const session = typeof sessionId === 'string' ? sessions.get(digest(sessionId)) : undefined;
      if (!session) throw new CapabilityError('invalid_session');
      if (request?.method !== 'GET') throw new CapabilityError('read_only');
      const { scope } = session;
      if (request?.boardId !== undefined && request.boardId !== scope.boardId)
        throw new CapabilityError('out_of_scope');
      if (request?.boardRevision !== undefined && request.boardRevision !== scope.boardRevision)
        throw new CapabilityError('stale_revision');
      if (
        request?.analysisId !== undefined &&
        !Object.hasOwn(scope.analysisRevisions, request.analysisId)
      )
        throw new CapabilityError('out_of_scope');
      const epoch = revocationEpoch;
      if (!(await authorize(scope)) || epoch !== revocationEpoch) {
        sessions.delete(digest(sessionId));
        throw new CapabilityError('revoked');
      }
      if (session.expiresAt <= now() || sessions.get(digest(sessionId)) !== session) {
        sessions.delete(digest(sessionId));
        throw new CapabilityError('expired_session');
      }
      return scope;
    },

    revoke({ userId, taskId }) {
      revocationEpoch++;
      const match = s =>
        (userId && s.scope.userId === userId) || (taskId && s.scope.taskId === taskId);
      for (const [k, v] of capabilities) if (match(v)) capabilities.delete(k);
      for (const [k, v] of sessions) if (match(v)) sessions.delete(k);
    },

    size: () => (sweep(), capabilities.size + sessions.size),
  };
}
