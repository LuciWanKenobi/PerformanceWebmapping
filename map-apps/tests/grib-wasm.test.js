import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createGribModuleLoader, instantiateGribModule } from '../shared/grib-wasm.js';
import { decodeGrib } from '../shared/grib-decoder.js';
import { mercatorY } from '../shared/cog-reader.js';

// A minimal module exporting its own memory, for tests independent of memory64.
const wasm = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  5, 3, 1, 0, 1,
  7, 10, 1, 6, 109, 101, 109, 111, 114, 121, 2, 0,
]);
const response = (type = 'application/wasm') => new Response(wasm, { headers: { 'Content-Type': type } });
const needsNode24 = Number(process.versions.node.split('.')[0]) < 24 ? 'ecCodes WASM tests require Node 24+' : false;
const require = createRequire(import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/temperature-ccsds.json', import.meta.url)));
const grib = readFileSync(new URL('./fixtures/temperature-ccsds.grib2', import.meta.url));
const compileDecoder = () => WebAssembly.compile(readFileSync(
  require.resolve('@meri-imperiumi/eccodes-wasm/build/eccodes/eccodes.wasm')));

test('concurrent and later layers share one lazy download and compiled module', async () => {
  let downloads = 0, release;
  const load = createGribModuleLoader('/decoder.wasm', (url) => {
    assert.equal(url, '/decoder.wasm');
    downloads++;
    return new Promise((resolve) => { release = resolve; });
  });
  assert.equal(downloads, 0);
  const first = load(), second = load(), third = load();
  assert.equal(downloads, 1);
  release(response());
  const modules = await Promise.all([first, second, third]);
  assert.ok(modules[0] instanceof WebAssembly.Module);
  assert.ok(modules.every((module) => module === modules[0]));
  assert.equal(await load(), modules[0]);
  assert.equal(downloads, 1);
});

test('decoder compilation also works when a server omits the WASM MIME type', async () => {
  const load = createGribModuleLoader('/decoder.wasm', async () => response('application/octet-stream'));
  assert.ok(await load() instanceof WebAssembly.Module);
});

test('failed downloads and compilation can be retried by later layers', async () => {
  let downloads = 0;
  const load = createGribModuleLoader('/decoder.wasm', async () => {
    downloads++;
    if (downloads === 1) return new Response('', { status: 503 });
    if (downloads === 2) return new Response('invalid wasm');
    return response();
  });
  await assert.rejects(Promise.all([load(), load()]), /HTTP 503/);
  assert.equal(downloads, 1);
  await assert.rejects(load(), WebAssembly.CompileError);
  const module = await load();
  assert.ok(module instanceof WebAssembly.Module);
  assert.equal(await load(), module);
  assert.equal(downloads, 3);
});

test('shared code creates instances with independent writable memory', async () => {
  const compiled = await WebAssembly.compile(wasm);
  const createRuntime = ({ instantiateWasm }) => new Promise((resolve) => {
    instantiateWasm({}, resolve);
  });
  const first = await instantiateGribModule(createRuntime, compiled);
  const second = await instantiateGribModule(createRuntime, compiled);
  assert.notEqual(first, second);
  new Uint8Array(first.exports.memory.buffer)[0] = 42;
  assert.equal(new Uint8Array(second.exports.memory.buffer)[0], 0);
});

test('real ecCodes runtimes reuse compiled code with independent memory and filesystems',
  { skip: needsNode24, timeout: 30000 }, async () => {
    const compiled = await compileDecoder();
    const createEccodesModule = require('@meri-imperiumi/eccodes-wasm/build/eccodes/eccodes.js');
    const [first, second] = await Promise.all([
      instantiateGribModule(createEccodesModule, compiled),
      instantiateGribModule(createEccodesModule, compiled),
    ]);
    assert.notEqual(first.HEAPU8.buffer, second.HEAPU8.buffer);
    first.FS.writeFile('/private-test', new Uint8Array([1, 2]));
    assert.equal(second.FS.analyzePath('/private-test').exists, false);
    for (const runtime of [first, second]) {
      assert.deepEqual([...decodeGrib(runtime, grib, 1, fixture.layer.nodata).values], fixture.values);
    }
  });

test('one downloaded decoder module is cloned into two workers with independent GRIB requests and styles',
  { skip: needsNode24, timeout: 30000 }, async () => {
    let decoderDownloads = 0, gribDownloads = 0;
    const decoder = readFileSync(require.resolve('@meri-imperiumi/eccodes-wasm/build/eccodes/eccodes.wasm'));
    const server = createServer((request, result) => {
      if (request.url === '/decoder.wasm') {
        decoderDownloads++;
        result.writeHead(200, { 'Content-Type': 'application/wasm' }); result.end(decoder);
      } else {
        gribDownloads++;
        result.writeHead(200, { 'Content-Type': 'application/octet-stream' }); result.end(grib);
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const load = createGribModuleLoader(base + '/decoder.wasm');
    const workers = [1, 2].map(() => new Worker(new URL('./grib-node-worker.mjs', import.meta.url)));
    try {
      await Promise.all(workers.map(async (worker, index) => {
        const ready = once(worker, 'message');
        worker.postMessage({ type: 'init', module: await load(),
          url: base + `/temperature.grib2?_map=${index + 1}`, layer: fixture.layer });
        assert.equal((await ready)[0].type, 'ready');
      }));
      assert.equal(decoderDownloads, 1);
      assert.equal(gribDownloads, 2);
      assert.ok(await load() instanceof WebAssembly.Module);
      assert.equal(decoderDownloads, 1);
      const limit = 20037508.342789244;
      const render = async (worker) => {
        const result = once(worker, 'message');
        worker.postMessage({ type: 'render', id: 1, width: 8, height: 8,
          bbox: [4.5 / 180 * limit, mercatorY(46.5), 12.5 / 180 * limit, mercatorY(54.5)] });
        const [message] = await result;
        assert.equal(message.type, 'pixels');
        return message.pixels;
      };
      const [original, other] = await Promise.all(workers.map(render));
      assert.deepEqual(original, other);
      const styled = once(workers[0], 'message');
      workers[0].postMessage({ type: 'style', id: 2,
        style: { ...fixture.layer.style, colors: [[0, 255, 0], [0, 255, 0]] } });
      assert.equal((await styled)[0].type, 'styled');
      const [changed, unchanged] = await Promise.all(workers.map(render));
      assert.notDeepEqual(changed, original);
      assert.deepEqual(unchanged, other);
      assert.equal(gribDownloads, 2);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
      await new Promise((resolve) => server.close(resolve));
    }
  });
