import { restyledLayer, COLOR_TABLES } from './color-tables.js';
import { COG_SERVER, WMS_SERVER } from './config.js';
import { rasterNativeZoom } from './raster-resolution.js';
import { assertRasterIsolation } from './benchmark/map-group.js';
import { createGlCogOverlay, createGlRasterOverlay } from './cog-reader.js';
import { createGribReader } from './grib-reader.js';
import { createRasterWorkload } from './benchmark/raster-workload.js';
import { waitForMapEvent } from './benchmark/timing.js';
import { trackGlTiles } from './benchmark/raster-coverage-adapters.js';

export function rasterUrl(url, layer) {
  if (!layer.requestKey) return url;
  return `${url}${url.includes('?') ? '&' : '?'}_map_request=${encodeURIComponent(layer.requestKey)}&_map=${layer.mapIndex}` +
    (layer.requestScope ? `&_benchmark_scope=${encodeURIComponent(layer.requestScope)}` : '');
}

export function cogUrl(layer) {
  return rasterUrl(`${COG_SERVER}/cog/${layer.path.split('/').map(encodeURIComponent).join('/')}`, layer);
}

export function gribUrl(layer) {
  if (layer.source.endsWith('.bz2')) throw new Error('Decompress the GRIB2 .bz2 file first.');
  return rasterUrl(`${COG_SERVER}/grib2/${layer.source.split('/').map(encodeURIComponent).join('/')}`, layer);
}

export function weatherTileUrl(layer, mode) {
  if (mode === 'xyz') return rasterUrl(`${WMS_SERVER}/tiles/${encodeURIComponent(layer.id)}/{z}/{x}/{y}.png`, layer);
  return rasterUrl(`${WMS_SERVER}/wms?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=${encodeURIComponent(layer.id)}` +
    `&STYLES=${encodeURIComponent(layer.colorTableStyle ?? '')}&FORMAT=image/png&TRANSPARENT=TRUE&SRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}`, layer);
}

export function cogStyle(layer) {
  const { min, max, colors } = layer.style;
  const ramp = ['interpolate', ['linear'], ['band', 1]];
  colors.forEach((rgb, i) => ramp.push(min + (max - min) * i / (colors.length - 1), [...rgb, 1]));
  return { color: ['case', ['>', ['band', 2], 0], ramp, [0, 0, 0, 0]] };
}

// createOverlay returns { remove(), setVisible(boolean) } for the native library.
export function mountWeather(createOverlay, { supportsCog = false, supportsGrib = false } = {}) {
  const group = document.createElement('fieldset');
  group.className = 'weather-controls';
  group.innerHTML = `<legend>Weather data</legend>
    <button type="button">Load weather</button>
    <label>Forecast <select class="weather-forecast" disabled><option value="">Off</option></select></label>
    <label>Delivery <select class="weather-mode"><option value="wms">WMS</option><option value="xyz">PNG tiles</option>${supportsCog ? '<option value="cog">COG (byte ranges)</option>' : ''}${supportsGrib ? '<option value="grib">GRIB2 (worker)</option>' : ''}</select></label>
    <span class="weather-info" role="status">Start the data servers, then load weather.</span>`;
  document.querySelector('.toolbar').append(group);
  const load = group.querySelector('button');
  const forecast = group.querySelector('.weather-forecast');
  const mode = group.querySelector('.weather-mode');
  const info = group.querySelector('.weather-info');
  let layers = [];
  let overlay;
  let revision = 0;
  let suspended = false;
  const reportError = (error) => { info.textContent = error?.message || 'Weather could not load. Check the data servers.'; };
  async function loadCatalog() {
    const response = await fetch(`${supportsCog ? COG_SERVER : WMS_SERVER}/catalog.json`,
      { signal: AbortSignal.timeout(10000), cache: 'no-cache' });
    if (!response.ok) throw new Error('Catalog unavailable. Start the weather data server.');
    const catalog = await response.json();
    if (catalog.schema_version !== 1 || !catalog.layers?.length) throw new Error('Empty weather catalog.');
    return catalog.layers;
  }

  async function update() {
    revision++;
    overlay?.remove();
    overlay = undefined;
    const layer = layers.find((item) => item.id === forecast.value);
    if (!layer) { info.textContent = 'Weather overlay off.'; return; }
    const requestRevision = revision;
    try {
      const delivery = mode.value;
      info.textContent = 'Checking weather server…';
      await assertRasterIsolation([{ layer, mode: delivery }]);
      if (revision !== requestRevision) return;
      overlay = createOverlay(layer, delivery, (error) => {
        if (revision === requestRevision) reportError(error);
      });
      overlay.setVisible(!suspended);
      const description = `Scale ${layer.style.min}–${layer.style.max} ${layer.units} · DWD ICON`;
      info.textContent = overlay.ready ? 'Loading weather layers…' : description;
      overlay.ready?.then(() => {
        if (revision === requestRevision) info.textContent = description;
      }).catch((error) => { if (revision === requestRevision) reportError(error); });
    } catch (error) { if (revision === requestRevision) reportError(error); }
  }
  forecast.addEventListener('change', update);
  mode.addEventListener('change', update);
  load.addEventListener('click', async () => {
    load.disabled = true;
    info.textContent = 'Loading forecasts…';
    try {
      layers = [...await loadCatalog()].sort((a, b) =>
        a.variable.localeCompare(b.variable) || a.valid_time.localeCompare(b.valid_time) || a.id.localeCompare(b.id));
      const previous = forecast.value;
      forecast.replaceChildren(new Option('Off', ''));
      for (const layer of layers) {
        const lead = layer.forecast_hour == null ? '' : ` · +${layer.forecast_hour}h`;
        const level = ` · ${layer.level_type} ${layer.level}`;
        forecast.add(new Option(`${layer.variable}${lead} · ${layer.valid_time.replace('+00:00', 'Z')}${level}`, layer.id));
      }
      forecast.disabled = false;
      forecast.value = layers.some((layer) => layer.id === previous) ? previous : '';
      update();
      if (!forecast.value) info.textContent = `${layers.length} forecasts available. Choose a forecast.`;
    } catch { reportError(); }
    finally { load.disabled = false; }
  });
  return {
    refresh: update,
    clearPreview() { revision++; overlay?.remove(); overlay = undefined; },
    loadCatalog,
    createOverlay,
    suspend() { suspended = true; group.disabled = true; overlay?.setVisible(false); },
    resume() { suspended = false; group.disabled = false; overlay?.setVisible(true); },
  };
}

export function withWeather(adapter, weather) {
  const rasters = createRasterWorkload(weather.createOverlay);
  return {
    ...adapter,
    loadRasterCatalog: weather.loadCatalog,
    addRasters: rasters.add,
    clearRasters: rasters.clear,
    settleRasters: rasters.settle,
    restyleRasters: rasters.restyle,
    sampleRasterCoverage: rasters.sampleCoverage,
    rasterWorkStats: rasters.workStats,
    measureReadiness: adapter.measureReadiness ? (signal, start, { hasRasters, afterReadyFrames = 0 }) =>
      adapter.measureReadiness(signal, start, { settleRaster: hasRasters ? rasters.settleMap : undefined, afterReadyFrames }) : undefined,
    async assertColorTables(requests, signal) {
      if (!requests.some(({ mode }) => mode === 'wms')) return;
      const response = await fetch(WMS_SERVER + '/health', { cache: 'no-store', signal: AbortSignal.any([
        ...(signal ? [signal] : []), AbortSignal.timeout(5000),
      ]) });
      const health = response.ok ? await response.json() : {};
      if (JSON.stringify(health.colorTables) !== JSON.stringify(COLOR_TABLES)) {
        throw new Error('Restart the updated WMS server: the benchmark needs matching parameter color tables.');
      }
    },
    async initializeMaps(count, signal, camera) {
      rasters.clear(); weather.suspend(); weather.clearPreview();
      return adapter.initializeMaps(count, signal, camera);
    },
    async setMapCount(count, signal) {
      weather.suspend(); weather.clearPreview();
      try { await adapter.setMapCount(count, signal); }
      finally { weather.refresh(); weather.resume(); }
    },
    prepare() {
      const snapshot = adapter.prepare();
      weather.suspend();
      return snapshot;
    },
    restore(snapshot) {
      try { rasters.clear(); adapter.restore(snapshot); } finally {
        weather.refresh?.(); weather.resume();
      }
    },
  };
}

export function mountGlWeather(map) {
  return mountWeather(glWeatherFactory(map), { supportsCog: true, supportsGrib: true });
}

export function glWeatherFactory(map) {
  return (layer, mode, onError, id = 'weather') => {
    if (mode === 'cog') return createGlCogOverlay(map, layer, cogUrl(layer), onError, id);
    if (mode === 'grib') return createGlRasterOverlay(map, layer, createGribReader(gribUrl(layer), layer), onError, id);
    const error = (event) => { if (event.sourceId === id) onError(event.error); };
    map.on('error', error);
    map.addSource(id, {
      type: 'raster', tiles: [weatherTileUrl(layer, mode)], tileSize: 256,
      minzoom: 0, maxzoom: rasterNativeZoom(layer), bounds: layer.bounds, attribution: 'DWD ICON forecast',
    });
    map.addLayer({ id, type: 'raster', source: id,
      paint: { 'raster-opacity': 0.7, 'raster-fade-duration': 0,
        'raster-resampling': layer.style.resampling === 'nearest' ? 'nearest' : 'linear' },
    }, 'stations');
    const tracking = trackGlTiles(map, layer, id, onError);
    return {
      sampleCoverage: tracking.sampleCoverage, workStats: tracking.workStats,
      restyle: mode === 'wms' ? () => map.getSource(id).setTiles([weatherTileUrl(restyledLayer(layer), mode)]) : undefined,
      settle: (signal) => waitForMapEvent({ on: map.on.bind(map), off: map.off.bind(map),
        trigger: () => map.triggerRepaint() }, 'idle', signal),
      remove() { tracking.dispose(); map.off('error', error); map.removeLayer(id); map.removeSource(id); },
      setVisible(visible) { map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none'); },
    };
  };
}
