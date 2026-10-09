import test from 'node:test';
import assert from 'node:assert/strict';
import { cogUrl, cogStyle, gribUrl, weatherTileUrl, withWeather, mountWeather } from '../shared/weather.js';
import { ColorType } from 'ol/expr/expression.js';
import { newCompilationContext } from 'ol/expr/gpu.js';
import { expressionToGlsl } from 'ol/render/webgl/compileUtil.js';

test('the COG style compiles with OpenLayers and includes the nodata alpha band', () => {
  const style = cogStyle({ style: { min: 253.15, max: 313.15,
    colors: [[49, 54, 149], [116, 173, 209], [215, 48, 39]] } });
  const context = { ...newCompilationContext(), bandCount: 2 };
  const glsl = expressionToGlsl(context, style.color, ColorType);
  assert.ok(glsl.includes('getBandValue(2.0'));
  assert.ok(glsl.includes('getBandValue(1.0'));
  assert.ok(glsl.includes('vec4'));
});

test('raw GRIB URL addresses the original source and rejects outer bz2 compression', () => {
  assert.equal(gribUrl({ source: 'run/T_2M +3.grib2' }),
    'http://127.0.0.1:8001/grib2/run/T_2M%20%2B3.grib2');
  assert.throws(() => gribUrl({ source: 'run/T_2M.grib2.bz2' }), /Decompress/);
});

test('weather URLs preserve tile placeholders and encode catalog paths', () => {
  const layer = { id: 'run__t_2m +3', path: 'run/temperature +3.tif' };
  assert.equal(cogUrl(layer), 'http://127.0.0.1:8001/cog/run/temperature%20%2B3.tif');
  assert.equal(weatherTileUrl(layer, 'xyz'),
    'http://127.0.0.1:8002/tiles/run__t_2m%20%2B3/{z}/{x}/{y}.png');
  const url = weatherTileUrl(layer, 'wms');
  assert.ok(url.includes('BBOX={bbox-epsg-3857}'));
  assert.ok(url.includes('LAYERS=run__t_2m%20%2B3'));
  assert.ok(url.includes('VERSION=1.1.1'));
  assert.ok(url.includes('SRS=EPSG:3857'));
});

test('weather is hidden during vector benchmarks and restored even if map restore fails', () => {
  const events = [];
  const adapter = withWeather({
    library: 'test', prepare: () => ({ zoom: 6 }),
    restore: (state) => { assert.equal(state.zoom, 6); events.push('map'); throw new Error('restore'); },
  }, { suspend: () => events.push('hide'), resume: () => events.push('show') });
  const state = adapter.prepare();
  assert.equal(adapter.library, 'test');
  assert.deepEqual(events, ['hide']);
  assert.throws(() => adapter.restore(state), /restore/);
  assert.deepEqual(events, ['hide', 'map', 'show']);
});


test('weather preview checks availability before creating map layers and ignores stale checks', async (t) => {
  const element = () => ({ value: '', disabled: false, children: [], handlers: new Map(),
    addEventListener(type, handler) { this.handlers.set(type, handler); },
    replaceChildren(...children) { this.children = children; }, add(option) { this.children.push(option); } });
  const button = element(), forecast = element(), mode = element(), info = element();
  mode.value = 'wms';
  const group = { querySelector: (selector) => ({ button, '.weather-forecast': forecast,
    '.weather-mode': mode, '.weather-info': info })[selector] };
  const globals = { document: { createElement: () => group, querySelector: () => ({ append() {} }) },
    Option: class { constructor(label, value) { this.label = label; this.value = value; } }, fetch: undefined };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else delete globalThis[key]; });
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ schema_version: 1,
    layers: [{ id: 'forecast', variable: 'temperature', valid_time: '2026-10-09T03:00:00Z', level_type: 'surface', level: 0 }] }) });
  let created = 0;
  mountWeather(() => { created++; throw new Error('Should not create a raster before availability is confirmed'); }, { supportsCog: true });
  await button.handlers.get('click')();
  forecast.value = 'forecast';
  globalThis.fetch = async () => { throw new TypeError('Connection refused'); };
  await forecast.handlers.get('change')();
  assert.equal(created, 0);
  assert.match(info.textContent, /WMS\/PNG server unavailable/);
  assert.match(info.textContent, /npm run start:all/);
  let release;
  globalThis.fetch = () => new Promise((resolve) => { release = resolve; });
  const pending = forecast.handlers.get('change')();
  forecast.value = '';
  await forecast.handlers.get('change')();
  release({ ok: true, json: async () => ({ cacheIsolationSupported: true }) });
  await pending;
  assert.equal(created, 0);
  assert.equal(info.textContent, 'Weather overlay off.');
});


test('map reset removes preview overlays before destruction and restores preview on fresh maps', async () => {
  const events = [];
  const adapter = withWeather({ prepare: () => 'view',
    async initializeMaps(count, _signal, camera) {
      assert.deepEqual(events, ['suspend', 'suspend', 'clearPreview']);
      events.push('reset'); assert.equal(count, 2); assert.equal(camera.zoom, 4);
      return { mapInitMs: 123 };
    }, restore(state) { assert.equal(state, 'view'); events.push('restore'); },
  }, { suspend: () => events.push('suspend'), clearPreview: () => events.push('clearPreview'),
    refresh: () => events.push('refresh'), resume: () => events.push('resume') });
  const state = adapter.prepare();
  assert.equal((await adapter.initializeMaps(2, new AbortController().signal, { center: [12, 52], zoom: 4 })).mapInitMs, 123);
  adapter.restore(state);
  assert.deepEqual(events, ['suspend', 'suspend', 'clearPreview', 'reset', 'restore', 'refresh', 'resume']);
});
