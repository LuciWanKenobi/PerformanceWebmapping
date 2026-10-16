import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

function eccodesWorkerLoader() {
  const id = '\0virtual:eccodes-worker-loader';
  return {
    name: 'eccodes-worker-loader',
    resolveId(source) { if (source === 'virtual:eccodes-worker-loader') return id; },
    load(source) {
      if (source !== id) return;
      // The published Emscripten loader has a CommonJS footer. Expose its
      // factory as ESM and select its browser/worker runtime, without NODEFS.
      const loader = readFileSync(new URL('./node_modules/@meri-imperiumi/eccodes-wasm/build/eccodes/eccodes.js', import.meta.url), 'utf8');
      const browser = loader
        .replace(/var ENVIRONMENT_IS_NODE=[^;]+;/, 'var ENVIRONMENT_IS_NODE=false;')
        .replace(/\brequire\("(?:node:)?(?:fs|path)"\)/g, 'undefined')
        .replace(/if\(typeof exports==="object"&&typeof module==="object"\)[^\n]*/, '');
      return `${browser}\nexport default createEccodes;`;
    },
  };
}

export default defineConfig(({ mode }) => {
  const isolated = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_').VITE_ISOLATE_MEMORY === 'true';
  const headers = isolated ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } : {};
  return {
    base: './',
    server: { headers }, preview: { headers },
    worker: { format: 'es', plugins: () => [eccodesWorkerLoader()] },
    plugins: [eccodesWorkerLoader()],
    build: {
      rolldownOptions: {
        input: {
          home: fileURLToPath(new URL('./index.html', import.meta.url)),
          maplibre: fileURLToPath(new URL('./maplibre/index.html', import.meta.url)),
          mapbox: fileURLToPath(new URL('./mapbox/index.html', import.meta.url)),
          openlayers: fileURLToPath(new URL('./openlayers/index.html', import.meta.url)),
          leaflet: fileURLToPath(new URL('./leaflet/index.html', import.meta.url)),
        },
      },
    },
  };
});
