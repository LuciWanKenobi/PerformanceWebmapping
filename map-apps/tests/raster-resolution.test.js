import test from 'node:test';
import assert from 'node:assert/strict';
import { rasterNativeZoom, planRasterCanvas, MERCATOR_LIMIT, mercatorY } from '../shared/raster-resolution.js';
import { createGlRasterOverlay } from '../shared/cog-reader.js';
import { glWeatherFactory } from '../shared/weather.js';
import { createGlAdapter } from '../shared/benchmark/gl-adapter.js';
import { createXYZ } from 'ol/tilegrid.js';
import TileWMS from 'ol/source/TileWMS.js';
import { get as projection } from 'ol/proj.js';

const icon = { width: 1377, height: 657, bounds: [-23.53125, 29.46875, 62.53125, 70.53125],
  variable: 't_2m', style: { min: 253.15, max: 313.15, colors: [[0, 0, 0], [255, 255, 255]], resampling: 'bilinear' }, id: 'temperature' };

test('native zoom is derived from source cells and retains detail for finer grids', () => {
  assert.equal(rasterNativeZoom(icon), 5);
  assert.equal(rasterNativeZoom({ ...icon, width: icon.width * 2, height: icon.height * 2 }), 6);
  assert.equal(rasterNativeZoom({ ...icon, width: icon.width * 8, height: icon.height * 8 }), 8);
  assert.equal(rasterNativeZoom({ ...icon, height: icon.height * 8 }), 8); // Finest row determines the ceiling.
  assert.equal(rasterNativeZoom({ bounds: icon.bounds }), 6);
  assert.equal(rasterNativeZoom({ ...icon, bounds: [0, 0, 0, 0] }), 6);
});

test('deep zoom and nearby pans use the same world-aligned canvas block', () => {
  const first = planRasterCanvas(icon, [13.39, 52.51, 13.41, 52.53], 800, 600);
  const closer = planRasterCanvas(icon, [13.395, 52.515, 13.405, 52.525], 800, 600);
  const pan = planRasterCanvas(icon, [13.4, 52.52, 13.42, 52.54], 800, 600);
  assert.equal(first.nativeZoom, 5);
  assert.equal(first.overzoom, true);
  assert.equal(first.key, closer.key);
  assert.equal(first.key, pan.key);
  assert.ok(first.bbox[0] <= 13.39 / 180 * MERCATOR_LIMIT);
  assert.ok(first.bbox[2] >= 13.41 / 180 * MERCATOR_LIMIT);
  assert.ok(first.bbox[1] <= mercatorY(52.51));
  assert.ok(first.bbox[3] >= mercatorY(52.53));
  assert.ok(first.width <= 1024 && first.height <= 1024);
  assert.notEqual(first.key, planRasterCanvas(icon, [26, 44, 26.02, 44.02], 800, 600).key);
  assert.equal(planRasterCanvas(icon, [-12, 34, 35, 70], 256, 256).overzoom, false);
});

test('overzoom blocks are clipped to data bounds while still covering edge views', () => {
  const layer = { ...icon, bounds: [5, 45, 15, 55] };
  const plan = planRasterCanvas(layer, [5, 45, 5.02, 45.02], 500, 500);
  assert.ok(plan.bbox[0] >= 5 / 180 * MERCATOR_LIMIT);
  assert.ok(plan.bbox[1] >= mercatorY(45));
  assert.ok(plan.bbox[2] <= 15 / 180 * MERCATOR_LIMIT);
  assert.ok(plan.bbox[3] <= mercatorY(55));
  assert.ok(plan.width > 0 && plan.height > 0);
});

test('OpenLayers capped WMS grid selects parent tiles for zoom 12 without hiding the layer', () => {
  const grid = createXYZ({ tileSize: 256, maxZoom: rasterNativeZoom(icon) });
  const viewResolution = 2 * MERCATOR_LIMIT / (256 * 2 ** 12);
  const z = grid.getZForResolution(viewResolution);
  assert.equal(z, 5);
  const coord = grid.getTileCoordForCoordAndZ([13.4 / 180 * MERCATOR_LIMIT, mercatorY(52.52)], z);
  const source = new TileWMS({ url: 'http://127.0.0.1:8002/wms?_map=2&_map_request=own-key',
    params: { LAYERS: icon.id, VERSION: '1.1.1', FORMAT: 'image/png' }, tileGrid: grid, hidpi: false });
  try {
    const url = new URL(source.getTileUrlFunction()(coord, 1, projection('EPSG:3857')));
    const bbox = url.searchParams.get('BBOX').split(',').map(Number);
    assert.ok(Math.abs(bbox[2] - bbox[0] - 2 * MERCATOR_LIMIT / 2 ** 5) < 1e-6);
    assert.equal(url.searchParams.get('_map'), '2');
    assert.equal(url.searchParams.get('_map_request'), 'own-key');
  } finally { source.dispose(); }
});

test('GL WMS and PNG sources cap their tile zoom while layers stay visible at deeper zoom', () => {
  for (const mode of ['wms', 'xyz']) {
    let source, layer;
    const map = { on() {}, off() {}, addSource(_id, value) { source = value; },
      addLayer(value) { layer = value; }, removeLayer() {}, removeSource() {} };
    const overlay = glWeatherFactory(map)({ ...icon, requestKey: mode + '-map1', mapIndex: 1 }, mode, assert.fail);
    assert.equal(source.maxzoom, 5);
    assert.equal(layer.maxzoom, undefined);
    assert.equal(new URL(source.tiles[0]).searchParams.get('_map'), '1');
    overlay.remove();
  }
});

function canvasBrowser(t) {
  const saved = new Map();
  const replace = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  replace('document', { createElement: () => ({ getContext: () => ({ putImageData() {} }) }) });
  replace('ImageData', class { constructor(data, width, height) { assert.equal(data.length, width * height * 4); } });
  t.after(() => { for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
}
function canvasMap() {
  const events = new Map(), sources = new Map();
  let bounds = [13.39, 52.51, 13.41, 52.53];
  const map = {
    fire(type, value) { for (const handler of [...(events.get(type) ?? [])]) handler(value); },
    move(value) { bounds = value; this.fire('moveend'); },
    on(type, handler) { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(handler); },
    off(type, handler) { events.get(type)?.delete(handler); },
    once(type, handler) { const wrapped = () => { this.off(type, wrapped); handler(); }; this.on(type, wrapped); },
    addSource(id) { sources.set(id, { setCoordinates() {}, play() {}, pause() {} }); },
    getSource: (id) => sources.get(id), removeSource: (id) => sources.delete(id),
    addLayer() {}, removeLayer() {}, setLayoutProperty() {}, setPaintProperty() {},
    getContainer: () => ({ clientWidth: 800, clientHeight: 600 }),
    getBounds: () => ({ getWest: () => bounds[0], getSouth: () => bounds[1], getEast: () => bounds[2], getNorth: () => bounds[3] }),
    triggerRepaint() { setImmediate(() => { this.fire('render'); this.fire('idle'); }); },
  };
  return map;
}

test('numeric GL overzoom reuses only its own canvas and refreshes after panning or changing forecast', async (t) => {
  canvasBrowser(t);
  let rendered = 0;
  const reader = () => ({ render: async (_bbox, width, height) => { rendered++; return new Uint8ClampedArray(width * height * 4); }, dispose() {} });
  const map = canvasMap();
  let overlay = createGlRasterOverlay(map, icon, reader(), assert.fail);
  const signal = new AbortController().signal;
  await overlay.settle(signal);
  assert.equal(rendered, 1);
  map.move([13.395, 52.515, 13.405, 52.525]);
  await overlay.settle(signal);
  assert.equal(rendered, 1);
  const secondMap = canvasMap();
  const other = createGlRasterOverlay(secondMap, icon, reader(), assert.fail);
  await other.settle(signal);
  assert.equal(rendered, 2); // A different map never reuses the first map's pixels.
  other.remove();
  map.move([26, 44, 26.02, 44.02]);
  await overlay.settle(signal);
  assert.equal(rendered, 3);
  map.move([100, 0, 101, 1]);
  await overlay.settle(signal);
  assert.equal(rendered, 3); // Outside the forecast extent needs no read.
  map.move([26, 44, 26.02, 44.02]);
  await overlay.settle(signal);
  assert.equal(rendered, 4);
  overlay.remove();
  overlay = createGlRasterOverlay(map, { ...icon, id: 'next-forecast' }, reader(), assert.fail);
  await overlay.settle(signal);
  assert.equal(rendered, 5); // A time change starts with independent data.
  overlay.remove();
});

test('GL benchmark failures include the underlying resource error', () => {
  const map = canvasMap();
  const adapter = createGlAdapter(map, { library: 'Test', version: '1', closePopup() {} });
  let failure;
  const stop = adapter.watchErrors((error) => { failure = error; });
  map.fire('error', { error: new Error('HTTP 500 during raster rendering') });
  assert.match(failure.message, /HTTP 500 during raster rendering/);
  stop();
});
