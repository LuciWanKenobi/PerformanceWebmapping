import { CENTER, GL_ZOOM, createRasterStyle, STATION_COLOR, STATION_RADIUS } from '../config.js';
import { stationContent } from '../ui.js';
import { glWeatherFactory } from '../weather.js';
import { createGlAdapter } from './gl-adapter.js';
import { waitForMapEvent } from './timing.js';

export function createGlMapFactory(gl, stations, { library, version, accessToken, projection }) {
  return async (surface, index, signal, startup = {}) => {
    signal.throwIfAborted();
    const style = createRasterStyle();
    if (startup.benchmark || index > 1) style.layers[0].layout = { visibility: 'none' };
    const map = new gl.Map({ container: surface, style, accessToken, projection,
      center: startup.camera?.center ?? CENTER, zoom: startup.camera ? startup.camera.zoom - 1 : GL_ZOOM, minZoom: 0, maxZoom: 18,
      dragRotate: false, pitchWithRotate: false });
    const initialization = new AbortController();
    const initSignal = AbortSignal.any([signal, initialization.signal]);
    const lost = () => initialization.abort(new Error('WebGL context lost during map initialization. Reduce the map count.'));
    const failed = (event) => { if (startup.benchmark) initialization.abort(event.error ?? new Error('Map initialization failed.')); };
    map.on('webglcontextlost', lost); map.on('error', failed);
    try {
      map.touchZoomRotate.disableRotation();
      map.addControl(new gl.NavigationControl({ showCompass: false }), 'top-left');
      if (!map.loaded()) await waitForMapEvent({ on: map.on.bind(map), off: map.off.bind(map),
        trigger: () => map.triggerRepaint() }, 'load', initSignal);
      initSignal.throwIfAborted();
      map.addSource('stations', { type: 'geojson', data: structuredClone(stations) });
      map.addLayer({ id: 'stations', type: 'circle', source: 'stations',
        layout: { visibility: startup.benchmark ? 'none' : 'visible' }, paint: {
        'circle-radius': STATION_RADIUS, 'circle-color': STATION_COLOR,
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
      } });
      let popup;
      map.on('click', 'stations', (event) => {
        popup?.remove();
        popup = new gl.Popup().setLngLat(event.lngLat)
          .setDOMContent(stationContent(event.features[0].properties)).addTo(map);
      });
      map.on('mouseenter', 'stations', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'stations', () => { map.getCanvas().style.cursor = ''; });
      return {
        surface, createOverlay: glWeatherFactory(map),
        adapter: createGlAdapter(map, { library, version, closePopup: () => popup?.remove() }),
        getCamera: () => ({ center: map.getCenter().toArray(), zoom: map.getZoom() + 1 }),
        onCameraChange(handler) { map.on('move', handler); return () => map.off('move', handler); },
        setStationsVisible(visible) {
          map.setLayoutProperty('stations', 'visibility', visible ? 'visible' : 'none'); popup?.remove();
        },
        destroy() { popup?.remove(); map.remove(); },
      };
    } catch (error) { map.remove(); throw error; }
    finally { map.off('webglcontextlost', lost); map.off('error', failed); }
  };
}
