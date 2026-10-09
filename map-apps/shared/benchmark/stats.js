export function percentile(values, percent) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)];
}

export function summarizeFrames(intervals) {
  const elapsed = intervals.reduce((sum, value) => sum + value, 0);
  const slowest = [...intervals].sort((a, b) => b - a);
  const low = (fraction) => {
    const count = Math.ceil(slowest.length * fraction);
    const time = slowest.slice(0, count).reduce((sum, value) => sum + value, 0);
    return time > 0 ? count * 1000 / time : null;
  };
  return {
    frameSamples: intervals.length,
    measuredMotionMs: elapsed,
    rafFps: elapsed > 0 ? (intervals.length * 1000) / elapsed : null,
    fpsLow5Percent: low(0.05),
    fpsLow1Percent: low(0.01),
    low5PercentSamples: Math.ceil(intervals.length * 0.05),
    low1PercentSamples: Math.ceil(intervals.length * 0.01),
    meanFrameMs: intervals.length ? elapsed / intervals.length : null,
    medianFrameMs: percentile(intervals, 50),
    p95FrameMs: percentile(intervals, 95),
    p99FrameMs: percentile(intervals, 99),
    maxFrameMs: intervals.length ? Math.max(...intervals) : null,
    framesOver50Ms: intervals.filter((value) => value > 50).length,
    framesOver100Ms: intervals.filter((value) => value > 100).length,
    framesOver33Ms: intervals.filter((value) => value > 1000 / 30).length,
  };
}

export function toCsv(rows) {
  if (!rows.length) return '';
  const columns = [...new Set(rows.flatMap(Object.keys))].filter((key) =>
    !/frameIntervalsMs$/i.test(key) && !['networkRequests', 'systemCpuSamples'].includes(key));
  const cell = (value) => {
    let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    // Prevent spreadsheet formula interpretation of text fields.
    if (typeof value === 'string' && /^[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [columns.map(cell).join(','), ...rows.map((row) => columns.map((key) => cell(row[key])).join(','))].join('\r\n');
}
