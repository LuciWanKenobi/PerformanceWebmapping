import { abortable } from './timing.js';

export const RASTER_MODES = ['wms', 'xyz', 'cog', 'grib'];

// Keep a run, variable, level and message together when switching valid time.
export function rasterSeries(layers) {
  const groups = new Map();
  for (const layer of layers) {
    const key = JSON.stringify([layer.run, layer.reference_time, layer.variable,
      layer.level_type, layer.level, layer.message]);
    if (!groups.has(key)) groups.set(key, {
      key, label: `${layer.variable} · ${layer.level_type} ${layer.level} · run ${layer.run} · message ${layer.message}`,
      layers: [],
    });
    groups.get(key).layers.push(layer);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label)).map((group) => ({
    ...group, layers: group.layers.sort((a, b) => a.valid_time.localeCompare(b.valid_time)),
  }));
}

export function commonRasterTimes(series, selections) {
  const selected = selections.map(({ key }) => series.find((group) => group.key === key));
  if (!selected.length || selected.some((group) => !group)) return [];
  return [...new Set(selected[0].layers.map((layer) => layer.valid_time))]
    .filter((time) => selected.every((group) => group.layers.some((layer) => layer.valid_time === time))).sort();
}

export function resolveRasterLayers(series, selections, time) {
  return selections.map(({ key, mode }) => {
    const layer = series.find((group) => group.key === key)?.layers.find((item) => item.valid_time === time);
    if (!layer || !RASTER_MODES.includes(mode)) throw new Error('Choose a forecast time available for every raster layer.');
    return { layer, mode };
  });
}

export function createRasterWorkload(createOverlay) {
  let overlays = [], failure, rejectFailure, errorPromise, retiredWork = [];
  const currentWork = () => overlays.flatMap((overlay, rasterIndex) => (overlay.workStats?.() ?? [])
    .map((counter) => ({ ...counter, rasterIndex, mode: overlay.mode })));
  function clear(preserveTracking = false) {
    retiredWork = preserveTracking ? [...retiredWork, ...currentWork()] : [];
    const previous = overlays;
    overlays = [];
    // Invalidate callbacks before removing workers and their pending requests.
    failure = undefined;
    rejectFailure = undefined;
    for (const overlay of previous) overlay.remove();
  }
  function add(requests) {
    clear(true);
    errorPromise = new Promise((_, reject) => { rejectFailure = reject; });
    errorPromise.catch(() => {});
    const reject = rejectFailure;
    const reportError = (error) => {
      if (rejectFailure !== reject) return;
      failure = error instanceof Error ? error : new Error('A benchmark raster failed to load.');
      reject(failure);
    };
    requests.forEach(({ layer, mode }, index) => {
      const overlay = createOverlay(layer, mode, reportError, `benchmark-raster-${index}`);
      overlays.push({ ...overlay, mode });
      overlay.ready?.catch(reportError);
    });
  }
  return {
    add, clear,
    sampleCoverage: () => overlays.flatMap((overlay, rasterIndex) => {
      const values = overlay.sampleCoverage?.();
      return (Array.isArray(values) ? values : [values ?? {}]).map((value) => ({ ...value, rasterIndex, mode: overlay.mode }));
    }),
    workStats: () => [...retiredWork, ...currentWork()],
    restyle(style) {
      if (failure) throw failure;
      // Precomputed RGB PNGs have no value-to-color restyle operation.
      const restyles = overlays.filter(({ mode }) => mode !== 'xyz').map((overlay) => {
        if (!overlay.restyle) throw new Error('Raster adapter does not support color restyling.');
        return overlay.restyle(style);
      });
      return Promise.race([Promise.all(restyles), errorPromise]);
    },
    async settle(signal) {
      if (!overlays.length) return;
      if (failure) throw failure;
      await abortable(Promise.race([
        Promise.all(overlays.map(async (overlay) => {
          await overlay.ready;
          if (!overlay.settle) throw new Error('Raster adapter does not provide a readiness signal.');
          await overlay.settle(signal);
        })), errorPromise,
      ]), signal);
      if (failure) throw failure;
    },
    async settleMap(mapIndex, signal) {
      if (!overlays.length) return;
      if (failure) throw failure;
      await abortable(Promise.race([Promise.all(overlays.map((overlay) => {
        if (!overlay.settleMap) throw new Error('Raster adapter does not provide per-map readiness.');
        return overlay.settleMap(mapIndex, signal);
      })), errorPromise]), signal);
      if (failure) throw failure;
    },
  };
}
