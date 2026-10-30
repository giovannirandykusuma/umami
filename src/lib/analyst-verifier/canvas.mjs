// Host-side canvas/exchange service for the network-less verifier container. Requests arrive only
// over the dispatcher's private stdio channel (never a listening socket). Every request is
// authenticated: /exchange consumes a single-use capability; /canvas and /receipt need the
// resulting read-only session, which re-checks live authority on each use.
//
// PRE-B3 CANVAS: this renders a minimal query-backed data table per widget from the host's own
// trusted saved executions. It is NOT the real board/AnalysisWidget route; real-widget capture
// stays pending until the UI checkpoint is restored.
import { VERIFIER_AUDIENCE } from './capability.mjs';

const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";
const html = value =>
  String(value).replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

function table(widget) {
  const columns = widget.columns ?? [];
  const head = columns.map(c => `<th>${html(c.label)}</th>`).join('');
  const body = (widget.rows ?? [])
    .slice(0, 200)
    .map(row => `<tr>${columns.map(c => `<td>${html(row[c.key] ?? '')}</td>`).join('')}</tr>`)
    .join('');
  const state = widget.rows?.length ? 'rendered' : 'empty';
  return `<section data-widget-id="${html(widget.id)}" data-analysis-state="${state}" data-execution-id="${html(widget.executionId)}" data-definition-hash="${html(widget.definitionHash)}"><h2>${html(widget.title ?? widget.id)}</h2><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
}

/**
 * @param {{ capabilities: ReturnType<import('./capability.mjs').createCapabilityStore>,
 *   jobs: Map<string, { widgets: any[] }> }} options
 */
export function createCanvasHandler({ capabilities, jobs }) {
  /** @param {{ method: string, path: string, cookie?: string, body?: string }} request */
  return async function handle({ method, path, cookie, body }) {
    const headers = { 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP };
    try {
      if (path === '/exchange') {
        if (method !== 'POST' || typeof body !== 'string' || body.length > 1024)
          return { status: 403, headers, body: '' };
        const exchanged = await capabilities.exchange(
          JSON.parse(body).capability,
          VERIFIER_AUDIENCE,
        );
        return { status: 204, headers, body: '', session: exchanged.sessionId };
      }
      if (method !== 'GET' || !['/canvas', '/receipt'].includes(path))
        return { status: 403, headers, body: '' };
      const session = /(?:^|; )verifier=([A-Za-z0-9_-]+)/.exec(cookie ?? '')?.[1];
      const scope = await capabilities.resolve(session, { method });
      const job = jobs.get(scope.jobId);
      if (!job) return { status: 403, headers, body: '' };
      if (path === '/receipt')
        return {
          status: 200,
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ boardId: scope.boardId, boardRevision: scope.boardRevision }),
        };
      // The receipt is derived in-page from the query-backed DOM attributes, not from canvas
      // presence; the dispatcher then requires an exact execution/hash/revision match.
      return {
        status: 200,
        headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
        body: `<!doctype html><html><head><title>Verifier canvas (pre-B3 data table)</title><style>
* {box-sizing:border-box} body {margin:0;font:14px sans-serif}
main {width:100%;padding:16px} section {border:1px solid #888;margin:0 0 12px;padding:12px;overflow-wrap:anywhere}
table {border-collapse:collapse;width:100%} td,th {border:1px solid #ccc;padding:4px;text-align:left}
</style></head><body><main data-verifier-canvas>${job.widgets.map(table).join('')}</main>
<script>window.__verifierReceipt={boardId:${JSON.stringify(scope.boardId)},boardRevision:${scope.boardRevision},analysisRevisions:${JSON.stringify(scope.analysisRevisions)},
widgets:[...document.querySelectorAll('[data-widget-id]')].map(el=>({id:el.dataset.widgetId,state:el.dataset.analysisState,executionId:el.dataset.executionId,definitionHash:el.dataset.definitionHash})),complete:true};</script></body></html>`,
      };
    } catch {
      return { status: 403, headers, body: '' };
    }
  };
}
