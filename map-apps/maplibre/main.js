import * as gl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../shared/style.css';
import { CENTER, ZOOM } from '../shared/config.js';
import { enableControls, loadStations, setStatus, READY_MESSAGE } from '../shared/ui.js';
import { mountBenchmark } from '../shared/benchmark/panel.js';
import { mountMapGroup } from '../shared/benchmark/map-group.js';
import { createGlMapFactory } from '../shared/benchmark/gl-map.js';
import { mountWeather, withWeather } from '../shared/weather.js';

async function start() {
  gl.setWorkerUrl(workerUrl);
  const createMap = createGlMapFactory(gl, await loadStations(), { library: 'MapLibre GL JS', version: gl.getVersion() });
  const first = await createMap(document.querySelector('#map'), 1, new AbortController().signal);
  const group = mountMapGroup(first, createMap);
  enableControls(() => group.setCamera({ center: CENTER, zoom: ZOOM }), group.setStationsVisible);
  const weather = mountWeather(group.createOverlay, { supportsCog: true, supportsGrib: true });
  mountBenchmark(withWeather(group, weather));
  setStatus(READY_MESSAGE);
}
start().catch(() => setStatus('Could not start MapLibre GL JS. Check your connection and WebGL support, then reload.', true));
