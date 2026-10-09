import test from 'node:test';
import assert from 'node:assert/strict';
import { createGlMapFactory } from '../shared/benchmark/gl-map.js';

function fakeGl(failControl = false) {
  const instances = [];
  class Map {
    constructor(options) {
      this.options = options; this.layers = []; this.sources = [];
      this.listeners = new globalThis.Map();
      this.touchZoomRotate = { disableRotation() {} };
      instances.push(this);
    }
    on(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
    }
    off(type, handler) { this.listeners.get(type)?.delete(handler); }
    addControl() {
      if (failControl) for (const callback of this.listeners.get('error') ?? []) callback({ error: new Error('renderer initialization failed') });
    }
    loaded() { return true; }
    addSource(id, source) { this.sources.push({ id, ...source }); }
    addLayer(layer) { this.layers.push(layer); }
    remove() { this.removed = true; }
  }
  return { gl: { Map, NavigationControl: class {} }, instances };
}

test('GL benchmark constructor starts at the benchmark camera with basemap and preview stations hidden', async () => {
  const { gl, instances } = fakeGl();
  const stations = { type: 'FeatureCollection', features: [] };
  const factory = createGlMapFactory(gl, stations, { library: 'Test', version: '1' });
  const camera = { center: [12, 52], zoom: 4 };
  const entry = await factory({}, 1, new AbortController().signal, { benchmark: true, camera });
  const map = instances[0];
  assert.deepEqual(map.options.center, camera.center);
  assert.equal(map.options.zoom, 3);
  assert.equal(map.options.style.layers[0].layout.visibility, 'none');
  assert.equal(map.layers.find((layer) => layer.id === 'stations').layout.visibility, 'none');
  assert.notEqual(map.sources[0].data, stations);
  assert.equal(map.listeners.get('error').size, 0, 'temporary initialization error listener is removed');
  entry.destroy(); assert.equal(map.removed, true);
});

test('GL initialization errors destroy the partial native map instead of returning it as ready', async () => {
  const { gl, instances } = fakeGl(true);
  const factory = createGlMapFactory(gl, { type: 'FeatureCollection', features: [] }, { library: 'Test', version: '1' });
  await assert.rejects(factory({}, 1, new AbortController().signal, { benchmark: true }), /renderer initialization failed/);
  assert.equal(instances[0].removed, true);
  assert.equal(instances[0].listeners.get('error').size, 0);
});
