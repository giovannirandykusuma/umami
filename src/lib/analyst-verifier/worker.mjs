import { validateImage } from './images.mjs';

export const VIEWPORTS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];

export function allowedRequest(raw, origin) {
  try {
    const url = new URL(raw);
    return (
      url.origin === origin &&
      !url.username &&
      !url.password &&
      ['/exchange', '/canvas', '/receipt'].includes(url.pathname) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

// This process must run behind the deployment egress policy. Routing is only a
// second boundary, not OS network isolation. No ambient browser profile is reused.
export async function renderJob({
  browser,
  origin,
  capability,
  scope,
  expectedWidgets,
  authorize,
  artifacts,
  signal,
  timeoutMs = 30_000,
  transport,
}) {
  if (timeoutMs > 30_000 || timeoutMs <= 0) throw new Error('invalid_timeout');
  if (!Array.isArray(expectedWidgets) || !expectedWidgets.length)
    throw new Error('missing_provenance');
  const deadline = AbortSignal.timeout(timeoutMs);
  const abort = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
  let context;
  let artifact;
  let cancel;
  const stopped = new Promise((_, reject) => {
    cancel = () => {
      void context?.close();
      reject(new Error('cancelled_or_timeout'));
    };
    abort.addEventListener('abort', cancel, { once: true });
  });
  const work = async () => {
    if (abort.aborted) throw new Error('cancelled_or_timeout');
    if (!(await authorize(scope))) throw new Error('revoked');
    context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    if (abort.aborted) {
      await context.close();
      throw new Error('cancelled_or_timeout');
    }
    await context.route('**/*', route =>
      allowedRequest(route.request().url(), origin) &&
      route.request().method() === 'GET' &&
      !route.request().redirectedFrom() &&
      route.request().url() !== `${origin}/exchange`
        ? transport
          ? transport({ method: 'GET', path: new URL(route.request().url()).pathname }).then(
              r => route.fulfill({ status: r.status, headers: r.headers, body: r.body }),
              () => route.abort(),
            )
          : route.continue()
        : route.abort(),
    );
    // Exchange is server-to-server, redirect disabled, not a capability-bearing URL. With a
    // private transport (network-less container) it goes over that channel, never a socket.
    const status = transport
      ? (
          await transport({
            method: 'POST',
            path: '/exchange',
            body: JSON.stringify({ capability }),
          })
        ).status
      : (
          await context.request.post(`${origin}/exchange`, {
            data: { capability },
            maxRedirects: 0,
            timeout: timeoutMs,
          })
        ).status();
    if (status !== 204) throw new Error('exchange_denied');
    const page = await context.newPage();
    page.on('popup', popup => {
      void popup.close();
    });
    page.on('download', download => {
      void download.cancel();
    });
    const errors = [];
    page.on('pageerror', () => errors.push('page_error'));
    page.on('console', message => {
      if (message.type() === 'error') errors.push('console_error');
    });
    const images = [];
    const views = [];
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.goto(`${origin}/canvas`, { waitUntil: 'load', timeout: timeoutMs });
      await page.waitForFunction(() => window.__verifierReceipt?.complete === true, null, {
        timeout: timeoutMs,
      });
      const receipt = await page.evaluate(() => window.__verifierReceipt);
      if (
        receipt.boardId !== scope.boardId ||
        receipt.boardRevision !== scope.boardRevision ||
        JSON.stringify(receipt.analysisRevisions) !== JSON.stringify(scope.analysisRevisions) ||
        !Array.isArray(receipt.widgets) ||
        !receipt.widgets.length ||
        receipt.widgets.length !== expectedWidgets.length ||
        new Set(receipt.widgets.map(w => w.id)).size !== expectedWidgets.length ||
        receipt.widgets.some(
          w =>
            !expectedWidgets.some(
              expected =>
                expected.id === w.id &&
                expected.executionId === w.executionId &&
                expected.definitionHash === w.definitionHash,
            ) || !['rendered', 'empty'].includes(w.state),
        )
      )
        throw new Error('incomplete_receipt');
      const canvas = page.locator('[data-verifier-canvas]');
      if ((await canvas.count()) !== 1) throw new Error('missing_canvas');
      const box = await canvas.boundingBox();
      const clipped = await canvas.evaluate(el => {
        // No canvas-local scrolling is supported. Refuse hidden/scrolling content,
        // including nested panels and clipping ancestors, rather than certify it.
        for (const node of [el, ...el.querySelectorAll('*')]) {
          if (node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight) {
            const style = getComputedStyle(node);
            if (node === el || style.overflowX !== 'visible' || style.overflowY !== 'visible')
              return true;
          }
        }
        const rect = el.getBoundingClientRect();
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          const bounds = parent.getBoundingClientRect();
          if (
            (style.overflowX !== 'visible' &&
              (rect.left < bounds.left || rect.right > bounds.right)) ||
            (style.overflowY !== 'visible' &&
              (rect.top < bounds.top || rect.bottom > bounds.bottom))
          )
            return true;
        }
        return false;
      });
      if (
        !box ||
        clipped ||
        box.width <= 0 ||
        box.height <= 0 ||
        box.x < 0 ||
        box.y < 0 ||
        box.y >= viewport.height ||
        box.x + box.width > viewport.width
      )
        throw new Error('clipped_canvas');
      const panelHeight = viewport.height - box.y;
      if (panelHeight <= 80) throw new Error('clipped_canvas');
      for (let y = 0; y < box.height; y += panelHeight - 80) {
        if (images.length >= 6) throw new Error('incomplete_coverage');
        const bytes = await page.screenshot({
          type: 'png',
          clip: {
            x: box.x,
            y: box.y + y,
            width: box.width,
            height: Math.min(panelHeight, box.height - y),
          },
          captureBeyondViewport: true,
        });
        const hash = validateImage(bytes, 'image/png');
        images.push({ bytes, mime: 'image/png' });
        views.push({
          viewport,
          hash,
          offset: y,
          widgets: receipt.widgets.map(w => ({
            id: w.id,
            state: w.state,
            executionId: w.executionId,
            definitionHash: w.definitionHash,
          })),
        });
      }
    }
    if (errors.length) throw new Error('browser_errors');
    if (abort.aborted) throw new Error('cancelled_or_timeout');
    if (!(await authorize(scope))) throw new Error('revoked');
    artifact = await artifacts.put(scope, images);
    if (abort.aborted) {
      artifacts.discard(artifact.id);
      throw new Error('cancelled_or_timeout');
    }
    return {
      artifactId: artifact.id,
      receipt: {
        boardId: scope.boardId,
        boardRevision: scope.boardRevision,
        analysisRevisions: scope.analysisRevisions,
        completedAt: new Date().toISOString(),
        views,
        errors,
        status: 'rendered_not_inspected',
      },
    };
  };
  try {
    return await Promise.race([work(), stopped]);
  } catch (error) {
    if (artifact) artifacts.discard(artifact.id);
    throw error;
  } finally {
    abort.removeEventListener('abort', cancel);
    await context?.close();
  }
}
