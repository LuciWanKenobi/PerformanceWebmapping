import test from 'node:test';
import assert from 'node:assert/strict';
import { withBenchmarkPresentation } from '../shared/benchmark/presentation.js';

function browser(t) {
  const frame = { inert: false }, controls = [{ disabled: false }, { disabled: true }];
  const classes = new Set(), events = new Map();
  const values = {
    document: { querySelector: () => frame, querySelectorAll: () => controls, activeElement: { blur() {} },
      body: { classList: { contains: (key) => classes.has(key), add: (key) => classes.add(key),
        toggle: (key, on) => on ? classes.add(key) : classes.delete(key) } } },
    window: { addEventListener: (key, value) => events.set(key, value), removeEventListener: (key) => events.delete(key) },
    requestAnimationFrame: (callback) => setImmediate(() => callback(0)), cancelAnimationFrame: clearImmediate,
  };
  for (const [key, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
  }
  return { frame, controls, classes, events };
}

test('benchmark presentation disables UI and map interaction, resizes before timing and restores on failure', async (t) => {
  const { frame, controls, classes, events } = browser(t);
  let resizes = 0;
  await assert.rejects(withBenchmarkPresentation({ resize: () => resizes++ }, new AbortController().signal, async () => {
    assert.equal(resizes, 1); assert.ok(frame.inert); assert.ok(classes.has('benchmark-running'));
    assert.ok(controls.every(({ disabled }) => disabled));
    throw new Error('renderer failed');
  }), /renderer failed/);
  assert.equal(resizes, 2); assert.equal(frame.inert, false);
  assert.equal(classes.has('benchmark-running'), false);
  assert.deepEqual(controls.map(({ disabled }) => disabled), [false, true]);
  assert.equal(events.size, 0);
});

test('Escape stops a hidden-UI benchmark and an early abort still restores every control', async (t) => {
  const { controls, events, classes } = browser(t);
  const controller = new AbortController();
  await assert.rejects(withBenchmarkPresentation({}, controller.signal, async () => {
    events.get('keydown')({ key: 'Escape', preventDefault() {} });
    controller.signal.throwIfAborted();
  }, (message) => controller.abort(new Error(message))), /Stopped with Escape/);
  await assert.rejects(withBenchmarkPresentation({}, controller.signal, assert.fail), /Stopped with Escape/);
  assert.deepEqual(controls.map(({ disabled }) => disabled), [false, true]);
  assert.equal(classes.size, 0);
});
