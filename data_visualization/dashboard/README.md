# Benchmark Lab

A dependency-free benchmark dashboard preloaded with `../maplibre-gl-js-benchmark-1792162022357.csv`.

## Open

Open `dist/index.html` directly in a modern browser, or run from this directory:

```powershell
npm start
```

Then visit the URL printed in the terminal (normally **http://127.0.0.1:4173**; the next available port is used if it is occupied). No installation or build step is required.

## Explore and export

- Filter by status, raster format, scene, map count, repetition, and library when multiple libraries exist.
- Explore 34 performance, loading, memory, CPU, network, and coverage metrics. Group comparisons by scene, maps, raster layers, configuration, or library; compare series by format, maps, library, or scene.
- Choose mean, median, or interpolated 95th percentile and bar or line charts.
- Hover or keyboard-focus marks for actual values and sample counts. Frame-rate boxes show Q1–Q3, median, and the full min–max range.
- Each **PNG** button downloads a high-resolution chart with its title, legend, source filename, filter selection, and aggregation. **Export report PNG** combines all four charts in one image. Downloads use a solid background at 2× resolution.
- Search, sort, and paginate trial records; click **↗** for all original fields, including JSON measurements and failure diagnostics. **Filtered CSV** exports the searched/filtered rows in the current sort order and preserves every source column.
- **Import CSV** replaces the in-memory dataset with a compatible benchmark CSV (up to 50 MB). Imports are processed in the browser and are not uploaded or persisted. Reload restores the bundled data. **Restore original** is also available after import.

## Measurement rules

Completed trials are selected by default. The benchmark runner discards successful warm-ups before recording; `warmup=true` records the configuration, not an instruction to exclude the row. Failed/aborted trials may contain partial observations, so interpret them separately.

Metrics weight each available trial equally. Missing/nonfinite measurements and explicitly unsupported/disabled color restyles are omitted, not converted to zero. Real zeroes remain valid. Headline metrics use their labeled mean/median independently of the chart aggregation selector. The frame-rate distribution and memory scatter always use raw trials.

Broad selections mix configurations and can have unbalanced samples. Filter to comparable scenes and map counts before drawing conclusions. FPS is requestAnimationFrame timing, not guaranteed GPU presentation. MiB means bytes / 1,048,576. JS heap, RSS, worker grids, and WASM capacity are separate observations and must not be summed as total memory.

## Refresh bundled data

```powershell
npm run data
# Or another benchmark CSV:
node prepare-data.mjs ../another-benchmark.csv
```

`prepare-data.mjs` stores the original CSV as a JavaScript string so both HTTP and direct local-file use work. `dist/` is the complete static website. `core.js` contains the parser and aggregation functions; `app.js` renders SVG charts and converts them to PNG with the browser canvas API. No CDN, analytics, external fonts, or network dependency is used at runtime.

## Verify

```powershell
npm test
node --check dist/app.js
```

The tests validate CSV quoting and nested fields, real dataset counts, filtering, missing versus zero values, group sample counts, and percentile calculations.
