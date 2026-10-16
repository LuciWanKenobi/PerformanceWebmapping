import { validateOptions } from './runner.js';
import { validateMapCount } from './map-group.js';
import { RASTER_MODES } from './raster-workload.js';

export const FRAMEWORKS = ['maplibre', 'mapbox', 'openlayers', 'leaflet'];
export const ACTIVE_SUITE_KEY = 'mapping-benchmark-active-suite';
export const LAST_SUITE_KEY = 'mapping-benchmark-last-suite';

function uniqueList(items, label, valid) {
  if (!Array.isArray(items) || !items.length || new Set(items).size !== items.length || items.some((item) => !valid(item))) {
    throw new Error(`Invalid or duplicate ${label} in benchmark config.`);
  }
}

export function validateSuiteConfig(config) {
  if (config?.schemaVersion !== 1 || typeof config.name !== 'string' || !config.name.trim()) throw new Error('Invalid benchmark config version/name.');
  uniqueList(config.frameworks, 'frameworks', (item) => FRAMEWORKS.includes(item));
  uniqueList(config.rasterPaths, 'raster paths', (item) => RASTER_MODES.includes(item));
  uniqueList(config.mapCounts, 'map counts', (item) => { try { validateMapCount(item); return true; } catch { return false; } });
  if (!config.parameters || !Array.isArray(config.scenes) || !config.scenes.length) throw new Error('Define parameters and scenes in the benchmark config.');
  uniqueList(config.scenes.map(({ id }) => id), 'scene IDs', (id) => typeof id === 'string' && Boolean(id));
  const viewport = config.viewport;
  if (!viewport || !['fixed-total', 'fixed-map'].includes(viewport.mode) ||
      [viewport.mapWidth, viewport.mapHeight].some((value) => !Number.isInteger(value) || value < 128 || value > 2048)) throw new Error('Invalid configured map viewport.');
  for (const scene of config.scenes) {
    uniqueList(scene.rasters, `parameters in scene ${scene.id}`, (key) => Boolean(config.parameters[key]));
    if (scene.rasters.length > 8 || !Number.isInteger(scene.pointLayers) || scene.pointLayers < 0 || scene.pointLayers > 4) throw new Error(`Invalid layer counts in scene ${scene.id}.`);
    for (const key of scene.rasters) {
      const selector = config.parameters[key];
      if (!selector || typeof selector.variable !== 'string' || !selector.variable || typeof selector.levelType !== 'string' || !Number.isFinite(selector.level) || !Number.isInteger(selector.message)) throw new Error(`Invalid selector for ${key}.`);
    }
  }
  const forecast = config.forecast;
  if (!forecast || ['run', 'initialTime', 'nextTime'].some((key) => forecast[key] != null && typeof forecast[key] !== 'string')) throw new Error('Invalid forecast selection.');
  validateOptions({ ...config, layerCount: 1, timeChange: null });
  return config;
}

export function suiteCounts(config) {
  validateSuiteConfig(config);
  const perCount = config.frameworks.length * config.scenes.length * config.rasterPaths.length;
  const configurations = perCount * config.mapCounts.length;
  return { configurations, measuredTrials: configurations * config.repetitions,
    warmupTrials: configurations * Number(config.warmup),
    singleMapTrials: config.mapCounts.includes(1) ? perCount * config.repetitions : 0,
    multiMapTrials: config.mapCounts.filter((count) => count > 1).length * perCount * config.repetitions };
}

// Resolve once for the entire suite so every scene/framework uses one run/time.
// Ambiguity is an error, never an arbitrary choice of meteorological data.
export function buildSuitePlan(config, catalog) {
  validateSuiteConfig(config);
  const keys = [...new Set(config.scenes.flatMap(({ rasters }) => rasters))];
  const candidates = new Map(keys.map((key) => {
    const selector = config.parameters[key];
    const layers = catalog.filter((layer) => layer.variable === selector.variable && layer.level_type === selector.levelType &&
      Number(layer.level) === selector.level && Number(layer.message) === selector.message);
    if (!layers.length) throw new Error(`No catalog layer matches ${key} (${selector.variable}, ${selector.levelType} ${selector.level}). Edit benchmark-config.json or prepare the missing data.`);
    return [key, layers];
  }));
  const commonRuns = [...new Set(candidates.get(keys[0]).map(({ run }) => run))]
    .filter((run) => keys.every((key) => candidates.get(key).some((layer) => layer.run === run))).sort();
  const run = config.forecast.run ?? commonRuns.at(-1);
  if (!run || !commonRuns.includes(run)) throw new Error('No requested/common forecast run is available for all configured parameters.');
  const commonTimes = [...new Set(candidates.get(keys[0]).filter((layer) => layer.run === run).map(({ valid_time }) => valid_time))]
    .filter((time) => keys.every((key) => candidates.get(key).some((layer) => layer.run === run && layer.valid_time === time))).sort();
  const initialTime = config.forecast.initialTime ?? commonTimes[0];
  const nextTime = config.timeChange?.rasters ? config.forecast.nextTime ?? commonTimes.find((time) => time > initialTime) : null;
  if (!commonTimes.includes(initialTime) || (config.timeChange?.rasters && (!nextTime || nextTime === initialTime || !commonTimes.includes(nextTime)))) throw new Error('Choose initial/next forecast times available for all configured parameters.');
  const at = (key, time) => {
    const matches = candidates.get(key).filter((layer) => layer.run === run && layer.valid_time === time);
    if (matches.length !== 1) throw new Error(`Ambiguous ${key} at ${time}; choose a unique catalog run, level and message.`);
    return matches[0];
  };
  const plan = [];
  for (const framework of config.frameworks) for (const mapCount of config.mapCounts) {
    for (const scene of config.scenes) for (const mode of config.rasterPaths) {
      const timeChange = config.timeChange ? { ...config.timeChange,
        points: Boolean(config.timeChange.points && scene.pointLayers) } : null;
      if (timeChange && !timeChange.points && !timeChange.rasters) throw new Error(`Time change has no supported layers in scene ${scene.id}. Enable raster time changes or remove this scene.`);
      const options = { mapCount, pointsPerLayer: config.pointsPerLayer, layerCount: scene.pointLayers,
        repetitions: config.repetitions, warmup: config.warmup, durationSeconds: config.durationSeconds,
        colorRestyle: config.colorRestyle, measureCpu: config.measureCpu,
        measureBrowserMemory: config.measureBrowserMemory, measureServerMetrics: config.measureServerMetrics,
        timeChange, rasterLayers: scene.rasters.map((key) => ({ layer: at(key, initialTime), mode })),
        nextRasterLayers: timeChange?.rasters ? scene.rasters.map((key) => ({ layer: at(key, nextTime), mode })) : [] };
      validateOptions(options);
      plan.push({ index: plan.length, framework, scene: scene.id, mode, layersPerMap: scene.rasters.length + scene.pointLayers,
        parameterKeys: scene.rasters, options });
    }
  }
  return { plan, forecast: { run, initialTime, nextTime }, counts: suiteCounts(config) };
}

export function openSuiteStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('mapping-benchmark-suites', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('suites', { keyPath: 'id' });
      const records = request.result.createObjectStore('records', { keyPath: 'key' });
      records.createIndex('suiteId', 'suiteId');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = (name, mode, action) => new Promise((done, fail) => {
        const tx = db.transaction(name, mode), request = action(tx.objectStore(name));
        tx.oncomplete = () => done(request.result);
        tx.onerror = tx.onabort = () => fail(tx.error ?? new Error('Could not persist benchmark results.'));
      });
      resolve({ get: (id) => transaction('suites', 'readonly', (store) => store.get(id)),
        put: (suite) => transaction('suites', 'readwrite', (store) => store.put(suite)),
        record: (entry) => transaction('records', 'readwrite', (store) => store.put(entry)),
        records: (id) => transaction('records', 'readonly', (store) => store.index('suiteId').getAll(id)) });
    };
  });
}

export function frameworkFromPath(path) { return FRAMEWORKS.find((framework) => path.includes(`/${framework}/`)); }

export function assertSuiteViewport(expected, actual) {
  if (expected.width !== actual.width || expected.height !== actual.height || expected.devicePixelRatio !== actual.devicePixelRatio) {
    throw new Error(`Restore the suite viewport to ${expected.width}×${expected.height} CSS pixels and DPR ${expected.devicePixelRatio}, then resume.`);
  }
}

export async function runSuite(suite, { store, signal, currentFramework, navigate, execute, viewport, onProgress = () => {} }) {
  suite.status = 'running'; suite.lastError = null;
  await store.put(suite);
  let failureRecorded = false;
  try {
    assertSuiteViewport(suite.browserViewport, viewport());
    for (; suite.nextIndex < suite.plan.length; suite.nextIndex++) {
      signal.throwIfAborted();
      const entry = suite.plan[suite.nextIndex]; failureRecorded = false;
      if (entry.framework !== currentFramework) { await store.put(suite); navigate(entry.framework); return 'navigating'; }
      suite.attempts ??= {};
      suite.attempts[entry.index] = crypto.randomUUID();
      await store.put(suite);
      onProgress(`Suite ${entry.index + 1}/${suite.plan.length} · ${entry.framework} · scene ${entry.scene} · ${entry.options.mapCount} maps · ${entry.mode}`);
      const metadata = { suiteId: suite.id, suiteName: suite.config.name, configurationIndex: entry.index,
        sceneId: entry.scene, sceneParameterKeys: entry.parameterKeys, sceneLayersPerMap: entry.layersPerMap,
        suiteFramework: entry.framework, suiteRasterPath: entry.mode, suiteAttemptId: suite.attempts[entry.index] };
      await execute(entry.options, {
        onResult: async (result) => store.record({ key: `${suite.id}:${entry.index}:completed:${result.repetition}`,
          suiteId: suite.id, result: { ...result, ...metadata } }),
        onFailure: async (failure) => {
          failureRecorded = true;
          await store.record({ key: `${suite.id}:${entry.index}:failure:${crypto.randomUUID()}`,
            suiteId: suite.id, result: { ...failure, ...metadata } });
        },
      });
      assertSuiteViewport(suite.browserViewport, viewport());
      // Checkpoint only a fully completed configuration. Resume repeats any
      // interrupted block, including warm-up, and replaces its partial rows.
      await store.put({ ...suite, nextIndex: suite.nextIndex + 1 });
    }
    suite.status = 'completed'; suite.completedAt = new Date().toISOString();
    await store.put(suite);
    return 'completed';
  } catch (error) {
    suite.status = 'paused'; suite.lastError = error.message;
    if (!failureRecorded) await store.record({ key: `${suite.id}:${suite.nextIndex}:failure:${crypto.randomUUID()}`,
      suiteId: suite.id, result: { schemaVersion: 10, recordType: signal.aborted ? 'aborted' : 'failed',
        suiteId: suite.id, suiteName: suite.config.name, configurationIndex: suite.nextIndex,
        sceneId: suite.plan[suite.nextIndex]?.scene, suiteFramework: suite.plan[suite.nextIndex]?.framework,
        failureType: error.name, failurePhase: 'configuration setup or persistence', recordedAt: new Date().toISOString() } });
    await store.put(suite);
    throw error;
  }
}
