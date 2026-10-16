(function (root) {
  'use strict';
  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, '');
    const records = []; let row = [], field = '', quoted = false, closed = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') { quoted = false; closed = true; }
        else field += c;
      } else if (c === '"' && !field && !closed) quoted = true;
      else if (c === ',' || c === '\n' || c === '\r') {
        row.push(field); field = ''; closed = false;
        if (c !== ',') { if (row.some(v => v !== '')) records.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
      } else { if (closed || c === '"') throw new Error('Invalid CSV quoting.'); field += c; }
    }
    if (quoted) throw new Error('The CSV contains an unclosed quoted field.');
    if (field || row.length) { row.push(field); if (row.some(v => v !== '')) records.push(row); }
    if (records.length < 2) throw new Error('The CSV needs a header and at least one data row.');
    const headers = records.shift().map(v => v.trim());
    if (new Set(headers).size !== headers.length || headers.some(v => !v)) throw new Error('CSV column names must be unique and nonempty.');
    const rows = records.map((values, index) => {
      if (values.length !== headers.length) throw new Error(`Row ${index + 2} has ${values.length} fields; expected ${headers.length}.`);
      return Object.fromEntries(headers.map((key, i) => [key, values[i]]));
    });
    if (!headers.includes('rafFps') || !headers.includes('recordType')) throw new Error('Expected a benchmark CSV with recordType and rafFps columns.');
    return {headers, rows};
  }
  function number(value) { if (value === null || value === undefined || String(value).trim() === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
  function quantile(values, p) { if (!values.length) return null; const v = [...values].sort((a,b) => a-b), i = (v.length-1)*p, lo = Math.floor(i); return v[lo] + (v[Math.ceil(i)]-v[lo])*(i-lo); }
  function aggregate(values, method = 'mean') { const v = values.filter(Number.isFinite); if (!v.length) return null; if (method === 'median') return quantile(v, .5); if (method === 'p95') return quantile(v, .95); return v.reduce((a,b)=>a+b,0)/v.length; }
  const natural = (a,b) => String(a).localeCompare(String(b), undefined, {numeric:true});
  const sceneOrder = ['I','II_A','II_B','III','V','VIII','IX'];
  const unique = (rows,key) => [...new Set(rows.map(r=>r[key] || 'Unknown'))].sort(key === 'sceneId' ? (a,b) => (sceneOrder.includes(a) ? sceneOrder.indexOf(a) : 100) - (sceneOrder.includes(b) ? sceneOrder.indexOf(b) : 100) || natural(a,b) : natural);
  function filterRows(rows, filters) { return rows.filter(row => Object.entries(filters).every(([key, allowed]) => allowed === null || allowed.includes(row[key] || 'Unknown'))); }
  function groups(rows, xKey, seriesKey, metric, method, divisor = 1) {
    return unique(rows, xKey).map(x => ({x, values:unique(rows, seriesKey).map(series => {
      const values = rows.filter(r => (r[xKey] || 'Unknown') === x && (r[seriesKey] || 'Unknown') === series).map(r=>number(r[metric])).filter(v=>v!==null).map(v=>v/divisor);
      return {series, n:values.length, value:aggregate(values, method)};
    })}));
  }
  const api = {parseCSV, number, quantile, aggregate, unique, filterRows, groups};
  if (typeof module !== 'undefined') module.exports = api;
  else root.BenchmarkCore = api;
})(globalThis);
