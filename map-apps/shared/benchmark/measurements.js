const stageListeners = new Set(), allocations = new Map();
export const epochNow = () => (performance.timeOrigin ?? 0) + performance.now();

export function recordStage(measurement) {
  for (const receive of stageListeners) receive(measurement);
}

export function recordAllocation(id, allocation) {
  if (allocation == null) allocations.delete(id);
  else allocations.set(id, allocation);
}

export function timedStage(kind, operation, details = {}) {
  const startEpochMs = epochNow();
  const finish = (status) => recordStage({ ...details, kind, startEpochMs,
    durationMs: epochNow() - startEpochMs, status });
  try {
    const result = operation();
    if (result?.then) return result.then((value) => { finish('completed'); return value; },
      (error) => { finish('failed'); throw error; });
    finish('completed'); return result;
  } catch (error) { finish('failed'); throw error; }
}

export function observeStages() {
  const stages = [];
  const receive = (stage) => stages.push(stage);
  stageListeners.add(receive);
  return {
    finish(start, end, changeStart, changeEnd, restyleStart, restyleEnd) {
      stageListeners.delete(receive);
      const origin = performance.timeOrigin ?? 0;
      const measurements = stages.filter((stage) => stage.startEpochMs >= origin + start && stage.startEpochMs <= origin + end)
        .map(({ startEpochMs, ...stage }) => ({ ...stage, startMs: startEpochMs - origin - start,
          phase: restyleStart != null && startEpochMs >= origin + restyleStart && startEpochMs <= origin + restyleEnd
            ? 'colorRestyle' : changeStart != null && startEpochMs >= origin + changeStart && startEpochMs <= origin + changeEnd
              ? 'timeChange' : changeStart != null && startEpochMs > origin + changeEnd ? 'afterChange' : 'initialOrBeforeChange' }));
      const summary = (items) => Object.fromEntries(['decode', 'readDecode', 'projectColor', 'upload', 'decoderCompile'].map((kind) => {
        const selected = items.filter((stage) => stage.kind === kind && stage.status === 'completed');
        return [`${kind}Ms`, selected.length ? selected.reduce((sum, stage) => sum + stage.durationMs, 0) : null];
      }));
      return { ...summary(measurements), stageMeasurements: measurements,
        latencyStageCoverage: 'GRIB decode and projection; frontend COG combined read/decode and projection; GL/Leaflet canvas pixel copies. Native library decoding and GPU execution are unavailable. Streaming compilation can overlap asset download. Durations across concurrent maps are work totals, not additive wall-clock phases.',
        timeChangeStageTotals: changeStart == null ? null : summary(measurements.filter(({ phase }) => phase === 'timeChange')),
        colorRestyleStageTotals: restyleStart == null ? null : summary(measurements.filter(({ phase }) => phase === 'colorRestyle')) };
    },
    disconnect() { stageListeners.delete(receive); },
  };
}

export function sampleMemory() {
  const sum = (key) => [...allocations.values()].reduce((total, item) => total + (item[key] ?? 0), 0);
  const heap = performance.memory?.usedJSHeapSize;
  return { epochMs: epochNow(), heapBytes: Number.isFinite(heap) ? heap : null,
    workerGridBytes: sum('workerGridBytes'), wasmCapacityBytes: sum('wasmCapacityBytes'),
    cogWindowBytes: sum('cogWindowBytes'), canvasPixelBytes: sum('canvasPixelBytes'),
    gribWorkerCount: [...allocations.values()].filter((item) => item.gribWorker).length };
}

export function observeMemory(periodMs = 100, measureUserAgentMemory = false) {
  const samples = [sampleMemory()];
  let uaMemory, uaFailure, measuring = false, stopped = false;
  const uaSamples = [];
  const canMeasureUa = Boolean(measureUserAgentMemory && globalThis.crossOriginIsolated && performance.measureUserAgentSpecificMemory);
  const measureUa = async () => {
    if (!canMeasureUa || measuring || stopped) return;
    measuring = true;
    try {
      const result = await performance.measureUserAgentSpecificMemory();
      if (!stopped && Number.isFinite(result.bytes)) {
        uaMemory = Math.max(uaMemory ?? 0, result.bytes);
        uaSamples.push({ epochMs: epochNow(), bytes: result.bytes });
      }
    } catch (error) { uaFailure = error.name; }
    finally { measuring = false; }
  };
  const timer = setInterval(() => samples.push(sampleMemory()), periodMs);
  const uaTimer = canMeasureUa ? setInterval(measureUa, 1000) : undefined;
  void measureUa();
  const stop = () => { stopped = true; clearInterval(timer); clearInterval(uaTimer); };
  return {
    finish(start, end) {
      const origin = performance.timeOrigin ?? 0;
      // Capture the final allocation state even when reading it takes a few
      // microseconds beyond the recorded trial end.
      samples.push({ ...sampleMemory(), epochMs: origin + end }); stop();
      const relevant = samples.filter(({ epochMs }) => epochMs >= origin + start && epochMs <= origin + end);
      const peak = (key) => {
        const values = relevant.map((sample) => sample[key]).filter(Number.isFinite);
        return values.length ? Math.max(...values) : null;
      };
      return { heapPeakBytes: peak('heapBytes'), workerGridPeakBytes: peak('workerGridBytes'),
        wasmCapacityPeakBytes: peak('wasmCapacityBytes'), cogWindowPeakBytes: peak('cogWindowBytes'),
        canvasPixelPeakBytes: peak('canvasPixelBytes'), gribWorkerPeakCount: peak('gribWorkerCount'),
        memorySamplePeriodMs: periodMs, memorySampleCount: relevant.length,
        memorySamples: relevant.map(({ epochMs, ...sample }) => ({ ...sample, elapsedMs: epochMs - origin - start })),
        userAgentMemoryPeakBytes: uaMemory ?? null,
        userAgentMemorySampleCount: uaSamples.length, userAgentMemorySamplePeriodMs: 1000,
        userAgentMemorySamples: uaSamples.map(({ epochMs, bytes }) => ({ elapsedMs: epochMs - origin - start, bytes })),
        userAgentMemoryStatus: !measureUserAgentMemory ? 'disabled' : !canMeasureUa ? 'unavailable; requires cross-origin isolation and measureUserAgentSpecificMemory'
          : uaMemory != null ? 'sampled browser estimate including related workers' : 'unavailable: ' + (uaFailure ?? 'measurement pending'),
        gpuMemoryBytes: null, gpuMemoryStatus: 'unavailable; GPU allocation bytes are not exposed by browser APIs',
        memoryCoverage: 'sampled window JS heap plus known GRIB grids, WASM memory capacity, frontend COG windows and canvas pixels. These are separate, potentially overlapping observations, not total browser memory. Sub-sample peaks can be missed.' };
    },
    disconnect: stop,
  };
}
