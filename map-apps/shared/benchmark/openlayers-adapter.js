import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import { fromLonLat } from 'ol/proj.js';
import { VERSION } from 'ol/util.js';
import { waitForMapEvent } from './timing.js';

export function createOpenLayersAdapter(map, basemapLayer, stationLayer, popup) {
  const layers = [];
  const view = map.getView();
  return {
    library: 'OpenLayers', version: VERSION, renderer: 'Canvas vector layers', readySignal: 'rendercomplete',
    size: () => map.getTargetElement().getBoundingClientRect(),
    resize: () => map.updateSize(),
    prepare() {
      const state = {
        center: [...view.getCenter()], zoom: view.getZoom(),
        basemap: basemapLayer.getVisible(), stations: stationLayer.getVisible(),
      };
      view.cancelAnimations();
      popup.setPosition(undefined);
      basemapLayer.setVisible(false);
      stationLayer.setVisible(false);
      return state;
    },
    restore(state) {
      view.setCenter(state.center);
      view.setZoom(state.zoom);
      basemapLayer.setVisible(state.basemap);
      stationLayer.setVisible(state.stations);
    },
    addPoints(datasets) {
      for (const data of datasets) {
        const layer = new VectorLayer({
          source: new VectorSource({
            features: new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' }),
          }),
          style: stationLayer.getStyle(),
        });
        layers.push(layer);
        map.addLayer(layer);
      }
    },
    restylePoints({ pointColor }) {
      for (const layer of layers) {
        // Keep the station style and next trial's initial colors unchanged.
        const style = layer.getStyle().clone();
        style.getImage().getFill().setColor(pointColor);
        layer.setStyle(style);
      }
    },
    clearPoints() {
      for (const layer of layers.splice(0)) { map.removeLayer(layer); layer.dispose(); }
    },
    updatePoints(datasets) {
      if (datasets.length !== layers.length) throw new Error('Point layer count changed during the trial.');
      datasets.forEach((data, index) => {
        const source = layers[index].getSource();
        source.clear();
        source.addFeatures(new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' }));
      });
    },
    setCamera({ center, zoom }) { view.setCenter(fromLonLat(center)); view.setZoom(zoom); },
    settle(signal) {
      return waitForMapEvent({ on: map.on.bind(map), off: map.un.bind(map), trigger: () => map.render() }, 'rendercomplete', signal);
    },
  };
}
