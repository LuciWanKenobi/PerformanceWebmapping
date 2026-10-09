// GeoJSON and GL libraries use [longitude, latitude].
export const CENTER = [10.45, 51.16];
export const ZOOM = 6;
export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// GL zoom uses a 512px world tile; Leaflet/OpenLayers use 256px.
// Subtract one to give all four apps the same initial map scale.
export const GL_ZOOM = ZOOM - 1;

export function createRasterStyle() {
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: [TILE_URL],
        tileSize: 256,
        maxzoom: 19,
        attribution: ATTRIBUTION,
      },
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
  };
}

export const STATION_COLOR = '#155bb5';
export const STATION_RADIUS = 3;

export const COG_SERVER = (import.meta.env?.VITE_COG_SERVER || 'http://127.0.0.1:8001').replace(/\/$/, '');
export const WMS_SERVER = (import.meta.env?.VITE_WMS_SERVER || 'http://127.0.0.1:8002').replace(/\/$/, '');
export const METRICS_SERVER = (import.meta.env?.VITE_METRICS_SERVER || 'http://127.0.0.1:8004').replace(/\/$/, '');
