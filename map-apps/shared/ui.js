export function setStatus(message, isError = false) {
  const status = document.querySelector('#status');
  status.textContent = message;
  status.dataset.error = String(isError);
}

export function enableControls(reset, toggleStations) {
  const resetButton = document.querySelector('#reset');
  const stationToggle = document.querySelector('#stations');
  resetButton.disabled = false;
  stationToggle.disabled = false;
  resetButton.addEventListener('click', reset);
  stationToggle.addEventListener('change', () => toggleStations(stationToggle.checked));
  toggleStations(stationToggle.checked);
}

export async function loadStations() {
  const response = await fetch(new URL('./stations.geojson', import.meta.url));
  if (!response.ok) throw new Error(`Could not load stations (${response.status}).`);
  return response.json();
}

export function stationContent(properties) {
  const container = document.createElement('div');
  container.className = 'station-popup';
  const title = document.createElement('strong');
  title.textContent = properties.name;
  const temperature = document.createElement('p');
  temperature.textContent = `${properties.temperature} °C (sample)`;
  container.append(title, temperature);
  return container;
}

export const READY_MESSAGE = 'Synthetic sample stations. Click a blue point to view its temperature.';
export const TILE_ERROR_MESSAGE = 'Some map tiles could not load. Check your connection and reload.';
