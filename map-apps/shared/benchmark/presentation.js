import { afterFrames } from './timing.js';

// Layout changes and resizing happen before the measured protocol begins.
export async function withBenchmarkPresentation(adapter, signal, operation, cancel) {
  const frame = document.querySelector('.map-frame');
  const controls = [...document.querySelectorAll('.toolbar button, .toolbar input, .toolbar select, .toolbar fieldset, .benchmark-panel button, .benchmark-panel input, .benchmark-panel select, .benchmark-panel fieldset')];
  const disabled = controls.map((control) => [control, control.disabled]);
  const wasInert = frame.inert, wasRunning = document.body.classList.contains('benchmark-running');
  const escape = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); cancel?.('Stopped with Escape. Completed trials are retained.'); }
  };
  disabled.forEach(([control]) => { control.disabled = true; });
  document.activeElement?.blur();
  frame.inert = true;
  document.body.classList.add('benchmark-running');
  window.addEventListener('keydown', escape, true);
  try {
    await afterFrames(2, signal);
    adapter.resize?.();
    await afterFrames(2, signal);
    return await operation();
  } finally {
    window.removeEventListener('keydown', escape, true);
    document.body.classList.toggle('benchmark-running', wasRunning);
    frame.inert = wasInert;
    disabled.forEach(([control, state]) => { control.disabled = state; });
    adapter.resize?.();
  }
}
