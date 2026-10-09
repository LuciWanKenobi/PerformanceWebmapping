import L from 'leaflet';
import { STATION_COLOR, STATION_RADIUS } from '../config.js';
import { afterFrames } from './timing.js';

export function createLeafletAdapter(map, basemap, stationLayer) {
  const layers = [];
  return {
    library: 'Leaflet', version: L.version, renderer: 'SVG circle markers', readySignal: 'two animation frames after synchronous update',
    size: () => map.getContainer().getBoundingClientRect(),
    resize: () => map.invalidateSize(),
    prepare() {
      const state = {
        center: map.getCenter(), zoom: map.getZoom(), zoomSnap: map.options.zoomSnap,
        basemap: map.hasLayer(basemap), stations: map.hasLayer(stationLayer),
      };
      map.closePopup();
      map.stop();
      map.removeLayer(basemap);
      map.removeLayer(stationLayer);
      // Match the continuous zoom path used by the other libraries.
      map.options.zoomSnap = 0;
      return state;
    },
    restore(state) {
      map.options.zoomSnap = state.zoomSnap;
      map.setView(state.center, state.zoom, { animate: false });
      if (state.basemap) basemap.addTo(map);
      if (state.stations) stationLayer.addTo(map);
    },
    addPoints(datasets) {
      for (const data of datasets) {
        const layer = L.geoJSON(data, {
          pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
            radius: STATION_RADIUS, fillColor: STATION_COLOR, fillOpacity: 1,
            color: '#ffffff', weight: 2, interactive: false,
          }),
        });
        layers.push(layer);
        layer.addTo(map);
      }
    },
    restylePoints({ pointColor }) { layers.forEach((layer) => layer.setStyle({ fillColor: pointColor })); },
    clearPoints() { for (const layer of layers.splice(0)) map.removeLayer(layer); },
    updatePoints(datasets) {
      if (datasets.length !== layers.length) throw new Error('Point layer count changed during the trial.');
      datasets.forEach((data, index) => { layers[index].clearLayers(); layers[index].addData(data); });
    },
    setCamera({ center, zoom }) { map.setView([center[1], center[0]], zoom, { animate: false }); },
    settle: (signal) => afterFrames(2, signal),
  };
}
