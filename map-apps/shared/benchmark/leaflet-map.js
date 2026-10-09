import { colorTableStyle, restyledLayer } from '../color-tables.js';
import L from 'leaflet';
import { rasterNativeZoom } from '../raster-resolution.js';
import 'leaflet/dist/leaflet.css';
import '../style.css';
import { CENTER, ZOOM, TILE_URL, ATTRIBUTION, STATION_COLOR, STATION_RADIUS, WMS_SERVER } from '../config.js';
import { createLeafletAdapter } from './leaflet-adapter.js';
import { createCogReader, xyzBounds } from '../cog-reader.js';
import { createGribReader } from '../grib-reader.js';
import { afterFrames, waitUntil } from './timing.js';

import { cogUrl, gribUrl, weatherTileUrl, rasterUrl } from '../weather.js';
import { stationContent, setStatus, TILE_ERROR_MESSAGE } from '../ui.js';

export function createLeafletMapFactory(stations) {
  return async (surface, index, signal, startup = {}) => {
    signal.throwIfAborted();
    // Leaflet's view API expects [latitude, longitude]; GeoJSON remains [lng, lat].
    const position = startup.camera?.center ?? CENTER;
    const center = [position[1], position[0]];
    const map = L.map(surface, { minZoom: 1, maxZoom: 19, zoomSnap: 0 });
    try {
      map.setView(center, startup.camera?.zoom ?? ZOOM);
      const basemap = L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 })
        .on('tileerror', () => setStatus(TILE_ERROR_MESSAGE, true));
      if (!startup.benchmark && index === 1) basemap.addTo(map);

      const stationLayer = L.geoJSON(structuredClone(stations), {
        pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
          radius: STATION_RADIUS,
          fillColor: STATION_COLOR,
          fillOpacity: 1,
          color: '#ffffff',
          weight: 2,
        }),
        onEachFeature: (feature, layer) => layer.bindPopup(stationContent(feature.properties)),
      });
      if (!startup.benchmark) stationLayer.addTo(map);

      const createOverlay = (layer, mode, onError) => {
        const maxNativeZoom = rasterNativeZoom(layer);
        if (mode === 'cog' || mode === 'grib') {
          const reader = mode === 'cog' ? createCogReader(cogUrl(layer), layer)
            : createGribReader(gribUrl(layer), layer);
          let removed = false;
          const CogGrid = L.GridLayer.extend({
            createTile(coords, done) {
              const canvas = L.DomUtil.create('canvas', 'leaflet-tile');
              canvas.width = canvas.height = 256;
              reader.render(xyzBounds(coords.z, coords.x, coords.y), 256, 256).then((pixels) => {
                if (removed) return;
                canvas.getContext('2d').putImageData(new ImageData(pixels, 256, 256), 0, 0);
                done(null, canvas);
              }).catch((error) => { if (!removed) { onError(error); done(error, canvas); } });
              return canvas;
            },
          });
          const tiles = new CogGrid({ tileSize: 256, opacity: 0.7, maxZoom: 19, maxNativeZoom,
            attribution: 'DWD ICON forecast', noWrap: true,
            bounds: [[layer.bounds[1], layer.bounds[0]], [layer.bounds[3], layer.bounds[2]]] }).addTo(map);
          return {
            async restyle() {
              await reader.restyle(colorTableStyle(layer));
              tiles.redraw();
            },
            ready: reader.ready,
            async settle(signal) {
              await afterFrames(2, signal);
              await waitUntil(() => !tiles.isLoading(), signal);
              await afterFrames(2, signal);
            },
            remove() { removed = true; reader.dispose(); map.removeLayer(tiles); },
            setVisible(visible) { if (visible) tiles.addTo(map); else map.removeLayer(tiles); },
          };
        }
        const options = { opacity: 0.7, tileSize: 256, maxZoom: 19, maxNativeZoom, noWrap: true,
          bounds: [[layer.bounds[1], layer.bounds[0]], [layer.bounds[3], layer.bounds[2]]], attribution: 'DWD ICON forecast' };
        const tiles = mode === 'wms'
          ? L.tileLayer.wms(rasterUrl(`${WMS_SERVER}/wms`, layer), { ...options, layers: layer.id, styles: '',
            format: 'image/png', transparent: true, version: '1.1.1', crs: L.CRS.EPSG3857 })
          : L.tileLayer(weatherTileUrl(layer, mode), options);
        tiles.on('tileerror', onError).addTo(map);
        return {
          restyle() {
            if (mode === 'wms') tiles.setParams({ styles: 'benchmark' });
            else tiles.setUrl(weatherTileUrl(restyledLayer(layer), mode));
          },
          async settle(signal) {
            await afterFrames(2, signal);
            await waitUntil(() => !tiles.isLoading(), signal);
            await afterFrames(2, signal);
          },
          remove() { map.removeLayer(tiles); tiles.off('tileerror', onError); },
          setVisible(visible) { if (visible) tiles.addTo(map); else map.removeLayer(tiles); },
        };
      };
      return {
        surface, createOverlay,
        adapter: createLeafletAdapter(map, basemap, stationLayer),
        getCamera: () => ({ center: [map.getCenter().lng, map.getCenter().lat], zoom: map.getZoom() }),
        onCameraChange(handler) { map.on('move', handler); return () => map.off('move', handler); },
        setStationsVisible(visible) { if (visible) stationLayer.addTo(map); else map.removeLayer(stationLayer); map.closePopup(); },
        destroy() { map.remove(); },
      };
    } catch (error) { map.remove(); throw error; }
  };
}
