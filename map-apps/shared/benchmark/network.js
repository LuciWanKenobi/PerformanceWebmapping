import { COG_SERVER, WMS_SERVER } from '../config.js';
import { percentile } from './stats.js';

const workerSubscribers = new Set();
export function recordWorkerResource(entry) {
  for (const receive of workerSubscribers) receive(entry);
}

export function resourceKind(name, pageOrigin = globalThis.location?.origin) {
  let url;
  try { url = new URL(name); } catch { return null; }
  for (const base of [COG_SERVER, WMS_SERVER]) {
    const server = new URL(base);
    if (url.origin !== server.origin) continue;
    const prefix = server.pathname.replace(/\/$/, '');
    if (!url.pathname.startsWith(`${prefix}/`)) continue;
    const path = url.pathname.slice(prefix.length);
    if (path.startsWith('/cog/')) return 'cog';
    if (path.startsWith('/grib2/')) return 'grib';
    if (path.startsWith('/tiles/')) return 'png';
    if (path === '/wms' && [...url.searchParams].some(([key, value]) =>
      key.toUpperCase() === 'REQUEST' && value.toLowerCase() === 'getmap')) return 'wms';
  }
  if (url.origin === pageOrigin && url.pathname.endsWith('.wasm')) return 'decoder';
  if (url.origin === pageOrigin && /\.(?:m?js)$/.test(url.pathname)) return 'code';
  return null;
}

// No raw URLs or query strings are retained: they may contain access tokens.
export function resourceRecord(entry, timeOrigin, context = 'window', pageOrigin = globalThis.location?.origin) {
  const kind = resourceKind(entry.name, pageOrigin);
  if (!kind) return null;
  const exposed = entry.responseStart > 0 || entry.decodedBodySize > 0 || entry.transferSize > 0;
  const size = (key) => exposed && Number.isFinite(entry[key]) ? entry[key] : null;
  const mapIndex = Number(new URL(entry.name).searchParams.get('_map'));
  return {
    mapIndex: Number.isInteger(mapIndex) && mapIndex >= 1 && mapIndex <= 20 ? mapIndex : null,
    kind, context, startEpochMs: timeOrigin + entry.startTime,
    endEpochMs: timeOrigin + (entry.responseEnd || entry.startTime + entry.duration),
    durationMs: entry.duration,
    ttfbMs: entry.requestStart > 0 && entry.responseStart >= entry.requestStart
      ? entry.responseStart - entry.requestStart : null,
    transferBytes: size('transferSize'), encodedBodyBytes: size('encodedBodySize'),
    fetchedBodyBytes: size('decodedBodySize'),
    cacheHit: exposed ? entry.transferSize === 0 && entry.decodedBodySize > 0 : null,
    status: entry.responseStatus > 0 ? entry.responseStatus : null,
    initiator: entry.initiatorType || 'unknown',
  };
}

export function summarizeNetwork(records, available = true) {
  const knownSum = (key) => !available || records.some((entry) => entry[key] == null) ? null :
    records.reduce((sum, entry) => sum + entry[key], 0);
  const durations = records.map((entry) => entry.durationMs);
  const ttfb = records.map((entry) => entry.ttfbMs).filter((value) => value != null);
  return {
    requestCount: available ? records.length : null,
    dataRequestCount: available ? records.filter((entry) => ['cog', 'grib', 'png', 'wms'].includes(entry.kind)).length : null,
    decoderRequestCount: available ? records.filter((entry) => entry.kind === 'decoder').length : null,
    codeRequestCount: available ? records.filter((entry) => entry.kind === 'code').length : null,
    transferBytes: knownSum('transferBytes'),
    encodedBodyBytes: knownSum('encodedBodyBytes'),
    fetchedBodyBytes: knownSum('fetchedBodyBytes'),
    knownTransferBytes: available ? records.reduce((sum, entry) => sum + (entry.transferBytes ?? 0), 0) : null,
    unknownSizeRequestCount: available ? records.filter((entry) => entry.transferBytes == null).length : null,
    cacheHitCount: available ? records.filter((entry) => entry.cacheHit === true).length : null,
    httpErrorCount: available ? records.filter((entry) => entry.status >= 400).length : null,
    requestMeanMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    requestP95Ms: percentile(durations, 95),
    requestMaxMs: durations.length ? Math.max(...durations) : null,
    ttfbMeanMs: ttfb.length ? ttfb.reduce((sum, value) => sum + value, 0) / ttfb.length : null,
  };
}

export function observeNetwork() {
  let observer;
  const records = [], seen = new Set();
  const available = Boolean(globalThis.PerformanceObserver?.supportedEntryTypes?.includes('resource'));
  const receive = (entry) => {
    if (!entry) return;
    // Stable worker message IDs prevent duplicate delivery being counted twice.
    const key = entry.recordId;
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    records.push(entry);
  };
  let sequence = 0;
  const collect = (entries) => entries.forEach((entry) => {
    const record = resourceRecord(entry, performance.timeOrigin);
    if (record) receive({ ...record, recordId: `window-${++sequence}` });
  });
  if (available) {
    observer = new PerformanceObserver((list) => collect(list.getEntries()));
    observer.observe({ type: 'resource', buffered: false });
  }
  workerSubscribers.add(receive);
  return {
    finish(start, end, timeChangeStart = null, timeChangeEnd = null, colorRestyleStart = null, colorRestyleEnd = null) {
      if (observer) collect(observer.takeRecords());
      observer?.disconnect();
      workerSubscribers.delete(receive);
      const origin = performance.timeOrigin;
      const requests = records.filter((entry) => entry.startEpochMs >= origin + start && entry.startEpochMs <= origin + end)
        .map(({ recordId, startEpochMs, endEpochMs, ...entry }) => ({ ...entry,
          startMs: startEpochMs - origin - start, endMs: endEpochMs - origin - start,
          phase: colorRestyleStart != null && startEpochMs >= origin + colorRestyleStart && startEpochMs <= origin + colorRestyleEnd
            ? 'colorRestyle' : timeChangeStart != null && startEpochMs >= origin + timeChangeStart && startEpochMs <= origin + timeChangeEnd
            ? 'timeChange' : timeChangeStart != null && startEpochMs > origin + timeChangeEnd ? 'afterChange' : 'initialOrBeforeChange',
        }));
      const changeRequests = requests.filter((entry) => entry.phase === 'timeChange');
      return {
        networkStatus: available ? 'Resource Timing: window plus instrumented GRIB workers' : 'Resource Timing unavailable; worker entries may be partial',
        ...summarizeNetwork(requests, available),
        colorRestyleNetwork: colorRestyleStart == null ? null : summarizeNetwork(requests.filter((entry) => entry.phase === 'colorRestyle'), available),
        timeChangeNetwork: timeChangeStart == null ? null : summarizeNetwork(changeRequests, available),
        networkRequests: requests,
      };
    },
    disconnect() { observer?.disconnect(); workerSubscribers.delete(receive); },
  };
}

// Each worker has its own Resource Timing timeline. Flush before sending ready
// or pixels so even a worker removed during a timestep leaves its download data.
export function observeWorkerResources(send) {
  if (!globalThis.PerformanceObserver?.supportedEntryTypes?.includes('resource')) return () => {};
  const context = `grib-worker-${crypto.randomUUID()}`;
  let sequence = 0;
  const collect = (entries) => entries.forEach((entry) => {
    const record = resourceRecord(entry, performance.timeOrigin, context);
    if (record) send({ type: 'resource', entry: { ...record, recordId: `${context}-${++sequence}` } });
  });
  const observer = new PerformanceObserver((list) => collect(list.getEntries()));
  observer.observe({ type: 'resource', buffered: true });
  return () => collect(observer.takeRecords());
}
