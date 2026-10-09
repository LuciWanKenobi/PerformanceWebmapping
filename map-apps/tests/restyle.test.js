import test from 'node:test';
import assert from 'node:assert/strict';
import VectorLayer from 'ol/layer/Vector.js';
import { Circle, Fill, Stroke, Style } from 'ol/style.js';
import { COLOR_RESTYLE } from '../shared/benchmark/restyle.js';
import { createGlAdapter } from '../shared/benchmark/gl-adapter.js';
import { createOpenLayersAdapter } from '../shared/benchmark/openlayers-adapter.js';
import { createPointLayers } from '../shared/benchmark/data.js';
import { glWeatherFactory, withWeather, cogStyle } from '../shared/weather.js';
import { colorTableStyle, restyledLayer, COLOR_TABLES } from '../shared/color-tables.js';
import { colorize, createCogReader, mercatorY } from '../shared/cog-reader.js';
import { createServer } from 'node:http';
import { writeArrayBuffer } from 'geotiff';
import { formatRestyleTime } from '../shared/benchmark/panel.js';
import { createRasterWorkload } from '../shared/benchmark/raster-workload.js';
import { STATION_COLOR } from '../shared/config.js';

test('GL changes every point fill and reloads server rasters with parameter color tables, retaining sources', () => {
  const paints = [], sources = [], tileUpdates = [];
  const map = { on() {}, off() {}, addSource(id) { sources.push(id); }, addLayer() {},
    getSource: () => ({ setTiles: (tiles) => tileUpdates.push(tiles) }),
    setPaintProperty(...args) { paints.push(args); }, removeLayer() {}, removeSource() {} };
  const adapter = createGlAdapter(map, { library: 'Test', version: '1' });
  adapter.addPoints(createPointLayers(100, 2));
  adapter.restylePoints(COLOR_RESTYLE);
  for (const id of ['benchmark-0', 'benchmark-1']) {
    assert.ok(paints.some(([layer, property, value]) => layer === id && property === 'circle-color' && value === '#a323c5'));
    assert.ok(paints.some(([layer, property, value]) => layer === id && property === 'circle-color-transition' && value.duration === 0));
  }
  for (const mode of ['wms']) {
    const raster = glWeatherFactory(map)({ id: 'weather', variable: 't_2m', requestKey: 'map1-private', mapIndex: 1, bounds: [-12, 34, 35, 72], style: { min: 253.15, max: 313.15 } }, mode, assert.fail, mode);
    const before = sources.length;
    raster.restyle(COLOR_RESTYLE);
    assert.equal(sources.length, before);
    const url = new URL(tileUpdates.at(-1)[0]);
    assert.equal(url.searchParams.get(mode === 'wms' ? 'STYLES' : 'style'), 'benchmark');
    assert.equal(url.searchParams.get('_map_request'), 'map1-private');
    assert.equal(url.searchParams.get('_map'), '1');
    raster.remove();
  }
});

test('OpenLayers restyles all benchmark layers without mutating station or future trial styles', () => {
  const originalStyle = new Style({ image: new Circle({ radius: 3,
    fill: new Fill({ color: STATION_COLOR }), stroke: new Stroke({ color: '#ffffff', width: 2 }) }) });
  const stations = new VectorLayer({ style: originalStyle });
  const layers = [];
  const map = { getView: () => ({}), addLayer(layer) { layers.push(layer); }, removeLayer() {} };
  const adapter = createOpenLayersAdapter(map, {}, stations, {});
  adapter.addPoints(createPointLayers(100, 2));
  const sources = layers.map((layer) => layer.getSource());
  adapter.restylePoints(COLOR_RESTYLE);
  layers.forEach((layer, index) => {
    assert.equal(layer.getStyle().getImage().getFill().getColor(), '#a323c5');
    assert.equal(layer.getStyle().getImage().getStroke().getColor(), '#ffffff');
    assert.equal(layer.getSource(), sources[index]);
    assert.equal(sources[index].getFeatures().length, 100);
  });
  assert.equal(originalStyle.getImage().getFill().getColor(), STATION_COLOR);
  adapter.clearPoints();
  adapter.addPoints(createPointLayers(100, 1));
  assert.equal(layers.at(-1).getStyle().getImage().getFill().getColor(), STATION_COLOR);
  adapter.clearPoints(); stations.dispose();
});


test('alternative tables vary by parameter and retain scale, resampling and nodata', () => {
  const base = { variable: 't_2m', nodata: -9999, style: { min: 253.15, max: 313.15,
    colors: [[0, 0, 255], [255, 0, 0]], resampling: 'nearest' } };
  const saved = structuredClone(base);
  const table = colorTableStyle(base);
  assert.notDeepEqual(table.colors, base.style.colors);
  assert.notDeepEqual(table.colors, colorTableStyle({ ...base, variable: 'clct' }).colors);
  assert.equal(table.min, base.style.min); assert.equal(table.max, base.style.max);
  assert.equal(table.resampling, 'nearest');
  assert.equal(restyledLayer(base).nodata, base.nodata);
  assert.deepEqual(colorize(-9999, table, -9999), [0, 0, 0, 0]);
  assert.notDeepEqual(colorize(290, table, -9999), colorize(290, base.style, -9999));
  assert.deepEqual(base, saved);
  assert.deepEqual(colorTableStyle({ ...base, variable: 't' }).colors, table.colors);
  assert.match(colorTableStyle({ ...base, variable: 'unknown' }).colorTable, /other-viridis/);
  const olStyle = cogStyle(restyledLayer(base));
  assert.notDeepEqual(olStyle, cogStyle(base));
  assert.deepEqual(olStyle.color.at(-1), [0, 0, 0, 0]);
});

test('COG reader recolors the last numeric window without downloading it again', async (t) => {
  const data = new Float32Array([270, 300, -9999, 310]);
  const tiff = Buffer.from(writeArrayBuffer(data, { width: 2, height: 2,
    ModelPixelScale: [1, 1, 0], ModelTiepoint: [0, 0, 0, 0, 2, 0],
    GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2 }));
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    assert.ok(match, 'reader uses range requests');
    const start = Number(match[1]), end = Math.min(Number(match[2]), tiff.length - 1);
    res.writeHead(206, { 'Content-Range': 'bytes ' + start + '-' + end + '/' + tiff.length,
      'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
    res.end(tiff.subarray(start, end + 1));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const layer = { variable: 't_2m', bounds: [0, 0, 2, 2], nodata: -9999,
    style: { min: 253.15, max: 313.15, colors: [[0, 0, 255], [255, 0, 0]], resampling: 'nearest' } };
  const reader = createCogReader('http://127.0.0.1:' + server.address().port + '/data.tif', layer);
  t.after(() => reader.dispose());
  const bbox = [0, 0, 2 / 180 * 20037508.342789244, mercatorY(2)];
  const before = await reader.render(bbox, 2, 2);
  const count = requests;
  reader.restyle(colorTableStyle(layer));
  const after = await reader.render(bbox, 2, 2);
  assert.notDeepEqual(after, before);
  assert.deepEqual([...after.slice(0, 4)], colorize(270, colorTableStyle(layer), -9999));
  assert.deepEqual([...after.slice(8, 12)], [0, 0, 0, 0]);
  assert.equal(requests, count);
});

test('table compatibility check rejects outdated WMS servers before timing, and skips numeric-only workloads', async (t) => {
  const saved = globalThis.fetch;
  t.after(() => { globalThis.fetch = saved; });
  const adapter = withWeather({}, {});
  let requests = 0;
  globalThis.fetch = async () => { requests++; return { ok: true, json: async () => ({}) }; };
  await adapter.assertColorTables([{ mode: 'cog' }, { mode: 'grib' }, { mode: 'xyz' }], new AbortController().signal);
  assert.equal(requests, 0);
  await assert.rejects(adapter.assertColorTables([{ mode: 'wms' }], new AbortController().signal), /Restart.*color tables/);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ colorTables: COLOR_TABLES }) });
  await adapter.assertColorTables([{ mode: 'wms' }], new AbortController().signal);
});

test('precomputed GL PNG overlays have no restyle operation and never change tile URLs', async () => {
  const sources = [], updates = [];
  const map = { on() {}, off() {}, addSource(_id, source) { sources.push(source); }, addLayer() {},
    getSource: () => ({ setTiles: (tiles) => updates.push(tiles) }), removeLayer() {}, removeSource() {} };
  const layer = { id: 'weather', variable: 't_2m', bounds: [-12, 34, 35, 72],
    requestKey: 'private-map', mapIndex: 1, colorTableStyle: 'benchmark',
    style: { min: 0, max: 100, resampling: 'nearest' } };
  const overlay = glWeatherFactory(map)(layer, 'xyz', assert.fail);
  assert.equal(overlay.restyle, undefined);
  const url = new URL(sources[0].tiles[0]);
  assert.equal(url.searchParams.has('style'), false);
  assert.equal(url.searchParams.get('_map_request'), 'private-map');
  const workload = createRasterWorkload(() => ({ ...overlay,
    restyle() { assert.fail('PNG restyle must never run, even when an adapter exposes one'); } }));
  workload.add([{ layer, mode: 'xyz' }]);
  await workload.restyle(COLOR_RESTYLE);
  assert.deepEqual(updates, []);
  workload.clear();
});

test('mixed workloads skip PNG restyling and display partial instead of a full success', async () => {
  const restyled = [];
  const workload = createRasterWorkload((_layer, mode) => ({
    restyle() { restyled.push(mode); }, remove() {},
  }));
  workload.add(['xyz', 'wms', 'cog', 'grib'].map((mode) => ({ layer: {}, mode })));
  await workload.restyle(COLOR_RESTYLE);
  assert.deepEqual(restyled, ['wms', 'cog', 'grib']);
  assert.equal(formatRestyleTime({ colorRestyleStatus: 'unsupported', colorRestyleReadyMs: null }), 'n/a (PNG fixed)');
  assert.equal(formatRestyleTime({ colorRestyleStatus: 'partial', colorRestyleReadyMs: 123 }), '123.0 (partial; PNG fixed)');
  workload.clear();
});
