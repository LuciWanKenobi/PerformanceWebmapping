import test from 'node:test';
import assert from 'node:assert/strict';
import { observeMemory, observeStages, recordAllocation, recordStage, sampleMemory, timedStage } from '../shared/benchmark/measurements.js';
import { summarizeMapReadiness, toCsv } from '../shared/benchmark/stats.js';

function replaceGlobals(t, entries) {
  for (const [key, value] of Object.entries(entries)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
  }
}

test('stage measurements preserve phases and failures and do not convert unsupported stages into zero work', async (t) => {
  let now = 10;
  replaceGlobals(t, { performance: { timeOrigin: 1000, now: () => now } });
  const stages = observeStages();
  recordStage({ kind: 'decode', startEpochMs: 1005, durationMs: 100, status: 'completed' });
  assert.equal(timedStage('decode', () => { now = 20; return 42; }, { mapIndex: 2 }), 42);
  now = 40;
  await timedStage('projectColor', async () => { now = 45; }, { mapIndex: 1 });
  now = 60;
  await assert.rejects(timedStage('upload', async () => { now = 65; throw new Error('copy failed'); }), /copy failed/);
  now = 80;
  timedStage('upload', () => { now = 85; });
  const row = stages.finish(10, 90, 30, 50, 70, 90);
  assert.equal(row.decodeMs, 10);
  assert.equal(row.projectColorMs, 5);
  assert.equal(row.uploadMs, 5);
  assert.equal(row.readDecodeMs, null);
  assert.deepEqual(row.stageMeasurements.map(({ phase }) => phase), ['initialOrBeforeChange', 'timeChange', 'afterChange', 'colorRestyle']);
  assert.equal(row.timeChangeStageTotals.projectColorMs, 5);
  assert.equal(row.colorRestyleStageTotals.uploadMs, 5);
  assert.equal(row.stageMeasurements[2].status, 'failed');
});

test('memory samples capture aggregate peaks, the final state and disposal without adding overlapping categories', (t) => {
  let now = 10;
  const timers = new Map();
  const performance = { timeOrigin: 1000, now: () => now, memory: { usedJSHeapSize: 100 } };
  replaceGlobals(t, { performance,
    setInterval: (callback, period) => { const id = Symbol(); timers.set(id, { callback, period }); return id; },
    clearInterval: (id) => timers.delete(id) });
  t.after(() => { recordAllocation('one', null); recordAllocation('two', null); });
  recordAllocation('one', { gribWorker: true, workerGridBytes: 50, wasmCapacityBytes: 100 });
  const observer = observeMemory(100);
  now = 110; performance.memory.usedJSHeapSize = 300;
  recordAllocation('two', { gribWorker: true, workerGridBytes: 100, wasmCapacityBytes: 200 });
  [...timers.values()][0].callback();
  recordAllocation('one', null);
  now = 211; performance.memory.usedJSHeapSize = 200;
  recordAllocation('two', { gribWorker: true, workerGridBytes: 250, wasmCapacityBytes: 400 });
  const row = observer.finish(10, 210);
  assert.equal(row.heapPeakBytes, 300);
  assert.equal(row.workerGridPeakBytes, 250);
  assert.equal(row.wasmCapacityPeakBytes, 400);
  assert.equal(row.gribWorkerPeakCount, 2);
  assert.equal(row.memorySampleCount, 3);
  assert.equal(row.memorySamples.at(-1).elapsedMs, 200);
  assert.equal(row.userAgentMemoryStatus, 'disabled');
  assert.equal(row.gpuMemoryBytes, null);
  assert.equal(timers.size, 0);
  recordAllocation('two', null);
  assert.equal(sampleMemory().gribWorkerCount, 0);
});

test('optional browser-wide memory requires isolation and ignores results after disconnect', async (t) => {
  let calls = 0, resolve;
  replaceGlobals(t, { performance: { timeOrigin: 1000, now: () => 10,
    measureUserAgentSpecificMemory: () => { calls++; return new Promise((done) => { resolve = done; }); } },
    crossOriginIsolated: false });
  const unavailable = observeMemory(100, true);
  assert.ok(unavailable.finish(10, 20).userAgentMemoryStatus.startsWith('unavailable'));
  assert.equal(calls, 0);
  globalThis.crossOriginIsolated = true;
  const active = observeMemory(100, true);
  resolve({ bytes: 512 }); await Promise.resolve();
  assert.equal(active.finish(10, 20).userAgentMemoryPeakBytes, 512);
  const cancelled = observeMemory(100, true);
  cancelled.disconnect(); resolve({ bytes: 1000 }); await Promise.resolve();
  assert.equal(cancelled.finish(10, 20).userAgentMemoryPeakBytes, null);
});

test('readiness spread uses extrema rather than map order and exports no fabricated samples', () => {
  const row = summarizeMapReadiness([{ mapIndex: 1, readyMs: 70 }, { mapIndex: 2, readyMs: 20 }]);
  assert.equal(row.firstMapReadyMs, 20);
  assert.equal(row.lastMapReadyMs, 70);
  assert.equal(row.mapReadySpreadMs, 50);
  assert.equal(summarizeMapReadiness([{ readyMs: 10 }]).mapReadySpreadMs, 0);
  assert.equal(summarizeMapReadiness().mapReadySpreadMs, null);
  const csv = toCsv([{ ...row, memorySamples: [{}], userAgentMemorySamples: [{}], stageMeasurements: [{}], processSamples: [{}] }]);
  assert.ok(csv.includes('mapReadiness'));
  for (const key of ['memorySamples', 'userAgentMemorySamples', 'stageMeasurements', 'processSamples']) assert.ok(!csv.includes(key));
});
