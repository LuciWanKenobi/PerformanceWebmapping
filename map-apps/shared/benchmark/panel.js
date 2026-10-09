import { runBenchmark } from './runner.js';
import { percentile, toCsv } from './stats.js';
import { rasterSeries, commonRasterTimes, resolveRasterLayers } from './raster-workload.js';
import { MOTION_DURATIONS, DEFAULT_MOTION_SECONDS } from './data.js';

const format = (value, digits = 1) => value == null ? 'n/a' : value.toFixed(digits);
const mib = (value) => value == null ? 'n/a' : (value / 1048576).toFixed(2);

export function mountBenchmark(adapter) {
  const panel = document.createElement('aside');
  panel.className = 'benchmark-panel';
  panel.setAttribute('aria-label', 'Performance benchmark');
  panel.innerHTML = `
    <h2>Performance benchmark</h2>
    <p>All maps are destroyed and recreated before every trial, including warm-up. Combine points across Europe and weather raster layers. Follow a Europe tour with broad pans and repeated zooms from level 4 to 12. The basemap is hidden during each run.</p>
    <form id="benchmark-form">
      <fieldset>
        <legend>Workload</legend>
        <label>Maps <select name="maps">${Array.from({ length: 20 }, (_, i) => `<option>${i + 1}</option>`).join('')}</select></label>
        <p>Every map gets the selected workload. Pan/zoom is synchronized. Rasters stop requesting finer tiles at their source resolution and remain visible at deeper zoom. Raster HTTP and PNG output caches are bypassed between maps and trials.</p>
        <label>Points per layer <select name="points"><option>100</option><option selected>1000</option><option>5000</option></select></label>
        <label>Point layers <select name="layers"><option>0</option><option selected>1</option><option>2</option><option>3</option><option>4</option></select></label>
        <div class="benchmark-raster-actions"><button type="button" id="benchmark-load-rasters">Load raster catalog</button><button type="button" id="benchmark-add-raster" disabled>Add raster layer</button></div>
        <div id="benchmark-raster-layers"></div>
        <p id="benchmark-raster-info" role="status">No benchmark rasters selected. Add up to 8 layers.</p>
        <label>Initial raster time <select name="rasterTime" disabled><option value="">Load a catalog first</option></select></label>
        <label>Motion per trial <select name="duration">${MOTION_DURATIONS.map((seconds) => `<option value="${seconds}"${seconds === DEFAULT_MOTION_SECONDS ? ' selected' : ''}>${seconds} seconds</option>`).join('')}</select></label>
        <label>Repetitions <select name="repetitions"><option>1</option><option selected>3</option><option>5</option></select></label>
        <label class="warmup"><input name="warmup" type="checkbox" checked /> Discard one warm-up trial</label>
        <label class="warmup"><input name="measureCpu" type="checkbox" checked /> Measure system CPU (local helper)</label>
        <p>CPU sampling uses <code>serve_metrics.py</code> on port 8004. Without it, CPU values are n/a.</p>
        <label class="warmup"><input name="colorRestyle" type="checkbox" checked /> Restyle colors at the end of each trial</label>
        <p>Points become purple; each raster parameter switches to its alternative color table at the final fixed view. WMS/PNG modes fetch newly colored tiles.</p>
        <label class="warmup"><input name="timeChange" type="checkbox" /> Change time during each trial</label>
        <fieldset id="benchmark-time-options" disabled>
          <legend>Time change</legend>
          <label>After motion <select name="changeFraction"><option value="0.25">25%</option><option value="0.5" selected>50%</option><option value="0.75">75%</option></select></label>
          <label class="warmup"><input name="changePoints" type="checkbox" checked /> Apply new point data</label>
          <label class="warmup"><input name="changeRasters" type="checkbox" checked /> Switch raster forecast time</label>
          <label>New raster time <select name="nextRasterTime" disabled><option value="">Select raster layers first</option></select></label>
          <p>The camera pauses while the new data loads, then continues. Point IDs and counts stay fixed; positions change reproducibly.</p>
        </fieldset>
      </fieldset>
      <div class="benchmark-actions"><button type="submit">Run benchmark</button><button id="benchmark-stop" type="button" disabled>Stop</button></div>
    </form>
    <p id="benchmark-progress" role="status">Ready. Keep this tab visible and the window size fixed.</p>
    <p id="benchmark-summary"></p>
    <div class="benchmark-results" tabindex="0" role="region" aria-label="Benchmark results">
      <table><caption>Completed trials in this tab</caption><thead><tr><th>Trial</th><th>Maps</th><th>Total points</th><th>Total rasters</th><th>Init ms</th><th>Ready ms</th><th>Change ms</th><th>Restyle ms</th><th>rAF fps</th><th>5% low</th><th>1% low</th><th>Before fps</th><th>After fps</th><th>p95 ms</th><th>p99 ms</th><th>CPU avg %</th><th>CPU peak %</th><th>Requests</th><th>Server GETs</th><th>Range GETs</th><th>Fetched MiB</th><th>Transferred MiB</th><th>Cache hits</th></tr></thead><tbody></tbody></table>
    </div>
    <div class="benchmark-actions"><button id="benchmark-csv" type="button" disabled>Export CSV</button><button id="benchmark-json" type="button" disabled>Export JSON</button><button id="benchmark-clear" type="button" disabled>Clear</button></div>
    <details><summary>What is measured?</summary>
      <p><b>Init ms:</b> fresh map construction and readiness for the whole grid before benchmark layers are added. Maps initialize sequentially at their final viewport sizes. Basemap and preview stations are hidden. Exports also include destruction plus two cleanup frames, total reset time and individual map initialization times. Initialization is separate from layer Ready ms, motion FPS and trial CPU/network totals; module, browser asset and OS caches can remain warm.</p>
      <p><b>Ready ms:</b> insertion of all selected layers through raster completion and the library's readiness signal. <b>Change ms:</b> replacing selected data through readiness at a fixed view. Synchronous submission times are also exported.</p>
      <p><b>Restyle ms:</b> end-of-trial point fill and parameter color-table replacement through readiness on every map, followed by two animation frames. COG/GRIB layers recolor numeric values in the frontend; OpenLayers COG updates its GPU color expression. WMS/PNG layers request tiles rendered with the new table, including server work and network time. Parameter ranges and nodata transparency stay fixed. Tables are defined in test_data/color_tables.json and included in exports. This is a presentation proxy, not a GPU timestamp. Restyle scheduling and requests are exported separately and excluded from motion FPS.</p>
      <p><b>rAF fps / p95:</b> browser animation-callback cadence during motion, not GPU frame rate. Higher fps and lower p95 intervals indicate smoother scheduling.</p>
      <p><b>5% / 1% lows:</b> 1000 divided by the average of the slowest 5% / 1% of callback intervals, rounding the sample count up. Short runs have few tail samples. p99 and counts over 33, 50 and 100 ms are also exported.</p>
      <p>Before/after motion and stationary time-change scheduling are exported separately, with forecast IDs/times, delivery modes, map count, per-map viewport sizes and raw intervals. Each map owns its sources, COG reader and GRIB workers. Raster URLs are unique per map/load, responses use no-store, and the PNG output cache is bypassed. Per-map memory caches can still serve subsequent views within the same load. Native-resolution tiles and canvas blocks are enlarged above the source ceiling; the camera and points continue zooming. Exports record the raster resolution policy and native tile zoom. OS disk caching and code/decoder asset caching are outside this isolation.</p>
      <p><b>CPU:</b> mean system utilization from counter deltas, plus peak/p95/last samples at 250 ms. Includes all applications and local servers. Main-thread long-task busy time is a separate metric.</p>
      <p><b>Requests:</b> completed browser resource fetches for rasters and code/decoder assets, including instrumented GRIB workers. Fetched bytes include cached bodies; transferred bytes include response headers and exclude browser cache hits. Unknown sizes are n/a, not zero. Updated data servers expose separate received-request, GET, range-GET and body-byte counters for all clients.</p>
      <p>JSON includes sanitized request timing and CPU samples; CSV includes totals. Failed/aborted or uninstrumented worker requests can be absent from browser timings. Use the server counters to check actual requests. Heap samples exclude GPU memory and may exclude workers. Use the production build for comparisons.</p>
    </details>`;

  const mapFrame = document.querySelector('.map-frame');
  const workspace = document.createElement('div');
  workspace.className = 'map-workspace';
  mapFrame.before(workspace);
  workspace.append(mapFrame, panel);
  adapter.resize?.();

  const form = panel.querySelector('form');
  const fieldset = panel.querySelector('fieldset');
  const run = panel.querySelector('[type="submit"]');
  const stop = panel.querySelector('#benchmark-stop');
  const progress = panel.querySelector('#benchmark-progress');
  const summary = panel.querySelector('#benchmark-summary');
  const tbody = panel.querySelector('tbody');
  const csv = panel.querySelector('#benchmark-csv');
  const json = panel.querySelector('#benchmark-json');
  const clear = panel.querySelector('#benchmark-clear');
  const mapElement = mapFrame;
  const controls = [...document.querySelectorAll('.toolbar button, .toolbar input, .toolbar select')]
    .filter((control) => !control.closest('.weather-controls'));
  const disabledBeforeRun = new Map();
  const results = [];
  let controller;
  let series = [], catalogLoading = false;
  const loadRasters = panel.querySelector('#benchmark-load-rasters');
  const addRaster = panel.querySelector('#benchmark-add-raster');
  const rasterRows = panel.querySelector('#benchmark-raster-layers');
  const rasterInfo = panel.querySelector('#benchmark-raster-info');
  const timeOptions = panel.querySelector('#benchmark-time-options');
  const modeLabels = { wms: 'WMS', xyz: 'PNG tiles', cog: 'COG (byte ranges)', grib: 'GRIB2 (worker)' };

  function selections() {
    return [...rasterRows.children].map((row) => ({ key: row.querySelector('.raster-series').value,
      mode: row.querySelector('.raster-delivery').value }));
  }
  function syncTimeControls() {
    timeOptions.disabled = !form.elements.timeChange.checked;
    form.elements.changePoints.disabled = Number(form.elements.layers.value) === 0;
    form.elements.changeRasters.disabled = rasterRows.children.length === 0;
    form.elements.nextRasterTime.disabled = !rasterRows.children.length || !form.elements.changeRasters.checked;
  }
  function updateTimes() {
    const chosen = selections();
    const times = commonRasterTimes(series, chosen);
    for (const [select, fallback] of [[form.elements.rasterTime, 0], [form.elements.nextRasterTime, 1]]) {
      const previous = select.value;
      select.replaceChildren();
      for (const time of times) select.add(new Option(time.replace('+00:00', 'Z'), time));
      if (!times.length) select.add(new Option(chosen.length ? 'No common forecast time' : 'No raster layers', ''));
      select.value = times.includes(previous) ? previous : times[Math.min(fallback, times.length - 1)] ?? '';
    }
    form.elements.rasterTime.disabled = !chosen.length;
    addRaster.disabled = !series.length || chosen.length >= 8;
    rasterInfo.textContent = chosen.length ? `${chosen.length} raster layers · ${times.length} shared forecast times.` : 'No benchmark rasters selected. Add up to 8 layers.';
    syncTimeControls();
  }
  function addRasterRow(key, mode = 'wms') {
    if (rasterRows.children.length >= 8) return;
    const row = document.createElement('div');
    row.className = 'benchmark-raster-row';
    row.innerHTML = '<label>Raster <select class="raster-series" aria-label="Raster variable and level"></select></label><label>Delivery <select class="raster-delivery" aria-label="Raster delivery"></select></label><button type="button">Remove raster</button>';
    const select = row.querySelector('.raster-series');
    for (const group of series) select.add(new Option(group.label, group.key));
    select.value = key;
    const delivery = row.querySelector('.raster-delivery');
    for (const [value, label] of Object.entries(modeLabels)) delivery.add(new Option(label, value));
    delivery.value = mode;
    select.addEventListener('change', updateTimes);
    row.querySelector('button').addEventListener('click', () => { row.remove(); updateTimes(); });
    rasterRows.append(row);
    updateTimes();
  }
  addRaster.addEventListener('click', () => {
    const chosen = selections();
    const next = series.find((group) => !chosen.some((item) => item.key === group.key)) ?? series[0];
    if (next) addRasterRow(next.key);
  });
  loadRasters.addEventListener('click', async () => {
    catalogLoading = true; loadRasters.disabled = true; run.disabled = true;
    rasterInfo.textContent = 'Loading raster catalog…';
    try {
      const previous = selections();
      series = rasterSeries(await adapter.loadRasterCatalog());
      rasterRows.replaceChildren();
      previous.filter(({ key }) => series.some((group) => group.key === key)).forEach(({ key, mode }) => addRasterRow(key, mode));
      updateTimes();
      if (!previous.length) rasterInfo.textContent = `${series.length} raster variables/levels available. Click Add raster layer.`;
    } catch (error) { rasterInfo.textContent = error.message; }
    finally { catalogLoading = false; loadRasters.disabled = false; run.disabled = Boolean(controller); }
  });
  form.elements.layers.addEventListener('change', syncTimeControls);
  form.elements.timeChange.addEventListener('change', syncTimeControls);
  form.elements.changeRasters.addEventListener('change', syncTimeControls);
  syncTimeControls();
  form.elements.maps.addEventListener('change', async () => {
    if (controller) return;
    controller = new AbortController();
    updateButtons(true);
    progress.textContent = `Preparing ${form.elements.maps.value} synchronized maps…`;
    try {
      await adapter.setMapCount(Number(form.elements.maps.value), controller.signal);
      progress.textContent = `${adapter.mapCount()} maps ready. Pan or zoom any map to synchronize the grid.`;
    } catch (error) { progress.textContent = error.message; }
    finally {
      form.elements.maps.value = String(adapter.mapCount());
      controller = undefined; updateButtons(false);
    }
  });

  function updateButtons(busy) {
    fieldset.disabled = busy;
    run.disabled = busy || catalogLoading;
    stop.disabled = !busy;
    csv.disabled = json.disabled = clear.disabled = busy || results.length === 0;
    mapElement.inert = busy;
    controls.forEach((control) => {
      if (busy) disabledBeforeRun.set(control, control.disabled);
      control.disabled = busy || (disabledBeforeRun.get(control) ?? control.disabled);
    });
    if (!busy) disabledBeforeRun.clear();
    panel.setAttribute('aria-busy', String(busy));
  }

  function addResult(result) {
    results.push(result);
    const row = document.createElement('tr');
    const cells = [results.length, result.mapCount, result.totalPoints, result.totalRasterLayerInstances, format(result.mapInitMs), format(result.layerReadyMs),
      format(result.timeChangeReadyMs), format(result.colorRestyleReadyMs), format(result.rafFps), format(result.fpsLow5Percent), format(result.fpsLow1Percent),
      format(result.beforeChangeRafFps), format(result.afterChangeRafFps), format(result.p95FrameMs), format(result.p99FrameMs),
      format(result.systemCpuMeanPercent), format(result.systemCpuPeakPercent), result.requestCount ?? 'n/a',
      result.serverGetRequestCount ?? 'n/a', result.serverRangeGetRequestCount ?? 'n/a', mib(result.fetchedBodyBytes),
      mib(result.transferBytes), result.cacheHitCount ?? 'n/a'];
    for (const value of cells) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    tbody.append(row);
  }

  const cancel = (message) => controller?.abort(new Error(message));
  stop.addEventListener('click', () => cancel('Stopped. Completed trials are retained; the interrupted trial was discarded.'));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (controller || catalogLoading) return;
    if (document.hidden) { progress.textContent = 'Bring this tab to the foreground before starting.'; return; }
    let options;
    try {
      const chosen = selections();
      const change = form.elements.timeChange.checked ? {
        fraction: Number(form.elements.changeFraction.value),
        points: form.elements.changePoints.checked && Number(form.elements.layers.value) > 0,
        rasters: form.elements.changeRasters.checked && chosen.length > 0,
      } : null;
      options = {
        pointsPerLayer: Number(form.elements.points.value),
        mapCount: Number(form.elements.maps.value),
        layerCount: Number(form.elements.layers.value),
        durationSeconds: Number(form.elements.duration.value),
        repetitions: Number(form.elements.repetitions.value),
        warmup: form.elements.warmup.checked,
        measureCpu: form.elements.measureCpu.checked,
        colorRestyle: form.elements.colorRestyle.checked,
        measureServerMetrics: true,
        rasterLayers: resolveRasterLayers(series, chosen, form.elements.rasterTime.value),
        nextRasterLayers: change?.rasters ? resolveRasterLayers(series, chosen, form.elements.nextRasterTime.value) : [],
        timeChange: change,
      };
    } catch (error) { progress.textContent = error.message; return; }
    controller = new AbortController();
    summary.textContent = '';
    updateButtons(true);
    const visibility = () => { if (document.hidden) cancel('Tab was hidden. Interrupted trial discarded; completed trials retained.'); };
    const resize = () => cancel('Window size changed. Interrupted trial discarded; completed trials retained.');
    const initialSize = adapter.size();
    const mapResize = new ResizeObserver(() => {
      const size = adapter.size();
      if (Math.abs(size.width - initialSize.width) > 0.5 || Math.abs(size.height - initialSize.height) > 0.5) {
        cancel('Map viewport changed. Interrupted trial discarded; completed trials retained.');
      }
    });
    mapResize.observe(mapElement);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', resize);
    const unwatch = adapter.watchErrors?.((error) => controller?.abort(error));
    try {
      const batch = await runBenchmark(adapter, options, {
        signal: controller.signal,
        onProgress: (text) => { progress.textContent = `${text} — keep this tab visible.`; },
        onResult: addResult,
      });
      const median = (key) => format(percentile(batch.map((row) => row[key]).filter((value) => value !== null), 50));
      summary.textContent = `Batch medians: init ${median('mapInitMs')} ms · ready ${median('layerReadyMs')} ms · rAF ${median('rafFps')} fps · p95 interval ${median('p95FrameMs')} ms.` +
        ` 5% low ${median('fpsLow5Percent')} fps · 1% low ${median('fpsLow1Percent')} fps · CPU ${median('systemCpuMeanPercent')}%.` +
        (options.colorRestyle ? ' Restyle ' + median('colorRestyleReadyMs') + ' ms.' : '') +
        (options.timeChange ? ` Time change ${median('timeChangeReadyMs')} ms · before ${median('beforeChangeRafFps')} fps · after ${median('afterChangeRafFps')} fps.` : '');
      const last = batch.at(-1);
      if (last?.cpuStatus.startsWith('unavailable')) summary.textContent += ' CPU helper unavailable; start test_data/serve_metrics.py.';
      if (last?.serverMetricsStatus.startsWith('unavailable')) summary.textContent += ' Server counters unavailable; restart the updated data servers.';
      progress.textContent = `${batch.length} trials completed. Original map view restored.`;
    } catch (error) {
      progress.textContent = error.message || 'Benchmark failed. Incomplete trial discarded.';
    } finally {
      unwatch?.();
      mapResize.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', resize);
      form.elements.maps.value = String(adapter.mapCount());
      controller = undefined;
      updateButtons(false);
    }
  });

  function download(extension, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${adapter.library.toLowerCase().replaceAll(' ', '-')}-benchmark-${Date.now()}.${extension}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  csv.addEventListener('click', () => download('csv', toCsv(results), 'text/csv;charset=utf-8'));
  json.addEventListener('click', () => download('json', JSON.stringify({ schemaVersion: 7, results }, null, 2), 'application/json'));
  clear.addEventListener('click', () => {
    results.length = 0;
    tbody.replaceChildren();
    summary.textContent = '';
    progress.textContent = 'Results cleared.';
    updateButtons(false);
  });
}
