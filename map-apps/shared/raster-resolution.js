// Source resolution in the same 256px Web Mercator convention for all adapters.
export const MERCATOR_LIMIT = 20037508.342789244;
const RADIUS = MERCATOR_LIMIT / Math.PI;
export const latitudeAt = (y) => Math.atan(Math.sinh(y / RADIUS)) * 180 / Math.PI;
export const mercatorY = (lat) => RADIUS * Math.asinh(Math.tan(Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180));

export function rasterNativeZoom(layer) {
  const bounds = layer.bounds;
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) ||
      !Number.isInteger(layer.width) || layer.width < 1 || !Number.isInteger(layer.height) || layer.height < 1 ||
      bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) return 6;
  const dx = (bounds[2] - bounds[0]) / layer.width;
  const dy = (bounds[3] - bounds[1]) / layer.height;
  // Finest projected row is nearest the equator; do not discard detail there.
  const nearestLatitude = bounds[1] <= 0 && bounds[3] >= 0 ? 0 : Math.min(Math.abs(bounds[1]), Math.abs(bounds[3]));
  const xMeters = dx / 180 * MERCATOR_LIMIT;
  const yMeters = Math.abs(mercatorY(nearestLatitude + dy) - mercatorY(nearestLatitude));
  const resolution = Math.min(xMeters, yMeters);
  if (!(resolution > 0) || !Number.isFinite(resolution)) return 6;
  // Round up to retain at least native detail, then enlarge these tiles at deeper zoom.
  return Math.max(0, Math.min(19, Math.ceil(Math.log2(2 * MERCATOR_LIMIT / (256 * resolution)))));
}

// Numeric GL canvases cover a stable block of native-zoom tiles at deep zoom.
// A camera can move inside that block without fetching/coloring another window.
export function planRasterCanvas(layer, bounds, width, height) {
  let [west, south, east, north] = bounds;
  const nativeZoom = rasterNativeZoom(layer);
  const tileSpan = 2 * MERCATOR_LIMIT / 2 ** nativeZoom;
  const pixelResolution = tileSpan / 256;
  let bbox = [west / 180 * MERCATOR_LIMIT, mercatorY(south), east / 180 * MERCATOR_LIMIT, mercatorY(north)];
  const overzoom = Math.min((bbox[2] - bbox[0]) / width, (bbox[3] - bbox[1]) / height) < pixelResolution;
  if (overzoom) {
    bbox = [
      Math.floor((bbox[0] + MERCATOR_LIMIT) / tileSpan) * tileSpan - MERCATOR_LIMIT,
      MERCATOR_LIMIT - Math.ceil((MERCATOR_LIMIT - bbox[1]) / tileSpan) * tileSpan,
      Math.ceil((bbox[2] + MERCATOR_LIMIT) / tileSpan) * tileSpan - MERCATOR_LIMIT,
      MERCATOR_LIMIT - Math.floor((MERCATOR_LIMIT - bbox[3]) / tileSpan) * tileSpan,
    ];
    // Clip the stable block to the data extent, not to the current viewport.
    const extent = layer.bounds;
    bbox[0] = Math.max(bbox[0], extent[0] / 180 * MERCATOR_LIMIT);
    bbox[1] = Math.max(bbox[1], mercatorY(extent[1]));
    bbox[2] = Math.min(bbox[2], extent[2] / 180 * MERCATOR_LIMIT);
    bbox[3] = Math.min(bbox[3], mercatorY(extent[3]));
    width = Math.max(1, Math.min(1024, Math.ceil((bbox[2] - bbox[0]) / pixelResolution)));
    height = Math.max(1, Math.min(1024, Math.ceil((bbox[3] - bbox[1]) / pixelResolution)));
    [west, south, east, north] = [bbox[0] / MERCATOR_LIMIT * 180, latitudeAt(bbox[1]), bbox[2] / MERCATOR_LIMIT * 180, latitudeAt(bbox[3])];
  }
  return { bbox, width, height, overzoom, nativeZoom,
    coordinates: [[west, north], [east, north], [east, south], [west, south]],
    key: JSON.stringify([bbox, width, height]) };
}
