import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validateImage } from './images.mjs';
import { createQueue } from './queue.mjs';

// Explicit local fixture transport, never selected by production dispatch.
export function launchFixtureWorker() {
  return fork(
    fileURLToPath(new URL('../../../scripts/ai/verifier/child.mjs', import.meta.url)),
    [],
    {
      env: {
        PATH: process.env.PATH,
        HOME: '/tmp',
        PLAYWRIGHT_BROWSERS_PATH:
          process.env.PLAYWRIGHT_BROWSERS_PATH ??
          join(
            homedir(),
            process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright',
          ),
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
}

// Host-only adapter. Production must supply its authenticated authority callback
// and launch this same protocol in the restricted deployment identity.
export function createDispatcher({
  authorize,
  artifacts,
  enabled = false,
  isolated = false,
  origin,
  launch,
  serve,
}) {
  const queue = createQueue();
  return {
    run({ capability, scope, expectedWidgets, signal }) {
      if (!enabled || !isolated || typeof launch !== 'function')
        return Promise.reject(new Error('verifier_unavailable'));
      return queue.submit(
        scope.userId,
        () =>
          new Promise((resolve, reject) => {
            const child = launch();
            let terminal = false;
            let receivingResult = false;
            let imageTransportBytes = 0;
            let jsonTransportBytes = 0;
            let artifact;
            let session;
            const stop = error => {
              if (terminal) return;
              terminal = true;
              clearTimeout(timer);
              signal?.removeEventListener('abort', cancel);
              child.kill();
              if (error) {
                if (artifact) artifacts.discard(artifact.id);
                reject(error);
              }
            };
            const cancel = () => stop(new Error('cancelled_or_timeout'));
            const timer = setTimeout(cancel, 30_000);
            signal?.addEventListener('abort', cancel, { once: true });
            child.on('error', () => stop(new Error('worker_failed')));
            child.on('exit', () => {
              if (!terminal && !receivingResult) stop(new Error('worker_exited'));
            });
            child.on('message', async message => {
              if (terminal) return;
              try {
                if (message.type === 'result')
                  imageTransportBytes += Buffer.byteLength(JSON.stringify(message));
                else jsonTransportBytes += Buffer.byteLength(JSON.stringify(message));
                if (imageTransportBytes > 32 * 1024 * 1024 || jsonTransportBytes > 8 * 1024 * 1024)
                  throw new Error('transport_budget');
                if (message.type === 'http') {
                  // Private-channel canvas request from a network-less worker. The session is
                  // bound to this job on the host and never handed to the child.
                  if (typeof serve !== 'function') throw new Error('no_transport');
                  const response = await serve({
                    method: message.method,
                    path: message.path,
                    body: message.body,
                    cookie: session ? `verifier=${session}` : '',
                  });
                  if (response.session) session = response.session;
                  if (!terminal)
                    child.send({
                      type: 'http',
                      id: message.id,
                      status: response.status,
                      headers: response.headers,
                      body: response.body,
                    });
                } else if (message.type === 'authorize') {
                  const allowed = await authorize(scope);
                  if (!terminal) child.send({ type: 'authority', id: message.id, allowed });
                } else if (message.type === 'result') {
                  if (receivingResult) throw new Error('duplicate_result');
                  receivingResult = true;
                  if (
                    message.receipt.boardId !== scope.boardId ||
                    message.receipt.boardRevision !== scope.boardRevision ||
                    message.receipt.status !== 'rendered_not_inspected' ||
                    JSON.stringify(message.receipt.analysisRevisions) !==
                      JSON.stringify(scope.analysisRevisions) ||
                    !Array.isArray(message.images) ||
                    !message.images.length ||
                    message.images.length > 6 ||
                    !Array.isArray(message.receipt.views) ||
                    message.receipt.views.length !== message.images.length ||
                    !Array.isArray(message.receipt.errors) ||
                    message.receipt.errors.length
                  )
                    throw new Error('invalid_worker_result');
                  const images = message.images.map(image => {
                    if (
                      typeof image.data !== 'string' ||
                      image.data.length > 1_398_104 ||
                      !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
                    )
                      throw new Error('image_budget');
                    const bytes = Buffer.from(image.data, 'base64');
                    validateImage(bytes, image.mime);
                    return { bytes, mime: image.mime };
                  });
                  const views = message.receipt.views.map((view, index) => {
                    const hash = validateImage(images[index].bytes, images[index].mime);
                    if (
                      view.hash !== hash ||
                      !Number.isInteger(view.offset) ||
                      view.offset < 0 ||
                      ![
                        [1440, 1000],
                        [390, 844],
                      ].some(([w, h]) => view.viewport.width === w && view.viewport.height === h) ||
                      !Array.isArray(view.widgets) ||
                      view.widgets.length !== expectedWidgets.length ||
                      new Set(view.widgets.map(w => w.id)).size !== expectedWidgets.length ||
                      view.widgets.some(
                        w =>
                          !expectedWidgets.some(
                            expected =>
                              expected.id === w.id &&
                              expected.executionId === w.executionId &&
                              expected.definitionHash === w.definitionHash,
                          ) || !['rendered', 'empty'].includes(w.state),
                      )
                    )
                      throw new Error('invalid_receipt');
                    return {
                      viewport: { width: view.viewport.width, height: view.viewport.height },
                      hash,
                      offset: view.offset,
                      widgets: view.widgets.map(w => ({
                        id: w.id,
                        state: w.state,
                        executionId: w.executionId,
                        definitionHash: w.definitionHash,
                      })),
                    };
                  });
                  if (
                    !views.some(v => v.viewport.width === 1440) ||
                    !views.some(v => v.viewport.width === 390)
                  )
                    throw new Error('incomplete_coverage');
                  if (terminal || !(await authorize(scope))) throw new Error('revoked');
                  artifact = await artifacts.put(scope, images);
                  if (terminal) {
                    artifacts.discard(artifact.id);
                    return;
                  }
                  stop();
                  resolve({
                    artifactId: artifact.id,
                    receipt: {
                      boardId: scope.boardId,
                      boardRevision: scope.boardRevision,
                      analysisRevisions: scope.analysisRevisions,
                      completedAt: new Date().toISOString(),
                      views,
                      errors: [],
                      status: 'rendered_not_inspected',
                    },
                  });
                } else if (message.type === 'failure') throw new Error('render_unavailable');
              } catch {
                stop(new Error('render_unavailable'));
              }
            });
            if (signal?.aborted) cancel();
            else child.send({ type: 'job', capability, scope, expectedWidgets, origin });
          }),
        signal,
      );
    },
  };
}
