import 'leaflet/dist/leaflet.css';
import '../shared/style.css';
import { CENTER, ZOOM } from '../shared/config.js';
import { enableControls, loadStations, setStatus, READY_MESSAGE } from '../shared/ui.js';
import { mountBenchmark } from '../shared/benchmark/panel.js';
import { mountMapGroup } from '../shared/benchmark/map-group.js';
import { createLeafletMapFactory } from '../shared/benchmark/leaflet-map.js';
import { mountWeather, withWeather } from '../shared/weather.js';

async function start() {
  const createMap = createLeafletMapFactory(await loadStations());
  const first = await createMap(document.querySelector('#map'), 1, new AbortController().signal);
  const group = mountMapGroup(first, createMap);
  enableControls(() => group.setCamera({ center: CENTER, zoom: ZOOM }), group.setStationsVisible);
  const weather = mountWeather(group.createOverlay, { supportsCog: true, supportsGrib: true });
  mountBenchmark(withWeather(group, weather));
  setStatus(READY_MESSAGE);
}
start().catch(() => setStatus('Could not start Leaflet. Check your connection and reload.', true));
