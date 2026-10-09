export const DATASET_SEED = 42;
export const POINT_BOUNDS = Object.freeze([-12, 34, 35, 72]); // west, south, east, north
export const MOTION_DURATIONS = Object.freeze([3, 5, 10, 30, 60, 120]);
export const DEFAULT_MOTION_SECONDS = 30;
export const CAMERA_PATH = 'europe-tour-v1';
// Overview views between city visits exercise broad pans and repeated deep zooms.
// Zoom uses the 256px convention; GL adapters subtract one.
export const CAMERA_WAYPOINTS = Object.freeze([
  { center: [12, 52], zoom: 4 },
  { center: [-3.7, 40.4], zoom: 12 }, // Madrid
  { center: [-1, 46], zoom: 5 },
  { center: [2.35, 48.86], zoom: 12 }, // Paris
  { center: [10, 51], zoom: 5 },
  { center: [13.4, 52.52], zoom: 12 }, // Berlin
  { center: [18, 60], zoom: 5 },
  { center: [24.94, 60.17], zoom: 12 }, // Helsinki
  { center: [25, 51], zoom: 5 },
  { center: [26.1, 44.43], zoom: 12 }, // Bucharest
  { center: [17, 42], zoom: 5 },
  { center: [12.5, 41.9], zoom: 12 }, // Rome
  { center: [12, 52], zoom: 4 },
].map(({ center, zoom }) => Object.freeze({ center: Object.freeze(center), zoom })));

// Deterministic synthetic points across a continental Europe bounding box.
// This is a uniform spatial workload, including sea, rather than a country mask.
export function createPointLayers(pointsPerLayer, layerCount, seed = DATASET_SEED) {
  if (!Number.isInteger(pointsPerLayer) || pointsPerLayer < 1 || pointsPerLayer > 5000 ||
      !Number.isInteger(layerCount) || layerCount < 1 || layerCount > 4) {
    throw new Error('Use 1–5,000 points per layer and 1–4 layers.');
  }
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const [west, south, east, north] = POINT_BOUNDS;
  return Array.from({ length: layerCount }, (_, layer) => ({
    type: 'FeatureCollection',
    features: Array.from({ length: pointsPerLayer }, (_, index) => ({
      type: 'Feature',
      id: layer * pointsPerLayer + index,
      properties: {},
      geometry: { type: 'Point', coordinates: [west + random() * (east - west), south + random() * (north - south)] },
    })),
  }));
}

// Smooth, closed tour. Position and zoom have zero velocity at each waypoint,
// and the same progress function is used on both sides of a time-change pause.
export function cameraAt(progress) {
  const position = Math.min(1, Math.max(0, progress)) * (CAMERA_WAYPOINTS.length - 1);
  const index = Math.min(Math.floor(position), CAMERA_WAYPOINTS.length - 2);
  const from = CAMERA_WAYPOINTS[index], to = CAMERA_WAYPOINTS[index + 1];
  const t = position - index;
  const eased = t * t * (3 - 2 * t);
  const interpolate = (a, b) => a + (b - a) * eased;
  return {
    center: from.center.map((value, axis) => interpolate(value, to.center[axis])),
    zoom: interpolate(from.zoom, to.zoom),
  };
}
