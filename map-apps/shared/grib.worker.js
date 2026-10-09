import createEccodesModule from 'virtual:eccodes-worker-loader';
import wasmUrl from '@meri-imperiumi/eccodes-wasm/build/eccodes/eccodes.wasm?url';
import { createGribWorkerHandler } from './grib-worker-core.js';
import { observeWorkerResources } from './benchmark/network.js';

const flushResources = observeWorkerResources((message) => self.postMessage(message));

self.onmessage = createGribWorkerHandler(
  () => createEccodesModule({ locateFile: () => wasmUrl }),
  (message, transfer = []) => { flushResources(); self.postMessage(message, transfer); },
);
