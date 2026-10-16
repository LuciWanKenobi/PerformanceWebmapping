import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFrames, toCsv } from '../shared/benchmark/stats.js';
import { resourceKind, resourceRecord, summarizeNetwork, observeNetwork, recordWorkerResource,
  observeWorkerResources } from '../shared/benchmark/network.js';
import { cpuSummary, serverSummary, processSummary, startTelemetry } from '../shared/benchmark/telemetry.js';

test('FPS lows average slowest tails, rather than inverting percentile thresholds', () => {
  const frames = [...Array(95).fill(16), 100, 100, 100, 100, 200];
  const stats = summarizeFrames(frames);
  assert.ok(Math.abs(stats.fpsLow5Percent - 1000 / 120) < 1e-10);
  assert.equal(stats.fpsLow1Percent, 5);
  assert.equal(stats.low5PercentSamples, 5);
  assert.equal(stats.low1PercentSamples, 1);
  assert.equal(stats.p99FrameMs, 100);
  assert.equal(stats.framesOver100Ms, 1);
  assert.equal(stats.framesOver33Ms, 5);
  assert.equal(summarizeFrames([]).fpsLow1Percent, null);
  assert.equal(summarizeFrames([20, 40]).fpsLow5Percent, 25);
});

const resource = (overrides = {}) => ({ name: 'http://127.0.0.1:8001/cog/test.tif',
  startTime: 10, responseEnd: 40, duration: 30, requestStart: 12, responseStart: 22,
  transferSize: 1324, encodedBodySize: 1024, decodedBodySize: 2048, responseStatus: 206,
  initiatorType: 'fetch', ...overrides });

test('network records expose sizes and timings without exporting sensitive resource URLs', () => {
  const record = resourceRecord(resource({ name: 'http://127.0.0.1:8001/cog/test.tif?token=secret&_map=20&_map_request=private-request-key' }), 1000);
  assert.equal(record.mapIndex, 20);
  assert.ok(!JSON.stringify(record).includes('private-request-key'));
  assert.equal(resourceRecord(resource({ name: 'http://127.0.0.1:8001/cog/test.tif?_map=21' }), 1000).mapIndex, null);
  assert.equal(record.kind, 'cog');
  assert.equal(record.startEpochMs, 1010);
  assert.equal(record.durationMs, 30);
  assert.equal(record.ttfbMs, 10);
  assert.equal(record.transferBytes, 1324);
  assert.equal(record.fetchedBodyBytes, 2048);
  assert.equal(record.status, 206);
  assert.ok(!JSON.stringify(record).includes('secret'));
  assert.ok(!JSON.stringify(record).includes('test.tif'));
  assert.equal(resourceKind('http://127.0.0.1:8002/wms?REQUEST=GetMap'), 'wms');
  assert.equal(resourceKind('http://127.0.0.1:8002/wms?REQUEST=GetCapabilities'), null);
  assert.equal(resourceKind('http://127.0.0.1:8001/metrics'), null);
  assert.equal(resourceKind('https://tile.openstreetmap.org/0/0/0.png'), null);
  assert.equal(resourceKind('http://app/assets/eccodes.wasm', 'http://app'), 'decoder');
  assert.equal(resourceKind('http://app/assets/geotiff.js', 'http://app'), 'code');
});

test('cached bodies and hidden cross-origin timings cannot be mistaken for zero-byte downloads', () => {
  const cached = resourceRecord(resource({ transferSize: 0 }), 1000);
  assert.equal(cached.cacheHit, true);
  const hidden = resourceRecord(resource({ transferSize: 0, encodedBodySize: 0,
    decodedBodySize: 0, requestStart: 0, responseStart: 0, responseStatus: 0 }), 1000);
  assert.equal(hidden.transferBytes, null);
  assert.equal(hidden.cacheHit, null);
  const stats = summarizeNetwork([cached, hidden]);
  assert.equal(stats.requestCount, 2);
  assert.equal(stats.cacheHitCount, 1);
  assert.equal(stats.unknownSizeRequestCount, 1);
  assert.equal(stats.transferBytes, null);
  assert.equal(stats.fetchedBodyBytes, null);
  assert.equal(stats.knownTransferBytes, 0);
  assert.equal(summarizeNetwork([], true).transferBytes, 0);
  assert.equal(summarizeNetwork([], false).transferBytes, null);
});

function replaceGlobals(t, entries) {
  for (const [key, value] of Object.entries(entries)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
    t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else delete globalThis[key]; });
  }
}

test('resource collector combines window and worker clocks, isolates trials, and cleans up', (t) => {
  const observers = [];
  replaceGlobals(t, { performance: { timeOrigin: 1000 }, location: { origin: 'http://app' },
    PerformanceObserver: class {
      static supportedEntryTypes = ['resource'];
      constructor(callback) { this.callback = callback; this.pending = []; observers.push(this); }
      observe() {}
      takeRecords() { const entries = this.pending; this.pending = []; return entries; }
      disconnect() { this.disconnected = true; }
    },
  });
  const collector = observeNetwork();
  observers[0].pending.push(resource({ startTime: 1 })); // Prior trial.
  observers[0].callback({ getEntries: () => [resource()] });
  const worker = { ...resourceRecord(resource({ name: 'http://127.0.0.1:8001/grib2/test.grib2',
    startTime: 15, responseEnd: 50 }), 1020, 'worker'), recordId: 'worker-1' };
  recordWorkerResource(worker);
  recordWorkerResource(worker); // Duplicate message cannot inflate totals.
  const result = collector.finish(5, 100, 30, 60);
  assert.equal(result.requestCount, 2);
  assert.equal(result.dataRequestCount, 2);
  assert.equal(result.transferBytes, 2648);
  assert.equal(result.timeChangeNetwork.requestCount, 1);
  assert.equal(result.networkRequests[1].startMs, 30);
  assert.equal(result.networkRequests[1].phase, 'timeChange');
  assert.ok(observers[0].disconnected);
  const next = observeNetwork();
  recordWorkerResource(worker);
  assert.equal(next.finish(100, 200).requestCount, 0);
});

test('worker resources are flushed before readiness and posted once without URLs', (t) => {
  let observer;
  replaceGlobals(t, { performance: { timeOrigin: 1200 }, location: { origin: 'http://app' },
    PerformanceObserver: class {
      static supportedEntryTypes = ['resource'];
      constructor(callback) { this.callback = callback; this.pending = []; observer = this; }
      observe() {}
      takeRecords() { const items = this.pending; this.pending = []; return items; }
    },
  });
  const messages = [];
  const flush = observeWorkerResources((message) => messages.push(message));
  observer.pending.push(resource({ name: 'http://app/assets/decoder.wasm?secret=private' }));
  flush(); flush();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'resource');
  assert.equal(messages[0].entry.kind, 'decoder');
  assert.equal(messages[0].entry.startEpochMs, 1210);
  assert.ok(!JSON.stringify(messages).includes('private'));
});

test('CPU average uses cumulative busy counters while peak/p95 use only this trial samples', () => {
  const before = { scope: 'system', monotonicMs: 1000, cpuTotalSeconds: 100, cpuIdleSeconds: 80 };
  const after = { scope: 'system', monotonicMs: 2000, cpuTotalSeconds: 120, cpuIdleSeconds: 90,
    samplePeriodMs: 250, logicalCpuCount: 20,
    samples: [{ monotonicMs: 900, percent: 100 }, { monotonicMs: 1250, percent: 20 },
      { monotonicMs: 1500, percent: 80 }, { monotonicMs: 2000, percent: 60 }],
  };
  const stats = cpuSummary(before, after);
  assert.equal(stats.systemCpuMeanPercent, 50);
  assert.equal(stats.systemCpuPeakPercent, 80);
  assert.equal(stats.systemCpuP95Percent, 80);
  assert.equal(stats.systemCpuLastPercent, 60);
  assert.equal(stats.systemCpuSampleCount, 3);
  assert.equal(stats.systemCpuWindowMs, 1000);
  assert.equal(stats.systemCpuSamples[0].elapsedMs, 250);
  assert.equal(cpuSummary(null, after).systemCpuMeanPercent, null);
  assert.equal(cpuSummary(after, before).systemCpuMeanPercent, null);
  assert.equal(cpuSummary(before, { ...after, cpuIdleSeconds: 200 }).systemCpuMeanPercent, null);
});

test('server deltas count actual requests, ranges and bytes and reject server restart/reset', () => {
  const before = { instance: 'a', requestCount: 1, getRequestCount: 1, rangeGetRequestCount: 1,
    completedRequestCount: 1, bodyBytesSent: 32, responseStatuses: { '206': 1 } };
  const after = { instance: 'a', requestCount: 4, getRequestCount: 3, rangeGetRequestCount: 2,
    completedRequestCount: 4, bodyBytesSent: 96, responseStatuses: { '206': 2, '304': 1, '204': 1 } };
  const stats = serverSummary(before, after);
  assert.equal(stats.getRequestCount, 2);
  assert.equal(stats.rangeGetRequestCount, 1);
  assert.equal(stats.bodyBytesSent, 64);
  assert.deepEqual(stats.responseStatuses, { '206': 1, '304': 1, '204': 1 });
  assert.equal(serverSummary(before, { ...after, instance: 'b' }), null);
  assert.equal(serverSummary(before, { ...after, requestCount: 0 }), null);
});

test('unavailable telemetry remains null while disabled CPU does not make helper requests', async (t) => {
  let calls = 0;
  replaceGlobals(t, { fetch: async () => { calls++; throw new Error('offline'); } });
  const session = await startTelemetry({ measureCpu: true, rasters: [{ mode: 'cog' }] });
  const result = await session.finish();
  assert.equal(result.systemCpuMeanPercent, null);
  assert.equal(result.serverGetRequestCount, null);
  assert.ok(result.cpuStatus.startsWith('unavailable'));
  const previousCalls = calls;
  const disabled = await startTelemetry({ measureCpu: false, rasters: [] });
  assert.equal((await disabled.finish()).cpuStatus, 'disabled');
  assert.equal(calls, previousCalls);
});

test('telemetry snapshots expose real counter deltas and take the CPU baseline after server polling', async (t) => {
  const calls = [];
  let cpuCalls = 0, serverCalls = 0;
  replaceGlobals(t, { fetch: async (url) => {
    calls.push(url);
    const value = url.includes('/cpu') ? {
      scope: 'system', monotonicMs: ++cpuCalls === 1 ? 1000 : 2000,
      cpuTotalSeconds: cpuCalls === 1 ? 100 : 120, cpuIdleSeconds: cpuCalls === 1 ? 80 : 90,
      samples: [{ monotonicMs: 1500, percent: 60 }],
    } : {
      instance: 'server', requestCount: ++serverCalls === 1 ? 0 : 2, getRequestCount: serverCalls === 1 ? 0 : 2,
      rangeGetRequestCount: serverCalls === 1 ? 0 : 2, completedRequestCount: serverCalls === 1 ? 0 : 2,
      bodyBytesSent: serverCalls === 1 ? 0 : 1024, responseStatuses: serverCalls === 1 ? {} : { '206': 2 },
    };
    return { ok: true, json: async () => value };
  } });
  const session = await startTelemetry({ measureCpu: true, rasters: [{ mode: 'cog' }] });
  const result = await session.finish();
  assert.ok(calls[0].endsWith('/metrics'));
  assert.ok(calls[1].endsWith('/cpu'));
  assert.equal(result.systemCpuMeanPercent, 50);
  assert.equal(result.systemCpuPeakPercent, 60);
  assert.equal(result.serverGetRequestCount, 2);
  assert.equal(result.serverRangeGetRequestCount, 2);
  assert.equal(result.serverBodyBytesSent, 1024);
});

test('CSV exports metric totals but keeps request details and CPU samples in JSON', () => {
  const csv = toCsv([{ fpsLow1Percent: 30, systemCpuMeanPercent: 25, transferBytes: 1024,
    networkRequests: [{ durationMs: 100 }], systemCpuSamples: [{ percent: 50 }] }]);
  assert.ok(csv.includes('fpsLow1Percent'));
  assert.ok(csv.includes('"1024"'));
  assert.ok(!csv.includes('networkRequests'));
  assert.ok(!csv.includes('systemCpuSamples'));
});


test('final color restyle network requests have their own phase and totals', (t) => {
  let observer;
  replaceGlobals(t, { performance: { timeOrigin: 1000 }, location: { origin: 'http://app' },
    PerformanceObserver: class {
      static supportedEntryTypes = ['resource'];
      constructor() { observer = this; this.pending = []; }
      observe() {}
      takeRecords() { return this.pending; }
      disconnect() {}
    },
  });
  const collector = observeNetwork();
  observer.pending.push(...[10, 40, 65, 85].map((startTime) => resource({ startTime })));
  const row = collector.finish(5, 100, 30, 60, 80, 100);
  assert.deepEqual(row.networkRequests.map((entry) => entry.phase),
    ['initialOrBeforeChange', 'timeChange', 'afterChange', 'colorRestyle']);
  assert.equal(row.requestCount, 4);
  assert.equal(row.timeChangeNetwork.requestCount, 1);
  assert.equal(row.colorRestyleNetwork.requestCount, 1);
  assert.equal(row.colorRestyleNetwork.fetchedBodyBytes, 2048);
});

test('concurrent data fetch intervals form a union while transfer/render work is summed', () => {
  const records = [[10, 40], [20, 60], [80, 90]].map(([startTime, responseEnd]) =>
    resourceRecord(resource({ startTime, responseEnd, responseStart: startTime + 5,
      serverTiming: [{ name: 'render', duration: 3 }] }), 1000));
  records.push(resourceRecord(resource({ name: 'http://app/decoder.wasm', startTime: 0, responseEnd: 200 }), 1000, 'window', 'http://app'));
  const result = summarizeNetwork(records);
  assert.equal(result.dataFetchActiveMs, 60);
  assert.equal(result.dataBodyTransferMs, 65);
  assert.equal(result.serverRenderMs, 9);
  assert.equal(summarizeNetwork([resourceRecord(resource({ responseStart: 0 }), 1000)]).dataBodyTransferMs, null);
});

test('process CPU uses identities, core normalization and trial samples without summing independent RSS peaks', () => {
  const processes = [
    { identity: '1:100', role: 'browser-renderer', cpuSeconds: 10, rssBytes: 100 },
    { identity: '2:100', role: 'browser-gpu-process', cpuSeconds: 10, rssBytes: 100 },
    { identity: '3:100', role: 'wms-png-server', cpuSeconds: 10, rssBytes: 200 },
  ];
  const before = { monotonicMs: 1000, processes };
  const sample = (monotonicMs, renderer, gpu) => ({ monotonicMs, groups: [
    { role: 'browser-renderer', rssBytes: renderer, cpuPercent: 40 },
    { role: 'browser-gpu-process', rssBytes: gpu, cpuPercent: 20 },
  ] });
  const after = { monotonicMs: 2000, logicalCpuCount: 4,
    processes: processes.map((item) => ({ ...item, cpuSeconds: item.cpuSeconds + 0.5 })),
    processSamples: [sample(900, 9000, 9000), sample(1250, 500, 100), sample(1750, 100, 400)] };
  const result = processSummary(before, after);
  assert.equal(result.browserCpuMeanPercent, 25);
  assert.equal(result.serverCpuMeanPercent, 12.5);
  assert.equal(result.browserRssPeakBytes, 600);
  assert.equal(result.processMetrics[0].cpuMeanPercent, 50);
  assert.equal(result.processMetrics[0].cpuPeakPercent, 40);
  assert.equal(result.processSamples.length, 2);
  const changed = processSummary(before, { ...after, processes: [{ ...processes[0], identity: '1:200' }] });
  assert.equal(changed.browserCpuMeanPercent, null);
  assert.ok(changed.processMetrics.every(({ counterCoverage }) => counterCoverage.startsWith('partial')));
  assert.equal(processSummary(null, after).browserRssPeakBytes, null);
});

test('trial-specific server counters include failures and aborts even for an interrupted trial', async (t) => {
  const controller = new AbortController(), urls = [];
  let count = 0;
  replaceGlobals(t, { fetch: async (url) => {
    urls.push(url);
    const initial = count++ === 0;
    return { ok: true, json: async () => ({ instance: 'scope', scopedMetricsSupported: true,
      requestCount: initial ? 0 : 4, getRequestCount: initial ? 0 : 4,
      rangeGetRequestCount: 0, completedRequestCount: initial ? 0 : 3,
      bodyBytesSent: initial ? 0 : 100, abortedRequestCount: initial ? 0 : 2,
      disconnectAccountingSupported: true, clientDisconnectedRequestCount: initial ? 0 : 2,
      truncatedResponseCount: initial ? 0 : 1, handlerErrorCount: initial ? 0 : 0,
      connectionPolicy: { version: 1, httpProtocol: 'HTTP/1.1', requestQueueSize: 256, socketTimeoutSeconds: 30, tcpNoDelay: true },
      responseStatuses: initial ? {} : { '200': 1, '404': 1, '0': 1 } }) };
  } });
  const session = await startTelemetry({ rasters: [{ mode: 'wms' }], requestScope: 'private-trial', signal: controller.signal });
  controller.abort(new Error('Stopped'));
  const row = await session.finish({ ignoreAbort: true });
  assert.ok(urls.every((url) => url.endsWith('/metrics?scope=private-trial')));
  assert.equal(row.serverRequestCount, 4);
  assert.equal(row.serverFailedResponseCount, 1);
  assert.equal(row.serverIncompleteRequestCount, 1);
  assert.equal(row.serverAbortedRequestCount, 2);
  assert.equal(row.serverClientDisconnectedRequestCount, 2);
  assert.equal(row.serverTruncatedResponseCount, 1);
  assert.equal(row.serverHandlerErrorCount, 0);
  assert.equal(row.serverNoResponseCount, 1);
  assert.equal(row.serverConnectionPolicies[0].httpProtocol, 'HTTP/1.1');
  assert.ok(row.serverMetricsScope.startsWith('this trial only'));
  assert.ok(!JSON.stringify(row).includes('private-trial'));
});
