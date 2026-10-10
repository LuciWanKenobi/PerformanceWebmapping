// Test bridge only: the production entry uses browser Worker messaging.
import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { createGribWorkerHandler } from '../shared/grib-worker-core.js';
import { instantiateGribModule } from '../shared/grib-wasm.js';
const require = createRequire(import.meta.url);
const createEccodesModule = require('@meri-imperiumi/eccodes-wasm/build/eccodes/eccodes.js');
const handler = createGribWorkerHandler(
  (module) => module ? instantiateGribModule(createEccodesModule, module) : createEccodesModule(),
  (message, transfer = []) => parentPort.postMessage(message, transfer),
);
parentPort.on('message', (data) => handler({ data }));
