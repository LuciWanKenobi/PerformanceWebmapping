# Mapping apps

Four basic, separate vanilla JavaScript apps for the mapping-library comparison described in `Exposé Bachelorarbeit.docx`. No UI framework or TypeScript. Vite only provides the development server and production bundling.

## Run

Use Node.js 24+ and npm (required by the ecCodes WebAssembly decoder and its worker tests). From this folder:

```sh
npm install
npm run dev
```

Start the app and its local raster/CPU services together with:

```powershell
npm run start:all
```

The launcher reads the same development environment files as Vite, starts missing
local services on their configured ports (defaults: COG 8001, WMS 8002, CPU 8004),
and waits for health and cache-isolation checks before reporting readiness. It
reuses healthy services and reports occupied ports, missing Python dependencies
and startup crashes. The app uses port 5173 with strict port selection. Logs are
in `.local-services/`. Keep the launcher terminal open; Ctrl+C stops only the
processes it started. Set the `PYTHON` environment variable to use a specific
Python interpreter. `node start-all.mjs --services-only` starts the data/CPU
services without starting another Vite instance.

If the browser reports `ERR_CONNECTION_REFUSED`, the service at that URL is
unavailable. Check the launcher/logs and the `VITE_COG_SERVER`,
`VITE_WMS_SERVER` and `VITE_METRICS_SERVER` URLs in `.env.local`. Restart
Vite after changing those URLs, or rebuild if using a production preview.
Raster benchmarks and weather previews check their server before loading tiles
and show the missing service URL with startup instructions. CPU sampling is
optional; turn off **Measure system CPU** for a run without the helper.
Install Python dependencies with `python -m pip install -r ../test_data/requirements.txt`.

Open the local URL printed by Vite. The start page links to all four apps:

| App | Path | Source |
| --- | --- | --- |
| MapLibre GL JS | `/maplibre/` | `maplibre/main.js` |
| Mapbox GL JS | `/mapbox/` | `mapbox/main.js` |
| OpenLayers | `/openlayers/` | `openlayers/main.js` |
| Leaflet | `/leaflet/` | `leaflet/main.js` |

Each page loads only its own mapping library. Keep the server running while using the apps; opening the HTML through `file://` will not work. Internet access is needed for basemap tiles. The GL apps also need browser WebGL support.

## Mapbox token

Copy `.env.example` to `.env.local` and enter your own **public** Mapbox token:

```dotenv
VITE_MAPBOX_ACCESS_TOKEN=pk.your_public_token_here
```

Restart Vite after editing the file. For production, set the value before building. The app displays setup instructions if the token is missing. No token is included in this project; the other three apps work without one.

Vite embeds `VITE_` variables in browser code. Never use a secret `sk.` token. Configure any URL restrictions to allow your local or deployed URL. See [Mapbox access tokens](https://docs.mapbox.com/help/dive-deeper/access-tokens/).

## What is included

- An OpenStreetMap raster basemap, centered on Germany, in each app.
- Pan and zoom controls, a reset button, and a sample-station layer toggle.
- The same three GeoJSON points, with clickable temperature popups.
- Plain shared CSS, shared settings, and local sample data.

The station temperatures are **synthetic demonstration data**, not observations. Edit `shared/stations.geojson` to replace them. Edit `shared/config.js` to change the initial view, tile URL, or station styling.

The GL apps use a zoom value one lower than Leaflet and OpenLayers because of their 512px versus 256px world-tile convention. This gives the same initial scale at the same viewport size. Mapbox explicitly uses Mercator. Leaflet uses its default SVG vector renderer; OpenLayers uses its default Canvas vector layer; MapLibre and Mapbox render the point layer using WebGL.

The performance panel benchmarks synthetic points together with local weather rasters and optional time changes, recording scheduling, downloads, server requests and optional system CPU load. Up to 20 maps support synchronized pan and zoom. The benchmark hides the public OSM basemap and uses the controlled local weather services for raster workloads. See the [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

## Local weather data

The scripts in [`../test_data`](../test_data/README.md) convert the downloaded GRIB2 files to numeric COGs and generate PNG tiles. Start `serve_cog.py` (default port 8001) and `serve_wms.py` (port 8002), click **Load weather**, then choose a forecast and delivery mode. All four apps offer **WMS**, **PNG tiles**, **COG (byte ranges)** and **GRIB2 (worker)**. Weather starts off. The ordinary weather preview is hidden during benchmarks; rasters selected in the benchmark panel are measured instead. The catalog includes each variable, forecast time and level.

**COG (byte ranges)** fetches numeric TIFF windows/overviews from the COG server and colors them in the frontend. OpenLayers uses its native GeoTIFF source and WebGL color expression. Leaflet uses canvas grid tiles. MapLibre and Mapbox use a GeoTIFF.js reader and a canvas source, refreshed after pan/zoom or resize, with a maximum canvas size of 1024×1024. Their previous canvas remains visible while the next view loads. Rapid viewport changes are coalesced, with at most one numeric render in flight per GL raster layer. These implementations have different rendering and sampling costs; record the library, mode and viewport when comparing results.

**GRIB2 (worker)** fetches the original decompressed `.grib2` file from port 8001's `/grib2/` route. The page lazily downloads and compiles [ecCodes WebAssembly](https://github.com/meri-imperiumi/eccodes-wasm) once, sharing the compiled `WebAssembly.Module` with every layer worker, including later benchmark trials and time changes. Each worker creates its own decoder instance, memory and filesystem, decodes the selected GRIB message, keeps its numeric grid in worker memory, reprojects and colors it there, then transfers RGBA pixels to the map. Failed shared loads can be retried. The selected GRIB file is downloaded once per layer selection; panning reuses the decoded grid. Removing/changing the layer terminates its worker and rejects pending work without cancelling the shared decoder load for other layers. Leaflet/OpenLayers request 256px tiles; the GL apps request a viewport canvas. The single decoder download is recorded in the window's Resource Timing timeline; workers still report their independent GRIB downloads. Later trials reuse compiled decoder code, while layer data and decoder instances remain independent.

The GRIB decoder supports the supplied DWD CCSDS/AEC compression. Display currently supports regular latitude/longitude grids and rejects other grids or metadata that disagrees with the catalog. Outer `.bz2` compression must be decompressed first. This mode needs a recent browser supporting WebAssembly memory64; a decoder error is shown if initialization fails. The decoder asset is about 39.6 MB before HTTP compression and is fetched only when this mode is used. The catalog is still generated by `grib2_to_cog.py`; the GRIB payload itself is served unchanged and is not converted to TIFF/PNG on the server.

Set `VITE_COG_SERVER` and `VITE_WMS_SERVER` in `.env.local` if the servers use different URLs, then restart Vite. See the data README for installation, conversion, serving and validation commands.

## Performance benchmarking

For comparisons, use the production build (`npm run build`, then `npm run preview`) and open one library at a time. In the **Performance benchmark** panel:

1. Choose **Maps** (1–20), then **Point layers** (0–4) and **Points per layer** (100, 1,000, or 5,000). Every map receives the same selected workload, using its own native instances and cloned point data: up to 20,000 points per map or 400,000 across 20 maps. Dragging or zooming any map synchronizes the others. **Fixed total area** divides the browser viewport among the maps during a benchmark. **Fixed size per map** instead preserves configurable map dimensions and increases the total rendered area; overflow scrolls and some maps can be offscreen. The export records the selected policy, actual per-map sizes and summed pixel areas.
2. For rasters, click **Load raster catalog**, then **Add raster layer** for each variable/level. Add up to eight rasters, choosing WMS, PNG tiles, COG or GRIB2 separately for each row. Remove rows to reduce the workload. Choose the **Initial raster time**, shared by all selected rasters. A raster-only workload uses zero point layers; a points-only workload needs no data server.
3. Optionally enable **Change time during each trial**. Choose 25%, 50% or 75% of the motion path, and update point data, switch raster forecast time, or both. Choose a different **New raster time** when switching rasters. Times are restricted to those available for every selected series; forecast runs and levels are preserved.
4. **Restyle colors at the end of each trial** is enabled by default. At the final Europe overview, benchmark point fills change to purple and WMS/COG/GRIB2 parameters switch to different value-to-color tables. Precomputed PNG tiles retain their fixed colors: PNG-only workloads show **n/a (PNG fixed)**, and mixed workloads report a **partial** restyle covering supported operations only. Disable it to skip this phase. **Restyle ms** shows elapsed time through readiness on every map plus two animation frames.
5. Every trial destroys the entire current map grid and initializes fresh maps before adding benchmark layers. This also applies to the discarded warm-up. **Init ms** shows creation through readiness of the whole fresh grid; initialization happens sequentially at the final grid viewport sizes. Basemap and preview stations start hidden, avoiding public basemap downloads during initialization.
6. Choose motion duration (3, 5, 10, 30, 60 or 120 seconds; default **30 seconds**), repetitions and whether to discard a warm-up, then click **Run benchmark**. All controls are disabled and hidden and the map workspace fills the entire browser content viewport, including its width and height. Map interaction is disabled during the scripted camera path. Press **Escape** to stop. The normal layout and previous control states return after completion, cancellation or failure. Resizing for this layout occurs before initialization and trial timing. The motion duration excludes layer loading, stationary waits during time changes and the final color restyle.

### Automated thesis matrix

Edit [`public/benchmark-config.json`](public/benchmark-config.json), then click **Run configured suite** in any framework's benchmark panel. The file is copied unchanged into the production build; rebuild after editing it when using `npm run preview`. The supplied matrix implements these seven scenes:

| Scene | Raster parameters | Point layers | Layers per map |
| --- | --- | --- | --- |
| I | CAPE | 0 | 1 |
| II A | CAPE | 1 | 2 |
| II B | CAPE, cloud | 0 | 2 |
| III | CAPE, cloud, temperature | 0 | 3 |
| V | CAPE, cloud, humidity, temperature, surface pressure | 0 | 5 |
| VIII | The five above, precipitation, gusts, weather phenomena | 0 | 8 |
| IX | The same eight raster parameters | 1 | 9 |

Every point layer contains 1,000 synthetic points. The four frameworks, `xyz` (precomputed PNG), `cog` and `grib` paths, map counts `[1, 2, 5, 10, 20]`, five repetitions and one discarded warm-up yield **420 configurations, 2,100 measured trials and 420 discarded warm-ups**. The single-map series contributes 420 measured trials; the other four map counts contribute 1,680. Increasing scene complexity also changes parameter composition; this is not an isolated identical-layer scaling experiment. The default `fixed-total` layout fills one browser viewport and divides that area among the synchronized maps. The basemap is disabled by the existing trial protocol.

Configuration fields control framework/path order, map counts, scenes, motion duration, repetitions, warm-up, color restyling, CPU/server/memory instrumentation, layout and optional time changes. `parameters` matches exact catalog variables, level types, numeric levels and message numbers: CAPE `cape_con`, cloud `clct`, humidity `relhum_2m`, temperature `t_2m`, **surface pressure `ps`**, precipitation `tot_prec`, gusts `vmax_10m`, and weather `ww`. Every scene prohibits duplicate parameter keys. Missing or ambiguous layers are errors; they are never replaced by another parameter. Prepare all eight parameters and the required precomputed PNG coverage before starting. A Mapbox public token must be configured when Mapbox is included.

`forecast.run: null` selects the newest run common to all used parameters; `initialTime: null` selects its earliest common forecast time. Both are resolved once and pinned for the whole suite. Set explicit strings to fix a particular run/time. For a timestep, set `timeChange` to `{ "fraction": 0.5, "points": true, "rasters": true }`; `forecast.nextTime: null` then selects the next common time. A scene without points skips the point update. All selected rasters retain the same run, variable, level and message.

The suite runs one configuration at a time and navigates to the next framework **in the same tab**. Keep the tab visible and the browser viewport/DPR unchanged. Results are written to IndexedDB after every completed measured repetition, before the next repetition starts; each fully completed configuration gets a checkpoint. The browser title shows configuration progress while the controls are hidden. Escape, visibility changes, resize, resource failures or context loss pause the suite. Click **Resume saved suite** to repeat the interrupted configuration, including its warm-up; earlier completed configurations remain saved. Repeated attempts are identified, and superseded partial results are omitted from exported successful measurements. A reload during an active suite resumes the saved configuration. An app that cannot start must be repaired before resuming from another working framework page.

**Export suite JSON/CSV** reads the saved suite across framework navigation, including scene/configuration IDs, attempt IDs and failure diagnostics. JSON includes the config, resolved forecast, viewport, planned counts, completion status and raw measurements; CSV includes aggregate metrics and structured metadata. Manual exports still cover the current tab's manual trials. Saved suites remain in this browser and origin until browser site data is cleared; use the same host/port for resume and export. Starting a new suite creates a new ID and makes that suite the active export target. Add `wms` to `rasterPaths` for a separately named optional comparison, or use a reduced scene/map/framework list for pilots; the planned counts are recalculated from the supplied config.

**Measure system CPU** is enabled by default. Start the local helper in another terminal from the project root:

```powershell
python test_data/serve_metrics.py
```

The helper requires `psutil`, included in `test_data/requirements.txt`, and defaults to port 8004. Set `VITE_METRICS_SERVER` in `.env.local` to change its URL. If unavailable or disabled, CPU metrics remain null rather than failing the benchmark. System CPU covers the **whole machine**. The updated helper additionally groups all running browser renderer, GPU and other processes, COG/GRIB servers, WMS/PNG servers and the metrics helper. It exports process CPU counter deltas and 250 ms CPU/RSS samples. Per-role CPU uses 100% per logical core; the browser/server total columns divide by the machine's logical-core count. Processes starting/exiting during a window produce partial coverage and null mean CPU for that group. Browser totals include other browser tabs/windows, and summed RSS can double-count shared pages and excludes VRAM. No raw command lines are exported. System mean utilization uses OS counter deltas; peak, p95 and last are sampled. Sampling windows can straddle trial boundaries, and HTTP snapshot latency adds a small offset; `systemCpuWindowMs` records the actual counter window. Restart the helper after updating.

Window JS heap and known raster allocations are sampled every 100 ms. GRIB workers report retained grid bytes and current WASM memory capacity every 250 ms and after decoding/rendering. Frontend COG windows and GL/Leaflet canvas backing pixels are separate allocation observations. These values can overlap; they are not summed into a fictitious total. Shorter allocation peaks, native library caches and worker heaps beyond the retained numeric grids are not fully observed. Exact GPU allocation bytes are exported as null with an unavailable status.

The optional **Browser memory estimate** uses `performance.measureUserAgentSpecificMemory` where supported, including related workers. It is disabled by default because it can trigger garbage collection and alter a measurement. Set `VITE_ISOLATE_MEMORY=true` in `.env.local` and restart Vite/preview to serve COOP/COEP headers. Data servers expose CORS/CORP; other external resources must also permit isolated loading. For deployed static builds the host must provide these headers. Estimates are sampled at most once per second, never concurrently; pending/unsupported measurements remain null. Exported measurement policy records whether this option was enabled. Compare runs with the same instrumentation policy.

Restart the updated COG and WMS servers to enable `/metrics` counters and `Timing-Allow-Origin` headers. Client Resource Timing measures completed raster fetches plus dynamically loaded code and decoder assets, including downloads in instrumented GRIB workers. **Fetched MiB** is decoded response-body size, including cache hits. **Transferred MiB** uses Resource Timing transfer size (encoded body plus HTTP response headers); this is not TCP/TLS packet accounting. Cache hits have zero transfer but nonzero fetched bodies. A response without exposed sizes is recorded as unknown, and aggregate byte totals become null; `knownTransferBytes` and `unknownSizeRequestCount` show partial coverage. In-memory COG block reuse and library tile caching may produce no new resource fetch at all.

The local servers separately count received raster requests, GETs, Range GETs, completed responses, status codes and successfully written response-body bytes. These counters exclude catalog, capabilities, health and metric polling requests, but include raster HEAD/OPTIONS, revalidations and failed requests. Updated servers isolate deltas to a private trial scope, so unrelated clients are excluded. Old servers expose their all-client fallback explicitly in `serverMetricsScope`; restart them to enable isolation. HTTP failures, incomplete requests and aborted/truncated successful response bodies have separate counts. A restarted/unavailable server produces null totals. Browser and server counts have different coverage: cache hits can avoid requests, preflights/aborts can appear only on the server, and uninstrumented library workers may be absent from browser timings. Server-written body bytes exclude headers and cannot prove every written byte reached the client. Failure/abort diagnostics are exported separately from successful trial rows; failures before trial timing starts have configuration-level diagnostics in suite exports.

Each trial uses seeded GeoJSON data (seed 42) uniformly distributed across a continental Europe bounding box: longitude **−12° to 35°**, latitude **34° to 72°**. This synthetic workload includes water and neighboring non-EU areas; it does not clip points to political borders. Time-change seed 43 uses the same bounds and counts.

The shared camera path (`europe-tour-v1`) starts and ends at a Europe overview, visits Madrid, Paris, Berlin, Helsinki, Bucharest and Rome, and repeatedly zooms between overview and city views. Zoom spans **4–12** in the 256-pixel convention (GL zoom 3–11). Smooth interpolation eases both pan and zoom at each waypoint, including continuity around optional timestep pauses. The same path and progress apply to every map and library. Each trial receives new native map instances; each logical layer has its own native layer/source or Leaflet GeoJSON group. The original sample stations, ordinary weather preview and basemap are hidden during the batch. Dataset generation and final cleanup occur outside the measured trial. The app adds all selected layers, waits for raster completion and native map readiness, moves the camera, and waits for readiness again. The original camera and preview layers are restored on completion, cancellation, or failure.

Exports include `pointRegion`, `pointBounds`, `cameraPath`, `cameraZoomRange` and `cameraWaypoints` so these workloads can be distinguished from older Germany-only runs. Compare runs with matching bounds, path and duration.

During a time change, the camera pauses at the selected path position until the old view has settled. A separate timed operation then applies new data and waits for readiness before motion resumes along the remaining path. Point data uses seed 43 with unchanged feature IDs and counts but new positions, representing a deterministic synthetic timestep rather than live observations. GL uses `setData`; OpenLayers replaces features in existing vector sources; Leaflet replaces features in existing GeoJSON groups. Raster time changes remove the old overlays and create the selected new forecasts using the same delivery modes, including fresh workers for GRIB2. This measures overlay replacement, not an optimized persistent-worker decoder update. The requested motion duration excludes these stationary waits.

Initial readiness includes raster fetch/decode/color work on every map. Leaflet waits for selected grid layers to finish loading, then animation-frame fences; OpenLayers waits for GeoTIFF/worker initialization and `rendercomplete`; GL canvas overlays wait for their current numeric render and then `idle`, while PNG/WMS sources use `idle`. These are adapter readiness signals, not guarantees about physically presented GPU frames. Camera motion, point updates and raster time changes apply to every map; readiness waits for the slowest map.

Each map now independently records its completion time for initial loading, time changes and supported color restyles. `mapReadySpreadMs` is last minus first map ready, with per-phase equivalents; a single map has zero spread and unavailable/disabled phases have null. Per-map `rasterReadyMs` is elapsed time through raster completion, and `nativeReadyWaitMs` is the subsequent native readiness/frame wait. These quantify differing adapter completion signals, not visible GPU presentation timestamps.

Stage timing records GRIB decode, numeric projection/coloring, frontend COG combined read/decode, canvas pixel copies and shared decoder compilation. WMS supplies actual server render duration using `Server-Timing`. `dataFetchActiveMs` is the union of observed data-request intervals, including server waits; `dataBodyTransferMs` sums exposed response-body intervals. COG's combined read/decode can overlap these network intervals. Concurrent maps and stages overlap, so their summed work durations must not be added to infer trial wall time. Native OpenLayers GeoTIFF decoding, native PNG decoding and GPU execution remain unavailable and are explicitly documented in coverage metadata. The native readiness wait is the rendering completion proxy. Streaming decoder compilation can overlap its asset download.

Raster layers use independent native sources, COG readers and GRIB workers, with a fresh URL request key for every map and layer load, including warm-up, repetitions and time changes. Updated raster servers return `Cache-Control: no-store`, skip TIFF/GRIB conditional cache reuse, and render WMS requests without reading or writing the shared output cache. **PNG tiles are strictly precomputed files in `wms_tiles/`.** Each map makes its own HTTP request and the server opens the file independently; it never generates or recolors an XYZ response. Missing files return 404 with a generation hint. Prepare every forecast, region and requested native zoom before benchmarking. OS file caching is outside this HTTP isolation. Restart both raster servers after updating; the benchmark checks their cache-isolation capability before running rasters. A reader may reuse its own blocks/tiles within the same map and load. OS disk caches, library code and decoder/WASM assets are outside this isolation, so these results do not claim a physically cold disk or cold code cache.

Raster source resolution is capped independently of camera zoom. `raster-resolution.js` estimates the finest projected cell spacing from the catalog bounds and grid dimensions, then rounds the corresponding 256px Web Mercator tile zoom up to retain source detail. The supplied 1377×657 ICON-EU grid has 0.0625° cells and a **native tile ceiling of zoom 5**. The camera can still follow its full zoom 4–12 path, and points continue rendering at the requested zoom. Above the raster ceiling, the same map enlarges its native tiles instead of requesting additional child zoom levels. This is overzooming; it does not add weather detail.

Leaflet uses `maxNativeZoom` for WMS, PNG, COG and GRIB tile layers, with a separate display `maxZoom`. GL WMS/PNG sources use `maxzoom` while leaving the layer visible beyond that zoom. OpenLayers WMS/PNG/GRIB sources use capped tile grids; its GeoTIFF source retains its own native grid/overview resolutions. Numeric GL COG/GRIB canvases use stable blocks aligned to native tiles at deep zoom and reuse their own pixels until the view leaves that block. An out-of-bounds view is hidden without a new read; returning reloads it. All reuse stays within the current map/layer load. New maps, trials and forecast changes retain independent readers, URLs and workers.

Exports include `rasterResolutionPolicy` and `nativeTileZoom` per raster. This policy changes the network/rendering workload, so compare results only when the resolution policy matches. High-zoom request/load churn is reduced, but connection failures, renderer errors and readiness timeouts still discard an incomplete trial. GL errors now preserve their underlying message in the benchmark panel. Native resolution metadata is a derived estimate, not a promise that a browser can render arbitrarily large workloads.

Native options: [Leaflet maxNativeZoom](https://leafletjs.com/reference.html#gridlayer-maxnativezoom), [MapLibre source maxzoom and overzoom](https://maplibre.org/maplibre-style-spec/sources/#raster), and [OpenLayers XYZ tile grids](https://openlayers.org/en/latest/apidoc/module-ol_tilegrid.html).

Only the first map shows the ordinary basemap outside a benchmark, to avoid multiplying public tile-server traffic; all basemaps are hidden during trials. Each GL map needs a WebGL context. Browsers/hardware may not support 20 simultaneous Mapbox/MapLibre contexts; context loss or setup failure is reported, and newly added maps are cleaned up. GRIB workloads create a worker/decoder per raster per map and can consume substantial memory. Choose a lower map count if the renderer cannot support the requested grid.

Keep the tab visible, avoid other interactions, and keep the viewport unchanged. Hiding the tab or resizing the window aborts the current trial. **Stop** also discards the incomplete trial and retains completed ones. A rendering timeout or GL map error fails the current trial instead of recording a successful result.

The final color restyle replaces each parameter's value-to-color table. The shared definitions in `../test_data/color_tables.json` contain separate alternative tables for temperature, cloud cover, pressure, humidity, CAPE, precipitation, wind and weather codes, with aliases and a fallback for other parameters. These are benchmark palettes, not standardized weather-product legends. Existing value ranges, units, resampling and nodata masking remain fixed. COG readers recolor numeric windows, GRIB workers recolor their retained decoded grids, and OpenLayers COG changes its WebGL color expression. WMS fetches images rendered by the server using the new table; its latency includes server rendering and network transfer. Precomputed XYZ PNGs cannot replace their value-to-color table: their URLs, sources and pixels remain unchanged, and no restyle requests are sent. No fallback to WMS or runtime generation is used. PNG-only restyle times are null and status is `unsupported`. Mixed workloads report `partial`, time the supported point/WMS/COG/GRIB operations, and export applied/skipped layer-instance counts and per-layer support. Table-specific WMS cache keys and unique per-map request URLs preserve WMS rendering and HTTP isolation. Numeric layers keep their readers/workers and private block caches; uncached COG windows can still require range requests. Restart the WMS server after updating or editing color tables; a preflight check rejects mismatched tables before timing. Native readiness followed by two animation frames is a presentation proxy, not an exact GPU/pixel timestamp. Warm-up trials also restyle, then all benchmark layers are removed before the next trial. Stop, errors and cancellation discard an incomplete restyle trial and restore the original view.

Initialization metrics are separate from `trialMs`, layer Ready ms, motion FPS and trial CPU/network/long-task totals. Fresh native maps reset their per-map sources and rendering state; browser/module/decoder asset caches, shared library worker pools and OS disk caches can remain warm. A fresh map is not a fresh browser process. Error listeners are reattached to replacement maps. If initialization is stopped or fails, unfinished maps and empty panes are removed; completed replacements are retained, or one new preview map is recovered when none remain. The map-count selector follows any reduced grid, and no incomplete trial is recorded. Original view/layer visibility and weather preview are restored on the replacement maps at the end.

The table shows individual trials; the summary shows medians for the last completed batch. **Export CSV** includes per-trial metrics and metadata. **Export JSON** additionally includes raw animation-frame intervals. Results stay in memory in the current tab until you clear them or reload; export each library's results to compare them externally.

| Metric | Meaning and limits |
| --- | --- |
| `mapInitMs` | Fresh native map construction/configuration through readiness, final resize/readiness and two animation frames for the whole grid. Measured before adding benchmark point/raster layers; includes controls and the hidden preview station source/layer setup. Constructors are sequential, so this is a total grid time. |
| `mapDestroyMs` | Removal of all old native maps, their listeners and DOM surfaces, followed by two animation frames to allow disposal/context cleanup. It does not force garbage collection or prove GPU memory was reclaimed. |
| `mapResetMs` | Combined map destruction and fresh initialization time. |
| `initializedMapCount`, `mapInitializations` | Successful replacement count and per-map construction-through-native-readiness timings in initialization order. The whole-grid metric also includes shared layout, final readiness and frame waits. |
| `submitMs` | Synchronous time creating native point sources/layers and raster overlays. Includes feature conversion and insertion; excludes synthetic data generation and asynchronous decoding. |
| `layerReadyMs` | Insertion through completion of all selected rasters and the adapter's native readiness signal, including `submitMs`. Point-only GL: `idle`; OpenLayers: `rendercomplete`; Leaflet SVG: two animation-frame callbacks after its synchronous update. |
| `firstMapReadyMs`, `lastMapReadyMs`, `mapReadySpreadMs`, `mapReadiness` | Independent per-map completion times and first-to-last spread. Also exported with `timeChange` and `colorRestyle` prefixes. Entries contain raster completion and subsequent native readiness/frame waits. |
| `dataFetchActiveMs`, `dataBodyTransferMs`, `decodeMs`, `readDecodeMs`, `projectColorMs`, `uploadMs`, `decoderCompileMs`, `serverRenderMs` | Observed network active/transfer durations, GRIB decode, COG combined read/decode, projection/coloring, frontend canvas copy, shared decoder compilation and WMS server rendering. Null for unobserved/unsupported stages. Concurrent work totals overlap. JSON includes raw stage events and phase totals. |
| `timeChangeSubmitMs`, `timeChangeReadyMs` | Synchronous data replacement, and replacement through readiness at the fixed camera view. Null when time changes are disabled. Includes worker startup/fetch/decode for replacement GRIB layers. |
| `colorRestyleSubmitMs`, `colorRestyleReadyMs` | Synchronous point/raster style submission, and color-table replacement through recoloring, tile fetches, all-map native readiness and two animation frames at the final fixed camera view. Null when disabled or unsupported (PNG-only). Mixed workloads are marked partial and time supported operations only. |
| `colorRestyleStatus`, `colorRestyleUnsupportedReason`, `colorRestyleAppliedPointLayerInstances`, `colorRestyleAppliedRasterLayerInstances`, `colorRestyleSkippedRasterLayerInstances` | Restyle status: disabled, unsupported, partial or applied. PNGs have fixed colors; skipped PNG instances are counted across every map, with per-layer support/method in `colorRestyleLayers`. |
| `colorRestyleRafFps`, `colorRestyleP95FrameMs`, etc. | Separate callback statistics during the stationary restyle; excluded from motion FPS and lows. |
| `colorRestyleRequestCount`, `colorRestyleTransferBytes`, `colorRestyleFetchedBodyBytes`, `colorRestyleNetwork` | Completed fetches initiated during the timed restyle. Includes newly rendered WMS images and any COG range reads; observed entries remain separate from timestep requests. |
| `preChangeSettleMs` | Time to finish the old raster view at the change position, recorded separately from replacement latency. |
| `motionRasterCoveragePercent`, `motionWorstMapCoveragePercent` | Time-weighted mean usable raster coverage across applicable map/layer instances during motion, and the lowest per-map time-weighted mean. Coverage is the union of native rendered/renderable tile or presented numeric-canvas footprints intersecting the current view and catalog data extent, in Web Mercator. Transparent/nodata values count as loaded, and available lower-resolution fallback counts as usable coverage; this does not measure target-resolution detail or physical GPU presentation. |
| `motionRasterIncompleteMs`, `motionRasterLongestGapMs`, `motionAllMapsCompletePercent` | Motion time with any expected layer below 99.9% coverage, longest observed continuous gap, and percentage of observed applicable motion time when all expected layers on all maps meet the threshold. Initial loading, timestep waits and final catch-up are excluded. Gaps do not bridge stationary pauses. |
| `postMotionRasterCatchUpMs`, `postMotionSettleMs`, `postMotionMapReadiness`, `postMotionMapReadySpreadMs` | Final camera-stop through all-map raster and native readiness. The raster catch-up field is null for point-only trials; total settle and independent per-map completion/spread are also exported. The wait is included in `trialMs` and excluded from motion frame statistics. |
| `motionMapCoverage`, `motionLayerCoverage` | Per-map and logical layer-slot summaries across both forecast times: coverage, complete percentage, incomplete/longest-gap time, expected/observed/unknown time. Slots retain their identity when the forecast changes. |
| `motionCoverageObservedMs`, `motionCoverageUnknownMs`, `motionNoRasterExpectedMs`, `motionRasterCoverageStatus` | Measurement availability: unsupported native hooks remain unknown, and views outside every data footprint are separate from loading gaps. Percentages use observed applicable time; check coverage status and observed/unknown times before comparing runs. |
| `motionCoverageSamplePeriodMs`, `motionCoverageMaxSampleIntervalMs`, `motionCoverageSamplingMs`, `motionCoverageSamples` | Sampling uses the existing camera rAF loop, with left-held 100 ms observations weighted by actual elapsed time. Delayed callbacks increase the actual interval. JSON includes the coverage/worst-map/all-map timeline; CSV omits that raw array. Sub-sample gaps can be missed. Sampler time is exported; additional native event/draw bookkeeping is not separately timed. Both contribute to measured runtime. |
| `motionRasterSupersededWorkCount`, `rasterSupersededWorkCount`, `rasterWorkCounters` | Observed superseded work during motion, and from layer insertion through final catch-up, including stationary timestep work. Detailed counters distinguish GL discarded numeric renders, GL aborted native tiles, Leaflet unfinished tile unloads and OpenLayers off-view successful tile completions. These units differ and omit unobservable native work; they are diagnostic counts, not an equivalent-work ranking. |
| `beforeChange*`, `afterChange*` | Motion frame statistics before and after the timestep. These cover different sections of the camera path, so a difference alone does not establish that the new data caused it. Compare otherwise identical batches as well. |
| `timeChangeRafFps`, `timeChangeP95FrameMs`, etc. | Animation-callback cadence during the stationary update, including main-thread stalls from data insertion. These callbacks do not move the camera. |
| `rafFps` | Animation-callback intervals per second during the scripted motion. Measures main-thread scheduling cadence, not actual presented GPU frames. |
| `fpsLow5Percent`, `fpsLow1Percent` | 1000 divided by the mean of the slowest 5% or 1% of frame intervals, with the count rounded up. Includes stalls. `low5PercentSamples`/`low1PercentSamples` disclose the sample counts; a 1% low from a short run may reflect only one or two frames. Also exported for before/after/change phases. |
| `meanFrameMs`, `medianFrameMs`, `p95FrameMs`, `p99FrameMs`, `maxFrameMs` | Statistics over those callback intervals. Percentiles use the nearest-rank method. |
| `framesOver33Ms`, `framesOver50Ms`, `framesOver100Ms` | Callback intervals above 1000/30, 50 and 100 ms; not an estimate of dropped GPU frames. |
| `longTaskCount`, `longTaskMs` | Browser Long Tasks API entries overlapping the trial, including layer insertion and final settling; duration is clipped to the trial window. Null if unsupported. Does not measure worker work or CPU utilization. |
| `longTaskBlockingMs`, `mainThreadLongTaskBusyPercent` | Time within long tasks beyond their first 50 ms, and the percentage of trial time occupied by long tasks. Busy percentage is a main-thread scheduling indicator, not full CPU utilization; shorter tasks and worker work are omitted. |
| `systemCpuMeanPercent`, `systemCpuPeakPercent`, `systemCpuP95Percent`, `systemCpuLastPercent` | Optional whole-machine CPU utilization from the local helper. Mean uses counter deltas; peak/p95/last are sampled. `systemCpuSampleMeanPercent`, sample count, period and logical core count are also exported. |
| `browserCpuMeanPercent`, `serverCpuMeanPercent`, `processMetrics`, `browserRssPeakBytes` | Optional browser/server CPU totals normalized to all cores, per-role CPU/RSS coverage and peaks, and sampled simultaneous aggregate browser RSS peak. Includes all running browser processes; not isolated to this tab. |
| `requestCount`, `dataRequestCount`, `decoderRequestCount`, `codeRequestCount` | Completed browser Resource Timing entries observed for the workload; the latter fields break down raster data, WASM and JavaScript. Requests that started before the trial are excluded, even if they finished inside it. |
| `fetchedBodyBytes`, `encodedBodyBytes`, `transferBytes`, `cacheHitCount` | Decoded bodies (including caches), encoded bodies, network transfers including response headers, and Resource Timing cache indicators. Unknown sizes are null rather than zero. |
| `requestMeanMs`, `requestP95Ms`, `requestMaxMs`, `ttfbMeanMs`, `httpErrorCount` | Fetch durations, exposed time to first byte, and observed HTTP 4xx/5xx responses. HTTP status visibility depends on the browser. Overlapping request durations must not be summed as trial wall time. |
| `timeChangeRequestCount`, `timeChangeTransferBytes`, `timeChangeFetchedBodyBytes`, `timeChangeNetwork` | Fetches initiated within the timed stationary timestep update, plus full phase network statistics. |
| `serverRequestCount`, `serverGetRequestCount`, `serverRangeGetRequestCount`, `serverBodyBytesSent` | Raster-server counter deltas, including actual requests received even when absent from browser timings. `serverCompletedRequestCount`, response-status breakdown and availability status are also exported. |
| `serverMetricsScope`, `serverFailedResponseCount`, `serverAbortedRequestCount`, `serverIncompleteRequestCount` | Trial-specific scope or explicit fallback, HTTP error counts, truncated successful bodies, and requests still incomplete at the final snapshot. Aborts after the snapshot can be missed. |
| `serverClientDisconnectedRequestCount`, `serverTruncatedResponseCount`, `serverHandlerErrorCount`, `serverNoResponseCount` | Observed socket disconnects, advertised bodies that were not completely written, unexpected handler failures, and requests ending without an HTTP status. These categories can overlap. Socket aborts preserve their original status and do not generate a second HTTP 500. `serverFailedResponseCount` counts actual HTTP 4xx/5xx; status 0 is separate. Server disconnects do not establish cancellation intent; renderer-confirmed superseded work remains in browser counters. |
| `serverConnectionPolicies`, `serverDisconnectAccountingStatus` | Per-server transport settings and disconnect-accounting coverage. Updated servers use HTTP/1.1 reuse, a 256-connection accept backlog, TCP_NODELAY and a 30-second socket timeout. Persistent connections preserve independent map/layer file reads and HTTP cache isolation. Restart old raster services before running; the launcher and benchmark reject stale capabilities. Genuine fetch failures and missing prepared tiles still invalidate a trial; explicit cancellation/supersession is recorded separately. |
| `heapBeforeBytes`, `heapAfterBytes`, `heapDeltaBytes` | Optional, approximate `performance.memory` readings before insertion and after motion/settling. Null if unavailable. Negative deltas are possible after garbage collection. Excludes GPU allocations and may omit worker heaps; not total memory usage. |
| `heapPeakBytes`, `workerGridPeakBytes`, `wasmCapacityPeakBytes`, `cogWindowPeakBytes`, `canvasPixelPeakBytes`, `gribWorkerPeakCount` | Sampled peaks of separate known allocations, not a total memory balance. Period/count and raw JSON samples expose sampling coverage. |
| `userAgentMemoryPeakBytes`, `userAgentMemoryStatus`, `gpuMemoryBytes`, `gpuMemoryStatus` | Optional sampled browser estimate and availability; exact GPU bytes remain null. |
| `viewportLayout`, `totalViewportCssPixels`, `totalViewportDevicePixels` | Layout policy and summed map surface areas; the device-pixel field is CSS area × DPR², not GPU allocation size. |
| `trialMs` | Total insertion, readiness waits, motion, optional time change and optional color restyle. Includes progress/frame fences between phases. |

Schema-version **10** retains the previous metrics and metadata and adds motion raster coverage, loading gaps, per-map/layer coverage, superseded-work counters and explicit final catch-up readiness. Coverage uses version-specific native tile hooks for the pinned mapping packages; revalidate these integrations when upgrading libraries. Unsupported hooks return null rather than full coverage. The fixed camera timeline is unchanged; no automatic waypoint pauses or raster preloading are added. Suite records additionally identify scene, framework/path, configuration and attempt. Frame cadence still measures the shared browser window, not separate per-map GPU FPS. JSON includes raw motion/change/restyle intervals, coverage observations, sanitized request timings, stage events, memory and process/system CPU samples, plus failure diagnostics. CSV includes aggregate metrics and structured metadata, omitting the raw sample arrays. No access tokens, request keys, private request scopes, raw process command lines or resource URLs are exported.

Use the same browser, hardware, window size, device pixel ratio, and workload across apps. Close developer tools and other busy tabs. Reload between batches for cleaner heap comparisons; retained results and library caches also consume memory. Repeat measurements and examine variability. The harness itself has overhead, and a high rAF rate alone does not prove that the map rendered every requested view. These measurements do not replace a browser profiler for GPU, CPU, worker, or total-memory analysis.

Implementation: `shared/benchmark/runner.js` holds the common protocol; the adapter files implement native point operations; `raster-workload.js` groups forecasts and manages multiple overlays through the weather adapters. `data.js`, `stats.js`, and `panel.js` hold the points, statistics/export, and UI. Run `npm test` for deterministic workloads, mixed/raster-only trials, timestep replacement, fresh map initialization/destruction/recovery, final color restyles, readiness, viewport coalescing, export, cancellation and cleanup checks.

References: [requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame), [Long Tasks](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongTaskTiming), [Resource Timing](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming), [Timing-Allow-Origin](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Timing-Allow-Origin), [psutil CPU counters](https://psutil.readthedocs.io/stable/#psutil.cpu_times), and [performance.memory limitations](https://developer.mozilla.org/en-US/docs/Web/API/Performance/memory).

## Build

```sh
npm run build
npm run preview
```

The production files are written to `dist/`. All four pages are included. `npm run preview` serves that build locally. The dependency versions are pinned in `package.json` and the resolved dependency tree is recorded in `package-lock.json`; use `npm ci` for subsequent reproducible installs.

## Official examples

- [MapLibre raster source](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-raster-tile-source/)
- [Mapbox basic map](https://docs.mapbox.com/mapbox-gl-js/example/simple-map/)
- [OpenLayers quick start](https://openlayers.org/doc/quickstart.html)
- [Leaflet quick start](https://leafletjs.com/examples/quick-start/)
