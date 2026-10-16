import { MERCATOR_LIMIT, mercatorY } from '../raster-resolution.js';

export const COVERAGE_PERIOD_MS = 100;
export const COMPLETE_COVERAGE = 0.999;
export const projectedBounds = ([west, south, east, north]) =>
  [west / 180 * MERCATOR_LIMIT, mercatorY(south), east / 180 * MERCATOR_LIMIT, mercatorY(north)];
export const tileBounds = (z, x, y, wrap = 0) => {
  const span = 2 * MERCATOR_LIMIT / 2 ** z;
  return [-MERCATOR_LIMIT + x * span + wrap * 2 * MERCATOR_LIMIT,
    MERCATOR_LIMIT - (y + 1) * span, -MERCATOR_LIMIT + (x + 1) * span + wrap * 2 * MERCATOR_LIMIT,
    MERCATOR_LIMIT - y * span];
};
export function intersection(a, b) {
  if (!a || !b || ![...a, ...b].every(Number.isFinite)) return null;
  const rect = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return rect[2] > rect[0] && rect[3] > rect[1] ? rect : null;
}

// Union, rather than a sum: parent/child fallback tiles may overlap.
export function coveredFraction(view, extent, rectangles) {
  if (!view || !extent || ![...view, ...extent].every(Number.isFinite)) return { applicable: true, fraction: null };
  const expected = intersection(view, extent);
  if (!expected) return { applicable: false, fraction: null };
  if (!Array.isArray(rectangles)) return { applicable: true, fraction: null };
  const clipped = rectangles.map((rect) => intersection(expected, rect)).filter(Boolean);
  const xs = [...new Set(clipped.flatMap((rect) => [rect[0], rect[2]]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 1; i < xs.length; i++) {
    const intervals = clipped.filter((rect) => rect[0] < xs[i] && rect[2] > xs[i - 1])
      .map((rect) => [rect[1], rect[3]]).sort((a, b) => a[0] - b[0]);
    let height = 0, end = -Infinity;
    for (const [south, north] of intervals) {
      height += Math.max(0, north - Math.max(south, end)); end = Math.max(end, north);
    }
    area += (xs[i] - xs[i - 1]) * height;
  }
  return { applicable: true, fraction: Math.min(1, area / ((expected[2] - expected[0]) * (expected[3] - expected[1]))) };
}

const accumulator = () => ({ expectedMs: 0, observedMs: 0, sum: 0, incompleteMs: 0, completeMs: 0, gap: 0, longestGapMs: 0 });
function accumulate(state, value, ms) {
  if (!value.applicable) { state.gap = 0; return; }
  state.expectedMs += ms;
  if (value.fraction == null) { state.gap = 0; return; }
  state.observedMs += ms; state.sum += value.fraction * ms;
  if (value.complete ?? value.fraction >= COMPLETE_COVERAGE) { state.completeMs += ms; state.gap = 0; }
  else { state.incompleteMs += ms; state.gap += ms; state.longestGapMs = Math.max(state.longestGapMs, state.gap); }
}
const report = (state) => ({ coveragePercent: state.observedMs ? state.sum / state.observedMs * 100 : null,
  expectedMs: state.expectedMs, observedMs: state.observedMs, unknownMs: state.expectedMs - state.observedMs,
  incompleteMs: state.observedMs ? state.incompleteMs : null,
  longestIncompleteMs: state.observedMs ? state.longestGapMs : null,
  completePercent: state.observedMs ? state.completeMs / state.observedMs * 100 : null });
function combine(values) {
  const applicable = values.filter((value) => value.applicable);
  return { applicable: applicable.length > 0,
    fraction: !applicable.length || applicable.some(({ fraction }) => fraction == null) ? null
      : applicable.reduce((sum, { fraction }) => sum + fraction, 0) / applicable.length,
    complete: applicable.length > 0 && applicable.every(({ fraction }) => fraction != null && fraction >= COMPLETE_COVERAGE) };
}

// Called by the existing camera rAF loop, with no additional timer/rAF loop.
// Left-held, time-weighted 100 ms observations; pauses are separate segments.
export function createMotionCoverage(adapter, enabled, expectedInstances) {
  const total = accumulator(), maps = new Map(), layers = new Map(), samples = [];
  let previous, previousTime, segmentStart, elapsed = 0, samplingMs = 0, maxSampleIntervalMs = 0;
  let workStart, superseded = 0;
  const methods = new Set();
  function snapshot() {
    let observations;
    try { observations = adapter.sampleRasterCoverage?.() ?? []; }
    catch { observations = []; methods.add('unavailable: native coverage hook failed'); }
    const values = observations.map((item) => {
      methods.add(item.method ?? 'unavailable');
      return { ...item, ...coveredFraction(item.view, item.extent, item.rectangles) };
    });
    // Missing adapters/instances must not turn into successful empty views.
    while (values.length < expectedInstances) {
      methods.add('unavailable: missing raster instance');
      values.push({ mapIndex: null, rasterIndex: values.length, applicable: true, fraction: null, method: 'unavailable' });
    }
    const byMap = new Map();
    for (const value of values) {
      if (!byMap.has(value.mapIndex)) byMap.set(value.mapIndex, []);
      byMap.get(value.mapIndex).push(value);
    }
    const result = { values, maps: [...byMap].map(([mapIndex, entries]) => ({ mapIndex, ...combine(entries) })), ...combine(values) };
    return result;
  }
  function integrate(now) {
    const ms = Math.max(0, now - previousTime);
    if (!ms) return;
    maxSampleIntervalMs = Math.max(maxSampleIntervalMs, ms);
    accumulate(total, previous, ms);
    for (const value of previous.maps) {
      if (!maps.has(value.mapIndex)) maps.set(value.mapIndex, accumulator());
      accumulate(maps.get(value.mapIndex), value, ms);
    }
    for (const value of previous.values) {
      const key = `${value.mapIndex}:${value.rasterIndex}`;
      if (!layers.has(key)) layers.set(key, { mapIndex: value.mapIndex, rasterIndex: value.rasterIndex, mode: value.mode, ...accumulator() });
      accumulate(layers.get(key), value, ms);
    }
    const knownMaps = previous.maps.filter(({ applicable }) => applicable);
    samples.push({ motionElapsedMs: elapsed + now - segmentStart, intervalMs: ms,
      coveragePercent: previous.fraction == null ? null : previous.fraction * 100,
      worstMapCoveragePercent: knownMaps.length && knownMaps.every(({ fraction }) => fraction != null)
        ? Math.min(...knownMaps.map(({ fraction }) => fraction)) * 100 : null,
      allMapsComplete: previous.fraction == null || !previous.applicable ? null
        : previous.maps.every(({ applicable, complete }) => !applicable || complete) });
    previousTime = now;
  }
  const work = () => { try { return adapter.rasterWorkStats?.() ?? []; } catch { return []; } };
  const count = (items) => items.reduce((sum, item) => sum + (item.count ?? 0), 0);
  const end = (now) => {
    if (segmentStart == null) return;
    const started = performance.now();
    integrate(now); elapsed += Math.max(0, now - segmentStart); segmentStart = null;
    superseded += Math.max(0, count(work()) - workStart);
    for (const state of [total, ...maps.values(), ...layers.values()]) state.gap = 0;
    samplingMs += performance.now() - started;
  };
  return {
    begin(now) {
      if (!enabled) return;
      const started = performance.now();
      segmentStart = previousTime = now; previous = snapshot(); workStart = count(work());
      samplingMs += performance.now() - started;
    },
    sample(now) {
      if (segmentStart == null || now - previousTime < COVERAGE_PERIOD_MS) return;
      const started = performance.now();
      integrate(now); previous = snapshot();
      samplingMs += performance.now() - started;
    },
    end,
    finish() {
      if (segmentStart != null) end(performance.now());
      const summary = report(total), mapResults = [...maps].map(([mapIndex, state]) => ({ mapIndex, ...report(state) }));
      const counters = work();
      return { motionRasterCoverageStatus: !enabled ? 'not applicable: no rasters' : elapsed && !total.expectedMs ? 'not applicable: outside data footprint' : !total.observedMs ? 'unavailable'
        : total.expectedMs > total.observedMs ? 'partial' : 'measured',
        motionRasterCoveragePercent: summary.coveragePercent,
        motionRasterIncompleteMs: summary.incompleteMs,
        motionRasterLongestGapMs: summary.longestIncompleteMs,
        motionAllMapsCompletePercent: summary.completePercent,
        motionWorstMapCoveragePercent: mapResults.length && mapResults.every(({ coveragePercent }) => coveragePercent != null)
          ? Math.min(...mapResults.map(({ coveragePercent }) => coveragePercent)) : null,
        motionCoverageObservedMs: summary.observedMs, motionCoverageUnknownMs: summary.unknownMs,
        motionNoRasterExpectedMs: enabled ? Math.max(0, elapsed - total.expectedMs) : null,
        motionCoverageSamplePeriodMs: COVERAGE_PERIOD_MS, motionCoverageMaxSampleIntervalMs: maxSampleIntervalMs,
        motionCoverageSamplingMs: samplingMs, motionCoverageCompleteThresholdPercent: COMPLETE_COVERAGE * 100,
        motionRasterSupersededWorkCount: enabled && counters.length ? superseded : null,
        rasterSupersededWorkCount: enabled && counters.length ? count(counters) : null,
        rasterWorkCounterStatus: !enabled ? 'not applicable: no rasters' : counters.length ? 'observed adapter events; incomplete native work coverage' : 'unavailable',
        rasterWorkCounters: enabled ? counters : [],
        motionCoverageMethods: [...methods], motionMapCoverage: mapResults,
        motionLayerCoverage: [...layers.values()].map(({ mapIndex, rasterIndex, mode, ...state }) => ({ mapIndex, rasterIndex, mode, ...report(state) })),
        motionCoverageSamples: samples,
        motionCoveragePolicy: 'Time-weighted 100 ms geometric footprint proxy in Web Mercator. Current forecast only; data extent clipped to view; transparent/nodata values are valid loaded coverage. Available lower-resolution fallback counts as usable coverage. No pixel readback or GPU presentation guarantee. Equal weight per applicable layer, then worst map; incomplete means any layer below 99.9%. Pauses excluded; sub-sample gaps can be missed. Sampler time is measured; native event/draw bookkeeping adds overhead that is not separately timed. Pinned native renderer hooks return unavailable when unsupported.',
        rasterWorkCounterPolicy: 'Observed superseded work only: GL numeric results discarded for a newer view, GL tile aborts, Leaflet unfinished tile unloads, OpenLayers off-view tile completions. Units differ; counts are diagnostics, not a comparable total of all cancelled native work.' };
    },
  };
}
