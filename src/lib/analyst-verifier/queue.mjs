// A host-only queue: callers cannot increase concurrency or deadlines.
export function createQueue({ now = Date.now, queueTimeoutMs = 30_000 } = {}) {
  if (queueTimeoutMs > 30_000 || queueTimeoutMs <= 0) throw new Error('invalid_queue_timeout');
  const pending = [];
  const users = new Set();
  let running = 0;
  function pump() {
    for (const job of [...pending]) {
      if (job.signal?.aborted || now() - job.created >= queueTimeoutMs) {
        pending.splice(pending.indexOf(job), 1);
        clearTimeout(job.timer);
        job.reject(new Error('queue_cancelled_or_timeout'));
        continue;
      }
      if (running >= 2 || users.has(job.userId)) continue;
      pending.splice(pending.indexOf(job), 1);
      clearTimeout(job.timer);
      running++;
      users.add(job.userId);
      Promise.resolve()
        .then(() => {
          if (job.signal?.aborted) throw new Error('queue_cancelled_or_timeout');
          return job.run();
        })
        .then(job.resolve, job.reject)
        .finally(() => {
          running--;
          users.delete(job.userId);
          pump();
        });
    }
  }
  return {
    submit(userId, run, signal) {
      return new Promise((resolve, reject) => {
        const job = { userId, run, signal, resolve, reject, created: now() };
        job.timer = setTimeout(pump, queueTimeoutMs);
        pending.push(job);
        signal?.addEventListener('abort', pump, { once: true });
        pump();
      });
    },
  };
}
