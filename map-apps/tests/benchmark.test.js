import test from 'node:test';
import assert from 'node:assert/strict';
import { createPointLayers, cameraAt, POINT_BOUNDS, CAMERA_PATH, CAMERA_WAYPOINTS } from '../shared/benchmark/data.js';
import { percentile, summarizeFrames, toCsv } from '../shared/benchmark/stats.js';
import { runBenchmark, validateOptions } from '../shared/benchmark/runner.js';
import { afterFrames, waitForMapEvent, abortable } from '../shared/benchmark/timing.js';
import { createRasterWorkload, rasterSeries, commonRasterTimes, resolveRasterLayers } from '../shared/benchmark/raster-workload.js';

test('seeded workloads match across runs, have distinct layers, and respect bounds', () => {
  const data = createPointLayers(100, 2);
  assert.deepEqual(data, createPointLayers(100, 2));
  assert.notDeepEqual(data, createPointLayers(100, 2, 43));
  const features = data.flatMap((layer) => layer.features);
  assert.equal(features.length, 200);
  assert.equal(new Set(features.map((feature) => feature.id)).size, 200);
  for (const { geometry } of features) {
    assert.ok(geometry.coordinates[0] >= -12 && geometry.coordinates[0] <= 35);
    assert.ok(geometry.coordinates[1] >= 34 && geometry.coordinates[1] <= 72);
  }
  assert.ok(features.some(({ geometry }) => geometry.coordinates[0] < -5));
  assert.ok(features.some(({ geometry }) => geometry.coordinates[0] > 25));
  assert.ok(features.some(({ geometry }) => geometry.coordinates[1] < 40));
  assert.ok(features.some(({ geometry }) => geometry.coordinates[1] > 65));
  assert.throws(() => createPointLayers(5001, 1));
  assert.throws(() => createPointLayers(100, 0));
});

test('camera follows a closed, bounded path with consistent zoom', () => {
  assert.deepEqual(cameraAt(0), { center: [12, 52], zoom: 4 });
  assert.deepEqual(cameraAt(1), cameraAt(0));
  assert.deepEqual(cameraAt(-1), cameraAt(0));
  assert.deepEqual(cameraAt(2), cameraAt(1));
  for (let index = 0; index < CAMERA_WAYPOINTS.length; index++) {
    const camera = cameraAt(index / (CAMERA_WAYPOINTS.length - 1));
    const waypoint = CAMERA_WAYPOINTS[index];
    assert.ok(Math.abs(camera.zoom - waypoint.zoom) < 1e-9);
    waypoint.center.forEach((value, axis) => assert.ok(Math.abs(camera.center[axis] - value) < 1e-9));
  }
  const samples = Array.from({ length: 601 }, (_, i) => cameraAt(i / 600));
  assert.equal(Math.max(...samples.map(({ zoom }) => zoom)), 12);
  assert.ok(Math.min(...samples.map(({ center }) => center[0])) < -3);
  assert.ok(Math.max(...samples.map(({ center }) => center[0])) > 26);
  assert.ok(Math.min(...samples.map(({ center }) => center[1])) < 41);
  assert.ok(Math.max(...samples.map(({ center }) => center[1])) > 60);
  samples.forEach((camera, i) => {
    assert.ok(camera.zoom >= 4 && camera.zoom <= 12);
    assert.ok(camera.center[0] >= POINT_BOUNDS[0] && camera.center[0] <= POINT_BOUNDS[2]);
    assert.ok(camera.center[1] >= POINT_BOUNDS[1] && camera.center[1] <= POINT_BOUNDS[3]);
    if (i) {
      assert.ok(Math.abs(camera.zoom - samples[i - 1].zoom) < 0.3);
      camera.center.forEach((value, axis) => assert.ok(Math.abs(value - samples[i - 1].center[axis]) < 1));
    }
  });
  for (const fraction of [0.25, 0.5, 0.75]) {
    const before = cameraAt(fraction - 1e-7), after = cameraAt(fraction + 1e-7);
    assert.ok(Math.abs(before.zoom - after.zoom) < 1e-4);
    before.center.forEach((value, axis) => assert.ok(Math.abs(value - after.center[axis]) < 1e-4));
  }
});

test('frame statistics use all intervals, including slow frames', () => {
  const stats = summarizeFrames([10, 10, 20, 60]);
  assert.equal(stats.rafFps, 40);
  assert.equal(stats.meanFrameMs, 25);
  assert.equal(stats.medianFrameMs, 10);
  assert.equal(stats.p95FrameMs, 60);
  assert.equal(stats.framesOver50Ms, 1);
  assert.equal(stats.maxFrameMs, 60);
  assert.equal(percentile([], 95), null);
  assert.equal(summarizeFrames([]).rafFps, null);
});

test('CSV escapes fields and preserves unavailable and negative numeric values', () => {
  const csv = toCsv([{ library: 'Map, "Test"', note: '=1+1', heapDeltaBytes: -24, longTaskCount: null, frameIntervalsMs: [16] }]);
  assert.equal(csv, '"library","note","heapDeltaBytes","longTaskCount"\r\n"Map, ""Test""","\'=1+1","-24",""');
  assert.equal(toCsv([]), '');
});

function fakeBrowser(t) {
  const originals = new Map();
  const pending = new Map();
  let clock = 0;
  let nextId = 0;
  const define = (key, value) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  define('requestAnimationFrame', (callback) => {
    const id = ++nextId;
    pending.set(id, setImmediate(() => { pending.delete(id); clock += 20; callback(clock); }));
    return id;
  });
  define('cancelAnimationFrame', (id) => { clearImmediate(pending.get(id)); pending.delete(id); });
  define('performance', { now: () => clock });
  define('window', { devicePixelRatio: 2 });
  define('navigator', { hardwareConcurrency: 8, userAgent: 'unit-test' });
  define('PerformanceObserver', undefined);
  t.after(() => {
    for (const handle of pending.values()) clearImmediate(handle);
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return pending;
}

function fakeAdapter() {
  const calls = { adds: 0, clears: 0, restores: 0, cameras: [] };
  const snapshot = { original: true };
  return {
    calls,
    library: 'Test', version: '1', renderer: 'test', readySignal: 'test frame fence',
    size: () => ({ width: 800, height: 600 }),
    prepare: () => snapshot,
    restore(state) { assert.equal(state, snapshot); calls.restores++; },
    clearPoints() { calls.clears++; },
    addPoints(data) { assert.equal(data.length, 2); calls.adds++; },
    setCamera(camera) { calls.cameras.push(camera); },
    settle: (signal) => afterFrames(2, signal),
  };
}

const options = { pointsPerLayer: 100, layerCount: 2, durationSeconds: 3, repetitions: 3, warmup: true, measureServerMetrics: false };

test('longer Europe tours preserve motion duration across a time change and export workload identity', async (t) => {
  fakeBrowser(t);
  for (const durationSeconds of [30, 60, 120]) {
    const adapter = fakeAdapter();
    let updated;
    adapter.updatePoints = (data) => { updated = data; };
    const [row] = await runBenchmark(adapter, { ...options, durationSeconds, repetitions: 1, warmup: false,
      timeChange: { fraction: 0.5, points: true, rasters: false } }, { signal: new AbortController().signal });
    assert.equal(row.requestedMotionMs, durationSeconds * 1000);
    assert.equal(row.measuredMotionMs, durationSeconds * 1000);
    assert.equal(row.beforeChangeMeasuredMotionMs, durationSeconds * 500);
    assert.equal(row.afterChangeMeasuredMotionMs, durationSeconds * 500);
    assert.equal(row.cameraPath, CAMERA_PATH);
    assert.deepEqual(row.cameraZoomRange, [4, 12]);
    assert.deepEqual(row.pointBounds, [-12, 34, 35, 72]);
    assert.equal(row.pointRegion, 'Europe bounding box');
    assert.deepEqual(row.cameraWaypoints, CAMERA_WAYPOINTS);
    assert.ok(adapter.calls.cameras.some(({ zoom }) => zoom > 11.9));
    assert.deepEqual(updated, createPointLayers(100, 2, 43));
  }
  assert.throws(() => validateOptions({ ...options, durationSeconds: 121 }), /Invalid benchmark/);
});

test('runner exports aggregate workload and per-map dimensions for 20 synchronized maps', async (t) => {
  fakeBrowser(t);
  const adapter = fakeAdapter();
  adapter.mapCount = () => 20;
  adapter.viewports = () => Array.from({ length: 20 }, (_, i) => ({ mapIndex: i + 1, width: 200, height: 150 }));
  const [row] = await runBenchmark(adapter, { ...options, mapCount: 20, repetitions: 1, warmup: false },
    { signal: new AbortController().signal });
  assert.equal(row.schemaVersion, 7);
  assert.equal(row.mapCount, 20);
  assert.equal(row.pointsPerMap, 200);
  assert.equal(row.totalPoints, 4000);
  assert.equal(row.totalPointLayerInstances, 40);
  assert.equal(row.mapViewports.length, 20);
  assert.equal(row.synchronizedCamera, true);
  await assert.rejects(runBenchmark(adapter, { ...options, mapCount: 19 },
    { signal: new AbortController().signal }), /requested map grid/);
});

test('runner discards warm-up, exports metadata and nulls, and restores the map', async (t) => {
  const pending = fakeBrowser(t);
  const adapter = fakeAdapter();
  const result = await runBenchmark(adapter, options, { signal: new AbortController().signal });
  assert.equal(result.length, 3);
  assert.equal(adapter.calls.adds, 4);
  assert.equal(adapter.calls.restores, 1);
  assert.equal(adapter.calls.clears, 5);
  assert.deepEqual(result.map((row) => row.repetition), [1, 2, 3]);
  assert.equal(new Set(result.map((row) => row.batchId)).size, 1);
  for (const row of result) {
    assert.equal(row.totalPoints, 200);
    assert.equal(row.rafFps, 50);
    assert.equal(row.measuredMotionMs, 3000);
    assert.equal(row.p95FrameMs, 20);
    assert.equal(row.layerReadyMs, 40);
    assert.equal(row.heapBeforeBytes, null);
    assert.equal(row.heapDeltaBytes, null);
    assert.equal(row.longTaskCount, null);
    assert.equal(row.viewportWidth, 800);
  }
  assert.equal(pending.size, 0);
});

test('cancellation keeps completed trials only and cleans up', async (t) => {
  const pending = fakeBrowser(t);
  const adapter = fakeAdapter();
  const controller = new AbortController();
  const saved = [];
  await assert.rejects(runBenchmark(adapter, options, {
    signal: controller.signal,
    onResult: (row) => { saved.push(row); controller.abort(new Error('Stopped')); },
  }), /Stopped/);
  assert.equal(saved.length, 1);
  assert.equal(adapter.calls.restores, 1);
  assert.equal(pending.size, 0);
});

test('failure during insertion still clears layers and restores the map', async (t) => {
  fakeBrowser(t);
  const adapter = fakeAdapter();
  adapter.addPoints = () => { throw new Error('renderer failure'); };
  await assert.rejects(runBenchmark(adapter, options, { signal: new AbortController().signal }), /renderer failure/);
  assert.equal(adapter.calls.restores, 1);
  assert.equal(adapter.calls.clears, 2);
});

test('abort during animation cancels pending frame callbacks and restores view', async (t) => {
  const pending = fakeBrowser(t);
  const controller = new AbortController();
  const adapter = fakeAdapter();
  let frames = 0;
  adapter.setCamera = () => { if (++frames === 4) controller.abort(new Error('hidden')); };
  await assert.rejects(runBenchmark(adapter, options, { signal: controller.signal }), /hidden/);
  assert.equal(adapter.calls.restores, 1);
  assert.equal(pending.size, 0);
});

test('invalid configuration never changes the map', async () => {
  const adapter = fakeAdapter();
  await assert.rejects(runBenchmark(adapter, { ...options, repetitions: -1 }, { signal: new AbortController().signal }), /Invalid/);
  assert.equal(adapter.calls.clears, 0);
  assert.equal(adapter.calls.restores, 0);
});

test('optional long-task entries are clipped to the measured trial window', async (t) => {
  fakeBrowser(t);
  let disconnected = false;
  globalThis.PerformanceObserver = class {
    static supportedEntryTypes = ['longtask'];
    observe() {}
    takeRecords() {
      return [{ startTime: 0, duration: 100 }, { startTime: 100, duration: 60 }, { startTime: 100000, duration: 70 }];
    }
    disconnect() { disconnected = true; }
  };
  const rows = await runBenchmark(fakeAdapter(), { ...options, repetitions: 1, warmup: false }, { signal: new AbortController().signal });
  // Trial starts at 80ms after readiness + preparation frame fences.
  assert.equal(rows[0].longTaskCount, 2);
  assert.equal(rows[0].longTaskMs, 80);
  assert.equal(disconnected, true);
});

test('map event readiness installs listeners before rendering and removes them on abort', async () => {
  const listeners = new Map();
  const events = { on: (event, handler) => listeners.set(event, handler), off: (event) => listeners.delete(event) };
  await waitForMapEvent({ ...events, trigger: () => listeners.get('idle')() }, 'idle', new AbortController().signal);
  assert.equal(listeners.size, 0);
  const controller = new AbortController();
  const waiting = waitForMapEvent({ ...events, trigger: () => {} }, 'idle', controller.signal);
  controller.abort(new Error('aborted'));
  await assert.rejects(waiting, /aborted/);
  assert.equal(listeners.size, 0);
});

const raster = (variable, time = '2026-10-05T03:00:00Z', mode = 'cog') => ({ mode, layer: {
  id: `${variable}_${time}`, variable, valid_time: time, run: '2026100500',
  reference_time: '2026-10-05T00:00:00Z', level_type: 'surface', level: 0, message: 1,
  width: 1377, height: 657, style: { min: 0, max: 100, colors: [[0, 0, 0], [255, 255, 255]], resampling: 'bilinear' },
} });
const initialRasters = [raster('t_2m'), raster('clct', undefined, 'grib')];
const nextRasters = [raster('t_2m', '2026-10-05T06:00:00Z'), raster('clct', '2026-10-05T06:00:00Z', 'grib')];

test('mixed workload replaces points and forecast, exporting each measured phase', async (t) => {
  const pending = fakeBrowser(t);
  const adapter = fakeAdapter();
  const events = [];
  adapter.addRasters = (data) => { events.push(['rasters', data]); };
  adapter.clearRasters = () => events.push(['clear']);
  adapter.settleRasters = (signal) => { events.push(['ready']); return afterFrames(3, signal); };
  adapter.updatePoints = (data) => { events.push(['points', data]); };
  const rows = await runBenchmark(adapter, { ...options, repetitions: 1, warmup: false,
    rasterLayers: initialRasters, nextRasterLayers: nextRasters,
    timeChange: { fraction: 0.5, points: true, rasters: true },
  }, { signal: new AbortController().signal });
  const row = rows[0];
  assert.equal(row.schemaVersion, 7);
  assert.equal(row.pointLayerCount, 2);
  assert.equal(row.rasterLayerCount, 2);
  assert.match(row.rasterResolutionPolicy, /source-native ceiling/);
  assert.ok(row.rasterLayers.every((layer) => Number.isInteger(layer.nativeTileZoom)));
  assert.ok(row.nextRasterLayers.every((layer) => Number.isInteger(layer.nativeTileZoom)));
  assert.equal(row.layerReadyMs, 100); // Three raster frames + two native frames.
  assert.ok(row.timeChangeReadyMs >= 100);
  assert.equal(row.timeChangeSubmitMs, 0);
  assert.equal(row.beforeChangeMeasuredMotionMs, 1500);
  assert.equal(row.afterChangeMeasuredMotionMs, 1500);
  assert.equal(row.measuredMotionMs, 3000);
  assert.ok(row.timeChangeFrameSamples > 0);
  assert.equal(row.updatedPointSeed, 43);
  assert.deepEqual(events.filter(([type]) => type === 'rasters').map(([, data]) => data), [initialRasters, nextRasters]);
  const updated = events.find(([type]) => type === 'points')[1];
  assert.deepEqual(updated, createPointLayers(100, 2, 43));
  assert.notDeepEqual(updated, createPointLayers(100, 2, 42));
  assert.deepEqual(updated.flatMap((layer) => layer.features.map((f) => f.id)),
    createPointLayers(100, 2).flatMap((layer) => layer.features.map((f) => f.id)));
  assert.equal(row.nextRasterLayers[0].validTime, nextRasters[0].layer.valid_time);
  assert.equal(adapter.calls.restores, 1);
  assert.equal(pending.size, 0);
});

test('raster-only workload is supported and point-only time changes leave raster sources intact', async (t) => {
  fakeBrowser(t);
  const adapter = fakeAdapter();
  let adds = 0;
  adapter.addPoints = (data) => assert.equal(data.length, 0);
  adapter.addRasters = () => { adds++; };
  adapter.clearRasters = () => {};
  adapter.settleRasters = (signal) => afterFrames(1, signal);
  const rows = await runBenchmark(adapter, { ...options, repetitions: 1, warmup: false, layerCount: 0,
    rasterLayers: initialRasters, nextRasterLayers: nextRasters,
    timeChange: { fraction: 0.25, points: false, rasters: true },
  }, { signal: new AbortController().signal });
  assert.equal(rows[0].totalPoints, 0);
  assert.equal(adds, 2);
  const pointAdapter = fakeAdapter();
  pointAdapter.addRasters = () => { adds++; };
  pointAdapter.clearRasters = () => {};
  pointAdapter.settleRasters = adapter.settleRasters;
  pointAdapter.updatePoints = () => {};
  await runBenchmark(pointAdapter, { ...options, repetitions: 1, warmup: false, rasterLayers: initialRasters,
    timeChange: { fraction: 0.75, points: true, rasters: false },
  }, { signal: new AbortController().signal });
  assert.equal(adds, 3); // Existing raster overlays are reused for a points-only change.
});

test('stop during a time change discards the trial and restores all map state', async (t) => {
  const pending = fakeBrowser(t);
  const adapter = fakeAdapter();
  const controller = new AbortController();
  let updates = 0, rasterClears = 0, saved = 0;
  adapter.addRasters = () => {};
  adapter.clearRasters = () => { rasterClears++; };
  adapter.settleRasters = (signal) => afterFrames(1, signal);
  adapter.updatePoints = () => { updates++; controller.abort(new Error('stopped during update')); };
  await assert.rejects(runBenchmark(adapter, { ...options, repetitions: 1, warmup: false,
    rasterLayers: initialRasters, timeChange: { fraction: 0.5, points: true, rasters: false },
  }, { signal: controller.signal, onResult: () => { saved++; } }), /stopped during update/);
  assert.equal(updates, 1);
  assert.equal(saved, 0);
  assert.equal(rasterClears, 2);
  assert.equal(adapter.calls.restores, 1);
  assert.equal(pending.size, 0);
});

test('empty workloads, invalid modes and mismatched or unchanged forecast times are rejected before timing', () => {
  assert.throws(() => validateOptions({ ...options, layerCount: 0 }), /at least one/);
  assert.throws(() => validateOptions({ ...options, rasterLayers: [raster('t_2m', undefined, 'jpeg')] }), /at least one/);
  const config = { ...options, rasterLayers: initialRasters,
    timeChange: { fraction: 0.5, points: false, rasters: true } };
  assert.throws(() => validateOptions({ ...config, nextRasterLayers: initialRasters }), /different time/);
  assert.throws(() => validateOptions({ ...config, nextRasterLayers: [raster('other', 'later'), nextRasters[1]] }), /different time/);
  assert.throws(() => validateOptions({ ...config, nextRasterLayers: [] }), /different time/);
  assert.doesNotThrow(() => validateOptions({ ...config, nextRasterLayers: nextRasters }));
});

test('raster selectors intersect forecast times without mixing runs or levels', () => {
  const layers = [...initialRasters, ...nextRasters].map(({ layer }) => layer);
  layers.push({ ...raster('t_2m', 'later').layer, run: 'different-run' });
  const series = rasterSeries(layers);
  assert.equal(series.length, 3);
  const choices = ['t_2m', 'clct'].map((variable) => ({ key: series.find((s) =>
    s.layers[0].variable === variable && s.layers[0].run === '2026100500').key, mode: 'wms' }));
  assert.deepEqual(commonRasterTimes(series, choices), ['2026-10-05T03:00:00Z', '2026-10-05T06:00:00Z']);
  const selected = resolveRasterLayers(series, choices, '2026-10-05T06:00:00Z');
  assert.ok(selected.every(({ layer }) => layer.valid_time === '2026-10-05T06:00:00Z'));
  assert.throws(() => resolveRasterLayers(series, choices, 'unavailable'), /available/);
  assert.deepEqual(commonRasterTimes(series, []), []);
});

test('raster completion waits for every layer and propagates late decoder failures', async () => {
  const created = [], removed = [];
  const workload = createRasterWorkload((_layer, _mode, onError, id) => {
    let finish;
    const complete = new Promise((resolve) => { finish = resolve; });
    created.push({ finish, onError, id });
    return { settle: () => complete, remove: () => removed.push(id) };
  });
  workload.add(initialRasters);
  let complete = false;
  const waiting = workload.settle(new AbortController().signal).then(() => { complete = true; });
  created[0].finish();
  await new Promise(setImmediate);
  assert.equal(complete, false);
  created[1].finish();
  await waiting;
  assert.equal(complete, true);
  workload.add(nextRasters);
  assert.deepEqual(removed, ['benchmark-raster-0', 'benchmark-raster-1']);
  created[0].onError(new Error('stale error')); // Removed layers cannot fail the new generation.
  const failed = workload.settle(new AbortController().signal);
  created[3].onError(new Error('worker failed'));
  await assert.rejects(failed, /worker failed/);
  workload.clear();
  assert.equal(removed.length, 4);
});

test('abort interrupts an unresolved raster decode wait and timeout is an error', async () => {
  const controller = new AbortController();
  const wait = abortable(new Promise(() => {}), controller.signal);
  controller.abort(new Error('cancel decode'));
  await assert.rejects(wait, /cancel decode/);
  await assert.rejects(abortable(new Promise(() => {}), new AbortController().signal, 1), /timed out/);
});

test('CSV includes structured raster metadata and excludes raw intervals for all phases', () => {
  const csv = toCsv([{ rasterLayers: [{ id: 'temperature', mode: 'grib' }], timeChangeReadyMs: 120,
    frameIntervalsMs: [16], beforeChangeFrameIntervalsMs: [17], timeChangeFrameIntervalsMs: [40] }]);
  assert.ok(csv.includes('temperature'));
  assert.ok(csv.includes('grib'));
  assert.ok(csv.includes('"120"'));
  assert.ok(!csv.includes('FrameIntervals'));
  assert.ok(!csv.includes('[object Object]'));
});


test('final color restyle follows updated data and all motion, including warm-up, without changing motion FPS', async (t) => {
  const pending = fakeBrowser(t);
  const adapter = fakeAdapter();
  const events = [];
  let activeRasters;
  adapter.addRasters = (requests) => { activeRasters = requests; events.push('load'); };
  adapter.clearRasters = () => {};
  adapter.settleRasters = (signal) => afterFrames(3, signal);
  adapter.updatePoints = () => events.push('timeChange');
  adapter.restylePoints = (style) => {
    assert.equal(style.pointColor, '#a323c5');
    assert.deepEqual(adapter.calls.cameras.at(-1), cameraAt(1));
    assert.equal(activeRasters, nextRasters);
    events.push('pointStyle');
  };
  adapter.restyleRasters = (style) => { assert.equal(style.rasterColorTable, 'benchmark'); events.push('rasterStyle'); };
  const rows = await runBenchmark(adapter, { ...options, repetitions: 1, colorRestyle: true,
    rasterLayers: initialRasters, nextRasterLayers: nextRasters,
    timeChange: { fraction: 0.5, points: true, rasters: true },
  }, { signal: new AbortController().signal });
  assert.equal(rows.length, 1);
  assert.deepEqual(events, ['load', 'timeChange', 'load', 'pointStyle', 'rasterStyle',
    'load', 'timeChange', 'load', 'pointStyle', 'rasterStyle']);
  const row = rows[0];
  assert.equal(row.colorRestyleEnabled, true);
  assert.equal(row.colorRestyleSubmitMs, 0);
  assert.ok(row.colorRestyleReadyMs >= 140); // Raster + native readiness + paint fence.
  assert.ok(row.colorRestyleFrameSamples > 0);
  assert.equal(row.measuredMotionMs, 3000);
  assert.equal(row.rafFps, 50);
  assert.equal(row.colorRestyleStartMs + row.colorRestyleReadyMs, row.trialMs);
  assert.ok(toCsv(rows).includes('colorRestyleReadyMs'));
  assert.ok(!toCsv(rows).includes('colorRestyleFrameIntervalsMs'));
  assert.equal(adapter.calls.restores, 1);
  assert.equal(pending.size, 0);
});

test('restyle works for point-only and raster-only workloads and disabled trials keep null timing', async (t) => {
  fakeBrowser(t);
  const points = fakeAdapter();
  let pointRestyles = 0;
  points.restylePoints = () => { pointRestyles++; };
  const [pointRow] = await runBenchmark(points, { ...options, repetitions: 1, warmup: false, colorRestyle: true },
    { signal: new AbortController().signal });
  assert.equal(pointRestyles, 1);
  assert.ok(pointRow.colorRestyleReadyMs >= 80);
  const rasterAdapter = fakeAdapter();
  rasterAdapter.addPoints = (data) => assert.equal(data.length, 0);
  rasterAdapter.addRasters = () => {};
  rasterAdapter.settleRasters = (signal) => afterFrames(1, signal);
  let rasterRestyles = 0;
  rasterAdapter.restyleRasters = () => { rasterRestyles++; };
  const [rasterRow] = await runBenchmark(rasterAdapter, { ...options, layerCount: 0,
    rasterLayers: initialRasters, repetitions: 1, warmup: false, colorRestyle: true },
  { signal: new AbortController().signal });
  assert.equal(rasterRestyles, 1);
  assert.ok(rasterRow.colorRestyleReadyMs >= 100);
  const [disabled] = await runBenchmark(points, { ...options, repetitions: 1, warmup: false, colorRestyle: false },
    { signal: new AbortController().signal });
  assert.equal(disabled.colorRestyleReadyMs, null);
  assert.equal(disabled.colorRestyleSubmitMs, null);
  assert.equal(disabled.colorRestyleFrameSamples, 0);
  assert.equal(disabled.colorRestyleNetwork, null);
  assert.equal(pointRestyles, 1);
  assert.throws(() => validateOptions({ ...options, colorRestyle: 'true' }), /Invalid/);
});

test('abort or failure during final restyle discards that trial and cancels frame sampling', async (t) => {
  const pending = fakeBrowser(t);
  for (const abort of [true, false]) {
    const adapter = fakeAdapter();
    const controller = new AbortController();
    let saved = 0;
    adapter.restylePoints = () => {
      if (abort) controller.abort(new Error('restyle stopped'));
      else throw new Error('restyle failed');
    };
    await assert.rejects(runBenchmark(adapter, { ...options, repetitions: 1, warmup: false, colorRestyle: true },
      { signal: controller.signal, onResult: () => { saved++; } }), /restyle (stopped|failed)/);
    assert.equal(saved, 0);
    assert.equal(adapter.calls.restores, 1);
    assert.equal(pending.size, 0);
  }
});


test('restyle readiness includes asynchronous recoloring, while submission stays synchronous', async (t) => {
  fakeBrowser(t);
  const adapter = fakeAdapter();
  let styling = false, styled = false;
  adapter.addRasters = () => {};
  adapter.restylePoints = () => {};
  adapter.restyleRasters = async () => {
    styling = true;
    await afterFrames(5, new AbortController().signal);
    styled = true;
  };
  adapter.settleRasters = async () => { if (styling) assert.equal(styled, true); };
  const [row] = await runBenchmark(adapter, { ...options, warmup: false, repetitions: 1,
    rasterLayers: initialRasters, colorRestyle: true }, { signal: new AbortController().signal });
  assert.equal(row.colorRestyleSubmitMs, 0);
  assert.ok(row.colorRestyleReadyMs >= 180);
  assert.ok(row.colorRestyleLayers.every((layer) => layer.style.colorTable && layer.style.colors.length >= 2));
  assert.equal(row.colorRestyleLayers[0].variable, 't_2m');
});

test('stop cancels a pending worker restyle acknowledgement instead of waiting indefinitely', async (t) => {
  const pending = fakeBrowser(t);
  const adapter = fakeAdapter();
  const controller = new AbortController();
  adapter.addRasters = () => {};
  adapter.settleRasters = async () => {};
  adapter.restylePoints = () => {};
  adapter.restyleRasters = () => {
    setImmediate(() => controller.abort(new Error('stop pending recolor')));
    return new Promise(() => {});
  };
  await assert.rejects(runBenchmark(adapter, { ...options, warmup: false, repetitions: 1,
    rasterLayers: initialRasters, colorRestyle: true }, { signal: controller.signal }), /stop pending recolor/);
  assert.equal(adapter.calls.restores, 1);
  assert.equal(pending.size, 0);
});


test('each trial gets a fresh map initialization metric, including discarded warm-up, outside motion and layer timing', async (t) => {
  const pending = fakeBrowser(t);
  const adapter = fakeAdapter();
  let initialized = 0;
  adapter.initializeMaps = async (count, signal, camera) => {
    assert.equal(count, 1); assert.deepEqual(camera, cameraAt(0));
    assert.equal(adapter.calls.adds, initialized);
    initialized++;
    await afterFrames(5, signal);
    return { mapInitMs: initialized * 100, mapDestroyMs: 40, mapResetMs: initialized * 100 + 40,
      initializedMapCount: count, mapInitializations: [{ mapIndex: 1, readyMs: initialized * 100 }],
      mapInitReadySignal: 'test readiness' };
  };
  const rows = await runBenchmark(adapter, options, { signal: new AbortController().signal });
  assert.equal(initialized, 4);
  assert.deepEqual(rows.map((row) => row.mapInitMs), [200, 300, 400]);
  rows.forEach((row) => {
    assert.equal(row.initializedMapCount, 1);
    assert.equal(row.mapDestroyMs, 40);
    assert.equal(row.mapResetMs, row.mapInitMs + 40);
    assert.equal(row.layerReadyMs, 40);
    assert.equal(row.measuredMotionMs, 3000);
    assert.equal(row.rafFps, 50);
    assert.match(row.mapInitPolicy, /destroy all maps before each trial/);
    assert.equal(row.mapInitializations.length, 1);
  });
  assert.ok(toCsv(rows).includes('mapInitMs'));
  assert.equal(adapter.calls.restores, 1);
  assert.equal(pending.size, 0);
});

test('failed or stopped initialization produces no trial row and still restores map state', async (t) => {
  const pending = fakeBrowser(t);
  for (const abort of [true, false]) {
    const adapter = fakeAdapter();
    const controller = new AbortController();
    let saved = 0;
    adapter.initializeMaps = async (_count, signal) => {
      if (!abort) throw new Error('map init failed');
      setImmediate(() => controller.abort(new Error('map init stopped')));
      await afterFrames(5, signal);
    };
    await assert.rejects(runBenchmark(adapter, options,
      { signal: controller.signal, onResult: () => { saved++; } }), /map init (failed|stopped)/);
    assert.equal(saved, 0); assert.equal(adapter.calls.adds, 0);
    assert.equal(adapter.calls.restores, 1); assert.equal(pending.size, 0);
  }
});
