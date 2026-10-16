import { projectedBounds, tileBounds, intersection } from './coverage.js';

export function glViewBounds(map) {
  const bounds = map.getBounds();
  return projectedBounds([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
}

// These small native renderer integrations target the pinned package versions.
// A missing hook returns null, never an optimistic 100% coverage value.
export function trackGlTiles(map, layer, id, onError = () => {}) {
  let aborted = 0, removed = false;
  const requests = new WeakMap();
  const source = map.getSource?.(id), originalAbort = source?.abortTile, originalLoad = source?.loadTile;
  function abortTile(tile, ...args) {
    const request = requests.get(tile);
    if (request) request.superseded = true;
    if (tile?.state === 'loading' || tile?.state === 'reloading') aborted++;
    return originalAbort.call(this, tile, ...args);
  }
  function loadTile(tile, ...args) {
    const request = { superseded: false, reported: false };
    requests.set(tile, request);
    const failed = (error) => {
      // Native GL engines may hide 404s to allow sparse third-party tile sets.
      // Our prepared benchmark tile set must be complete. Observe the original
      // load result, keeping renderer-confirmed cancellations separate.
      if (!removed && !request.superseded && !request.reported && Number(error?.status) === 404) {
        request.reported = true;
        onError(new Error('Raster tile request failed (HTTP 404): ' + layer.id));
      }
    };
    const wrapped = args.map((arg) => typeof arg !== 'function' ? arg : function (...values) {
      try { return arg.apply(this, values); } finally { failed(values[0]); }
    });
    try {
      const result = originalLoad.call(this, tile, ...wrapped);
      return result?.then ? result.then((value) => value, (error) => { failed(error); throw error; }) : result;
    } catch (error) { failed(error); throw error; }
  }
  if (originalAbort) source.abortTile = abortTile;
  if (originalLoad) source.loadTile = loadTile;
  return {
    sampleCoverage() {
      let rectangles = null;
      const cache = map.style?.tileManagers?.[id] ?? map.style?.getSourceCache?.(id);
      if (cache?.getRenderableIds && cache?.getTileByID) {
        rectangles = cache.getRenderableIds().flatMap((key) => {
          const tile = cache.getTileByID(key), coord = tile?.tileID;
          return coord?.canonical && tile.hasData?.() ? [tileBounds(coord.canonical.z, coord.canonical.x, coord.canonical.y, coord.wrap ?? 0)] : [];
        });
      }
      return { view: glViewBounds(map), extent: projectedBounds(layer.bounds), rectangles,
        method: rectangles ? 'GL renderable native tiles (pinned source cache)' : 'unavailable: GL source cache' };
    },
    workStats: () => originalAbort ? [{ kind: 'abortedNativeTiles', count: aborted }] : [],
    dispose() {
      removed = true;
      if (source?.abortTile === abortTile) source.abortTile = originalAbort;
      if (source?.loadTile === loadTile) source.loadTile = originalLoad;
    },
  };
}

export function trackLeafletTiles(map, tiles, layer) {
  const loading = new Set();
  let superseded = 0;
  const start = ({ tile }) => loading.add(tile);
  const end = ({ tile }) => loading.delete(tile);
  const unload = ({ tile }) => { if (loading.delete(tile)) superseded++; };
  tiles.on('tileloadstart', start).on('tileload', end).on('tileerror', end).on('tileunload', unload);
  return {
    sampleCoverage() {
      const bounds = map.getBounds();
      const view = projectedBounds([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
      // _tiles contains retained fallback tiles as well as the current grid.
      // Include usable partially faded tiles, but exclude detached/cache-only
      // tiles, failed loads and tiles whose fade has not started (opacity 0).
      const rectangles = tiles._tiles ? Object.values(tiles._tiles).flatMap(({ coords, el, active, loaded }) => {
        const successful = el?.classList?.contains('leaflet-tile-loaded');
        const shown = successful && (active || (loaded && Number(el.style?.opacity || 1) > 0));
        return shown && el?.isConnected ? [tileBounds(coords.z, coords.x, coords.y)] : [];
      }) : null;
      return { view, extent: projectedBounds(layer.bounds), rectangles,
        method: rectangles ? 'Leaflet active attached native tiles (pinned grid)' : 'unavailable: Leaflet tile grid' };
    },
    workStats: () => [{ kind: 'unfinishedTileUnloads', count: superseded }],
    dispose() {
      tiles.off('tileloadstart', start).off('tileload', end).off('tileerror', end).off('tileunload', unload);
      loading.clear();
    },
  };
}

export function trackOpenLayersTiles(map, overlay, source, layer, transform) {
  let drawn = [], renderer, originalDraw, drawHook, supported = false, failed = false, offView = 0;
  const viewBounds = () => map.getView().calculateExtent(map.getSize());
  function before() {
    drawn = [];
    try {
      renderer = overlay.getRenderer();
      if (typeof renderer.drawTile_ === 'function' && !drawHook) {
        originalDraw = renderer.drawTile_;
        drawHook = function (...args) {
          const result = originalDraw.apply(this, args);
          const [, representation, , , extent, , grid] = args;
          try {
            if (representation.ready) {
              const rect = intersection(grid.getTileCoordExtent(representation.tile.tileCoord), extent);
              if (rect) drawn.push(rect);
            }
          } catch { failed = true; supported = false; }
          return result;
        };
        renderer.drawTile_ = drawHook;
      }
      supported = !failed && Boolean(drawHook || Array.isArray(renderer.renderedTiles));
    } catch { failed = true; supported = false; }
  }
  function after() {
    if (!Array.isArray(renderer?.renderedTiles)) return;
    try {
      const grid = source.getTileGridForProjection(map.getView().getProjection());
      drawn = renderer.renderedTiles.filter((tile) => tile.getState() === 2)
        .map((tile) => grid.getTileCoordExtent(tile.getTileCoord()).slice());
    } catch { failed = true; supported = false; }
  }
  const completed = ({ tile }) => {
    if (tile.getState() !== 2) return; // Aborted/error/empty tiles are not successful completions.
    try {
      const projection = source.getProjection() ?? map.getView().getProjection();
      const grid = source.getTileGridForProjection(projection);
      const extent = transform(grid.getTileCoordExtent(tile.getTileCoord()), projection, map.getView().getProjection());
      if (!intersection(extent, viewBounds())) offView++;
    } catch { failed = true; supported = false; }
  };
  overlay.on('prerender', before); overlay.on('postrender', after); source.on('tileloadend', completed);
  return {
    sampleCoverage: () => ({ view: viewBounds(), extent: projectedBounds(layer.bounds), rectangles: supported ? drawn : null,
      method: supported ? 'OpenLayers drawn tile footprints (pinned Canvas/WebGL renderer)' : 'unavailable: OpenLayers renderer' }),
    workStats: () => failed ? [] : [{ kind: 'offViewTileCompletions', count: offView }],
    dispose() {
      overlay.un('prerender', before); overlay.un('postrender', after); source.un('tileloadend', completed);
      if (renderer && drawHook && renderer.drawTile_ === drawHook) renderer.drawTile_ = originalDraw;
      drawn = [];
    },
  };
}
