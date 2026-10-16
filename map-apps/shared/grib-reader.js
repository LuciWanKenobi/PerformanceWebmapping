import { recordWorkerResource } from './benchmark/network.js';
import { createGribModuleLoader } from './grib-wasm.js';
import { recordStage, recordAllocation } from './benchmark/measurements.js';

// Lazy, page-wide promise: concurrent layers and later trials reuse this code.
const loadDecoderModule = createGribModuleLoader(async () =>
  (await import('@meri-imperiumi/eccodes-wasm/build/eccodes/eccodes.wasm?url')).default);

export function createGribReader(url, layer) {
  const worker = new Worker(new URL('./grib.worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  const allocationId = crypto.randomUUID();
  recordAllocation(allocationId, { gribWorker: true });
  const memoryTimer = setInterval(() => { if (!disposed && !failed) worker.postMessage({ type: 'metrics' }); }, 250);
  let sequence = 0, disposed = false, failed;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // render() and the overlay status both observe the same initialization error.
  ready.catch(() => {});
  function fail(error) {
    failed = error;
    clearInterval(memoryTimer); recordAllocation(allocationId, null);
    rejectReady(error);
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  }
  worker.onmessage = ({ data }) => {
    if (disposed || failed) return;
    if (data.memory) recordAllocation(allocationId, data.memory);
    data.measurements?.forEach(recordStage);
    if (data.type === 'metrics') return;
    if (data.type === 'resource') { recordWorkerResource(data.entry); return; }
    if (data.type === 'ready') { resolveReady(); return; }
    const job = pending.get(data.id);
    if (data.type === 'error') {
      const error = new Error(data.message);
      if (job) { pending.delete(data.id); job.reject(error); }
      else fail(error);
    } else if (job && (data.type === 'pixels' || data.type === 'styled')) {
      pending.delete(data.id); job.resolve(data.pixels);
    }
  };
  worker.onerror = (event) => fail(new Error(event.message || 'GRIB2 worker failed. Use a recent browser with WebAssembly memory64 support.'));
  worker.onmessageerror = () => fail(new Error('Could not read the GRIB2 worker response.'));
  loadDecoderModule().then((module) => {
    if (!disposed && !failed) worker.postMessage({ type: 'init', url, layer, module });
  }).catch((error) => {
    if (!disposed && !failed) { fail(error); worker.terminate(); }
  });
  return {
    ready,
    dispose() {
      disposed = true; worker.terminate();
      fail(new DOMException('Weather layer removed.', 'AbortError'));
    },
    async restyle(style) {
      await ready;
      if (disposed || failed) throw failed || new DOMException('Weather layer removed.', 'AbortError');
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: 'style', id, style });
      });
    },
    async render(bbox, width, height) {
      await ready;
      if (disposed || failed) throw failed || new DOMException('Weather layer removed.', 'AbortError');
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: 'render', id, bbox, width, height });
      });
    },
  };
}
