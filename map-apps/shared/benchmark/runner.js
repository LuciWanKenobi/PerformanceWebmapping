import { cameraAt, createPointLayers, DATASET_SEED, POINT_BOUNDS, MOTION_DURATIONS,
  CAMERA_PATH, CAMERA_WAYPOINTS } from './data.js';
import { summarizeFrames } from './stats.js';
import { rasterNativeZoom } from '../raster-resolution.js';
import { afterFrames, abortable } from './timing.js';
import { colorTableStyle, COLOR_TABLES } from '../color-tables.js';
import { RASTER_MODES } from './raster-workload.js';
import { observeNetwork } from './network.js';
import { startTelemetry } from './telemetry.js';
import { validateMapCount } from './map-group.js';
import { COLOR_RESTYLE } from './restyle.js';

export function validateOptions(options) {
  validateMapCount(options.mapCount ?? 1);
  if (![100, 1000, 5000].includes(options.pointsPerLayer) ||
      !Number.isInteger(options.layerCount) || options.layerCount < 0 || options.layerCount > 4 ||
      !MOTION_DURATIONS.includes(options.durationSeconds) ||
      ![1, 3, 5].includes(options.repetitions) || typeof options.warmup !== 'boolean' ||
      (options.colorRestyle !== undefined && typeof options.colorRestyle !== 'boolean') ||
      (options.measureCpu !== undefined && typeof options.measureCpu !== 'boolean') ||
      (options.measureServerMetrics !== undefined && typeof options.measureServerMetrics !== 'boolean')) {
    throw new Error('Invalid benchmark configuration.');
  }
  const rasters = options.rasterLayers ?? [];
  const validRaster = (item) => item?.layer?.id && item.layer.valid_time && RASTER_MODES.includes(item.mode);
  if (!Array.isArray(rasters) || rasters.length > 8 || rasters.some((item) => !validRaster(item)) ||
      (!options.layerCount && !rasters.length)) throw new Error('Choose at least one point or raster layer (up to 8 rasters).');
  const change = options.timeChange;
  if (change) {
    if (![0.25, 0.5, 0.75].includes(change.fraction) || typeof change.points !== 'boolean' ||
        typeof change.rasters !== 'boolean' || (!change.points && !change.rasters) ||
        (change.points && !options.layerCount) || (change.rasters && !rasters.length)) {
      throw new Error('Invalid time-change configuration. Choose points, rasters, or both.');
    }
    if (change.rasters) {
      const next = options.nextRasterLayers;
      const family = ({ layer }) => JSON.stringify([layer.run, layer.reference_time, layer.variable,
        layer.level_type, layer.level, layer.message]);
      if (!Array.isArray(next) || next.length !== rasters.length || next.some((item, i) =>
        !validRaster(item) || item.mode !== rasters[i].mode || family(item) !== family(rasters[i]) ||
        item.layer.valid_time === rasters[i].layer.valid_time)) {
        throw new Error('Choose a different time for the same raster variables, run and levels.');
      }
    }
  }
}

function heapBytes() {
  const value = performance.memory?.usedJSHeapSize;
  return Number.isFinite(value) ? value : null;
}

function observeLongTasks() {
  if (!globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) return null;
  const entries = [];
  const observer = new PerformanceObserver((list) => entries.push(...list.getEntries()));
  observer.observe({ type: 'longtask' });
  return {
    finish(start, end) {
      entries.push(...observer.takeRecords());
      observer.disconnect();
      const overlapping = entries.filter((entry) => entry.startTime < end && entry.startTime + entry.duration > start);
      return {
        longTaskCount: overlapping.length,
        longTaskMs: overlapping.reduce((sum, entry) => sum + Math.max(0,
          Math.min(end, entry.startTime + entry.duration) - Math.max(start, entry.startTime)), 0),
        longTaskBlockingMs: overlapping.reduce((sum, entry) => sum + Math.max(0,
          Math.min(end, entry.startTime + entry.duration) - Math.max(start, entry.startTime + 50)), 0),
      };
    },
    disconnect() { observer.disconnect(); },
  };
}

export function animateCamera(adapter, durationMs, signal, from = 0, to = 1) {
  return new Promise((resolve, reject) => {
    const intervals = [];
    let frame;
    let start;
    let previous;
    const cleanup = () => { cancelAnimationFrame(frame); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const tick = (now) => {
      try {
        if (signal.aborted) return abort();
        start ??= now;
        if (previous !== undefined) intervals.push(now - previous);
        previous = now;
        const progress = Math.min(1, (now - start) / durationMs);
        adapter.setCamera(cameraAt(from + progress * (to - from)));
        // A synchronous map error can abort from inside setCamera().
        if (signal.aborted) return abort();
        if (progress === 1) { cleanup(); resolve(intervals); }
        else frame = requestAnimationFrame(tick);
      } catch (error) { cleanup(); reject(error); }
    };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    frame = requestAnimationFrame(tick);
  });
}

async function settleAll(adapter, hasRasters, signal) {
  if (hasRasters) await adapter.settleRasters(signal);
  await adapter.settle(signal);
}

function prefixedFrames(prefix, intervals) {
  return Object.fromEntries(Object.entries(summarizeFrames(intervals)).map(([key, value]) =>
    [`${prefix}${key[0].toUpperCase()}${key.slice(1)}`, value]));
}

// Observe scheduling during the stationary update as well as during motion.
async function sampleUpdate(operation, signal) {
  const intervals = [];
  let previous = performance.now(), frame;
  const tick = (now) => { intervals.push(now - previous); previous = now; frame = requestAnimationFrame(tick); };
  frame = requestAnimationFrame(tick);
  try { await operation(); signal.throwIfAborted(); return intervals; }
  finally { cancelAnimationFrame(frame); }
}

// Adapter owns native map operations; this function owns the identical protocol.
export async function runBenchmark(adapter, options, { signal, onProgress = () => {}, onResult = () => {} }) {
  validateOptions(options);
  signal.throwIfAborted();
  const datasets = options.layerCount ? createPointLayers(options.pointsPerLayer, options.layerCount) : [];
  const change = options.timeChange;
  const updatedDatasets = change?.points ? createPointLayers(options.pointsPerLayer, options.layerCount, DATASET_SEED + 1) : [];
  const rasters = options.rasterLayers ?? [];
  const mapCount = options.mapCount ?? 1;
  if (adapter.mapCount && adapter.mapCount() !== mapCount) throw new Error('Wait for the requested map grid to finish loading.');
  await adapter.assertCacheIsolation?.(rasters, signal);
  if (options.colorRestyle) await adapter.assertColorTables?.(rasters, signal);
  if (rasters.length && (!adapter.addRasters || !adapter.settleRasters)) throw new Error('Raster benchmark adapter unavailable.');
  if (change?.points && !adapter.updatePoints) throw new Error('Point update adapter unavailable.');
  if (options.colorRestyle && ((options.layerCount && !adapter.restylePoints) || (rasters.length && !adapter.restyleRasters))) {
    throw new Error('Color-restyle benchmark adapter unavailable.');
  }
  const results = [];
  const batchId = crypto.randomUUID();
  const snapshot = adapter.prepare();
  try {
    const trialCount = options.repetitions + Number(options.warmup);
    for (let index = 0; index < trialCount; index++) {
      signal.throwIfAborted();
      const warmup = options.warmup && index === 0;
      const repetition = index + 1 - Number(options.warmup);
      onProgress(warmup ? 'Warm-up (discarded)' : `Trial ${repetition} of ${options.repetitions}`);
      adapter.clearPoints();
      adapter.clearRasters?.();
      if (adapter.initializeMaps) onProgress((warmup ? 'Warm-up' : 'Trial ' + repetition) + ' · initializing ' + mapCount + ' fresh maps');
      const mapInitialization = adapter.initializeMaps
        ? await adapter.initializeMaps(mapCount, signal, cameraAt(0))
        : { mapInitMs: null, mapDestroyMs: null, mapResetMs: null, initializedMapCount: 0,
          mapInitializations: [], mapInitReadySignal: null };
      signal.throwIfAborted();
      adapter.setCamera(cameraAt(0));
      await adapter.settle(signal);
      // Keep preparation, DOM status updates, and dataset generation outside timing.
      await afterFrames(2, signal);
      // HTTP snapshots happen outside the measured trial. Their own requests
      // are excluded from both browser resource totals and server counters.
      const telemetry = await startTelemetry({ measureCpu: options.measureCpu,
        rasters, measureServerMetrics: options.measureServerMetrics !== false, signal });
      const heapBeforeBytes = heapBytes();
      const tasks = observeLongTasks();
      const network = observeNetwork();
      const start = performance.now();
      try {
        adapter.addPoints(datasets);
        if (rasters.length) adapter.addRasters(rasters);
        const submitMs = performance.now() - start;
        await settleAll(adapter, rasters.length > 0, signal);
        const layerReadyMs = performance.now() - start;
        let before = [], after = [], updateIntervals = [], intervals;
        let timeChangeSubmitMs = null, timeChangeReadyMs = null, preChangeSettleMs = null;
        let timeChangeStart = null, timeChangeEnd = null;
        let colorRestyleStart = null, colorRestyleEnd = null;
        let colorRestyleSubmitMs = null, colorRestyleReadyMs = null, restyleIntervals = [];
        if (change) {
          before = await animateCamera(adapter, options.durationSeconds * 1000 * change.fraction, signal, 0, change.fraction);
          const settleStart = performance.now();
          await settleAll(adapter, rasters.length > 0, signal);
          preChangeSettleMs = performance.now() - settleStart;
          onProgress(`${warmup ? 'Warm-up' : `Trial ${repetition}`} · applying time change`);
          // DOM progress updates are outside the time-change measurement.
          await afterFrames(2, signal);
          const updateStart = performance.now();
          timeChangeStart = updateStart;
          updateIntervals = await sampleUpdate(async () => {
            if (change.points) adapter.updatePoints(updatedDatasets);
            if (change.rasters) adapter.addRasters(options.nextRasterLayers);
            timeChangeSubmitMs = performance.now() - updateStart;
            await settleAll(adapter, rasters.length > 0, signal);
            timeChangeReadyMs = performance.now() - updateStart;
            timeChangeEnd = performance.now();
          }, signal);
          after = await animateCamera(adapter, options.durationSeconds * 1000 * (1 - change.fraction), signal, change.fraction, 1);
          intervals = [...before, ...after];
        } else intervals = await animateCamera(adapter, options.durationSeconds * 1000, signal);
        await settleAll(adapter, rasters.length > 0, signal);
        if (options.colorRestyle) {
          onProgress((warmup ? 'Warm-up' : 'Trial ' + repetition) + ' · applying color restyle');
          await afterFrames(2, signal);
          colorRestyleStart = performance.now();
          restyleIntervals = await sampleUpdate(async () => {
            if (options.layerCount) adapter.restylePoints(COLOR_RESTYLE);
            const restyling = rasters.length ? adapter.restyleRasters(COLOR_RESTYLE) : undefined;
            colorRestyleSubmitMs = performance.now() - colorRestyleStart;
            await abortable(Promise.resolve(restyling), signal);
            await settleAll(adapter, rasters.length > 0, signal);
            // Allow a paint opportunity after all recoloring and native readiness.
            // This is a presentation proxy, not a GPU timestamp.
            await afterFrames(2, signal);
            colorRestyleEnd = performance.now();
            colorRestyleReadyMs = colorRestyleEnd - colorRestyleStart;
          }, signal);
        }
        const end = performance.now();
        const heapAfterBytes = heapBytes();
        const telemetryResult = await telemetry.finish();
        // Allow the observer to receive entries generated by the final task.
        await afterFrames(2, signal);
        const longTasks = tasks?.finish(start, end) ?? { longTaskCount: null, longTaskMs: null, longTaskBlockingMs: null };
        const networkResult = network.finish(start, end, timeChangeStart, timeChangeEnd, colorRestyleStart, colorRestyleEnd);
        signal.throwIfAborted();
        if (warmup) continue;
        const size = adapter.size();
        const result = {
          schemaVersion: 7,
          batchId,
          recordedAt: new Date().toISOString(),
          library: adapter.library,
          libraryVersion: adapter.version,
          renderer: adapter.renderer,
          readySignal: adapter.readySignal,
          repetition,
          requestedRepetitions: options.repetitions,
          warmup: options.warmup,
          seed: DATASET_SEED,
          pointRegion: 'Europe bounding box',
          pointBounds: [...POINT_BOUNDS],
          cameraPath: CAMERA_PATH,
          cameraZoomRange: [4, 12],
          cameraWaypoints: CAMERA_WAYPOINTS.map(({ center, zoom }) => ({ center: [...center], zoom })),
          pointsPerLayer: options.pointsPerLayer,
          mapCount,
          synchronizedCamera: true,
          ...mapInitialization,
          mapInitPolicy: adapter.initializeMaps ? 'destroy all maps before each trial, including warm-up; fresh native instances; sequential initialization; basemap and preview stations hidden' : 'adapter does not provide map reset',
          mapViewports: adapter.viewports?.() ?? [{ mapIndex: 1, width: size.width, height: size.height }],
          pointsPerMap: options.pointsPerLayer * options.layerCount,
          totalPointLayerInstances: options.layerCount * mapCount,
          totalRasterLayerInstances: rasters.length * mapCount,
          layerCount: options.layerCount,
          pointLayerCount: options.layerCount,
          rasterLayerCount: rasters.length,
          rasterResolutionPolicy: 'source-native ceiling with per-map overzoom; OpenLayers COG uses its native grid',
          rasterLayers: rasters.map(({ layer, mode }) => ({ nativeTileZoom: rasterNativeZoom(layer), id: layer.id, variable: layer.variable,
            validTime: layer.valid_time, run: layer.run, levelType: layer.level_type, level: layer.level,
            mode, width: layer.width, height: layer.height })),
          nextRasterLayers: change?.rasters ? options.nextRasterLayers.map(({ layer, mode }) =>
            ({ id: layer.id, validTime: layer.valid_time, mode, nativeTileZoom: rasterNativeZoom(layer) })) : [],
          rasterReadySignal: rasters.length ? 'adapter raster completion, then native map readiness' : null,
          cachePolicy: adapter.mapCount ? 'independent sources/readers/workers; unique URLs per map and load; no-store; bypass WMS/PNG output cache' : 'adapter default',
          colorRestyleEnabled: Boolean(options.colorRestyle),
          colorRestyle: options.colorRestyle ? { ...COLOR_RESTYLE } : null,
          colorRestyleMethod: options.colorRestyle ? 'native point fill; per-parameter value-to-color table replacement; numeric frontend recoloring or WMS/PNG server rendering and tile fetch' : null,
          colorTablesId: options.colorRestyle ? COLOR_TABLES.id : null,
          colorRestyleLayers: options.colorRestyle ? (change?.rasters ? options.nextRasterLayers : rasters).map(({ layer, mode }) =>
            ({ id: layer.id, variable: layer.variable, mode, style: colorTableStyle(layer),
              method: ['wms', 'xyz'].includes(mode) ? 'server recolor and tile fetch' : 'frontend numeric recolor' })) : [],
          colorRestyleReadySignal: options.colorRestyle ? 'all raster and native map readiness, then two animation frames; presentation proxy' : null,
          colorRestyleSubmitMs,
          colorRestyleReadyMs,
          colorRestyleStartMs: colorRestyleStart == null ? null : colorRestyleStart - start,
          ...prefixedFrames('colorRestyle', restyleIntervals),
          timeChangeEnabled: Boolean(change),
          timeChangeFraction: change?.fraction ?? null,
          timeChangePoints: change?.points ?? false,
          timeChangeRasters: change?.rasters ?? false,
          updatedPointSeed: change?.points ? DATASET_SEED + 1 : null,
          pointUpdateMethod: change?.points ? 'replace data in existing native sources/groups' : null,
          rasterUpdateMethod: change?.rasters ? 'replace overlays with the selected forecast time' : null,
          timeChangeSubmitMs,
          timeChangeReadyMs,
          preChangeSettleMs,
          ...prefixedFrames('beforeChange', before),
          ...prefixedFrames('afterChange', after),
          ...prefixedFrames('timeChange', updateIntervals),
          totalPoints: options.pointsPerLayer * options.layerCount * mapCount,
          requestedMotionMs: options.durationSeconds * 1000,
          basemap: 'disabled',
          submitMs,
          layerReadyMs,
          trialMs: end - start,
          ...summarizeFrames(intervals),
          ...longTasks,
          mainThreadLongTaskBusyPercent: longTasks.longTaskMs === null || end <= start ? null : 100 * longTasks.longTaskMs / (end - start),
          ...networkResult,
          timeChangeRequestCount: networkResult.timeChangeNetwork?.requestCount ?? null,
          timeChangeTransferBytes: networkResult.timeChangeNetwork?.transferBytes ?? null,
          timeChangeFetchedBodyBytes: networkResult.timeChangeNetwork?.fetchedBodyBytes ?? null,
          colorRestyleRequestCount: networkResult.colorRestyleNetwork?.requestCount ?? null,
          colorRestyleTransferBytes: networkResult.colorRestyleNetwork?.transferBytes ?? null,
          colorRestyleFetchedBodyBytes: networkResult.colorRestyleNetwork?.fetchedBodyBytes ?? null,
          ...telemetryResult,
          heapBeforeBytes,
          heapAfterBytes,
          heapDeltaBytes: heapBeforeBytes === null || heapAfterBytes === null ? null : heapAfterBytes - heapBeforeBytes,
          viewportWidth: size.width,
          viewportHeight: size.height,
          devicePixelRatio: window.devicePixelRatio,
          hardwareConcurrency: navigator.hardwareConcurrency ?? null,
          userAgent: navigator.userAgent,
          buildMode: import.meta.env?.MODE ?? 'test',
          frameIntervalsMs: intervals,
          beforeChangeFrameIntervalsMs: before,
          afterChangeFrameIntervalsMs: after,
          timeChangeFrameIntervalsMs: updateIntervals,
          colorRestyleFrameIntervalsMs: restyleIntervals,
        };
        results.push(result);
        onResult(result);
      } finally {
        tasks?.disconnect();
        network.disconnect();
      }
    }
    return results;
  } finally {
    try { adapter.clearPoints(); adapter.clearRasters?.(); } finally { adapter.restore(snapshot); }
  }
}
