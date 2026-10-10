// Share compiled code across layer workers, but never their instances or memory.
export function createGribModuleLoader(wasmUrl, fetchFile = fetch) {
  let modulePromise;
  return () => {
    if (!modulePromise) {
      modulePromise = (async () => {
        const response = await fetchFile(typeof wasmUrl === 'function' ? await wasmUrl() : wasmUrl);
        if (!response.ok) throw new Error(`GRIB2 decoder returned HTTP ${response.status}.`);
        if (response.headers.get('Content-Type') === 'application/wasm' && WebAssembly.compileStreaming) {
          return WebAssembly.compileStreaming(response);
        }
        return WebAssembly.compile(await response.arrayBuffer());
      })().catch((error) => {
        // A temporary download/compilation failure must not poison later layers.
        modulePromise = undefined;
        throw error;
      });
    }
    return modulePromise;
  };
}

export function instantiateGribModule(createEccodesModule, compiledModule) {
  return createEccodesModule({
    instantiateWasm(imports, receiveInstance) {
      const instance = new WebAssembly.Instance(compiledModule, imports);
      receiveInstance(instance);
      return instance.exports;
    },
  });
}
