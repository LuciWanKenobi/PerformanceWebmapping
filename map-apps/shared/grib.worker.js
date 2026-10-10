import createEccodesModule from 'virtual:eccodes-worker-loader';
import { createGribWorkerHandler } from './grib-worker-core.js';
import { instantiateGribModule } from './grib-wasm.js';
import { observeWorkerResources } from './benchmark/network.js';

const flushResources = observeWorkerResources((message) => self.postMessage(message));

self.onmessage = createGribWorkerHandler(
  (module) => instantiateGribModule(createEccodesModule, module),
  (message, transfer = []) => { flushResources(); self.postMessage(message, transfer); },
);
