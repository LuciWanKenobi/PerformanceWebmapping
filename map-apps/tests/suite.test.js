import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSuitePlan, suiteCounts, runSuite, assertSuiteViewport, frameworkFromPath } from '../shared/benchmark/suite.js';

const config = JSON.parse(readFileSync(new URL('../public/benchmark-config.json', import.meta.url)));
const catalogTimes = [...new Set([config.forecast.initialTime ?? '2026-10-05T03:00:00Z', '2026-10-05T15:00:00Z', config.forecast.nextTime].filter(Boolean))];
const catalog = Object.values(config.parameters).flatMap((selector) => catalogTimes.map((valid_time) => ({
  id: `${selector.variable}-${valid_time}`, variable: selector.variable, level_type: selector.levelType,
  level: selector.level, message: selector.message, run: '2026100500', reference_time: '2026-10-05T00:00:00Z', valid_time,
})));
const viewport = { width: 1200, height: 800, devicePixelRatio: 1 };

test('core matrix matches all seven thesis scenes and 2,100 trials plus 420 warm-ups', () => {
  assert.deepEqual(suiteCounts(config), { configurations: 420, measuredTrials: 2100, warmupTrials: 420,
    singleMapTrials: 420, multiMapTrials: 1680 });
  const { plan, forecast } = buildSuitePlan(config, catalog);
  assert.equal(plan.length, 420);
  assert.deepEqual(plan.slice(0, 21).filter(({ mode }) => mode === 'xyz').map(({ layersPerMap }) => layersPerMap), [1, 2, 2, 3, 5, 8, 9]);
  const iiA = plan.find(({ scene }) => scene === 'II_A'), iiB = plan.find(({ scene }) => scene === 'II_B');
  assert.equal(iiA.options.layerCount, 1); assert.equal(iiA.options.pointsPerLayer, config.pointsPerLayer);
  assert.equal(iiA.options.rasterLayers.length, 1);
  assert.equal(iiB.options.layerCount, 0); assert.equal(iiB.options.rasterLayers.length, 2);
  for (const entry of plan) {
    assert.equal(new Set(entry.options.rasterLayers.map(({ layer }) => layer.variable)).size, entry.options.rasterLayers.length);
    assert.ok(entry.options.rasterLayers.every(({ mode, layer }) => mode === entry.mode && layer.valid_time === forecast.initialTime));
    assert.equal(entry.options.repetitions, 5); assert.equal(entry.options.warmup, true);
  }
  assert.equal(plan.filter(({ framework }) => framework === 'maplibre').length, 105);
});

test('suite rejects missing, ambiguous or duplicate data instead of changing scene composition', () => {
  assert.throws(() => buildSuitePlan(config, catalog.filter(({ variable }) => variable !== 'ww')), /No catalog layer matches weather/);
  assert.throws(() => buildSuitePlan(config, [...catalog, catalog[0]]), /Ambiguous cape/);
  const duplicate = structuredClone(config); duplicate.scenes[0].rasters.push('cape');
  assert.throws(() => buildSuitePlan(duplicate, catalog), /duplicate parameters/);
  const invalid = { ...config, repetitions: 4 };
  assert.throws(() => buildSuitePlan(invalid, catalog), /Invalid benchmark configuration/);
  const missingRun = { ...config, forecast: { ...config.forecast, run: 'missing' } };
  assert.throws(() => buildSuitePlan(missingRun, catalog), /forecast run/);
});

test('time changes pin the same run/level and a second common time for every scene', () => {
  const { plan, forecast } = buildSuitePlan({ ...config, timeChange: { fraction: 0.5, points: true, rasters: true } }, catalog);
  assert.notEqual(forecast.initialTime, forecast.nextTime);
  for (const entry of plan) {
    assert.equal(entry.options.timeChange.points, Boolean(entry.options.layerCount));
    assert.ok(entry.options.nextRasterLayers.every(({ layer }) => layer.valid_time === forecast.nextTime));
  }
});

function memoryStore() {
  const suites = new Map(), records = new Map();
  return { suites, entries: records,
    put: async (suite) => suites.set(suite.id, structuredClone(suite)),
    record: async (record) => records.set(record.key, structuredClone(record)) };
}

test('suite persists repetitions before checkpointing and navigates sequentially across frameworks', async () => {
  const small = { ...config, frameworks: ['leaflet', 'openlayers'], scenes: config.scenes.slice(0, 2), mapCounts: [1], rasterPaths: ['cog'] };
  const suite = { id: 'test', config: small, ...buildSuitePlan(small, catalog), nextIndex: 0, browserViewport: viewport };
  const store = memoryStore(), executed = [], navigated = [];
  const execute = async (options, { onResult }) => {
    executed.push(options.layerCount);
    for (let repetition = 1; repetition <= 5; repetition++) await onResult({ recordType: 'completed', repetition });
  };
  const hooks = { store, signal: new AbortController().signal, viewport: () => viewport, execute, navigate: (framework) => navigated.push(framework) };
  assert.equal(await runSuite(suite, { ...hooks, currentFramework: 'leaflet' }), 'navigating');
  assert.deepEqual(navigated, ['openlayers']);
  assert.equal(store.suites.get('test').nextIndex, 2);
  assert.equal(store.entries.size, 10);
  assert.equal(await runSuite(suite, { ...hooks, currentFramework: 'openlayers' }), 'completed');
  assert.equal(store.entries.size, 20);
  assert.equal(store.suites.get('test').nextIndex, 4);
  assert.equal(store.suites.get('test').status, 'completed');
  assert.deepEqual(executed, [0, 1, 0, 1]);
  assert.ok([...store.entries.values()].every(({ result }) => result.suiteAttemptId && result.sceneId));
});

test('interruption pauses without advancing, then repeats the complete block and replaces partial rows', async () => {
  const small = { ...config, frameworks: ['leaflet'], scenes: config.scenes.slice(0, 1), mapCounts: [1], rasterPaths: ['grib'] };
  const suite = { id: 'resume', config: small, ...buildSuitePlan(small, catalog), nextIndex: 0, browserViewport: viewport };
  const store = memoryStore();
  const hooks = { store, currentFramework: 'leaflet', signal: new AbortController().signal, viewport: () => viewport, navigate: assert.fail };
  await assert.rejects(runSuite(suite, { ...hooks, execute: async (_, { onResult, onFailure }) => {
    await onResult({ recordType: 'completed', repetition: 1 });
    await onFailure({ recordType: 'failed', failureType: 'Error' });
    throw new Error('context lost');
  } }), /context lost/);
  assert.equal(suite.nextIndex, 0); assert.equal(suite.status, 'paused');
  const attempt = suite.attempts[0];
  assert.equal(await runSuite(suite, { ...hooks, execute: async (options, { onResult }) => {
    assert.equal(options.warmup, true);
    for (let repetition = 1; repetition <= 5; repetition++) await onResult({ recordType: 'completed', repetition });
  } }), 'completed');
  assert.notEqual(suite.attempts[0], attempt);
  const results = [...store.entries.values()].map(({ result }) => result);
  assert.equal(results.filter(({ recordType }) => recordType === 'completed').length, 5);
  assert.equal(results.filter(({ recordType }) => recordType === 'failed').length, 1);
});

test('suite checks viewport/DPR across resume and resolves framework routes', () => {
  assert.doesNotThrow(() => assertSuiteViewport(viewport, { ...viewport }));
  assert.throws(() => assertSuiteViewport(viewport, { ...viewport, width: 1000 }), /Restore the suite viewport/);
  assert.throws(() => assertSuiteViewport(viewport, { ...viewport, devicePixelRatio: 2 }), /Restore the suite viewport/);
  assert.equal(frameworkFromPath('/maps/leaflet/index.html'), 'leaflet');
  assert.equal(frameworkFromPath('/maps/'), undefined);
});
