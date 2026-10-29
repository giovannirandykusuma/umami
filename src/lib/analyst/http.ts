import { AnalysisError } from './definition';

const STATUS: Record<string, number> = {
  denied: 403,
  not_found: 404,
  conflict: 409,
  feature_disabled: 404,
  unsupported_sharing: 422,
  result_too_large: 422,
  execution_failed: 502,
};

/** Lifecycle creation/edit/preview is off unless explicitly enabled; execution stays available. */
export function isAnalystEnabled() {
  return process.env.AI_ANALYST_ENABLED === 'true';
}

export function analysisErrorResponse(error: unknown) {
  if (!(error instanceof AnalysisError)) throw error;
  return Response.json({ error: error.toJSON() }, { status: STATUS[error.code] ?? 400 });
}

export function disabledResponse() {
  return analysisErrorResponse(
    new AnalysisError('feature_disabled', 'Analyst lifecycle is disabled'),
  );
}
