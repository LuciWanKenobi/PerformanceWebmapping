import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { COLOR_TABLES } from './shared/color-tables.js';
import { supportsRasterConnections } from './shared/benchmark/server-policy.js';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function serviceSpecs(directory, env, python = 'python', servicesOnly = false) {
  const project = path.dirname(directory);
  const specs = [
    ['COG server', 'cog', 'VITE_COG_SERVER', 8001, 'serve_cog.py'],
    ['WMS server', 'wms', 'VITE_WMS_SERVER', 8002, 'serve_wms.py'],
    ['CPU helper', 'benchmark-metrics', 'VITE_METRICS_SERVER', 8004, 'serve_metrics.py'],
  ].map(([name, service, key, port, script]) => {
    const url = new URL(env[key] || 'http://127.0.0.1:' + port);
    const local = ['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol === 'http:' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
    return { name, service, url: url.href.replace(/\/$/, ''), local,
      command: python, args: ['-u', path.join(project, 'test_data', script), '--host', '127.0.0.1', '--port', url.port || '80'], cwd: project };
  });
  if (!servicesOnly) specs.push({ name: 'Map app', service: 'vite', url: 'http://127.0.0.1:5173', local: true,
    command: process.execPath, args: [path.join(directory, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], cwd: directory });
  return specs;
}

export async function probeService(spec) {
  let response;
  try { response = await fetch(spec.url + (spec.service === 'vite' ? '/' : '/health'), { signal: AbortSignal.timeout(1500) }); }
  catch { return false; }
  if (!response.ok) throw new Error(spec.name + ' at ' + spec.url + ' returned HTTP ' + response.status + '. Check the existing server.');
  if (spec.service === 'vite') {
    if (!(await response.text()).includes('<title>Mapping apps</title>')) throw new Error('Port 5173 is occupied by a different app.');
  } else {
    let health;
    try { health = await response.json(); } catch { throw new Error(spec.name + ': the configured URL does not serve this project.'); }
    if (health.service !== spec.service) throw new Error(spec.name + ': another service occupies ' + spec.url + '. Check .env.local.');
    if (spec.service === 'wms' && JSON.stringify(health.colorTables) !== JSON.stringify(COLOR_TABLES)) {
      throw new Error('Restart the updated ' + spec.name + ' at ' + spec.url + '; matching parameter color tables are required. Stop the existing server, then rerun npm run start:all.');
    }
    if (spec.service === 'wms' && (health.xyzDelivery !== 'precomputed-only' || health.xyzColorRestyleSupported !== false)) {
      throw new Error('Restart the updated ' + spec.name + ' at ' + spec.url + '; PNG tiles must be precomputed and read-only. Stop the existing server, then rerun npm run start:all.');
    }
    if (['cog', 'wms'].includes(spec.service)) {
      const response = await fetch(spec.url + '/metrics', { signal: AbortSignal.timeout(1500) });
      const metrics = response.ok ? await response.json() : null;
      if (!metrics?.cacheIsolationSupported) throw new Error('Restart the updated ' + spec.name + ' at ' + spec.url + '; cache isolation is required.');
      if (!supportsRasterConnections(metrics)) throw new Error('Restart the updated ' + spec.name + ' at ' + spec.url + '; HTTP/1.1 connection handling and disconnect accounting are required.');
    }
  }
  return true;
}

function portListening(url) {
  const target = new URL(url);
  return new Promise((resolve) => {
    const socket = createConnection({ host: target.hostname, port: Number(target.port || 80) });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(1000, () => done(false));
  });
}

export async function stopServices(started) {
  await Promise.all(started.map(async ({ child }) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
  }));
}

export async function startServices(specs, logDirectory, started, report = console.log, timeoutMs = 15000, signal) {
  mkdirSync(logDirectory, { recursive: true });
  for (const spec of specs) {
    signal?.throwIfAborted();
    if (await probeService(spec)) { report(spec.name + ' ready (existing): ' + spec.url); continue; }
    if (!spec.local) throw new Error(spec.name + ' is unavailable at ' + spec.url + '. Remote services must be started on their host.');
    if (await portListening(spec.url)) throw new Error(spec.name + ' has a listener at ' + spec.url + ' but is not healthy. Check that server before restarting.');
    signal?.throwIfAborted();
    const log = path.join(logDirectory, spec.service + '.log');
    const fd = openSync(log, 'w');
    let child;
    try { child = spawn(spec.command, spec.args, { cwd: spec.cwd, windowsHide: true, stdio: ['ignore', fd, fd] }); }
    finally { closeSync(fd); }
    const state = { child, spec, log, error: null };
    child.on('error', (error) => { state.error = error; });
    started.push(state);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      await pause(150);
      signal?.throwIfAborted();
      if (state.error || child.exitCode !== null || child.signalCode !== null) {
        const detail = state.error?.message || readFileSync(log, 'utf8').slice(-3000);
        throw new Error(spec.name + ' failed to start: ' + detail + '\nPython dependencies: python -m pip install -r ../test_data/requirements.txt');
      }
      if (await probeService(spec)) break;
      if (Date.now() >= deadline) throw new Error(spec.name + ' did not become ready. See ' + log);
    }
    report(spec.name + ' ready: ' + spec.url);
  }
}

async function main() {
  const started = [];
  let stopping = false;
  const controller = new AbortController();
  const stop = () => { stopping = true; controller.abort(new Error('Stopped.')); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const env = loadEnv('development', appDir, 'VITE_');
    const specs = serviceSpecs(appDir, env, process.env.PYTHON || 'python', process.argv.includes('--services-only'));
    await startServices(specs, path.join(appDir, '.local-services'), started, console.log, 15000, controller.signal);
    console.log('All services ready. Keep this terminal open; Ctrl+C stops only services started here.');
    while (!stopping) {
      await pause(500);
      for (const state of started) {
        if (state.error || state.child.exitCode !== null || state.child.signalCode !== null) throw new Error(state.spec.name + ' stopped. See ' + state.log);
      }
    }
  } catch (error) { if (!stopping) { console.error(error.message); process.exitCode = 1; } }
  finally { await stopServices(started); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
