import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(root, process.argv[2] || '../maplibre-gl-js-benchmark-1792162022357.csv');
const csv = readFileSync(source, 'utf8');
writeFileSync(path.join(root, 'dist/dataset.js'), `/* Generated from the source CSV by prepare-data.mjs. */\nwindow.BENCHMARK_SOURCE = ${JSON.stringify({name:path.basename(source), csv})};\n`);
console.log(`Bundled ${path.basename(source)} (${Buffer.byteLength(csv)} bytes).`);
