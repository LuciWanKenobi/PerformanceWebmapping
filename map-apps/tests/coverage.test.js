import test from 'node:test';
import assert from 'node:assert/strict';
import { coveredFraction, createMotionCoverage, tileBounds } from '../shared/benchmark/coverage.js';
import { trackGlTiles, trackLeafletTiles, trackOpenLayersTiles } from '../shared/benchmark/raster-coverage-adapters.js';
import { createRasterWorkload } from '../shared/benchmark/raster-workload.js';
import { toCsv } from '../shared/benchmark/stats.js';
import { createGlAdapter } from '../shared/benchmark/gl-adapter.js';

const rect = [0, 0, 10, 10];
const observation = (fraction = 1, mapIndex = 1, rasterIndex = 0) => ({ mapIndex, rasterIndex, mode: 'cog', view: rect,
  extent: rect, rectangles: [[0, 0, fraction * 10, 10]], method: 'test rendered footprint' });

test('coverage clips to the data footprint and unions overlapping fallback tiles', () => {
  assert.equal(coveredFraction(rect, rect, [[0, 0, 5, 10], [0, 0, 5, 5]]).fraction, 0.5);
  assert.equal(coveredFraction(rect, [0, 0, 5, 10], [[0, 0, 5, 10]]).fraction, 1);
  assert.equal(coveredFraction(rect, rect, [[-10, -10, 20, 20]]).fraction, 1);
  assert.equal(coveredFraction(rect, rect, []).fraction, 0);
  assert.deepEqual(coveredFraction(rect, [20, 20, 30, 30], []), { applicable: false, fraction: null });
  assert.deepEqual(coveredFraction(rect, rect, null), { applicable: true, fraction: null });
  assert.deepEqual(coveredFraction(null, rect, []), { applicable: true, fraction: null });
});

test('motion coverage weights elapsed time, counts gaps and exposes delayed sampling', () => {
  let fraction = 0.5;
  const collector = createMotionCoverage({ sampleRasterCoverage: () => [observation(fraction)] }, true, 1);
  collector.begin(0);
  fraction = 1; collector.sample(100); collector.end(300);
  const result = collector.finish();
  assert.ok(Math.abs(result.motionRasterCoveragePercent - 100 * 250 / 300) < 1e-9);
  assert.equal(result.motionRasterIncompleteMs, 100);
  assert.equal(result.motionRasterLongestGapMs, 100);
  assert.equal(result.motionCoverageObservedMs, 300);
  assert.equal(result.motionCoverageMaxSampleIntervalMs, 200);
  assert.equal(result.motionLayerCoverage[0].incompleteMs, 100);
  assert.equal(result.motionRasterCoverageStatus, 'measured');
  assert.equal(result.motionRasterSupersededWorkCount, null);
  assert.ok(!toCsv([result]).split('\r\n')[0].includes('motionCoverageSamples'));
});

test('all-map completeness tests every layer, including one weak layer hidden by averaging', () => {
  const collector = createMotionCoverage({ sampleRasterCoverage: () => [
    observation(1, 1, 0), observation(1, 1, 1), observation(1, 2, 0), observation(0.5, 2, 1),
  ] }, true, 4);
  collector.begin(0); collector.end(100);
  const result = collector.finish();
  assert.equal(result.motionRasterCoveragePercent, 87.5);
  assert.equal(result.motionWorstMapCoveragePercent, 75);
  assert.equal(result.motionAllMapsCompletePercent, 0);
  assert.equal(result.motionRasterIncompleteMs, 100);
  assert.deepEqual(result.motionMapCoverage.map(({ coveragePercent }) => coveragePercent), [100, 75]);
});

test('stationary pauses do not extend motion gaps or superseded-work counters', () => {
  let count = 0;
  const collector = createMotionCoverage({ sampleRasterCoverage: () => [observation(0.5)],
    rasterWorkStats: () => [{ kind: 'discardedNumericRenders', count }] }, true, 1);
  collector.begin(0); count = 2; collector.end(100);
  count = 20; collector.begin(1000); count = 21; collector.end(1100);
  const result = collector.finish();
  assert.equal(result.motionRasterIncompleteMs, 200); assert.equal(result.motionRasterLongestGapMs, 100);
  assert.equal(result.motionRasterSupersededWorkCount, 3); assert.equal(result.rasterSupersededWorkCount, 21);
  assert.equal(result.motionCoverageObservedMs, 200);
});

test('unsupported or failed hooks remain unknown and off-footprint time is separate', () => {
  for (const adapter of [{}, { sampleRasterCoverage() { throw new Error('changed native API'); } },
    { sampleRasterCoverage: () => [{ ...observation(), rectangles: null }] }]) {
    const collector = createMotionCoverage(adapter, true, 1); collector.begin(0); collector.end(100);
    const result = collector.finish();
    assert.equal(result.motionRasterCoveragePercent, null);
    assert.equal(result.motionAllMapsCompletePercent, null);
    assert.equal(result.motionCoverageUnknownMs, 100);
    assert.equal(result.motionRasterCoverageStatus, 'unavailable');
  }
  const collector = createMotionCoverage({ sampleRasterCoverage: () => [{ ...observation(), extent: [20, 20, 30, 30] }] }, true, 1);
  collector.begin(0); collector.end(100);
  assert.equal(collector.finish().motionNoRasterExpectedMs, 100);
  assert.equal(createMotionCoverage({}, false, 0).finish().motionRasterCoverageStatus, 'not applicable: no rasters');
});

test('partial observations disclose unknown time instead of counting it as full coverage', () => {
  let known = true;
  const collector = createMotionCoverage({ sampleRasterCoverage: () => [{ ...observation(), rectangles: known ? [rect] : null }] }, true, 1);
  collector.begin(0); known = false; collector.sample(100); collector.end(300);
  const result = collector.finish();
  assert.equal(result.motionRasterCoverageStatus, 'partial');
  assert.equal(result.motionCoverageObservedMs, 100); assert.equal(result.motionCoverageUnknownMs, 200);
  assert.equal(result.motionRasterCoveragePercent, 100); // Only the disclosed 100 ms observed window.
});

const geographicBounds = () => ({ getWest: () => 0, getSouth: () => 0, getEast: () => 1, getNorth: () => 1 });
function events(object = {}) {
  const listeners = new Map();
  return Object.assign(object, {
    on(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); return this; },
    off(type, callback) { listeners.get(type)?.delete(callback); return this; },
    un(type, callback) { return this.off(type, callback); },
    fire(type, event) { for (const callback of listeners.get(type) ?? []) callback(event); },
  });
}

test('GL tile hooks observe renderable footprints and preserve native abort behavior', () => {
  const source = { abortTile(tile, value) { assert.equal(this, source); tile.state = 'unloaded'; return value; } };
  const original = source.abortTile;
  const cache = { getRenderableIds: () => [1, 2], getTileByID: (id) => ({ hasData: () => id === 1,
    tileID: { canonical: { z: 2, x: 1, y: 1 }, wrap: 0 } }) };
  for (const style of [{ tileManagers: { raster: cache } }, { getSourceCache: () => cache }]) {
    const tracker = trackGlTiles({ getSource: () => source, getBounds: geographicBounds, style }, { bounds: [-10, -10, 10, 10] }, 'raster');
    assert.deepEqual(tracker.sampleCoverage().rectangles, [tileBounds(2, 1, 1)]);
    assert.equal(source.abortTile({ state: 'loading' }, 42), 42);
    source.abortTile({ state: 'loaded' });
    assert.equal(tracker.workStats()[0].count, 1);
    tracker.dispose(); assert.equal(source.abortTile, original);
  }
});

test('GL Promise loaders surface missing benchmark tiles and exclude renderer-superseded loads', async () => {
  const jobs = [], failures = [];
  const source = { loadTile: () => new Promise((resolve, reject) => jobs.push({ resolve, reject })),
    abortTile(tile) { tile.state = 'unloaded'; } };
  const original = source.loadTile;
  const tracker = trackGlTiles({ getSource: () => source }, { id: 'weather' }, 'weather', (error) => failures.push(error));
  const missing = source.loadTile({ state: 'loading' });
  jobs.shift().reject(Object.assign(new Error('Missing PNG'), { status: 404 }));
  await assert.rejects(missing, /Missing PNG/);
  assert.match(failures[0].message, /HTTP 404/);
  const tile = { state: 'loading' }, superseded = source.loadTile(tile);
  source.abortTile(tile);
  jobs.shift().reject(Object.assign(new Error('Obsolete request'), { status: 404 }));
  await assert.rejects(superseded, /Obsolete/);
  assert.equal(failures.length, 1); assert.equal(tracker.workStats()[0].count, 1);
  const removed = source.loadTile({ state: 'loading' }); tracker.dispose();
  jobs.shift().reject(Object.assign(new Error('Removed overlay'), { status: 404 }));
  await assert.rejects(removed, /Removed/); assert.equal(failures.length, 1);
  assert.equal(source.loadTile, original);
});

test('GL callback loaders preserve callbacks, and genuine status-zero/500 map errors remain fatal', () => {
  let complete, callbackCount = 0;
  const source = { loadTile(_tile, callback) { complete = callback; return 42; }, abortTile() {} };
  const failures = [], mapErrors = [], map = events({ getSource: () => source });
  const tracker = trackGlTiles(map, { id: 'weather' }, 'weather', (error) => failures.push(error));
  const adapter = createGlAdapter(map, { library: 'Test', version: '1' });
  const stop = adapter.watchErrors((error) => mapErrors.push(error));
  assert.equal(source.loadTile({ state: 'loading' }, () => { callbackCount++; }), 42);
  complete({ status: 404 }); assert.equal(callbackCount, 1); assert.equal(failures.length, 1);
  const tile = { state: 'loading' }; source.loadTile(tile, () => { callbackCount++; }); source.abortTile(tile);
  complete({ status: 404 }); assert.equal(callbackCount, 2); assert.equal(failures.length, 1);
  for (const status of [0, 500]) map.fire('error', { error: Object.assign(new Error('HTTP ' + status), { status }) });
  assert.equal(mapErrors.length, 2);
  stop(); tracker.dispose();
});

test('Leaflet counts attached active fallback tiles and unfinished unloads', () => {
  const pending = {}, tiles = events({ _tiles: {
    loaded: { active: true, el: { isConnected: true, classList: { contains: () => true } }, coords: { z: 2, x: 1, y: 1 } },
    detached: { active: true, el: { isConnected: false, classList: { contains: () => true } }, coords: { z: 2, x: 0, y: 1 } },
    loading: { active: false, el: { isConnected: true }, coords: { z: 2, x: 1, y: 0 } },
  } });
  const tracker = trackLeafletTiles({ getBounds: geographicBounds }, tiles, { bounds: [-10, -10, 10, 10] });
  assert.deepEqual(tracker.sampleCoverage().rectangles, [tileBounds(2, 1, 1)]);
  tiles.fire('tileloadstart', { tile: pending }); tiles.fire('tileunload', { tile: pending });
  tiles.fire('tileloadstart', { tile: pending }); tiles.fire('tileload', { tile: pending }); tiles.fire('tileunload', { tile: pending });
  assert.equal(tracker.workStats()[0].count, 1);
  tracker.dispose(); tiles.fire('tileloadstart', { tile: pending }); tiles.fire('tileunload', { tile: pending });
  assert.equal(tracker.workStats()[0].count, 1);
});

test('Leaflet counts usable fade-in tiles and excludes fully transparent or unsuccessful loads', () => {
  const entry = (opacity, success = true) => ({ active: false, loaded: 42, coords: { z: 2, x: 1, y: 1 },
    el: { isConnected: true, style: { opacity }, classList: { contains: () => success } } });
  const tiles = events({ _tiles: { faded: entry('0.5'), transparent: entry('0'), failed: entry('1', false) } });
  const tracker = trackLeafletTiles({ getBounds: geographicBounds }, tiles, { bounds: [-10, -10, 10, 10] });
  assert.deepEqual(tracker.sampleCoverage().rectangles, [tileBounds(2, 1, 1)]);
  tracker.dispose();
});

test('OpenLayers WebGL hooks count drawn ready tiles, clip extents, and restore renderer methods', () => {
  const renderer = { drawTile_() { return 42; } }, original = renderer.drawTile_;
  const overlay = events({ getRenderer: () => renderer }), source = events({ getProjection: () => 'test',
    getTileGridForProjection: () => ({ getTileCoordExtent: (coord) => coord }) });
  const map = { getView: () => ({ calculateExtent: () => rect, getProjection: () => 'test' }), getSize: () => [100, 100] };
  const tracker = trackOpenLayersTiles(map, overlay, source, { bounds: [-10, -10, 10, 10] }, (extent) => extent);
  assert.equal(tracker.sampleCoverage().rectangles, null);
  overlay.fire('prerender');
  assert.equal(renderer.drawTile_(null, { ready: true, tile: { tileCoord: [-5, -5, 5, 5] } }, 0, 0, rect, {},
    source.getTileGridForProjection()), 42);
  renderer.drawTile_(null, { ready: false }, 0, 0, rect, {}, source.getTileGridForProjection());
  assert.deepEqual(tracker.sampleCoverage().rectangles, [[0, 0, 5, 5]]);
  source.fire('tileloadend', { tile: { getState: () => 2, getTileCoord: () => [20, 20, 30, 30] } });
  assert.equal(tracker.workStats()[0].count, 1);
  tracker.dispose(); assert.equal(renderer.drawTile_, original);
});

test('OpenLayers Canvas reads drawn loaded tiles, while incompatible hooks remain unavailable', () => {
  const renderer = { renderedTiles: [{ getState: () => 2, getTileCoord: () => rect },
    { getState: () => 1, getTileCoord: () => rect }] };
  const overlay = events({ getRenderer: () => renderer }), source = events({ getProjection: () => 'test',
    getTileGridForProjection: () => ({ getTileCoordExtent: (coord) => coord }) });
  const map = { getView: () => ({ calculateExtent: () => rect, getProjection: () => 'test' }), getSize: () => [100, 100] };
  const tracker = trackOpenLayersTiles(map, overlay, source, { bounds: [-10, -10, 10, 10] }, (extent) => extent);
  overlay.fire('prerender'); overlay.fire('postrender');
  assert.deepEqual(tracker.sampleCoverage().rectangles, [rect]);
  source.getTileGridForProjection = () => { throw new Error('incompatible grid'); };
  assert.doesNotThrow(() => overlay.fire('postrender'));
  assert.equal(tracker.sampleCoverage().rectangles, null);
  tracker.dispose();
});

test('OpenLayers tracking can be disposed before its first frame or native renderer exists', () => {
  const overlay = events({ getRenderer: () => undefined }), source = events();
  const tracker = trackOpenLayersTiles({}, overlay, source, {}, (extent) => extent);
  assert.doesNotThrow(() => tracker.dispose());
  assert.doesNotThrow(() => tracker.dispose());
});

test('forecast replacement preserves work counters and logical layer identity until trial cleanup', () => {
  let count = 2;
  const workload = createRasterWorkload(() => ({ sampleCoverage: () => [observation()],
    workStats: () => [{ count, kind: 'discardedNumericRenders' }], remove() {} }));
  workload.add([{ layer: {}, mode: 'grib' }]);
  assert.equal(workload.sampleCoverage()[0].rasterIndex, 0);
  workload.add([{ layer: {}, mode: 'grib' }]); count = 3;
  assert.equal(workload.workStats().reduce((sum, entry) => sum + entry.count, 0), 5);
  workload.clear(); assert.deepEqual(workload.workStats(), []);
});
