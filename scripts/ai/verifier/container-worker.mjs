// Runs INSIDE the network-less verifier container (see src/lib/analyst-verifier/launcher.mjs).
// Protocol: JSON lines on stdin/stdout only. The browser never opens a socket: every canvas
// request is fulfilled through the host over this channel; anything else is aborted in-browser.
import { createInterface } from 'node:readline';
import { chromium } from 'playwright-core';
import { renderJob } from '../../../src/lib/analyst-verifier/worker.mjs';
import { createArtifactStore } from '../../../src/lib/analyst-verifier/images.mjs';

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const waiting = new Map();
let sequence = 0;
const request = (type, payload) =>
  new Promise(resolve => {
    const id = ++sequence;
    waiting.set(id, resolve);
    send({ type, id, ...payload });
  });
const authorize = async scope => (await request('authorize', { scope })).allowed === true;
const transport = async ({ method, path, body }) => request('http', { method, path, body });

const controller = new AbortController();
let used = false;
let browser;
createInterface({ input: process.stdin }).on('line', async line => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.exit(1);
  }
  if (message.type === 'authority' || message.type === 'http') {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
  if (message.type === 'cancel') return controller.abort();
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
      transport,
    });
    const images = await artifacts.get(result.artifactId, message.scope);
    await browser.close();
    send({
      type: 'result',
      receipt: result.receipt,
      images: images.map(image => ({ mime: image.mime, data: image.bytes.toString('base64') })),
    });
  } catch {
    await browser?.close();
    send({ type: 'failure', code: 'render_unavailable' });
  }
  process.exit(0);
});
process.stdin.on('end', () => {
  controller.abort();
  void browser?.close().finally(() => process.exit(0));
});
