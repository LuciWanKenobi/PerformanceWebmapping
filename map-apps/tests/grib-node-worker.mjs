// Test bridge only: the production entry uses browser Worker messaging.
import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { createGribWorkerHandler } from '../shared/grib-worker-core.js';
const require = createRequire(import.meta.url);
const handler = createGribWorkerHandler(
  () => require('@meri-imperiumi/eccodes-wasm/build/eccodes/eccodes.js')(),
  (message, transfer = []) => parentPort.postMessage(message, transfer),
);
parentPort.on('message', (data) => handler({ data }));
