export function afterFrames(count, signal) {
  return new Promise((resolve, reject) => {
    let frame;
    const cleanup = () => { cancelAnimationFrame(frame); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const tick = () => {
      if (--count <= 0) { cleanup(); resolve(); }
      else frame = requestAnimationFrame(tick);
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    frame = requestAnimationFrame(tick);
  });
}

// Cancel the wait even when a library's underlying decoder cannot be cancelled.
export function abortable(promise, signal, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let timeout;
    const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    if (signal?.aborted) { Promise.resolve(promise).catch(() => {}); return abort(); }
    signal?.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => {
      cleanup(); reject(new Error('Raster loading timed out. Incomplete trial discarded.'));
    }, timeoutMs);
    Promise.resolve(promise).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

export async function waitUntil(predicate, signal) {
  const start = performance.now();
  do {
    await afterFrames(1, signal);
    if (performance.now() - start > 45000) throw new Error('Raster tiles did not finish loading. Trial discarded.');
  } while (!predicate());
}

export function waitForMapEvent({ on, off, trigger }, event, signal) {
  return new Promise((resolve, reject) => {
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      off(event, done);
      signal?.removeEventListener('abort', abort);
    };
    const done = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(signal.reason); };
    if (signal?.aborted) return abort();
    on(event, done);
    signal?.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Map did not reach ${event} within 15 seconds. No result was recorded for this trial.`));
    }, 15000);
    try { trigger(); } catch (error) { cleanup(); reject(error); }
  });
}
