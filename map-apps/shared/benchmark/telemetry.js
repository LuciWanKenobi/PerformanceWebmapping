import { COG_SERVER, WMS_SERVER, METRICS_SERVER } from '../config.js';
import { percentile } from './stats.js';

async function snapshot(url, signal) {
  signal?.throwIfAborted();
  try {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.any([
      ...(signal ? [signal] : []), AbortSignal.timeout(1500),
    ]) });
    if (!response.ok) return null;
    return await response.json();
  } catch { signal?.throwIfAborted(); return null; }
}

export function cpuSummary(before, after) {
  const unavailable = { systemCpuMeanPercent: null, systemCpuSampleMeanPercent: null,
    systemCpuPeakPercent: null, systemCpuP95Percent: null, systemCpuLastPercent: null,
    systemCpuSampleCount: 0, systemCpuWindowMs: null, systemCpuSamplePeriodMs: null,
    systemCpuLogicalCores: null, systemCpuSamples: [] };
  if (before?.scope !== 'system' || after?.scope !== 'system' || after.monotonicMs <= before.monotonicMs) return unavailable;
  const total = after.cpuTotalSeconds - before.cpuTotalSeconds;
  const idle = after.cpuIdleSeconds - before.cpuIdleSeconds;
  const samples = (after.samples ?? []).filter((entry) => entry.monotonicMs > before.monotonicMs && entry.monotonicMs <= after.monotonicMs);
  const values = samples.map((entry) => entry.percent);
  return {
    systemCpuMeanPercent: total > 0 && idle >= 0 && idle <= total ? 100 * (total - idle) / total : null,
    systemCpuSampleMeanPercent: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    systemCpuPeakPercent: values.length ? Math.max(...values) : null,
    systemCpuP95Percent: percentile(values, 95),
    systemCpuLastPercent: values.at(-1) ?? null,
    systemCpuSampleCount: values.length,
    systemCpuWindowMs: after.monotonicMs - before.monotonicMs,
    systemCpuSamplePeriodMs: after.samplePeriodMs,
    systemCpuLogicalCores: after.logicalCpuCount,
    systemCpuSamples: samples.map((entry) => ({ elapsedMs: entry.monotonicMs - before.monotonicMs, percent: entry.percent })),
  };
}

export function serverSummary(before, after) {
  if (!before?.instance || before.instance !== after?.instance) return null;
  const keys = ['requestCount', 'getRequestCount', 'rangeGetRequestCount', 'completedRequestCount', 'bodyBytesSent'];
  const result = {};
  for (const key of keys) {
    if (!Number.isFinite(before[key]) || !Number.isFinite(after[key]) || after[key] < before[key]) return null;
    result[key] = after[key] - before[key];
  }
  result.responseStatuses = Object.fromEntries(Object.keys(after.responseStatuses ?? {}).map((key) =>
    [key, after.responseStatuses[key] - (before.responseStatuses?.[key] ?? 0)]));
  for (const key of ['abortedRequestCount', 'clientDisconnectedRequestCount', 'truncatedResponseCount', 'handlerErrorCount']) {
    result[key] = Number.isFinite(before[key]) && Number.isFinite(after[key]) && after[key] >= before[key] ? after[key] - before[key] : null;
  }
  return result;
}

export function processSummary(before, after) {
  const samples = (after?.processSamples ?? []).filter(({ monotonicMs }) =>
    monotonicMs > before?.monotonicMs && monotonicMs <= after?.monotonicMs);
  if (!before?.processes || !after?.processes || after.monotonicMs <= before.monotonicMs) {
    return { processMetricsStatus: 'unavailable; restart the updated CPU helper', processMetrics: [], processSamples: [],
      browserCpuMeanPercent: null, serverCpuMeanPercent: null, browserRssPeakBytes: null };
  }
  const elapsed = (after.monotonicMs - before.monotonicMs) / 1000;
  const previous = new Map(before.processes.map((entry) => [entry.identity, entry]));
  const groups = new Map();
  for (const entry of after.processes) {
    const old = previous.get(entry.identity);
    const cpuSeconds = old ? entry.cpuSeconds - old.cpuSeconds : null;
    if (!groups.has(entry.role)) groups.set(entry.role, { role: entry.role, processCount: 0, cpuSeconds: 0, complete: true, rssBytes: 0 });
    const group = groups.get(entry.role); group.processCount++; group.rssBytes += entry.rssBytes;
    if (cpuSeconds == null || cpuSeconds < 0) group.complete = false;
    else group.cpuSeconds += cpuSeconds;
  }
  const remaining = new Set(after.processes.map(({ identity }) => identity));
  for (const entry of before.processes) if (!remaining.has(entry.identity)) {
    if (!groups.has(entry.role)) groups.set(entry.role, { role: entry.role, processCount: 0, cpuSeconds: 0, complete: false, rssBytes: 0 });
    groups.get(entry.role).complete = false;
  }
  const metrics = [...groups.values()].map(({ complete, ...group }) => ({ ...group,
    counterCoverage: complete ? 'complete' : 'partial; processes started/exited during the window',
    cpuMeanPercent: complete ? 100 * group.cpuSeconds / elapsed : null,
    cpuMachineMeanPercent: complete && after.logicalCpuCount ? 100 * group.cpuSeconds / elapsed / after.logicalCpuCount : null,
    rssPeakBytes: Math.max(group.rssBytes, before.processes.filter(({ role }) => role === group.role).reduce((sum, entry) => sum + entry.rssBytes, 0),
      ...samples.map((sample) => sample.groups?.find(({ role }) => role === group.role)?.rssBytes ?? 0)),
    cpuPeakPercent: samples.length ? Math.max(...samples.map((sample) => sample.groups?.find(({ role }) => role === group.role)?.cpuPercent ?? 0)) : null,
  }));
  const browser = metrics.filter(({ role }) => role.startsWith('browser-'));
  const servers = metrics.filter(({ role }) => role.endsWith('-server'));
  const cpu = (items) => items.length && items.every(({ cpuMachineMeanPercent }) => cpuMachineMeanPercent != null)
    ? items.reduce((sum, item) => sum + item.cpuMachineMeanPercent, 0) : null;
  const browserRss = browser.reduce((sum, item) => sum + item.rssBytes, 0);
  return { browserCpuMeanPercent: cpu(browser), serverCpuMeanPercent: cpu(servers),
    browserRssPeakBytes: browser.length ? Math.max(browserRss, before.processes.filter(({ role }) => role.startsWith('browser-')).reduce((sum, entry) => sum + entry.rssBytes, 0), ...samples.map((sample) =>
      (sample.groups ?? []).filter(({ role }) => role.startsWith('browser-')).reduce((sum, item) => sum + item.rssBytes, 0))) : null,
    processMetricsStatus: 'sampled all running browser processes, grouped by role, and local raster servers; not isolated to this tab; per-role 100% CPU = one logical core; browser/server totals normalized to all cores. Summed process RSS can double-count shared pages and excludes GPU VRAM.',
    processMetrics: metrics, processSamples: samples.map(({ monotonicMs, ...sample }) => ({ ...sample, elapsedMs: monotonicMs - before.monotonicMs })) };
}

export async function startTelemetry({ measureCpu = false, measureServerMetrics = true, rasters = [], requestScope, signal }) {
  const servers = measureServerMetrics ? [...new Set(rasters.map(({ mode }) => ['wms', 'xyz'].includes(mode) ? WMS_SERVER : COG_SERVER))] : [];
  const suffix = requestScope ? `?scope=${encodeURIComponent(requestScope)}` : '';
  const before = await Promise.all(servers.map((server) => snapshot(`${server}/metrics${suffix}`, signal)));
  // Take the CPU baseline last so slow/unavailable raster metric endpoints do
  // not add idle preparation time to the CPU utilization window.
  const cpuBefore = measureCpu ? await snapshot(`${METRICS_SERVER}/cpu`, signal) : null;
  return {
    async finish({ ignoreAbort = false } = {}) {
      const finishSignal = ignoreAbort ? undefined : signal;
      const [cpuAfter, after] = await Promise.all([
        cpuBefore ? snapshot(`${METRICS_SERVER}/cpu?since=${cpuBefore.monotonicMs}`, finishSignal) : null,
        Promise.all(servers.map((server) => snapshot(`${server}/metrics${suffix}`, finishSignal))),
      ]);
      const deltas = before.map((entry, i) => serverSummary(entry, after[i]));
      const valid = measureServerMetrics && deltas.every(Boolean);
      const scoped = Boolean(requestScope && servers.length && before.every((entry) => entry?.scopedMetricsSupported) && after.every((entry) => entry?.scopedMetricsSupported));
      const processResult = processSummary(cpuBefore, cpuAfter);
      const sum = (key) => valid ? deltas.reduce((total, entry) => total + entry[key], 0) : null;
      return {
        cpuStatus: !measureCpu ? 'disabled' : cpuBefore && cpuAfter ? 'system CPU (all processes)' : 'unavailable; start the local CPU helper',
        ...cpuSummary(cpuBefore, cpuAfter),
        ...processResult,
        processMetricsStatus: measureCpu ? processResult.processMetricsStatus : 'disabled',
        serverMetricsStatus: !measureServerMetrics ? 'disabled' : !servers.length ? 'no raster servers used' : valid ? 'raster-server counter deltas; ' + (scoped ? 'this trial only' : 'all clients') : 'unavailable or server restarted; restart updated data servers',
        serverRequestCount: sum('requestCount'), serverGetRequestCount: sum('getRequestCount'),
        serverRangeGetRequestCount: sum('rangeGetRequestCount'), serverCompletedRequestCount: sum('completedRequestCount'),
        serverBodyBytesSent: sum('bodyBytesSent'),
        serverMetricsScope: !measureServerMetrics ? 'disabled' : !servers.length ? 'no raster servers used' : scoped ? 'this trial only; private request scope' : 'all clients; scoped counters unavailable',
        serverIncompleteRequestCount: valid ? Math.max(0, sum('requestCount') - sum('completedRequestCount')) : null,
        serverAbortedRequestCount: valid && deltas.every((entry) => entry.abortedRequestCount != null) ? sum('abortedRequestCount') : null,
        serverClientDisconnectedRequestCount: valid && deltas.every((entry) => entry.clientDisconnectedRequestCount != null) ? sum('clientDisconnectedRequestCount') : null,
        serverTruncatedResponseCount: valid && deltas.every((entry) => entry.truncatedResponseCount != null) ? sum('truncatedResponseCount') : null,
        serverHandlerErrorCount: valid && deltas.every((entry) => entry.handlerErrorCount != null) ? sum('handlerErrorCount') : null,
        serverNoResponseCount: valid ? deltas.reduce((sum, entry) => sum + (entry.responseStatuses['0'] ?? 0), 0) : null,
        serverFailedResponseCount: valid ? deltas.reduce((sum, entry) => sum + Object.entries(entry.responseStatuses).reduce((count, [status, value]) => count + (Number(status) >= 400 ? value : 0), 0), 0) : null,
        serverConnectionPolicies: before.map((entry, index) => {
          const policy = entry?.connectionPolicy;
          return { serverIndex: index + 1, version: policy?.version ?? null, httpProtocol: policy?.httpProtocol ?? null,
            requestQueueSize: policy?.requestQueueSize ?? null, socketTimeoutSeconds: policy?.socketTimeoutSeconds ?? null,
            tcpNoDelay: policy?.tcpNoDelay ?? null };
        }),
        serverDisconnectAccountingStatus: !servers.length ? 'no raster servers used'
          : before.every((entry) => entry?.disconnectAccountingSupported) && after.every((entry) => entry?.disconnectAccountingSupported)
            ? 'observed disconnects and truncated bodies; server cannot infer cancellation intent; browser superseded-work counters are separate'
            : 'unavailable; restart updated data servers',
        serverResponseStatuses: valid ? deltas.reduce((counts, entry) => {
          for (const [status, count] of Object.entries(entry.responseStatuses)) counts[status] = (counts[status] ?? 0) + count;
          return counts;
        }, {}) : null,
      };
    },
  };
}
