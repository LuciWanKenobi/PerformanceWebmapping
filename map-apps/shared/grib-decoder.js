// Small browser-safe adapter over ecCodes' published wasm64 C bindings.
// The server delivers the original bytes; ecCodes unpacks them in the worker.
export function selectGribMessage(bytes, number = 1) {
  if (!Number.isInteger(number) || number < 1) throw new Error('Invalid GRIB message number.');
  let offset = 0, index = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 20 || String.fromCharCode(...bytes.subarray(offset, offset + 4)) !== 'GRIB' || bytes[offset + 7] !== 2) {
      throw new Error('Expected a GRIB2 message (decompress .bz2 files first).');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.length - offset);
    const length = Number(view.getBigUint64(8));
    if (!Number.isSafeInteger(length) || length < 20 || offset + length > bytes.length ||
        String.fromCharCode(...bytes.subarray(offset + length - 4, offset + length)) !== '7777') {
      throw new Error('Invalid or truncated GRIB2 message.');
    }
    if (++index === number) return bytes.subarray(offset, offset + length);
    offset += length;
  }
  throw new Error(`GRIB message ${number} was not found.`);
}

export function decodeGrib(module, bytes, message = 1, nodata = -9999) {
  const path = '/browser-input.grib2';
  module.FS.writeFile(path, selectGribMessage(bytes, message));
  const string = (value) => BigInt(module.stringToNewUTF8(value));
  const allocate = (size) => BigInt(module._malloc(size));
  const error = () => module.UTF8ToString(Number(module._codes_get_last_error())) || 'ecCodes could not decode this GRIB2 file.';
  let handle;
  function scalar(key, integer = false) {
    const keyPtr = string(key), valuePtr = allocate(8);
    try {
      const result = integer ? module._codes_get_long_wrapper(handle, keyPtr, valuePtr)
        : module._codes_get_double_wrapper(handle, keyPtr, valuePtr);
      if (result !== 0) throw new Error(error());
      return integer ? Number(module.HEAP64[Number(valuePtr) / 8]) : module.HEAPF64[Number(valuePtr) / 8];
    } finally { module._free(keyPtr); module._free(valuePtr); }
  }
  function text(key) {
    const keyPtr = string(key);
    let valuePtr;
    try {
      valuePtr = module._codes_get_string_alloc(handle, keyPtr);
      if (!valuePtr) throw new Error(error());
      return module.UTF8ToString(Number(valuePtr));
    } finally { module._free(keyPtr); if (valuePtr) module._codes_free_string(valuePtr); }
  }
  function array(key) {
    const keyPtr = string(key), sizePtr = allocate(8);
    let valuesPtr;
    try {
      valuesPtr = module._codes_get_double_array_alloc(handle, keyPtr, sizePtr);
      if (!valuesPtr) throw new Error(error());
      const count = Number(module.HEAP64[Number(sizePtr) / 8]);
      return new Float64Array(module.HEAPF64.buffer, Number(valuesPtr), count).slice();
    } finally {
      module._free(keyPtr); module._free(sizePtr);
      if (valuesPtr) module._codes_free_array(valuesPtr);
    }
  }
  try {
    const pathPtr = string(path);
    try { handle = module._wasm_handle_new_from_file(pathPtr, 0); }
    finally { module._free(pathPtr); }
    if (!handle) throw new Error(error());
    if (text('gridType') !== 'regular_ll') throw new Error('GRIB2 worker display currently supports regular latitude/longitude grids.');
    const width = scalar('Ni', true), height = scalar('Nj', true);
    const dx = scalar('iDirectionIncrementInDegrees'), dy = scalar('jDirectionIncrementInDegrees');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || dx <= 0 || dy <= 0) {
      throw new Error('Invalid GRIB grid dimensions or spacing.');
    }
    const negativeI = scalar('iScansNegatively', true), positiveJ = scalar('jScansPositively', true);
    const consecutiveJ = scalar('jPointsAreConsecutive', true), alternating = scalar('alternativeRowScanning', true);
    let west = (scalar('longitudeOfFirstGridPointInDegrees') + 180) % 360 - 180;
    let north = scalar('latitudeOfFirstGridPointInDegrees');
    if (negativeI) west -= (width - 1) * dx;
    if (positiveJ) north += (height - 1) * dy;
    if (west < -180 || west + (width - 1) * dx > 180) throw new Error('Dateline-crossing GRIB grids need remapping first.');
    const packed = array('values');
    if (packed.length !== width * height) throw new Error('GRIB value count does not match its grid.');
    const bitmap = scalar('bitmapPresent', true) ? array('bitmap') : null;
    const missing = scalar('numberOfMissing', true) ? scalar('missingValue') : null;
    const values = new Float32Array(packed.length);
    for (let i = 0; i < packed.length; i++) {
      const major = Math.floor(i / (consecutiveJ ? height : width));
      let minor = i % (consecutiveJ ? height : width);
      if (alternating && major % 2) minor = (consecutiveJ ? height : width) - 1 - minor;
      let col = consecutiveJ ? major : minor, row = consecutiveJ ? minor : major;
      if (negativeI) col = width - 1 - col;
      if (positiveJ) row = height - 1 - row;
      const valid = Number.isFinite(packed[i]) && (bitmap ? bitmap[i] !== 0 : packed[i] !== missing);
      values[row * width + col] = valid ? packed[i] : nodata;
    }
    return { values, width, height, origin: [west - dx / 2, north + dy / 2],
      resolution: [dx, -dy], units: text('units'), gridType: 'regular_ll',
      bounds: [west - dx / 2, north - (height - 0.5) * dy,
        west + (width - 0.5) * dx, north + dy / 2] };
  } finally {
    if (handle) module._codes_handle_delete_wrapper(handle);
    module.FS.unlink(path);
  }
}
