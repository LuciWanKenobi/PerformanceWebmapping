import { afterFrames, abortable } from './timing.js';
import { summarizeMapReadiness } from './stats.js';
import { COG_SERVER, WMS_SERVER } from '../config.js';
import { supportsRasterConnections } from './server-policy.js';

export function validateMapCount(count) {
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('Choose 1–20 maps.');
}

export function isolatedRaster(layer, mapIndex, requestScope) {
  return { ...layer, mapIndex, requestScope, requestKey: crypto.randomUUID() };
}

export async function assertRasterIsolation(requests, signal) {
  const servers = [...new Set(requests.map(({ mode }) => ['wms', 'xyz'].includes(mode) ? WMS_SERVER : COG_SERVER))];
  await Promise.all(servers.map(async (server) => {
    const label = server === WMS_SERVER ? 'WMS/PNG server' : 'COG/GRIB server';
    let response, metrics;
    try {
      response = await fetch(server + '/metrics', { cache: 'no-store', signal: AbortSignal.any([
        ...(signal ? [signal] : []), AbortSignal.timeout(5000),
      ]) });
      if (response.ok) metrics = await response.json();
    } catch {
      signal?.throwIfAborted();
      throw new Error(label + ' unavailable at ' + server + '. Run npm run start:all in map-apps, keep that terminal open, and check the service URL in .env.local.');
    }
    if (!response.ok || !metrics?.cacheIsolationSupported) {
      throw new Error('Restart the updated ' + label + ' at ' + server + ': independent map requests require cache-isolation support.');
    }
    if (!supportsRasterConnections(metrics)) {
      throw new Error('Restart the updated ' + label + ' at ' + server + ': HTTP/1.1 connection handling and disconnect accounting are required.');
    }
    if (server === WMS_SERVER && requests.some(({ mode }) => mode === 'xyz')) {
      const healthResponse = await fetch(server + '/health', { cache: 'no-store', signal: AbortSignal.any([
        ...(signal ? [signal] : []), AbortSignal.timeout(5000),
      ]) });
      const health = healthResponse.ok ? await healthResponse.json() : {};
      if (health.xyzDelivery !== 'precomputed-only' || health.xyzColorRestyleSupported !== false) {
        throw new Error('Restart the updated WMS/PNG server: PNG benchmarks require read-only precomputed tiles.');
      }
    }
  }));
}

function sameCamera(a, b) {
  return Math.abs(a.zoom - b.zoom) < 1e-7 && a.center.every((value, i) => Math.abs(value - b.center[i]) < 1e-7);
}

// Native entries provide independent adapters, overlays and camera listeners.
// DOM layout is injected so synchronization and failure cleanup can be tested.
export function createMapGroup(first, createMap, layout) {
  const entries = [first], listeners = new Map(), countListeners = new Set(), errorWatchers = new Map();
  let muted = false, stationsVisible = true, requestScope;
  const mute = (operation) => { const before = muted; muted = true; try { return operation(); } finally { muted = before; } };
  const resize = () => entries.forEach((entry) => entry.adapter.resize?.());
  function watch(entry, callback, registrations) {
    const mapIndex = entries.indexOf(entry) + 1;
    registrations.set(entry, entry.adapter.watchErrors?.((error) =>
      callback(new Error('Map ' + mapIndex + ': ' + error.message))));
  }
  function listen(entry) {
    for (const [callback, registrations] of errorWatchers) watch(entry, callback, registrations);
    listeners.set(entry, entry.onCameraChange(() => {
      if (muted) return;
      const camera = entry.getCamera();
      mute(() => entries.forEach((other) => {
        if (other !== entry && !sameCamera(other.getCamera(), camera)) other.adapter.setCamera(camera);
      }));
    }));
  }
  listen(first);
  function remove(entry) {
    listeners.get(entry)?.(); listeners.delete(entry);
    for (const registrations of errorWatchers.values()) {
      registrations.get(entry)?.(); registrations.delete(entry);
    }
    try { entry.destroy(); } finally { layout.remove(entry.surface); }
  }
  return {
    library: first.adapter.library, version: first.adapter.version,
    renderer: first.adapter.renderer, readySignal: `all maps: ${first.adapter.readySignal}`,
    size: layout.size, resize,
    setRequestScope(scope) { requestScope = scope; },
    setViewportLayout(mode, width, height) {
      if (!['fixed-total', 'fixed-map'].includes(mode) || !Number.isInteger(width) || !Number.isInteger(height) ||
          width < 128 || width > 2048 || height < 128 || height > 2048) throw new Error('Choose map dimensions between 128 and 2048 pixels.');
      layout.configure?.(mode, width, height); layout.arrange(entries.length); resize();
    },
    viewportLayout: () => layout.configuration?.() ?? { mode: 'fixed-total' },
    mapCount: () => entries.length,
    viewports: () => entries.map((entry, index) => ({ mapIndex: index + 1,
      width: entry.adapter.size().width, height: entry.adapter.size().height })),
    onCountChange(callback) { countListeners.add(callback); return () => countListeners.delete(callback); },
    async setMapCount(count, signal) {
      validateMapCount(count);
      const oldCount = entries.length;
      const camera = entries[0]?.getCamera();
      const pending = [];
      try {
        // Add one at a time to limit simultaneous renderer initialization.
        while (entries.length < count) {
          signal.throwIfAborted();
          const surface = layout.add(entries.length + 1);
          pending.push(surface);
          // Give the new native renderer a real viewport before initialization.
          layout.arrange(entries.length + 1); resize();
          const entry = await createMap(surface, entries.length + 1, signal);
          entries.push(entry); pending.pop(); listen(entry);
          signal.throwIfAborted();
          if (camera) mute(() => entry.adapter.setCamera(camera));
          entry.setStationsVisible(stationsVisible);
        }
        while (entries.length > count) remove(entries.pop());
        layout.arrange(entries.length); resize();
        await afterFrames(2, signal);
        entries.forEach((entry) => entry.adapter.assertReady?.());
      } catch (error) {
        while (entries.length > oldCount) remove(entries.pop());
        pending.forEach((surface) => layout.remove(surface));
        layout.arrange(entries.length); resize();
        throw error;
      }
      countListeners.forEach((callback) => callback());
    },
    async initializeMaps(count, signal, camera) {
      validateMapCount(count); signal.throwIfAborted();
      camera ??= entries[0]?.getCamera();
      const resetStart = performance.now();
      // Destroy the whole old generation before constructing a single new map.
      while (entries.length) remove(entries.pop());
      const pending = [];
      const perMap = [];
      let completed = false;
      try {
        // Give disposal callbacks and browser context cleanup a frame opportunity.
        await afterFrames(2, signal);
        const initStart = performance.now();
        const mapDestroyMs = initStart - resetStart;
        layout.arrange(count);
        for (let index = 1; index <= count; index++) pending.push(layout.add(index));
        // Stable final viewport sizes and sequential constructors limit GPU pressure.
        for (let index = 1; index <= count; index++) {
          signal.throwIfAborted();
          const mapStart = performance.now();
          const entry = await createMap(pending[0], index, signal, { benchmark: true, camera, mapCount: count });
          entries.push(entry); pending.shift(); listen(entry);
          signal.throwIfAborted();
          mute(() => entry.adapter.setCamera(camera));
          await entry.adapter.settle(signal);
          entry.adapter.assertReady?.();
          perMap.push({ mapIndex: index, readyMs: performance.now() - mapStart });
        }
        resize();
        await Promise.all(entries.map((entry) => entry.adapter.settle(signal)));
        await afterFrames(2, signal);
        entries.forEach((entry) => entry.adapter.assertReady?.());
        const end = performance.now();
        completed = true;
        return { mapInitMs: end - initStart, mapDestroyMs, mapResetMs: end - resetStart,
          initializedMapCount: entries.length, mapInitializations: perMap,
          mapInitReadySignal: 'sequential native construction and map readiness; final resize and two animation frames' };
      } catch (error) {
        // Remove a constructor that returned but never reached readiness.
        while (entries.length > perMap.length) remove(entries.pop());
        // A context can be evicted from an earlier map as later maps initialize.
        if (entries.some((entry) => {
          try { entry.adapter.assertReady?.(); return false; } catch { return true; }
        })) while (entries.length) remove(entries.pop());
        // Old maps are gone. Keep completed replacements usable on Stop/failure.
        // If construction failed before returning any map, recover one preview.
        if (!entries.length) {
          pending.splice(0).forEach((surface) => layout.remove(surface));
          layout.arrange(1);
          const surface = layout.add(1);
          try {
            const entry = await createMap(surface, 1, AbortSignal.timeout(15000));
            entries.push(entry); listen(entry); entry.setStationsVisible(stationsVisible);
          } catch {
            layout.remove(surface);
            throw new Error(error.message + ' No map could be recovered; reload the page.');
          }
        }
        throw error;
      } finally {
        pending.forEach((surface) => layout.remove(surface));
        if (!completed) { layout.arrange(Math.max(1, entries.length)); resize(); }
        countListeners.forEach((callback) => callback());
      }
    },
    prepare() {
      const snapshots = [];
      const camera = entries[0]?.getCamera();
      mute(() => {
        try { for (const entry of entries) snapshots.push(entry.adapter.prepare()); }
        catch (error) {
          snapshots.forEach((state, i) => { try { entries[i].adapter.restore(state); } catch { /* Preserve setup error. */ } });
          throw error;
        }
      });
      return { maps: snapshots, camera };
    },
    restore({ maps: snapshots, camera }) {
      let error;
      mute(() => entries.forEach((entry, i) => {
        try {
          if (snapshots[i] !== undefined) entry.adapter.restore(snapshots[i]);
          else {
            // A suite can grow the grid during fresh initialization. New panes
            // have no old snapshot: preserve their hidden basemap, then apply
            // the original synchronized camera and station visibility.
            entry.adapter.restore(entry.adapter.prepare());
            if (camera) entry.adapter.setCamera(camera);
            entry.setStationsVisible(stationsVisible);
          }
        } catch (failure) { error ??= failure; }
      }));
      if (error) throw error;
    },
    setCamera(camera) { mute(() => entries.forEach((entry) => entry.adapter.setCamera(camera))); },
    setStationsVisible(visible) { stationsVisible = visible; entries.forEach((entry) => entry.setStationsVisible(visible)); },
    addPoints(datasets) { entries.forEach((entry) => entry.adapter.addPoints(structuredClone(datasets))); },
    updatePoints(datasets) { entries.forEach((entry) => entry.adapter.updatePoints(structuredClone(datasets))); },
    restylePoints(style) { entries.forEach((entry) => entry.adapter.restylePoints(style)); },
    clearPoints() { entries.forEach((entry) => entry.adapter.clearPoints()); },
    settle(signal) { return Promise.all(entries.map((entry) => entry.adapter.settle(signal))); },
    async measureReadiness(signal, start, { settleRaster, afterReadyFrames = 0 } = {}) {
      const controller = new AbortController();
      const combined = AbortSignal.any([signal, controller.signal]);
      try {
        const measurements = await abortable(Promise.all(entries.map(async (entry, index) => {
          combined.throwIfAborted();
          await settleRaster?.(index + 1, combined);
          const rasterReadyMs = settleRaster ? performance.now() - start : null;
          const nativeStart = performance.now();
          await entry.adapter.settle(combined);
          if (afterReadyFrames) await afterFrames(afterReadyFrames, combined);
          combined.throwIfAborted(); entry.adapter.assertReady?.();
          const ready = performance.now();
          return { mapIndex: index + 1, readyMs: ready - start, rasterReadyMs,
            nativeReadyWaitMs: ready - nativeStart };
        })), combined);
        return summarizeMapReadiness(measurements);
      } catch (error) { controller.abort(error); throw error; }
    },
    assertCacheIsolation: assertRasterIsolation,
    watchErrors(callback) {
      const registrations = new Map();
      errorWatchers.set(callback, registrations);
      entries.forEach((entry) => watch(entry, callback, registrations));
      return () => {
        errorWatchers.delete(callback);
        registrations.forEach((stop) => stop?.()); registrations.clear();
      };
    },
    createOverlay(layer, mode, onError, id = 'weather') {
      const overlays = [];
      try {
        entries.forEach((entry, i) => overlays.push(entry.createOverlay(isolatedRaster(layer, i + 1, requestScope), mode,
          (error) => onError(new Error(`Map ${i + 1}: ${error?.message || 'Raster failed to load.'}`)), id)));
      } catch (error) { overlays.forEach((overlay) => overlay.remove()); throw error; }
      const ready = Promise.all(overlays.map((overlay) => overlay.ready));
      ready.catch(() => {});
      let restyles = [];
      return {
        ready,
        sampleCoverage: () => overlays.map((overlay, index) => ({ ...overlay.sampleCoverage?.(), mapIndex: index + 1 })),
        workStats: () => overlays.flatMap((overlay, index) => (overlay.workStats?.() ?? [])
          .map((counter) => ({ ...counter, mapIndex: index + 1 }))),
        restyle: mode === 'xyz' ? undefined : (style) => {
          restyles = overlays.map((overlay) => overlay.restyle(style));
          return Promise.all(restyles);
        },
        async settleMap(mapIndex, signal) {
          const overlay = overlays[mapIndex - 1];
          await overlay.ready;
          await restyles[mapIndex - 1];
          await overlay.settle(signal);
        },
        settle: (signal) => Promise.all(overlays.map((overlay) => overlay.settle(signal))),
        remove: () => overlays.forEach((overlay) => overlay.remove()),
        setVisible: (visible) => overlays.forEach((overlay) => overlay.setVisible(visible)),
      };
    },
  };
}

export function mountMapGroup(first, createMap) {
  const frame = document.querySelector('.map-frame');
  const grid = document.createElement('div'); grid.className = 'map-grid';
  frame.append(grid);
  function pane(surface, index) {
    const container = document.createElement('div'); container.className = 'map-pane';
    const label = document.createElement('span'); label.className = 'map-caption'; label.textContent = `Map ${index}`;
    surface.classList.add('map-surface');
    surface.setAttribute('aria-label', `Map ${index}`);
    container.append(surface, label); grid.append(container);
    return surface;
  }
  pane(first.surface, 1);
  let mode = 'fixed-total', width = 400, height = 300;
  const layout = {
    configure(nextMode, nextWidth, nextHeight) { mode = nextMode; width = nextWidth; height = nextHeight; },
    configuration: () => ({ mode, mapWidth: mode === 'fixed-map' ? width : null, mapHeight: mode === 'fixed-map' ? height : null }),
    add(index) { const surface = document.createElement('div'); surface.id = `map-${index}`; return pane(surface, index); },
    remove(surface) { surface.parentElement.remove(); },
    arrange(count) {
      const cols = mode === 'fixed-map' ? Math.min(count, Math.max(1, Math.floor(frame.clientWidth / (width + 3)))) : Math.ceil(Math.sqrt(count));
      frame.style.overflow = mode === 'fixed-map' ? 'auto' : '';
      grid.style.inset = mode === 'fixed-map' ? '0 auto auto 0' : '0';
      grid.style.width = mode === 'fixed-map' ? `${cols * (width + 3) - 3}px` : '';
      grid.style.height = mode === 'fixed-map' ? `${Math.ceil(count / cols) * (height + 3) - 3}px` : '';
      grid.style.gridTemplateColumns = `repeat(${cols}, ${mode === 'fixed-map' ? width + 'px' : 'minmax(0, 1fr)'})`;
      grid.style.gridTemplateRows = `repeat(${Math.ceil(count / cols)}, ${mode === 'fixed-map' ? height + 'px' : 'minmax(0, 1fr)'})`;
    },
    size: () => grid.getBoundingClientRect(),
  };
  const group = createMapGroup(first, createMap, layout);
  layout.arrange(1);
  new ResizeObserver(group.resize).observe(grid);
  group.resize();
  return group;
}
