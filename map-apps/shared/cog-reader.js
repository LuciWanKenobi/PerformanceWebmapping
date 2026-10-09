import { waitForMapEvent, abortable } from './benchmark/timing.js';
import { planRasterCanvas, MERCATOR_LIMIT, latitudeAt, mercatorY } from './raster-resolution.js';
export { latitudeAt, mercatorY } from './raster-resolution.js';

import { colorTableStyle } from './color-tables.js';

// Numeric COG windows are fetched and colored here, entirely in the frontend.
const LIMIT = MERCATOR_LIMIT;

export function xyzBounds(z, x, y) {
  const size = 2 * LIMIT / 2 ** z;
  return [-LIMIT + x * size, LIMIT - (y + 1) * size, -LIMIT + (x + 1) * size, LIMIT - y * size];
}

export function colorize(value, style, nodata) {
  if (!Number.isFinite(value) || value === nodata) return [0, 0, 0, 0];
  const position = Math.max(0, Math.min(1, (value - style.min) / (style.max - style.min))) * (style.colors.length - 1);
  const left = Math.min(Math.floor(position), style.colors.length - 2);
  const fraction = position - left;
  return [...style.colors[left].map((v, i) => Math.round(v + fraction * (style.colors[left + 1][i] - v))), 255];
}

export function projectRaster(values, window, origin, resolution, bbox, width, height, style, nodata) {
  const output = new Uint8ClampedArray(width * height * 4);
  const rasterWidth = window[2] - window[0];
  const rasterHeight = window[3] - window[1];
  const valid = (v) => Number.isFinite(v) && v !== nodata;
  for (let row = 0; row < height; row++) {
    const latitude = latitudeAt(bbox[3] - (row + 0.5) / height * (bbox[3] - bbox[1]));
    const sy = (latitude - origin[1]) / resolution[1] - window[1] - 0.5;
    if (sy < -0.5 || sy > rasterHeight - 0.5) continue;
    for (let col = 0; col < width; col++) {
      const longitude = (bbox[0] + (col + 0.5) / width * (bbox[2] - bbox[0])) / LIMIT * 180;
      const sx = (longitude - origin[0]) / resolution[0] - window[0] - 0.5;
      if (sx < -0.5 || sx > rasterWidth - 0.5) continue;
      let value;
      if (style.resampling === 'nearest') {
        const x = Math.max(0, Math.min(rasterWidth - 1, Math.round(sx)));
        const y = Math.max(0, Math.min(rasterHeight - 1, Math.round(sy)));
        value = values[y * rasterWidth + x];
      } else {
        const x = Math.max(0, Math.min(rasterWidth - 1, sx));
        const y = Math.max(0, Math.min(rasterHeight - 1, sy));
        const x0 = Math.floor(x), y0 = Math.floor(y);
        const x1 = Math.min(x0 + 1, rasterWidth - 1), y1 = Math.min(y0 + 1, rasterHeight - 1);
        const samples = [values[y0 * rasterWidth + x0], values[y0 * rasterWidth + x1],
          values[y1 * rasterWidth + x0], values[y1 * rasterWidth + x1]];
        const weights = [(1 - (x - x0)) * (1 - (y - y0)), (x - x0) * (1 - (y - y0)),
          (1 - (x - x0)) * (y - y0), (x - x0) * (y - y0)];
        let total = 0, sum = 0;
        samples.forEach((v, i) => { if (valid(v)) { sum += v * weights[i]; total += weights[i]; } });
        value = total > 0 ? sum / total : nodata;
      }
      output.set(colorize(value, style, nodata), (row * width + col) * 4);
    }
  }
  return output;
}

export function createCogReader(url, layer) {
  const controller = new AbortController();
  let opening, style = layer.style, lastWindow;
  async function open() {
    if (!opening) opening = (async () => {
      const { fromUrl } = await import('geotiff');
      const tiff = await fromUrl(url, { allowFullFile: false, maxRanges: 0, cacheSize: 64 }, controller.signal);
      const count = await tiff.getImageCount();
      const base = await tiff.getImage(0);
      const images = [];
      for (let i = 0; i < count; i++) {
        const image = await tiff.getImage(i);
        images.push({ image, resolution: image.getResolution(base) });
      }
      return { base, images, origin: base.getOrigin() };
    })();
    return opening;
  }
  return {
    restyle(nextStyle) { style = nextStyle; },
    dispose() { controller.abort(); lastWindow = undefined; },
    async render(bbox, width, height) {
      controller.signal.throwIfAborted();
      const { images, origin } = await open();
      const west = bbox[0] / LIMIT * 180, east = bbox[2] / LIMIT * 180;
      const north = latitudeAt(bbox[3]), south = latitudeAt(bbox[1]);
      const extent = layer.bounds;
      if (east <= extent[0] || west >= extent[2] || north <= extent[1] || south >= extent[3]) {
        return new Uint8ClampedArray(width * height * 4);
      }
      const targetX = (east - west) / width, targetY = (north - south) / height;
      let selected = images[0];
      for (const candidate of images) {
        if (Math.abs(candidate.resolution[0]) <= targetX && Math.abs(candidate.resolution[1]) <= targetY) selected = candidate;
      }
      const { image, resolution } = selected;
      const window = [
        Math.max(0, Math.floor((west - origin[0]) / resolution[0]) - 1),
        Math.max(0, Math.floor((north - origin[1]) / resolution[1]) - 1),
        Math.min(image.getWidth(), Math.ceil((east - origin[0]) / resolution[0]) + 1),
        Math.min(image.getHeight(), Math.ceil((south - origin[1]) / resolution[1]) + 1),
      ];
      const key = JSON.stringify([image.getWidth(), image.getHeight(), window]);
      const values = lastWindow?.key === key ? lastWindow.values
        : await image.readRasters({ window, samples: [0], interleave: true, signal: controller.signal });
      lastWindow = { key, values };
      controller.signal.throwIfAborted();
      return projectRaster(values, window, origin, resolution, bbox, width, height, style, layer.nodata);
    },
  };
}

export function createGlCogOverlay(map, layer, url, onError, id = 'weather') {
  return createGlRasterOverlay(map, layer, createCogReader(url, layer), onError, id);
}

export function createGlRasterOverlay(map, layer, reader, onError, id = 'weather') {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  map.addSource(id, { type: 'canvas', canvas, animate: false,
    coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] });
  map.addLayer({ id, type: 'raster', source: id,
    paint: { 'raster-opacity': 0.7, 'raster-fade-duration': 0,
      'raster-resampling': layer.style?.resampling === 'nearest' ? 'nearest' : 'linear' } }, 'stations');
  let removed = false, visible = true, revision = 0;
  let pause;
  let drawing, needsDraw = false, renderedKey;
  function redraw() {
    revision++;
    needsDraw = true;
    if (!drawing) drawing = drain().finally(() => { drawing = undefined; });
    return drawing;
  }
  async function drain() {
    // Keep one numeric render in flight per viewport layer. Rapid camera
    // updates replace the pending view rather than queuing worker requests.
    while (needsDraw && visible && !removed) {
      needsDraw = false;
      await renderView(revision);
    }
  }
  async function renderView(current) {
    if (removed || !visible) return;
    const bounds = map.getBounds();
    const west = Math.max(-180, bounds.getWest(), layer.bounds[0]);
    const east = Math.min(180, bounds.getEast(), layer.bounds[2]);
    const south = Math.max(-85.05112878, bounds.getSouth(), layer.bounds[1]);
    const north = Math.min(85.05112878, bounds.getNorth(), layer.bounds[3]);
    if (west >= east || south >= north) {
      renderedKey = undefined;
      map.setLayoutProperty(id, 'visibility', 'none');
      return;
    }
    const width = Math.max(1, Math.min(1024, Math.round(map.getContainer().clientWidth)));
    const height = Math.max(1, Math.min(1024, Math.round(map.getContainer().clientHeight)));
    const plan = planRasterCanvas(layer, [west, south, east, north], width, height);
    if (plan.overzoom && plan.key === renderedKey) return;
    try {
      const pixels = await reader.render(plan.bbox, plan.width, plan.height);
      if (removed || !visible || current !== revision) return;
      canvas.width = plan.width; canvas.height = plan.height;
      canvas.getContext('2d').putImageData(new ImageData(pixels, plan.width, plan.height), 0, 0);
      const source = map.getSource(id);
      source.setCoordinates(plan.coordinates);
      renderedKey = plan.key;
      map.setLayoutProperty(id, 'visibility', 'visible');
      if (pause) map.off('render', pause);
      source.play();
      pause = () => { if (!removed) source.pause(); };
      map.once('render', pause);
      map.triggerRepaint();
    } catch (error) { if (!removed && current === revision && error.name !== 'AbortError') onError(error); }
  }
  map.on('moveend', redraw);
  map.on('resize', redraw);
  redraw();
  return {
    ready: reader.ready,
    async restyle() {
      await reader.restyle(colorTableStyle(layer));
      renderedKey = undefined;
      await redraw();
    },
    async settle(signal) {
      // A canvas source can be idle before its asynchronous numeric read has
      // finished. Explicitly render this fixed view before waiting for upload.
      let current;
      do { current = drawing; await abortable(current, signal); } while (current !== drawing);
      await waitForMapEvent({ on: map.on.bind(map), off: map.off.bind(map),
        trigger: () => map.triggerRepaint() }, 'idle', signal);
    },
    remove() {
      removed = true; revision++; reader.dispose();
      map.off('moveend', redraw); map.off('resize', redraw);
      if (pause) map.off('render', pause);
      map.removeLayer(id); map.removeSource(id);
    },
    setVisible(value) {
      if (value === visible) return;
      visible = value; revision++;
      if (!value) needsDraw = false;
      map.setLayoutProperty(id, 'visibility', value ? 'visible' : 'none');
      if (value) redraw();
    },
  };
}
