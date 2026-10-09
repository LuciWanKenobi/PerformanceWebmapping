import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapGroup, validateMapCount, assertRasterIsolation } from '../shared/benchmark/map-group.js';
import { cogUrl, gribUrl, weatherTileUrl } from '../shared/weather.js';

function frames(t) {
  const raf = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setImmediate(() => callback(0));
  globalThis.cancelAnimationFrame = clearImmediate;
  t.after(() => { globalThis.requestAnimationFrame = raf; globalThis.cancelAnimationFrame = cancel; });
}

function native(index, surface = { index }) {
  const callbacks = new Set();
  const calls = { cameras: [], rasters: [], points: [], updates: [], destroyed: false, restored: 0 };
  let camera = { center: [10, 51], zoom: 6 };
  const entry = {
    surface, calls,
    getCamera: () => structuredClone(camera),
    onCameraChange(callback) { callbacks.add(callback); return () => callbacks.delete(callback); },
    setStationsVisible() {},
    destroy() { calls.destroyed = true; assert.equal(callbacks.size, 0); },
    adapter: {
      library: 'Test', version: '1', renderer: 'test', readySignal: 'test',
      size: () => ({ width: 200, height: 150 }), resize() {}, assertReady() {},
      setCamera(value) { camera = structuredClone(value); calls.cameras.push(value); callbacks.forEach((callback) => callback()); },
      prepare: () => index, restore(state) { assert.equal(state, index); calls.restored++; },
      addPoints(data) { calls.points.push(data); }, updatePoints(data) { calls.updates.push(data); }, clearPoints() {},
      restylePoints(style) { calls.pointStyle = style; },
      settle: async () => {},
    },
    createOverlay(layer) {
      calls.rasters.push(layer);
      return { restyle(style) { calls.rasterStyle = style; }, ready: Promise.resolve(), settle: async () => {}, remove() { calls.removed = (calls.removed ?? 0) + 1; }, setVisible() {} };
    },
  };
  return entry;
}

function harness(factory) {
  const entries = [native(1)], panes = new Set([entries[0].surface]), arrangements = [];
  const layout = {
    add(index) { const surface = { index }; panes.add(surface); return surface; },
    remove(surface) { assert.ok(panes.delete(surface)); },
    arrange(count) { arrangements.push(count); }, size: () => ({ width: 1000, height: 600 }),
  };
  const group = createMapGroup(entries[0], async (surface, index, signal, startup) => {
    assert.equal(arrangements.at(-1), startup?.mapCount ?? index, 'renderer receives a sized grid before construction');
    const entry = factory ? await factory(surface, index, signal, startup) : native(index, surface);
    entries.push(entry); return entry;
  }, layout);
  return { group, entries, panes, arrangements };
}

test('map count accepts integers 1–20 only', () => {
  for (let count = 1; count <= 20; count++) validateMapCount(count);
  for (const count of [0, 21, -1, 2.5, '2', NaN]) assert.throws(() => validateMapCount(count));
});

test('20 maps synchronize from any map without feedback, then dispose removed maps', async (t) => {
  frames(t);
  const { group, entries, panes } = harness();
  await group.setMapCount(20, new AbortController().signal);
  assert.equal(group.mapCount(), 20);
  const camera = { center: [12, 49], zoom: 8.75 };
  const before = entries.map((entry) => entry.calls.cameras.length);
  entries[19].adapter.setCamera(camera);
  entries.forEach((entry, i) => {
    assert.deepEqual(entry.getCamera(), camera);
    assert.equal(entry.calls.cameras.length - before[i], 1);
  });
  group.setCamera({ center: [7, 53], zoom: 5.5 });
  assert.ok(entries.every((entry) => entry.getCamera().zoom === 5.5));
  assert.equal(group.viewports().length, 20);
  await group.setMapCount(2, new AbortController().signal);
  assert.equal(panes.size, 2);
  assert.ok(entries.slice(2).every((entry) => entry.calls.destroyed));
  assert.ok(!entries[0].calls.destroyed);
});

test('point data and every raster load have independent instances for all 20 maps', async (t) => {
  frames(t);
  const { group, entries } = harness();
  await group.setMapCount(20, new AbortController().signal);
  const input = [{ features: [{ id: 1 }] }];
  group.addPoints(input); group.updatePoints(input);
  entries[0].calls.points[0][0].features[0].id = 99;
  assert.equal(input[0].features[0].id, 1);
  assert.equal(entries[1].calls.points[0][0].features[0].id, 1);
  assert.notEqual(entries[0].calls.updates[0], entries[1].calls.updates[0]);
  const layer = { id: 'temperature', path: 'test.tif', source: 'test.grib2' };
  const first = group.createOverlay(layer, 'cog', () => {});
  const second = group.createOverlay(layer, 'cog', () => {});
  await Promise.all([first.ready, second.ready]);
  const loads = entries.flatMap((entry) => entry.calls.rasters);
  assert.equal(new Set(loads.map((item) => item.requestKey)).size, 40);
  assert.equal(new Set(loads.map(cogUrl)).size, 40);
  for (const item of loads) {
    for (const url of [cogUrl(item), gribUrl(item), weatherTileUrl(item, 'wms'), weatherTileUrl(item, 'xyz')]) {
      assert.equal(new URL(url).searchParams.get('_map'), String(item.mapIndex));
      assert.equal(new URL(url).searchParams.get('_map_request'), item.requestKey);
    }
    assert.ok(weatherTileUrl(item, 'xyz').includes('{z}/{x}/{y}'));
    assert.ok(weatherTileUrl(item, 'wms').includes('{bbox-epsg-3857}'));
  }
  assert.equal(layer.requestKey, undefined);
  const restyle = { pointColor: '#a323c5', rasterColorTable: 'benchmark' };
  group.restylePoints(restyle); second.restyle(restyle);
  entries.forEach((entry) => {
    assert.deepEqual(entry.calls.pointStyle, restyle);
    assert.deepEqual(entry.calls.rasterStyle, restyle);
  });
  first.remove(); second.remove();
  assert.ok(entries.every((entry) => entry.calls.removed === 2));
});

test('failed and cancelled map construction roll back new maps and pending panes', async (t) => {
  frames(t);
  const failed = harness((surface, index) => {
    if (index === 4) throw new Error('GPU limit');
    return native(index, surface);
  });
  await assert.rejects(failed.group.setMapCount(20, new AbortController().signal), /GPU limit/);
  assert.equal(failed.group.mapCount(), 1);
  assert.equal(failed.panes.size, 1);
  assert.ok(failed.entries.slice(1).every((entry) => entry.calls.destroyed));
  const controller = new AbortController();
  const cancelled = harness((surface, index) => { controller.abort(new Error('Stopped')); return native(index, surface); });
  await assert.rejects(cancelled.group.setMapCount(20, controller.signal), /Stopped/);
  assert.equal(cancelled.panes.size, 1);
  assert.ok(cancelled.entries[1].calls.destroyed);
});

test('partial preparation and overlay creation clean up earlier native maps', async (t) => {
  frames(t);
  const { group, entries } = harness();
  await group.setMapCount(3, new AbortController().signal);
  entries[2].adapter.prepare = () => { throw new Error('Context lost'); };
  assert.throws(() => group.prepare(), /Context lost/);
  assert.deepEqual(entries.map((entry) => entry.calls.restored), [1, 1, 0]);
  entries[2].createOverlay = () => { throw new Error('Raster failed'); };
  assert.throws(() => group.createOverlay({}, 'cog', () => {}), /Raster failed/);
  assert.equal(entries[0].calls.removed, 1);
  assert.equal(entries[1].calls.removed, 1);
});

test('raster settling waits for the slowest map', async (t) => {
  frames(t);
  const { group, entries } = harness();
  await group.setMapCount(20, new AbortController().signal);
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  entries[19].createOverlay = () => ({ ready: slow, settle: () => slow, remove() {}, setVisible() {} });
  const overlay = group.createOverlay({}, 'cog', () => {});
  let settled = false;
  const pending = overlay.settle(new AbortController().signal).then(() => { settled = true; });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  release(); await pending; await overlay.ready;
  assert.equal(settled, true);
});

test('benchmark requires updated isolation-aware raster servers, once per server', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push(url); assert.equal(options.cache, 'no-store');
    return { ok: true, json: async () => ({ cacheIsolationSupported: true }) }; };
  await assertRasterIsolation([{ mode: 'wms' }, { mode: 'xyz' }, { mode: 'cog' }, { mode: 'grib' }], new AbortController().signal);
  assert.equal(calls.length, 2);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  await assert.rejects(assertRasterIsolation([{ mode: 'cog' }], new AbortController().signal), /Restart the updated/);
});


test('unreachable raster servers report the endpoint and startup command while cancellation stays cancellation', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(assertRasterIsolation([{ mode: 'wms' }]), (error) => {
    assert.match(error.message, /WMS\/PNG server unavailable at http:/);
    assert.match(error.message, /npm run start:all/);
    return true;
  });
  const controller = new AbortController();
  controller.abort(new Error('User stopped'));
  await assert.rejects(assertRasterIsolation([{ mode: 'cog' }], controller.signal), /User stopped/);
});


test('fresh initialization destroys all 20 old maps before creating any replacement and preserves controls', async (t) => {
  frames(t);
  let generation, watchStops = 0;
  const { group, entries, panes } = harness((surface, index, _signal, startup) => {
    if (generation) {
      assert.ok(generation.every((entry) => entry.calls.destroyed));
      assert.equal(startup.benchmark, true);
      assert.equal(startup.mapCount, 20);
      assert.deepEqual(startup.camera, { center: [12, 52], zoom: 4 });
    }
    const entry = native(index, surface);
    entry.adapter.watchErrors = (callback) => {
      entry.emitError = callback;
      return () => { watchStops++; entry.emitError = undefined; };
    };
    return entry;
  });
  await group.setMapCount(20, new AbortController().signal);
  generation = [...entries];
  const errors = [];
  const stopWatching = group.watchErrors((error) => errors.push(error.message));
  const snapshot = group.prepare();
  const result = await group.initializeMaps(20, new AbortController().signal, { center: [12, 52], zoom: 4 });
  assert.equal(group.mapCount(), 20); assert.equal(panes.size, 20);
  assert.equal(result.initializedMapCount, 20);
  assert.equal(result.mapInitializations.length, 20);
  assert.ok(result.mapInitMs >= 0 && result.mapDestroyMs >= 0);
  assert.ok(Math.abs(result.mapResetMs - result.mapInitMs - result.mapDestroyMs) < 1e-8);
  const fresh = entries.slice(20);
  assert.ok(fresh.every((entry) => !generation.includes(entry) && !entry.calls.destroyed));
  assert.ok(generation.slice(1).every((entry) => !entry.emitError));
  fresh[19].emitError(new Error('new context failed'));
  assert.deepEqual(errors, ['Map 20: new context failed']);
  group.restore(snapshot);
  assert.ok(fresh.every((entry) => entry.calls.restored === 1));
  generation[0].getCamera = () => { throw new Error('Destroyed first map must never be used'); };
  const camera = { center: [7, 48], zoom: 9 };
  group.setCamera(camera);
  await group.setMapCount(19, new AbortController().signal);
  assert.ok(fresh.slice(0, 19).every((entry) => entry.getCamera().zoom === 9));
  stopWatching();
  assert.equal(watchStops, 39); // 19 old + 20 replacements (first old map had no watcher).
});

test('initialization waits for native readiness and cancels without leaking empty surfaces', async (t) => {
  frames(t);
  let release, created = false;
  const waiting = new Promise((resolve) => { release = resolve; });
  const slow = harness((surface, index) => {
    const entry = native(index, surface); created = true;
    entry.adapter.settle = () => waiting;
    return entry;
  });
  let completed = false;
  const init = slow.group.initializeMaps(1, new AbortController().signal, { center: [12, 52], zoom: 4 })
    .then((result) => { completed = true; return result; });
  while (!created) await new Promise(setImmediate);
  assert.equal(completed, false);
  release(); await init; assert.equal(completed, true);
  const controller = new AbortController();
  const cancelled = harness((surface, index) => {
    const entry = native(index, surface);
    if (index === 2) controller.abort(new Error('Stop fresh init'));
    return entry;
  });
  await assert.rejects(cancelled.group.initializeMaps(20, controller.signal, { center: [12, 52], zoom: 4 }), /Stop fresh init/);
  assert.equal(cancelled.group.mapCount(), 1);
  assert.equal(cancelled.panes.size, 1);
  assert.ok(cancelled.entries[0].calls.destroyed);
  assert.equal(cancelled.entries[1].calls.destroyed, false);
  assert.equal(cancelled.entries[2].calls.destroyed, true);
});

test('failed first initialization recovers a fresh preview and a later benchmark can retry', async (t) => {
  frames(t);
  let fail = true;
  const { group, entries, panes } = harness((surface, index, _signal, startup) => {
    if (startup?.benchmark && fail) throw new Error('Initialization failed');
    return native(index, surface);
  });
  await assert.rejects(group.initializeMaps(3, new AbortController().signal, { center: [12, 52], zoom: 4 }), /Initialization failed/);
  assert.equal(group.mapCount(), 1); assert.equal(panes.size, 1);
  assert.ok(entries[0].calls.destroyed);
  fail = false;
  await group.initializeMaps(3, new AbortController().signal, { center: [12, 52], zoom: 4 });
  assert.equal(group.mapCount(), 3); assert.equal(panes.size, 3);
});


test('lost contexts from earlier replacements are removed before recovering a usable map', async (t) => {
  frames(t);
  let earlier;
  const { group, panes } = harness((surface, index, _signal, startup) => {
    const entry = native(index, surface);
    if (startup?.benchmark && index === 1) earlier = entry;
    if (startup?.benchmark && index === 2) {
      earlier.adapter.assertReady = () => { throw new Error('Context lost'); };
      throw new Error('Context evicted');
    }
    return entry;
  });
  await assert.rejects(group.initializeMaps(20, new AbortController().signal, { center: [12, 52], zoom: 4 }), /Context evicted/);
  assert.equal(earlier.calls.destroyed, true);
  assert.equal(group.mapCount(), 1); assert.equal(panes.size, 1);
});
