# Local weather rasters

Run these commands from the project root with Python 3.11+. All default data paths
are relative to the scripts, so the tools also work from another working directory.

```powershell
python -m pip install -r test_data/requirements.txt
python test_data/grib2_to_cog.py
python test_data/generate_wms_tiles.py
```

Start each server in a separate terminal and leave it running:

```powershell
python test_data/serve_cog.py
```

```powershell
python test_data/serve_wms.py
```

For optional system/process CPU and process RAM measurements, start the helper in another terminal:

```powershell
python test_data/serve_metrics.py
```

It uses `psutil` to sample system utilization every 250 ms on port 8004. The
benchmark reads CPU counters before/after each trial and exports mean, peak,
p95, last sample and raw samples. This includes other applications and local
servers, not just the test tab. CPU values are n/a if the helper is not running.
The updated helper also groups all running browser renderer, GPU and other
processes separately from COG/GRIB and WMS/PNG servers. CPU counter deltas and
250 ms RSS/CPU samples are exported without raw command lines. Per-role CPU
uses 100% per logical core; browser/server totals are normalized to all cores.
Processes starting/exiting produce partial counter coverage. Summed RSS can
double-count shared pages and excludes GPU VRAM. Restart the helper after updating.

Start the app in a third terminal:

```powershell
cd map-apps
npm run dev
```

Open any mapping app, click **Load weather**, select a forecast, and choose
**WMS**, **PNG tiles**, **COG (byte ranges)** or **GRIB2 (worker)**. All four apps
can read numeric TIFFs through ranges and color them in the frontend. The GRIB2
mode decodes and colors the original file in a dedicated JavaScript worker.
Weather starts off. Its ordinary preview is hidden during benchmarks; use
**Load raster catalog** and **Add raster layer** in the performance panel to
benchmark multiple rasters together with points and optional forecast-time changes.

## Files and endpoints

| Tool | Input | Output / endpoint |
| --- | --- | --- |
| `grib2_to_cog.py` | `grib2/**/*.grib2`, or `.grib2.bz2` | `cog/<relative-input-path>.tif`, `cog/catalog.json` |
| `serve_cog.py` | `cog/`, `grib2/` | `http://127.0.0.1:8001/catalog.json`, `/cog/<relative-path>.tif`, `/grib2/<relative-path>.grib2` |
| `generate_wms_tiles.py` | COG catalog and rasters | `wms_tiles/<layer-id>/<cache-key>/<z>/<x>/<y>.png`, `tiles.json` |
| `serve_wms.py` | COGs for WMS; precomputed PNG files for XYZ | `http://127.0.0.1:8002/wms`, `/catalog.json`, `/tiles/<layer-id>/<z>/<x>/<y>.png` |
| `serve_metrics.py` | OS system/process CPU and process RSS | `http://127.0.0.1:8004/cpu`, `/cpu?since=<monotonic-ms>` |

Each GRIB message becomes a separate single-band Float32 COG, retaining the run
directory, geographic cell centres, original units, level and valid/reference
times. Multi-message files get `_band0001`, `_band0002`, etc. Temperature remains
Kelvin and pressure remains Pa. Missing cells use `-9999`. ecCodes handles the
CCSDS compression in the supplied DWD files; it avoids requiring a GDAL build
with a GRIB/libaec decoder.

The converter supports **regular latitude/longitude (`regular_ll`) grids**.
Unstructured ICON-global, rotated or dateline-crossing grids need remapping first
and produce a clear error. For web display, the geographic grid coordinates are
written as EPSG:4326; the GRIB spherical earth definition is not retained as a
custom browser projection. The supplied ICON-EU grid needs no interpolation at
conversion time. Rendering PNGs reprojects to the requested map grid.

The [GDAL COG driver](https://gdal.org/en/stable/drivers/raster/cog.html) writes
256×256 internal tiles, DEFLATE compression and internal reduced-resolution
overviews. Continuous-variable overviews use averages; weather-code (`ww`)
overviews use nearest neighbours. Full-resolution values are preserved as
Float32. Outputs are written atomically and existing matching outputs are reused.
If an input or conversion setting changed, rerun with `--overwrite`. Old files
remain on disk, but the catalog only advertises the current input scan. Failed
inputs are recorded in the catalog and cause exit code 1.

## COG byte ranges

The COG server supports GET, HEAD, OPTIONS, `Accept-Ranges: bytes`, single-range
206 responses, suffix/open-ended ranges, `Content-Range`, and 416 for unsatisfiable
ranges. Multi-range requests receive the whole file (200); clients should use
single ranges. `If-Range` can validate a range using the ETag or Last-Modified
value; `If-None-Match` supports exact ETags or `*`. HEAD reports whole-file
metadata. The server streams only the requested bytes and does not gzip TIFFs.
CORS allows local Vite apps to fetch ranges and exposes the response headers to
JavaScript. The standalone COG server uses only Python's standard library.

Both raster servers send `Timing-Allow-Origin: *` so browser Resource Timing can
expose transfer sizes across ports. Their `/metrics` endpoints report cumulative
raster requests received, GETs, range GETs, completed response statuses and
successfully written body bytes. They exclude metric polling, catalog, health
and capabilities routes. HEAD/OPTIONS count as requests, with no body bytes;
304 revalidation responses also send no body. Counters are thread-safe, scoped
to one server instance, and reset on restart. The benchmark adds a private
`_benchmark_scope` to data URLs and reads `/metrics?scope=...` snapshots so unrelated
clients are excluded. Aggregate `/metrics` remains available. Scope histories
are bounded to the latest 512 scopes. Failures, incomplete requests and truncated
successful response bodies are counted separately. WMS exposes render duration
through `Server-Timing`; CORS, CORP and Timing-Allow-Origin expose it to local apps
and support their optional cross-origin-isolated memory mode. Body bytes exclude
HTTP headers and are server-written bytes rather than guaranteed client receipts.
Restart both data servers after updating these helpers.

The local services use HTTP/1.1 persistent connections with explicit response
lengths, a 256-connection accept backlog, TCP_NODELAY and a 30-second socket
timeout. Connection reuse does not share map sources, readers or cached raster
data: isolated requests still open/read their own prepared files and use
`Cache-Control: no-store`. `/metrics` exports this `connectionPolicy`; the app and
launcher reject older raster services until they are restarted.

Metrics schema 2 distinguishes `clientDisconnectedRequestCount`,
`truncatedResponseCount` and `handlerErrorCount`. Windows connection aborts
(including WinError 10053), resets and broken pipes close the connection without
writing a second response or inventing HTTP 500. A disconnect before any response
has status `0` (no HTTP status), while a partially sent response retains its
original status. HTTP 4xx/5xx remain actual error responses. Unexpected server
errors after headers close the incomplete body and increment handler-error
counters. `completedRequestCount` counts finished request handlers, including
errors and disconnects; `abortedRequestCount` includes detected disconnects and
truncated bodies. These categories can overlap. Body bytes count completed
server writes and can undercount a partially completed socket write.

The server cannot infer whether a client disconnect was an intentional
supersession, a navigation or a transport failure. Browser renderer-confirmed
tile cancellations stay in separate superseded-work counters. Genuine fetch
failures still invalidate the trial. Missing prepared GL tiles also explicitly
fail the benchmark, even when a native renderer would otherwise hide a 404 and
fall back to another zoom. No automatic retries are added.

Example using the supplied dataset:

```powershell
$url = 'http://127.0.0.1:8001/cog/2026100500/icon-eu_europe_regular-lat-lon_single-level_2026100500_003_T_2M.tif'
curl.exe -I $url
curl.exe -D - -H 'Range: bytes=0-1023' $url -o "$env:TEMP/icon-cog-header.bin"
```

## WMS and PNG tiles

The local WMS implements `GetCapabilities` and single-layer `GetMap` for versions
1.1.1 and 1.3.0. Supported projections are EPSG:3857, EPSG:4326 and CRS:84. WMS
1.3.0 EPSG:4326 uses latitude/longitude axis order; WMS 1.1.1 EPSG:4326 and CRS:84
use longitude/latitude. It supports PNG, transparent or solid backgrounds, empty
or `default` styles, and image dimensions up to 2048×2048. Unsupported requests
return an XML error with HTTP 400. This is a local test service implementing that
subset; it does not implement GetFeatureInfo, TIME dimensions or layer stacking.
Every run/time/level/message is a separate layer listed in the catalog and
capabilities. Restart the WMS server after reconverting to reload its catalog.

```text
http://127.0.0.1:8002/wms?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0
```

The generator defaults to Germany (`5.5 47 15.5 55.5`) at zooms 3–6, giving 15
256px tiles per layer in the current dataset. Tiles use **XYZ** (north-origin Y),
not TMS. The XYZ endpoint serves only existing files under `wms_tiles/`. Missing
zooms/regions return 404; generate them offline with `generate_wms_tiles.py` first.
Only WMS can render new maps from COG values during requests. Standard 256px transparent Web Mercator WMS
requests on the XYZ grid reuse the same pre-rendered PNG; other WMS maps are
cached in `_getmap/`. Cache keys include source size/mtime and style settings,
so changed COGs do not reuse old images. Cache files have no automatic eviction;
remove obsolete cache directories manually when no longer needed.

```powershell
python test_data/generate_wms_tiles.py --variables t_2m clct --zoom 3 8 --bbox 5.5 47 15.5 55.5
python test_data/grib2_to_cog.py --input-dir test_data/grib2 --output-dir test_data/cog --overwrite
```

The frontend now caps raster tile requests at the source's useful resolution and
scales those tiles at deeper camera zoom. For the supplied 1377×657 ICON-EU
rasters (0.0625° cells), the derived 256px XYZ ceiling is zoom 5. Generating
millions of zoom 6–12 files adds no source detail and the app no longer requests
those child zooms for this dataset. For complete supplied ICON-EU data coverage at all requested
native levels, use:

```powershell
python test_data/generate_wms_tiles.py --zoom 0 5 --bbox -23.53125 29.46875 62.53125 70.53125
```

Generate these PNGs before benchmarking, then restart the WMS/PNG server. XYZ
requests never render missing tiles or alternative palettes. Each map/load has
unique URLs and no-store responses, so files are fetched independently between
maps; only subsequent views within the same map can reuse its native tile pixels.
WMS renders isolated requests afresh. COG and GRIB modes retain independent numeric data.

Styles use fixed scales for the supplied variables across forecast times and a
blue-to-red ramp. Scales clip extreme values for display without changing numeric
COGs. New variables use their data minimum/maximum unless added to `STYLE_RANGES`
in `raster_pipeline.py`. Weather codes use nearest-neighbour rendering, with a
numeric color ramp rather than meteorological symbols. The same ramp/scales are
exposed to OpenLayers. The PNG and direct COG displays can differ slightly due to
resampling and server/browser rendering.

## Direct GRIB2 delivery

Restart `serve_cog.py` after updating these scripts to enable its new `/grib2/`
route. It streams the original `.grib2` bytes with CORS and optional byte-range
support. The frontend GRIB worker downloads the selected full compressed message
file once, unpacks it using ecCodes WebAssembly, and colors/reprojects subsequent
views in the worker. It does not use `wms_tiles/` or read TIFF payloads. GRIB
messages are not internally tiled like COGs, so this mode does not claim to fetch
just the geographic viewport using ranges. Run `grib2_to_cog.py` to refresh the
shared catalog when the source dataset changes; metadata is checked against the
actual GRIB grid and units before display.

Use decompressed `.grib2`, not outer `.bz2` files. Display supports `regular_ll`
grids within -180..180. The decoder asset is loaded only on demand and is about
39.6 MB uncompressed. It requires a recent browser with WebAssembly memory64;
use Node.js 24+ to run the complete frontend worker tests. See the
[frontend README](../map-apps/README.md) for the map-specific renderers.

## Configuration and validation

The multi-map benchmark appends `_map_request` (a unique key per map/layer load)
and `_map` to raster URLs. These requests return `Cache-Control: no-store`.
TIFF/GRIB responses ignore `If-None-Match` cache reuse, while range reads retain
normal byte-range semantics. WMS requests render afresh and bypass the GetMap
output cache. XYZ requests open existing precomputed PNG files independently,
without rendering or writing files, and ignore conditional HTTP reuse. Missing
files return 404; alternative XYZ styles return 400. Ordinary requests without
the key retain HTTP revalidation and WMS rendering-cache behavior. Restart the servers after updating;
`/metrics` advertises `cacheIsolationSupported` for the benchmark's startup check.
This isolates raster HTTP/output caching between maps and trials, but does not
flush OS disk caches or shared library/decoder assets.

All three servers default to loopback. Use `--host`/`--port` to change their listeners.
`serve_cog.py --root ... --grib-dir ...` changes its TIFF/GRIB directories; the WMS server accepts
`--cog-dir` and `--tile-dir`. The generator supports `--variables`, exact `--layers`
IDs, custom bounds/zooms, and a `--max-tiles` limit (100,000 by default).

For changed ports/hosts, set these values in `map-apps/.env.local` and restart Vite:

```dotenv
VITE_COG_SERVER=http://127.0.0.1:8001
VITE_WMS_SERVER=http://127.0.0.1:8002
VITE_METRICS_SERVER=http://127.0.0.1:8004
```

```powershell
python -m unittest discover -s test_data/tests -v
cd map-apps
npm test
npm run build
```

The Python integration tests check ecCodes decoding, cell orientation, nodata,
compressed/multi-message inputs, numeric COG output, HTTP ranges/CORS/path
handling, WMS axis order, PNG backgrounds and tile cache reuse. Browser-specific
COG handling follows the [OpenLayers GeoTIFF source](https://openlayers.org/en/latest/apidoc/module-ol_source_GeoTIFF-GeoTIFFSource.html).


## Benchmark parameter color tables

The end-of-trial restyle uses the named style `benchmark`. Its per-parameter RGB tables are defined in [color_tables.json](color_tables.json), shared by Python rendering and the frontend. The default catalog style stays unchanged; the alternate table preserves its numeric range, units, resampling and nodata. RGB stops are evenly spaced over that range. Aliases map related parameters to the corresponding table, and unknown parameters use the fallback. These palettes are for benchmark workloads.

WMS GetCapabilities advertises `default` and `benchmark`. Request `STYLES=benchmark` for WMS GetMap. Each WMS style has a separate output-cache key; isolated requests bypass the rendering cache and return `Cache-Control: no-store`. The server renders the new palette from numeric COG values. XYZ PNG tiles have fixed colors: alternative styles are rejected, existing files remain unchanged and missing files are never generated by the XYZ endpoint. The frontend skips PNG restyling and exports its unsupported/partial status with null timing for PNG-only workloads. Restart the WMS/PNG server after code changes; its health response advertises `xyzDelivery: precomputed-only` and `xyzColorRestyleSupported: false`, checked before PNG workloads start. The launcher and WMS-restyle preflight also verify the shared color tables.
