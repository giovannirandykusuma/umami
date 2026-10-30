// Query-backed render receipt attributes for board widgets. State comes ONLY from the query result
// (loading / error / data), never from whether a canvas element exists. The verifier reads these
// via the canvas page's window.__verifierReceipt; see wiki contract in the integration result.

export type RenderState = 'loading' | 'rendered' | 'empty' | 'error' | 'denied' | 'unsupported';

export interface RenderReceipt {
  state: RenderState;
  executionId?: string;
  definitionHash?: string;
}

export function queryRenderState(query: {
  isLoading?: boolean;
  error?: { code?: string; status?: number } | null;
  data?: unknown;
  isEmpty?: (data: any) => boolean;
}): RenderState {
  if (query.error) {
    if (query.error.status === 401 || query.error.status === 403 || query.error.code === 'denied')
      return 'denied';
    if (query.error.code === 'unsupported') return 'unsupported';
    return 'error';
  }
  if (query.isLoading || query.data === undefined) return 'loading';
  return query.isEmpty?.(query.data) ? 'empty' : 'rendered';
}

/** DOM attributes; execution/hash are present only when the query actually returned them. */
export function receiptAttributes(receipt?: RenderReceipt) {
  if (!receipt) return {};
  return {
    'data-analysis-state': receipt.state,
    ...(receipt.executionId ? { 'data-execution-id': receipt.executionId } : {}),
    ...(receipt.definitionHash ? { 'data-definition-hash': receipt.definitionHash } : {}),
  };
}
