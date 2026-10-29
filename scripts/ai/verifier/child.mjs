// Private host IPC only. The model never receives this protocol or generic inputs.
import { chromium } from '@playwright/test';
import { renderJob } from '../../../src/lib/analyst-verifier/worker.mjs';
import { createArtifactStore } from '../../../src/lib/analyst-verifier/images.mjs';

let used = false;
let browser;
const controller = new AbortController();
const authorityRequests = new Map();
let sequence = 0;
const authorize = scope =>
  new Promise(resolve => {
    const id = ++sequence;
    authorityRequests.set(id, resolve);
    process.send({ type: 'authorize', id, scope });
  });
process.on('disconnect', () => {
  controller.abort();
  void browser?.close();
});
process.on('message', async message => {
  if (message.type === 'authority') {
    authorityRequests.get(message.id)?.(message.allowed === true);
    authorityRequests.delete(message.id);
    return;
  }
  if (message.type === 'cancel') {
    controller.abort();
    return;
  }
  if (message.type !== 'job' || used) return;
  used = true;
  try {
    browser = await chromium.launch({ headless: true });
    const artifacts = createArtifactStore({ authorize });
    const result = await renderJob({
      browser,
      origin: message.origin,
      capability: message.capability,
      scope: message.scope,
      expectedWidgets: message.expectedWidgets,
      authorize,
      artifacts,
      signal: controller.signal,
    });
    const images = await artifacts.get(result.artifactId, message.scope);
    artifacts.discard(result.artifactId);
    await browser.close();
    process.send(
      {
        type: 'result',
        receipt: result.receipt,
        images: images.map(image => ({ mime: image.mime, data: image.bytes.toString('base64') })),
      },
      () => process.disconnect(),
    );
  } catch {
    await browser?.close();
    process.send({ type: 'failure', code: 'render_unavailable' }, () => process.disconnect());
  }
});
