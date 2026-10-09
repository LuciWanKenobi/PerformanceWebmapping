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
  return result;
}

export async function startTelemetry({ measureCpu = false, measureServerMetrics = true, rasters = [], signal }) {
  const servers = measureServerMetrics ? [...new Set(rasters.map(({ mode }) => ['wms', 'xyz'].includes(mode) ? WMS_SERVER : COG_SERVER))] : [];
  const before = await Promise.all(servers.map((server) => snapshot(`${server}/metrics`, signal)));
  // Take the CPU baseline last so slow/unavailable raster metric endpoints do
  // not add idle preparation time to the CPU utilization window.
  const cpuBefore = measureCpu ? await snapshot(`${METRICS_SERVER}/cpu`, signal) : null;
  return {
    async finish() {
      const [cpuAfter, after] = await Promise.all([
        cpuBefore ? snapshot(`${METRICS_SERVER}/cpu?since=${cpuBefore.monotonicMs}`, signal) : null,
        Promise.all(servers.map((server) => snapshot(`${server}/metrics`, signal))),
      ]);
      const deltas = before.map((entry, i) => serverSummary(entry, after[i]));
      const valid = measureServerMetrics && deltas.every(Boolean);
      const sum = (key) => valid ? deltas.reduce((total, entry) => total + entry[key], 0) : null;
      return {
        cpuStatus: !measureCpu ? 'disabled' : cpuBefore && cpuAfter ? 'system CPU (all processes)' : 'unavailable; start the local CPU helper',
        ...cpuSummary(cpuBefore, cpuAfter),
        serverMetricsStatus: !measureServerMetrics ? 'disabled' : !servers.length ? 'no raster servers used' : valid ? 'cumulative raster-server counter deltas; all clients' : 'unavailable or server restarted; restart updated data servers',
        serverRequestCount: sum('requestCount'), serverGetRequestCount: sum('getRequestCount'),
        serverRangeGetRequestCount: sum('rangeGetRequestCount'), serverCompletedRequestCount: sum('completedRequestCount'),
        serverBodyBytesSent: sum('bodyBytesSent'),
        serverResponseStatuses: valid ? deltas.reduce((counts, entry) => {
          for (const [status, count] of Object.entries(entry.responseStatuses)) counts[status] = (counts[status] ?? 0) + count;
          return counts;
        }, {}) : null,
      };
    },
  };
}
