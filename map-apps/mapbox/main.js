import gl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../shared/style.css';
import { CENTER, ZOOM } from '../shared/config.js';
import { enableControls, loadStations, setStatus, READY_MESSAGE } from '../shared/ui.js';
import { mountBenchmark } from '../shared/benchmark/panel.js';
import { mountMapGroup } from '../shared/benchmark/map-group.js';
import { createGlMapFactory } from '../shared/benchmark/gl-map.js';
import { mountWeather, withWeather } from '../shared/weather.js';

async function start() {
  const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN?.trim();
  if (!token?.startsWith('pk.')) {
    document.querySelector('#token-setup').hidden = false;
    setStatus('A public Mapbox access token is required. See setup instructions above.', true);
    return;
  }
  const createMap = createGlMapFactory(gl, await loadStations(), { library: 'Mapbox GL JS', version: gl.version, accessToken: token, projection: 'mercator' });
  const first = await createMap(document.querySelector('#map'), 1, new AbortController().signal);
  const group = mountMapGroup(first, createMap);
  enableControls(() => group.setCamera({ center: CENTER, zoom: ZOOM }), group.setStationsVisible);
  const weather = mountWeather(group.createOverlay, { supportsCog: true, supportsGrib: true });
  mountBenchmark(withWeather(group, weather));
  setStatus(READY_MESSAGE);
}
start().catch(() => setStatus('Could not start Mapbox GL JS. Check your connection and WebGL support, then reload.', true));
