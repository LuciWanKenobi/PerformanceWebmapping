import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { COLOR_TABLES } from '../shared/color-tables.js';
import { serviceSpecs, probeService, startServices, stopServices } from '../start-all.mjs';

async function temporaryLogs(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'map-launcher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function server(t, handler) {
  const instance = createServer(handler);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { instance.close(resolve); instance.closeAllConnections(); }));
  return 'http://127.0.0.1:' + instance.address().port;
}
async function freeUrl() {
  const instance = createTcpServer();
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + instance.address().port;
  await new Promise((resolve) => instance.close(resolve));
  return url;
}
function spec(url, command = process.execPath, args = []) {
  return { name: 'CPU helper', service: 'benchmark-metrics', url, local: true, command, args, cwd: path.resolve('.') };
}

test('launcher uses configured ports and a selected Python interpreter', () => {
  const services = serviceSpecs(path.resolve('app'), { VITE_COG_SERVER: 'http://localhost:8101',
    VITE_WMS_SERVER: 'http://127.0.0.1:8102', VITE_METRICS_SERVER: 'http://127.0.0.1:8104' }, 'custom-python', true);
  assert.deepEqual(services.map(({ args }) => args.at(-1)), ['8101', '8102', '8104']);
  assert.ok(services.every(({ command, local }) => command === 'custom-python' && local));
  assert.equal(serviceSpecs(path.resolve('app'), { VITE_WMS_SERVER: 'https://example.org/raster' }, 'python', true)[1].local, false);
});

test('healthy existing services are reused without spawning duplicate processes', async (t) => {
  const url = await server(t, (req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/metrics' ? { cacheIsolationSupported: true } : { service: 'wms', colorTables: COLOR_TABLES })); });
  const service = { ...spec(url, 'nonexistent-executable'), service: 'wms' };
  const started = [], reports = [];
  await startServices([service], await temporaryLogs(t), started, (message) => reports.push(message));
  assert.equal(started.length, 0);
  assert.ok(reports[0].includes('ready (existing)'));
});

test('wrong and outdated servers fail clearly without replacing the listener', async (t) => {
  const wrong = await server(t, (_req, res) => res.end(JSON.stringify({ service: 'other' })));
  await assert.rejects(probeService(spec(wrong)), /another service occupies/);
  const outdated = await server(t, (req, res) => res.end(JSON.stringify(req.url === '/metrics' ? {} : { service: 'wms' })));
  await assert.rejects(probeService({ ...spec(outdated), service: 'wms' }), /Restart the updated WMS|Restart the updated CPU helper/);
  const oldTables = await server(t, (req, res) => res.end(JSON.stringify(req.url === '/metrics' ? { cacheIsolationSupported: true } : { service: 'wms' })));
  await assert.rejects(probeService({ ...spec(oldTables), service: 'wms' }), /matching parameter color tables/);
});

test('missing executables and startup crashes include a useful error and clean up', async (t) => {
  for (const [command, args, expected] of [['definitely-missing-map-python', [], /failed to start/],
    [process.execPath, ['-e', 'console.error("missing dependency"); process.exit(7)'], /missing dependency/]]) {
    const started = [];
    try { await assert.rejects(startServices([spec(await freeUrl(), command, args)], await temporaryLogs(t), started, () => {}), expected); }
    finally { await stopServices(started); }
    assert.ok(started.every(({ child }) => !child.pid || child.exitCode !== null || child.signalCode !== null));
  }
});

test('launcher waits for a newly started server and terminates only its own process', async (t) => {
  const url = await freeUrl();
  const port = new URL(url).port;
  const source = 'const http=require("node:http");setTimeout(()=>http.createServer((req,res)=>res.end(JSON.stringify({service:"benchmark-metrics"}))).listen(' + port + ',"127.0.0.1"),250);';
  const started = [], reports = [];
  try {
    await startServices([spec(url, process.execPath, ['-e', source])], await temporaryLogs(t), started, (message) => reports.push(message));
    assert.equal(started.length, 1);
    assert.ok(await probeService(spec(url)));
    assert.ok(reports[0].includes('ready:'));
  } finally { await stopServices(started); }
  assert.ok(started[0].child.exitCode !== null || started[0].child.signalCode !== null);
});
