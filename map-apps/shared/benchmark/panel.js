import { runBenchmark } from './runner.js';
import { percentile, toCsv } from './stats.js';
import { rasterSeries, commonRasterTimes, resolveRasterLayers } from './raster-workload.js';
import { MOTION_DURATIONS, DEFAULT_MOTION_SECONDS } from './data.js';
import { withBenchmarkPresentation } from './presentation.js';
import { ACTIVE_SUITE_KEY, LAST_SUITE_KEY, buildSuitePlan, frameworkFromPath, openSuiteStore, runSuite } from './suite.js';

const format = (value, digits = 1) => value == null ? 'n/a' : value.toFixed(digits);
const mib = (value) => value == null ? 'n/a' : (value / 1048576).toFixed(2);

export function formatRestyleTime(result) {
  if (result.colorRestyleStatus === 'unsupported') return 'n/a (PNG fixed)';
  return format(result.colorRestyleReadyMs) + (result.colorRestyleStatus === 'partial' ? ' (partial; PNG fixed)' : '');
}

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
        <label>Map sizing <select name="viewportMode"><option value="fixed-total">Fixed total area</option><option value="fixed-map">Fixed size per map</option></select></label>
        <label>Map width (px) <input name="mapWidth" type="number" value="400" min="128" max="2048" step="1" disabled /></label>
        <label>Map height (px) <input name="mapHeight" type="number" value="300" min="128" max="2048" step="1" disabled /></label>
        <p>Fixed total area makes individual maps smaller as the count increases. Fixed size per map increases total rendered pixels; the grid scrolls when it exceeds the visible area.</p>
        <p>Every map gets the selected workload. Pan/zoom is synchronized. Rasters stop requesting finer tiles at their source resolution and remain visible at deeper zoom. Raster HTTP caches and WMS render caches are bypassed between maps and trials. PNG tiles are read from precomputed files for every map; missing files are not generated.</p>
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
        <label class="warmup"><input name="measureBrowserMemory" type="checkbox" /> Browser memory estimate (may trigger GC)</label>
        <p>Window heap and known raster/WASM allocations are sampled automatically. The optional browser estimate includes related workers and requires cross-origin isolation.</p>
        <p>CPU sampling uses <code>serve_metrics.py</code> on port 8004. Without it, CPU values are n/a.</p>
        <label class="warmup"><input name="colorRestyle" type="checkbox" checked /> Restyle colors at the end of each trial</label>
        <p>Points become purple; WMS, COG and GRIB2 parameters switch to alternative color tables at the final fixed view. Precomputed PNG tiles keep their original colors and are reported as unsupported; mixed workloads report a partial restyle.</p>
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
    <details open><summary>Automated benchmark suite</summary>
      <p>Edit <a href="../benchmark-config.json" target="_blank" rel="noopener">benchmark-config.json</a> before starting. The supplied core matrix contains seven scenes, three raster paths, four frameworks and 1/2/5/10/20 maps: 2,100 measured trials plus 420 warm-ups.</p>
      <p>Runs use the full browser viewport with all controls hidden and disabled. Press <b>Escape</b> to stop. Keep this tab visible and the window size fixed. Each completed repetition is saved in this browser; resume repeats an interrupted configuration with its warm-up.</p>
      <div class="benchmark-actions"><button type="button" id="benchmark-suite-start">Run configured suite</button><button type="button" id="benchmark-suite-resume" disabled>Resume saved suite</button><button type="button" id="benchmark-suite-csv" disabled>Export suite CSV</button><button type="button" id="benchmark-suite-json" disabled>Export suite JSON</button></div>
      <p id="benchmark-suite-info" role="status">No saved suite.</p>
    </details>
    <div class="benchmark-results" tabindex="0" role="region" aria-label="Benchmark results">
      <table><caption>Completed trials in this tab</caption><thead><tr><th>Trial</th><th>Maps</th><th>Total points</th><th>Total rasters</th><th>Init ms</th><th>Ready ms</th><th>Ready spread ms</th><th>Raster coverage %</th><th>Worst map %</th><th>Incomplete ms</th><th>Longest gap ms</th><th>All maps complete %</th><th>Catch-up ms</th><th>Superseded work</th><th>Change ms</th><th>Change spread ms</th><th>Restyle ms</th><th>Restyle spread ms</th><th>Fetch active ms</th><th>Body transfer ms</th><th>Decode ms</th><th>COG read/decode ms</th><th>Projection ms</th><th>Canvas upload ms</th><th>WMS render ms</th><th>Heap peak MiB</th><th>Worker grids MiB</th><th>WASM capacity MiB</th><th>Browser RSS peak MiB</th><th>Browser memory MiB</th><th>rAF fps</th><th>5% low</th><th>1% low</th><th>Before fps</th><th>After fps</th><th>p95 ms</th><th>p99 ms</th><th>CPU avg %</th><th>CPU peak %</th><th>Browser CPU %</th><th>Server CPU %</th><th>Requests</th><th>Server GETs</th><th>Range GETs</th><th>Failed responses</th><th>Aborted responses</th><th>Fetched MiB</th><th>Transferred MiB</th><th>Cache hits</th></tr></thead><tbody></tbody></table>
    </div>
    <div class="benchmark-actions"><button id="benchmark-csv" type="button" disabled>Export CSV</button><button id="benchmark-json" type="button" disabled>Export JSON</button><button id="benchmark-failures" type="button" disabled>Export failures CSV</button><button id="benchmark-clear" type="button" disabled>Clear</button></div>
    <p id="benchmark-failure-count">No failed or aborted trials.</p>
    <details><summary>What is measured?</summary>
      <p><b>Raster coverage during motion:</b> time-weighted geometric coverage sampled every 100 ms from rendered canvas or native tile footprints, clipped to the data extent. Transparent/nodata pixels count as loaded; available lower-resolution fallback counts as usable coverage. Incomplete ms and longest gap count time when any expected layer is below 99.9% coverage. Worst map is the lowest per-map mean; all maps complete requires every expected layer on every map. Catch-up ms measures the final stationary wait through raster and native readiness. Samples, per-map/per-layer summaries and sampling overhead are exported. This is a presentation proxy; unsupported hooks show n/a. Superseded-work counters identify discarded numeric renders, aborted GL tiles, unfinished Leaflet tile unloads or off-view OpenLayers completions; these units differ between adapters.</p>
      <p><b>Ready spread:</b> last minus first map reaching its own raster and native readiness signal. Measured for loading, time changes and supported color changes. One map has a spread of zero; unavailable phases show n/a. Per-map timings are exported. These signals approximate presentation; they are not GPU timestamps.</p>
      <p><b>Stage timings:</b> fetch-active time is the union of completed data-request intervals, including server waits. Body-transfer time sums response-body intervals. GRIB decoding and projection/coloring are measured in workers; frontend COG reads combine fetch/decode, followed by measured projection. Canvas upload measures the frontend copy, not GPU execution. WMS exposes server rendering via Server-Timing. Concurrent stage totals overlap and must not be added to derive wall time. Native library stages without instrumentation show n/a.</p>
      <p><b>Memory:</b> sampled window JS heap peak (100 ms), GRIB grids and WASM capacity (worker reports every 250 ms), frontend COG windows and canvas pixels. These observations overlap and are not a full memory balance. The optional browser estimate can trigger garbage collection. Process RSS includes native memory and can double-count shared pages. Exact GPU allocation bytes are unavailable.</p>
      <p><b>Process CPU/RAM:</b> updated helper samples browser renderer, GPU and other processes separately from COG/GRIB and WMS/PNG servers. Browser/server CPU columns use whole-machine normalization; exported per-role percentages use 100% per logical core. All running browser processes are included, not only this tab.</p>
      <p><b>Request coverage:</b> updated servers isolate counters to this trial and count failures and aborted bodies. Browser timings may omit failed/aborted or uninstrumented library-worker requests. Failed trials stay out of successful measurements and have separate JSON/CSV diagnostics.</p>
      <p><b>Init ms:</b> fresh map construction and readiness for the whole grid before benchmark layers are added. Maps initialize sequentially at their final viewport sizes. Basemap and preview stations are hidden. Exports also include destruction plus two cleanup frames, total reset time and individual map initialization times. Initialization is separate from layer Ready ms, motion FPS and trial CPU/network totals; module, browser asset and OS caches can remain warm.</p>
      <p><b>Ready ms:</b> insertion of all selected layers through raster completion and the library's readiness signal. <b>Change ms:</b> replacing selected data through readiness at a fixed view. Synchronous submission times are also exported.</p>
      <p><b>Restyle ms:</b> end-of-trial point fill and parameter color-table replacement through readiness on every map, followed by two animation frames. COG/GRIB layers recolor numeric values in the frontend; OpenLayers COG updates its GPU color expression. WMS layers request images rendered with the new table, including server work and network time. Precomputed PNG layers remain unchanged and cause no restyle requests. PNG-only workloads report n/a, not a zero-millisecond success; mixed workloads time only supported operations and report partial. Parameter ranges and nodata transparency stay fixed. Tables are defined in test_data/color_tables.json and included in exports. This is a presentation proxy, not a GPU timestamp. Restyle scheduling and requests are exported separately and excluded from motion FPS.</p>
      <p><b>rAF fps / p95:</b> browser animation-callback cadence during motion, not GPU frame rate. Higher fps and lower p95 intervals indicate smoother scheduling.</p>
      <p><b>5% / 1% lows:</b> 1000 divided by the average of the slowest 5% / 1% of callback intervals, rounding the sample count up. Short runs have few tail samples. p99 and counts over 33, 50 and 100 ms are also exported.</p>
      <p>Before/after motion and stationary time-change scheduling are exported separately, with forecast IDs/times, delivery modes, map count, per-map viewport sizes and raw intervals. Each map owns its sources, COG reader and GRIB workers. Raster URLs are unique per map/load, responses use no-store, WMS bypasses its render cache, and PNG requests independently read precomputed files. Per-map memory caches can still serve subsequent views within the same load. Native-resolution tiles and canvas blocks are enlarged above the source ceiling; the camera and points continue zooming. Exports record the raster resolution policy and native tile zoom. OS disk caching and code/decoder asset caching are outside this isolation.</p>
      <p><b>CPU:</b> mean system utilization from counter deltas, plus peak/p95/last samples at 250 ms. Includes all applications and local servers. Main-thread long-task busy time is a separate metric.</p>
      <p><b>Requests:</b> completed browser resource fetches for rasters and code/decoder assets, including instrumented GRIB workers. Fetched bytes include cached bodies; transferred bytes include response headers and exclude browser cache hits. Unknown sizes are n/a, not zero. Updated data servers expose separate received-request, GET, range-GET and body-byte counters scoped to this trial; older helpers report all-client scope explicitly.</p>
      <p>JSON includes sanitized request timings, stage events, memory and CPU samples; CSV includes totals. Failed/aborted or uninstrumented worker requests can be absent from browser timings. Use the server counters to check actual requests. Window heap samples exclude GPU memory and may exclude workers. Use the production build for comparisons.</p>
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
  const failureCsv = panel.querySelector('#benchmark-failures');
  const failureCount = panel.querySelector('#benchmark-failure-count');
  const suiteStart = panel.querySelector('#benchmark-suite-start');
  const suiteResume = panel.querySelector('#benchmark-suite-resume');
  const suiteCsv = panel.querySelector('#benchmark-suite-csv');
  const suiteJson = panel.querySelector('#benchmark-suite-json');
  const suiteInfo = panel.querySelector('#benchmark-suite-info');
  const mapElement = mapFrame;
  const controls = [...document.querySelectorAll('.toolbar button, .toolbar input, .toolbar select')]
    .filter((control) => !control.closest('.weather-controls'));
  const disabledBeforeRun = new Map();
  const results = [];
  const failures = [];
  let controller;
  let savedSuite, storePromise;
  const suiteStore = () => storePromise ??= openSuiteStore();
  const browserViewport = () => ({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio });
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
  const applyViewport = () => {
    const fixed = form.elements.viewportMode.value === 'fixed-map';
    form.elements.mapWidth.disabled = form.elements.mapHeight.disabled = !fixed;
    try { adapter.setViewportLayout(form.elements.viewportMode.value,
      Number(form.elements.mapWidth.value), Number(form.elements.mapHeight.value)); }
    catch (error) { progress.textContent = error.message; }
  };
  for (const name of ['viewportMode', 'mapWidth', 'mapHeight']) form.elements[name].addEventListener('change', applyViewport);
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
    csv.disabled = busy || results.length === 0;
    json.disabled = clear.disabled = busy || results.length + failures.length === 0;
    failureCsv.disabled = busy || failures.length === 0;
    mapElement.inert = busy;
    controls.forEach((control) => {
      if (busy) disabledBeforeRun.set(control, control.disabled);
      control.disabled = busy || (disabledBeforeRun.get(control) ?? control.disabled);
    });
    if (!busy) disabledBeforeRun.clear();
    panel.setAttribute('aria-busy', String(busy));
    suiteStart.disabled = busy || catalogLoading;
    suiteResume.disabled = busy || !savedSuite || savedSuite.status === 'completed';
    suiteCsv.disabled = suiteJson.disabled = busy || !savedSuite;
  }

  function addResult(result) {
    results.push(result);
    const row = document.createElement('tr');
    const cells = [results.length, result.mapCount, result.totalPoints, result.totalRasterLayerInstances, format(result.mapInitMs), format(result.layerReadyMs),
      format(result.mapReadySpreadMs), format(result.motionRasterCoveragePercent), format(result.motionWorstMapCoveragePercent),
      format(result.motionRasterIncompleteMs), format(result.motionRasterLongestGapMs), format(result.motionAllMapsCompletePercent),
      format(result.postMotionRasterCatchUpMs), result.motionRasterSupersededWorkCount ?? 'n/a', format(result.timeChangeReadyMs), format(result.timeChangeMapReadySpreadMs),
      formatRestyleTime(result), format(result.colorRestyleMapReadySpreadMs), format(result.dataFetchActiveMs), format(result.dataBodyTransferMs),
      format(result.decodeMs), format(result.readDecodeMs), format(result.projectColorMs), format(result.uploadMs), format(result.serverRenderMs),
      mib(result.heapPeakBytes), mib(result.workerGridPeakBytes), mib(result.wasmCapacityPeakBytes), mib(result.browserRssPeakBytes), mib(result.userAgentMemoryPeakBytes),
      format(result.rafFps), format(result.fpsLow5Percent), format(result.fpsLow1Percent),
      format(result.beforeChangeRafFps), format(result.afterChangeRafFps), format(result.p95FrameMs), format(result.p99FrameMs),
      format(result.systemCpuMeanPercent), format(result.systemCpuPeakPercent), format(result.browserCpuMeanPercent), format(result.serverCpuMeanPercent), result.requestCount ?? 'n/a',
      result.serverGetRequestCount ?? 'n/a', result.serverRangeGetRequestCount ?? 'n/a', result.serverFailedResponseCount ?? 'n/a', result.serverAbortedRequestCount ?? 'n/a', mib(result.fetchedBodyBytes),
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

  async function runObserved(options, signal, callbacks) {
    const visibility = () => { if (document.hidden) cancel('Tab was hidden. Interrupted configuration stopped; completed trials retained.'); };
    const resize = () => cancel('Window size changed. Interrupted configuration stopped; completed trials retained.');
    const initialSize = mapElement.getBoundingClientRect();
    const mapResize = new ResizeObserver(() => {
      const size = mapElement.getBoundingClientRect();
      if (Math.abs(size.width - initialSize.width) > 0.5 || Math.abs(size.height - initialSize.height) > 0.5) resize();
    });
    mapResize.observe(mapElement);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', resize);
    const unwatch = adapter.watchErrors?.((error) => controller?.abort(error));
    try {
      return await runBenchmark(adapter, options, { signal,
        onProgress: (text) => { progress.textContent = `${text} — Escape to stop; keep this tab visible.`; }, ...callbacks });
    } finally {
      unwatch?.(); mapResize.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', resize);
    }
  }
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
        measureBrowserMemory: form.elements.measureBrowserMemory.checked,
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
    try {
      const batch = await withBenchmarkPresentation(adapter, controller.signal,
        () => runObserved(options, controller.signal, {
        onResult: addResult,
        onFailure: (failure) => { failures.push(failure); failureCount.textContent = `${failures.length} failed or aborted trials available in diagnostics exports.`; },
      }), cancel);
      const median = (key) => format(percentile(batch.map((row) => row[key]).filter(Number.isFinite), 50));
      summary.textContent = `Batch medians: init ${median('mapInitMs')} ms · ready ${median('layerReadyMs')} ms · rAF ${median('rafFps')} fps · p95 interval ${median('p95FrameMs')} ms.` +
        ` 5% low ${median('fpsLow5Percent')} fps · 1% low ${median('fpsLow1Percent')} fps · CPU ${median('systemCpuMeanPercent')}%.` +
        (options.colorRestyle ? batch.at(-1)?.colorRestyleStatus === 'unsupported'
          ? ' Restyle n/a: precomputed PNG colors are fixed.'
          : ' Restyle ' + median('colorRestyleReadyMs') + ' ms.' +
            (batch.at(-1)?.colorRestyleStatus === 'partial' ? ' Partial: PNG layers unchanged.' : '') : '') +
        (options.timeChange ? ` Time change ${median('timeChangeReadyMs')} ms · before ${median('beforeChangeRafFps')} fps · after ${median('afterChangeRafFps')} fps.` : '');
      const last = batch.at(-1);
      summary.textContent += ` Ready spread ${median('mapReadySpreadMs')} ms · heap peak ${mib(percentile(batch.map((row) => row.heapPeakBytes).filter(Number.isFinite), 50))} MiB.`;
      if (options.rasterLayers.length) summary.textContent += ` Raster coverage ${median('motionRasterCoveragePercent')}% · incomplete ${median('motionRasterIncompleteMs')} ms · catch-up ${median('postMotionRasterCatchUpMs')} ms.`;
      if (last?.cpuStatus.startsWith('unavailable')) summary.textContent += ' CPU helper unavailable; start test_data/serve_metrics.py.';
      if (last?.serverMetricsStatus.startsWith('unavailable')) summary.textContent += ' Server counters unavailable; restart the updated data servers.';
      progress.textContent = `${batch.length} trials completed. Original map view restored.`;
    } catch (error) {
      progress.textContent = error.message || 'Benchmark failed. Incomplete trial discarded.';
    } finally {
      form.elements.maps.value = String(adapter.mapCount());
      controller = undefined;
      updateButtons(false);
    }
  });

  async function refreshSuite() {
    const id = localStorage.getItem(LAST_SUITE_KEY);
    savedSuite = id ? await (await suiteStore()).get(id) : undefined;
    if (savedSuite) suiteInfo.textContent = `${savedSuite.config.name}: ${savedSuite.status} · ${savedSuite.nextIndex}/${savedSuite.plan.length} configurations completed · ${savedSuite.counts.measuredTrials} planned measured trials.` + (savedSuite.lastError ? ` ${savedSuite.lastError}` : '');
    updateButtons(Boolean(controller));
  }

  async function startSuite(resume = false) {
    if (controller || catalogLoading) return;
    if (document.hidden) { suiteInfo.textContent = 'Bring this tab to the foreground before starting.'; return; }
    controller = new AbortController(); updateButtons(true);
    let navigating = false;
    try {
      await withBenchmarkPresentation(adapter, controller.signal, async () => {
        const store = await suiteStore();
        if (!resume) {
          const response = await fetch(new URL('../benchmark-config.json', location.href), { cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error('Could not load benchmark-config.json.');
          const config = await response.json();
          if (config.frameworks?.includes('mapbox') && !import.meta.env?.VITE_MAPBOX_ACCESS_TOKEN?.trim().startsWith('pk.')) throw new Error('Set VITE_MAPBOX_ACCESS_TOKEN before running a suite that includes Mapbox.');
          const resolved = buildSuitePlan(config, await adapter.loadRasterCatalog());
          savedSuite = { id: crypto.randomUUID(), config, ...resolved, browserViewport: browserViewport(),
            status: 'running', nextIndex: 0, createdAt: new Date().toISOString() };
          await store.put(savedSuite);
          localStorage.setItem(LAST_SUITE_KEY, savedSuite.id);
        } else {
          savedSuite = await store.get(localStorage.getItem(LAST_SUITE_KEY));
          if (!savedSuite || savedSuite.status === 'completed') throw new Error('No unfinished saved suite.');
        }
        controller.signal.throwIfAborted();
        sessionStorage.setItem(ACTIVE_SUITE_KEY, savedSuite.id);
        adapter.setViewportLayout(savedSuite.config.viewport.mode, savedSuite.config.viewport.mapWidth, savedSuite.config.viewport.mapHeight);
        const outcome = await runSuite(savedSuite, { store, signal: controller.signal,
          currentFramework: frameworkFromPath(location.pathname), viewport: browserViewport,
          navigate: (framework) => { navigating = true; location.assign(new URL(`../${framework}/`, location.href)); },
          onProgress: (text) => { suiteInfo.textContent = text; document.title = text; },
          execute: (options, callbacks) => runObserved(options, controller.signal, callbacks) });
        if (outcome === 'completed') suiteInfo.textContent = `Suite complete: ${savedSuite.counts.measuredTrials} measured trials. Export the saved results below.`;
      }, cancel);
    } catch (error) { suiteInfo.textContent = error.message || 'Suite stopped.'; }
    finally {
      if (!navigating) sessionStorage.removeItem(ACTIVE_SUITE_KEY);
      form.elements.maps.value = String(adapter.mapCount());
      const layout = adapter.viewportLayout();
      form.elements.viewportMode.value = layout.mode;
      form.elements.mapWidth.value = layout.mapWidth ?? 400; form.elements.mapHeight.value = layout.mapHeight ?? 300;
      form.elements.mapWidth.disabled = form.elements.mapHeight.disabled = layout.mode !== 'fixed-map';
      controller = undefined; updateButtons(false);
      document.title = `${adapter.library} · Mapping apps`;
    }
  }
  suiteStart.addEventListener('click', () => startSuite());
  suiteResume.addEventListener('click', () => startSuite(true));
  async function exportSuite(extension) {
    try {
      const store = await suiteStore(), suite = await store.get(localStorage.getItem(LAST_SUITE_KEY));
      if (!suite) return;
      const records = (await store.records(suite.id)).map(({ result }) => result)
        .filter((result) => result.recordType !== 'completed' || result.suiteAttemptId === suite.attempts?.[result.configurationIndex])
        .sort((a, b) => a.configurationIndex - b.configurationIndex || (a.repetition ?? 0) - (b.repetition ?? 0));
      if (extension === 'csv') download('csv', toCsv(records), 'text/csv;charset=utf-8');
      else download('json', JSON.stringify({ schemaVersion: 10, suiteId: suite.id, config: suite.config,
        resolvedForecast: suite.forecast, counts: suite.counts, status: suite.status,
        completedConfigurations: suite.nextIndex, browserViewport: suite.browserViewport,
        results: records.filter(({ recordType }) => recordType === 'completed'),
        failures: records.filter(({ recordType }) => recordType !== 'completed') }, null, 2), 'application/json');
    } catch (error) { suiteInfo.textContent = 'Export failed: ' + error.message; }
  }
  suiteCsv.addEventListener('click', () => exportSuite('csv'));
  suiteJson.addEventListener('click', () => exportSuite('json'));
  void refreshSuite().then(() => {
    const active = sessionStorage.getItem(ACTIVE_SUITE_KEY);
    if (savedSuite?.id === active && savedSuite.status === 'running') void startSuite(true);
  }).catch((error) => { suiteInfo.textContent = 'Suite storage unavailable: ' + error.message; });

  function download(extension, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${adapter.library.toLowerCase().replaceAll(' ', '-')}-benchmark-${Date.now()}.${extension}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  csv.addEventListener('click', () => download('csv', toCsv(results), 'text/csv;charset=utf-8'));
  json.addEventListener('click', () => download('json', JSON.stringify({ schemaVersion: 10, results, failures }, null, 2), 'application/json'));
  failureCsv.addEventListener('click', () => download('csv', toCsv(failures), 'text/csv;charset=utf-8'));
  clear.addEventListener('click', () => {
    results.length = 0;
    failures.length = 0; failureCount.textContent = 'No failed or aborted trials.';
    tbody.replaceChildren();
    summary.textContent = '';
    progress.textContent = 'Results cleared.';
    updateButtons(false);
  });
}
