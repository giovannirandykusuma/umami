/** Server-side opt-ins. Missing or unrecognized values keep new analyst features off. */
export function isAnalystEnabled(): boolean {
  return process.env.AI_ANALYST_ENABLED === 'true';
}

/** Verifier opt-in never substitutes for an explicitly isolated launcher. */
export function isAnalystVerifierEnabled(): boolean {
  return process.env.AI_ANALYST_VERIFIER_ENABLED === 'true';
}
