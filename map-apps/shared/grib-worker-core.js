import { decodeGrib } from './grib-decoder.js';
import { projectRaster } from './cog-reader.js';

// Kept separate from the browser entry so the actual worker protocol can also
// be checked in a Node worker against native ecCodes output.
export function createGribWorkerHandler(createModule, postMessage, fetchFile = fetch) {
  let grid, layer;
  return async ({ data }) => {
    const { id, type } = data;
    try {
      if (type === 'init') {
        layer = data.layer;
        const [module, response] = await Promise.all([createModule(data.module), fetchFile(data.url,
          layer.requestKey ? { cache: 'no-store' } : undefined)]);
        if (!response.ok) throw new Error(`GRIB2 server returned HTTP ${response.status}.`);
        grid = decodeGrib(module, new Uint8Array(await response.arrayBuffer()), layer.message, layer.nodata);
        if (grid.width !== layer.width || grid.height !== layer.height || grid.units !== layer.units ||
            grid.bounds.some((v, i) => Math.abs(v - layer.bounds[i]) > 0.000001)) {
          throw new Error('GRIB2 metadata differs from the catalog. Regenerate the catalog and reload weather.');
        }
        postMessage({ type: 'ready' });
      } else if (type === 'style') {
        if (!grid) throw new Error('GRIB2 worker is not initialized.');
        const style = data.style;
        if (!style || !Number.isFinite(style.min) || !Number.isFinite(style.max) || style.max <= style.min ||
            !Array.isArray(style.colors) || style.colors.length < 2 || style.colors.length > 256 ||
            !style.colors.every((rgb) => Array.isArray(rgb) && rgb.length === 3 &&
              rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) ||
            !['nearest', 'bilinear'].includes(style.resampling)) throw new Error('Invalid GRIB color table.');
        layer = { ...layer, style };
        postMessage({ type: 'styled', id });
      } else if (type === 'render') {
        if (!grid) throw new Error('GRIB2 worker is not initialized.');
        const { bbox, width, height } = data;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
            width > 2048 || height > 2048 || !Array.isArray(bbox) || bbox.length !== 4 ||
            !bbox.every(Number.isFinite) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
          throw new Error('Invalid worker render dimensions or bounds.');
        }
        const pixels = projectRaster(grid.values, [0, 0, grid.width, grid.height], grid.origin,
          grid.resolution, bbox, width, height, layer.style, layer.nodata);
        postMessage({ type: 'pixels', id, pixels }, [pixels.buffer]);
      } else {
        throw new Error('Unknown GRIB2 worker request.');
      }
    } catch (error) {
      postMessage({ type: 'error', id, message: error.message || 'GRIB2 decoding failed.' });
    }
  };
}
