import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { decodeGrib, selectGribMessage } from '../shared/grib-decoder.js';
import { colorize, projectRaster, mercatorY, createGlRasterOverlay } from '../shared/cog-reader.js';

import { colorTableStyle } from '../shared/color-tables.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/temperature-ccsds.json', import.meta.url)));
const bytes = new Uint8Array(readFileSync(new URL('./fixtures/temperature-ccsds.grib2', import.meta.url)));
const needsNode24 = Number(process.versions.node.split('.')[0]) < 24 ? 'ecCodes WASM tests require Node 24+' : false;

test('color ramp clamps extremes and makes nodata transparent', () => {
  const style = fixture.layer.style;
  assert.deepEqual(colorize(270, style, -9999), [0, 0, 255, 255]);
  assert.deepEqual(colorize(302, style, -9999), [128, 0, 128, 255]);
  assert.deepEqual(colorize(999, style, -9999), [255, 0, 0, 255]);
  assert.deepEqual(colorize(-9999, style, -9999), [0, 0, 0, 0]);
  assert.deepEqual(colorize(NaN, style, -9999), [0, 0, 0, 0]);
});

test('multiple GL canvases await actual pixels and coalesce rapid viewport changes', async (t) => {
  const originals = ['document', 'ImageData'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  let uploads = 0;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ getContext: () => ({ putImageData: () => { uploads++; } }) }),
  } });
  Object.defineProperty(globalThis, 'ImageData', { configurable: true, value: class {
    constructor(data, width, height) { Object.assign(this, { data, width, height }); }
  } });
  t.after(() => { for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  } });
  const events = new Map(), sources = new Map(), layers = new Set();
  const fire = (event) => { for (const handler of [...(events.get(event) ?? [])]) handler(); };
  const map = {
    on(event, handler) { if (!events.has(event)) events.set(event, new Set()); events.get(event).add(handler); },
    off(event, handler) { events.get(event)?.delete(handler); },
    once(event, handler) { const once = () => { this.off(event, once); handler(); }; this.on(event, once); },
    addSource(id) { assert.ok(!sources.has(id)); sources.set(id, { setCoordinates() {}, play() {}, pause() {} }); },
    getSource: (id) => sources.get(id), removeSource: (id) => sources.delete(id),
    addLayer({ id }) { assert.ok(!layers.has(id)); layers.add(id); }, removeLayer: (id) => layers.delete(id),
    setLayoutProperty() {}, getContainer: () => ({ clientWidth: 8, clientHeight: 8 }),
    getBounds: () => ({ getWest: () => 0, getEast: () => 1, getSouth: () => 0, getNorth: () => 1 }),
    triggerRepaint() { setImmediate(() => { fire('render'); fire('idle'); }); },
  };
  const jobs = [], readers = [];
  const makeReader = () => {
    const reader = { disposed: false, render: () => new Promise((resolve) => jobs.push(resolve)),
      dispose() { this.disposed = true; } };
    readers.push(reader);
    return reader;
  };
  const overlayA = createGlRasterOverlay(map, { bounds: [-10, -10, 10, 10] }, makeReader(),
    assert.fail, 'benchmark-raster-0');
  const overlayB = createGlRasterOverlay(map, { bounds: [-10, -10, 10, 10] }, makeReader(),
    assert.fail, 'benchmark-raster-1');
  t.after(() => { overlayA.remove(); overlayB.remove(); });
  let ready = false;
  const completion = Promise.all([overlayA.settle(new AbortController().signal), overlayB.settle(new AbortController().signal)])
    .then(() => { ready = true; });
  for (let i = 0; i < 50; i++) fire('moveend');
  assert.equal(jobs.length, 2); // One request per layer, rather than 102 requests.
  assert.equal(ready, false);
  const pixels = new Uint8ClampedArray(8 * 8 * 4);
  jobs[0](pixels); jobs[1](pixels);
  await new Promise(setImmediate);
  assert.equal(jobs.length, 4); // Exactly one follow-up for the latest view on each layer.
  assert.equal(uploads, 0); // Obsolete views cannot overwrite current pixels.
  assert.equal(ready, false);
  jobs[2](pixels); jobs[3](pixels);
  await completion;
  assert.equal(uploads, 2);
  assert.equal(ready, true);
  assert.equal(sources.size, 2);
});

test('projection samples north-up pixels and keeps cells outside the grid transparent', () => {
  const limit = 20037508.342789244;
  const values = new Float32Array([270, 302, -9999, 334]);
  const bbox = [0, mercatorY(0), 2 / 180 * limit, mercatorY(2)];
  const pixels = projectRaster(values, [0, 0, 2, 2], [0, 2], [1, -1], bbox, 2, 2, fixture.layer.style, -9999);
  assert.deepEqual([...pixels], [0, 0, 255, 255, 128, 0, 128, 255, 0, 0, 0, 0, 255, 0, 0, 255]);
  const outside = projectRaster(values, [0, 0, 2, 2], [0, 2], [1, -1],
    [-10 / 180 * limit, mercatorY(0), -9 / 180 * limit, mercatorY(1)], 2, 2, fixture.layer.style, -9999);
  assert.ok(outside.every((v) => v === 0));
  const interpolated = projectRaster(values, [0, 0, 2, 2], [0, 2], [1, -1], bbox, 2, 2,
    { ...fixture.layer.style, resampling: 'bilinear' }, -9999);
  assert.ok(interpolated[0] < interpolated[4]);
});

test('GRIB framing selects concatenated messages and rejects truncated files', () => {
  const combined = new Uint8Array(bytes.length * 2);
  combined.set(bytes); combined.set(bytes, bytes.length);
  assert.deepEqual(selectGribMessage(combined, 2), bytes);
  assert.throws(() => selectGribMessage(bytes.subarray(0, bytes.length - 1)), /truncated/);
  assert.throws(() => selectGribMessage(bytes, 2), /not found/);
  assert.throws(() => selectGribMessage(bytes, 0), /number/);
});

test('WASM decodes CCSDS packing, bitmap nodata and orientation against native ecCodes',
  { skip: needsNode24 }, async () => {
    const require = createRequire(import.meta.url);
    const module = await require('@meri-imperiumi/eccodes-wasm/build/eccodes/eccodes.js')();
    const grid = decodeGrib(module, bytes, 1, fixture.layer.nodata);
    assert.equal(fixture.packing_template, 42);
    assert.deepEqual([...grid.values], fixture.values);
    assert.equal(grid.units, 'K');
    assert.deepEqual(grid.bounds, fixture.layer.bounds);
    assert.equal(module.FS.analyzePath('/browser-input.grib2').exists, false);
  });

test('worker fetches original GRIB once and transfers colored pixels for repeated views',
  { skip: needsNode24, timeout: 30000 }, async () => {
    let downloads = 0;
    const server = createServer((_request, response) => {
      downloads++; response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.end(bytes);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const worker = new Worker(new URL('./grib-node-worker.mjs', import.meta.url));
    try {
      worker.postMessage({ type: 'init', layer: fixture.layer,
        url: `http://127.0.0.1:${server.address().port}/temperature.grib2` });
      assert.equal((await once(worker, 'message'))[0].type, 'ready');
      const limit = 20037508.342789244;
      const bbox = [4.5 / 180 * limit, mercatorY(46.5), 12.5 / 180 * limit, mercatorY(54.5)];
      let originalPixels;
      for (const id of [1, 2]) {
        worker.postMessage({ type: 'render', id, bbox, width: 8, height: 8 });
        const [result] = await once(worker, 'message');
        assert.equal(result.type, 'pixels'); assert.equal(result.id, id);
        originalPixels = result.pixels;
        assert.ok(result.pixels instanceof Uint8ClampedArray);
        assert.equal(result.pixels.length, 8 * 8 * 4);
        assert.equal(result.pixels.at(-32 + 3), 0); // missing southwest cell
        assert.ok(result.pixels.some((v) => v !== 0));
      }
      const alternate = colorTableStyle({ ...fixture.layer, variable: 't_2m' });
      worker.postMessage({ type: 'style', id: 3, style: alternate });
      assert.deepEqual((await once(worker, 'message'))[0], { type: 'styled', id: 3 });
      worker.postMessage({ type: 'render', id: 4, bbox, width: 8, height: 8 });
      const [restyled] = await once(worker, 'message');
      assert.equal(restyled.type, 'pixels');
      assert.notDeepEqual(restyled.pixels, originalPixels);
      assert.deepEqual([...restyled.pixels].filter((_v, i) => i % 4 === 3),
        [...originalPixels].filter((_v, i) => i % 4 === 3));
      assert.equal(downloads, 1, 'changing tables recolors the retained decoded grid');
      worker.postMessage({ type: 'render', id: 3, bbox, width: 1000000, height: 1 });
      const [error] = await once(worker, 'message');
      assert.equal(error.type, 'error'); assert.equal(error.id, 3);
    } finally {
      await worker.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  });
