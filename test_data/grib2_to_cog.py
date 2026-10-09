#!/usr/bin/env python3
"""Decode regular-lat/lon GRIB2 (including .bz2) into tiled, numeric COGs."""
from __future__ import annotations

import argparse
import bz2
from datetime import datetime, timezone
import os
from pathlib import Path
import re
import sys
import tempfile

import eccodes
import numpy as np
import rasterio
from rasterio.shutil import copy as raster_copy
from rasterio.transform import from_origin

from raster_pipeline import DATA_DIR, NODATA, style_for, write_json


def grib_messages(path: Path):
    """Keep ecCodes responsible for packing (notably DWD's CCSDS/libaec data)."""
    opener = bz2.open if path.suffix.lower() == ".bz2" else open
    with opener(path, "rb") as source:
        # Read message framing ourselves: ecCodes' C FILE* adapter retains file
        # handles on some Windows builds, preventing temporary-file cleanup.
        while header := source.read(16):
            if len(header) != 16 or header[:4] != b"GRIB" or header[7] != 2:
                raise ValueError("Expected a GRIB edition 2 message header.")
            length = int.from_bytes(header[8:16], "big")
            if length < 20:
                raise ValueError("Invalid GRIB2 message length.")
            message = header + source.read(length - 16)
            if len(message) != length or message[-4:] != b"7777":
                raise ValueError("Truncated GRIB2 message.")
            handle = eccodes.codes_new_from_message(message)
            try:
                yield decode_message(handle)
            finally:
                eccodes.codes_release(handle)


def decode_message(handle):
    get = lambda key: eccodes.codes_get(handle, key)
    if get("gridType") != "regular_ll":
        raise ValueError(f"Unsupported grid {get('gridType')}; remap to a regular lat/lon grid first.")
    ni, nj = int(get("Ni")), int(get("Nj"))
    if ni < 2 or nj < 2:
        raise ValueError("GRIB must have at least 2 x 2 grid points.")
    dx, dy = float(get("iDirectionIncrementInDegrees")), float(get("jDirectionIncrementInDegrees"))
    if dx <= 0 or dy <= 0:
        raise ValueError("Invalid GRIB grid spacing.")
    lon = (float(get("longitudeOfFirstGridPointInDegrees")) + 180) % 360 - 180
    lat = float(get("latitudeOfFirstGridPointInDegrees"))
    values = eccodes.codes_get_values(handle)
    valid = np.isfinite(values)
    if int(get("bitmapPresent")):
        valid &= eccodes.codes_get_array(handle, "bitmap").astype(bool)
    elif int(get("numberOfMissing")):
        valid &= values != get("missingValue")
    values = np.where(valid, values, NODATA).astype("float32")
    consecutive_j = bool(get("jPointsAreConsecutive"))
    data = values.reshape((ni, nj) if consecutive_j else (nj, ni))
    if get("alternativeRowScanning"):
        data[1::2] = data[1::2, ::-1]
    if consecutive_j:
        data = data.T
    if get("iScansNegatively"):
        data = data[:, ::-1]
        lon -= (ni - 1) * dx
    if get("jScansPositively"):
        data = data[::-1]
        lat += (nj - 1) * dy
    if lon < -180 or lon + (ni - 1) * dx > 180:
        raise ValueError("Grid crosses the dateline; remap to a grid within -180..180 first.")
    # GRIB coordinates describe cell centres. Use half-cell edges, north-up.
    transform = from_origin(lon - dx / 2, lat + dy / 2, dx, dy)
    def timestamp(date_key, time_key):
        return datetime.strptime(f"{int(get(date_key)):08d}{int(get(time_key)):04d}",
                                 "%Y%m%d%H%M").replace(tzinfo=timezone.utc).isoformat()
    metadata = {
        "name": str(get("name")), "short_name": str(get("shortName")),
        "units": str(get("units")), "level_type": str(get("typeOfLevel")),
        "level": float(get("level")), "reference_time": timestamp("dataDate", "dataTime"),
        "valid_time": timestamp("validityDate", "validityTime"),
    }
    return np.ascontiguousarray(data), transform, metadata


def convert_file(source: Path, input_dir: Path, output_dir: Path, blocksize: int,
                 overwrite: bool) -> list[dict]:
    relative = source.relative_to(input_dir)
    filename = relative.name.removesuffix(".bz2")
    stem = Path(filename).stem
    match = re.search(r"_(\d{10})_(\d{3})_(?:\d+_)?(.+)$", stem)
    variable = match.group(3).lower() if match else stem.lower()
    messages = list(grib_messages(source))
    if not messages:
        raise ValueError("No GRIB messages found.")
    layers = []
    for index, (data, transform, metadata) in enumerate(messages, 1):
        suffix = f"_band{index:04d}" if len(messages) > 1 else ""
        destination = output_dir / relative.parent / f"{stem}{suffix}.tif"
        destination.parent.mkdir(parents=True, exist_ok=True)
        good = data[data != NODATA]
        if not good.size:
            raise ValueError(f"Message {index} contains no valid values.")
        minimum, maximum = float(good.min()), float(good.max())
        style = style_for(variable, minimum, maximum)
        expected = {"source_size": str(source.stat().st_size),
                    "source_mtime_ns": str(source.stat().st_mtime_ns),
                    "blocksize": str(blocksize), "conversion_version": "1"}
        if destination.is_file() and not overwrite:
            with rasterio.open(destination) as existing:
                if (existing.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") != "COG" or
                        any(existing.tags().get(k) != v for k, v in expected.items())):
                    raise ValueError(f"Output differs from input/settings: {destination}. Use --overwrite.")
        else:
            with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
                intermediate = Path(temporary) / "source.tif"
                with rasterio.open(intermediate, "w", driver="GTiff", width=data.shape[1],
                                   height=data.shape[0], count=1, dtype="float32", nodata=NODATA,
                                   crs="EPSG:4326", transform=transform) as dst:
                    dst.write(data, 1)
                    dst.update_tags(**expected, **metadata, variable=variable,
                                    source_grib=relative.as_posix(), source_message=index)
                    dst.update_tags(1, units=metadata["units"],
                                    STATISTICS_MINIMUM=minimum, STATISTICS_MAXIMUM=maximum)
                    dst.set_band_description(1, metadata["name"])
                    dst.set_band_unit(1, metadata["units"])
                cog = Path(temporary) / "result.tif"
                raster_copy(intermediate, cog, driver="COG", BLOCKSIZE=blocksize,
                            COMPRESS="DEFLATE", PREDICTOR="FLOATING_POINT",
                            OVERVIEW_RESAMPLING="NEAREST" if variable == "ww" else "AVERAGE",
                            BIGTIFF="IF_SAFER", NUM_THREADS="2")
                with rasterio.open(cog) as check:
                    if check.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") != "COG":
                        raise ValueError("GDAL did not produce a COG layout.")
                os.replace(cog, destination)
        path = destination.relative_to(output_dir).as_posix()
        with rasterio.open(destination) as ds:
            layer = {"id": path.removesuffix(".tif").replace("/", "__"), "path": path,
                     "variable": variable, "source": relative.as_posix(), "message": index,
                     "forecast_hour": int(match.group(2)) if match else None,
                     "run": match.group(1) if match else None,
                     **metadata, "crs": "EPSG:4326", "bounds": list(ds.bounds),
                     "width": ds.width, "height": ds.height, "nodata": NODATA,
                     "min": minimum, "max": maximum, "overviews": ds.overviews(1),
                     "size_bytes": destination.stat().st_size, "style": style}
        layers.append(layer)
    return layers


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, default=DATA_DIR / "grib2")
    parser.add_argument("--output-dir", type=Path, default=DATA_DIR / "cog")
    parser.add_argument("--blocksize", type=int, choices=[128, 256, 512], default=256)
    parser.add_argument("--overwrite", action="store_true", help="Replace existing outputs atomically.")
    args = parser.parse_args(argv)
    sources = sorted(args.input_dir.rglob("*.grib2"))
    sources += sorted(p for p in args.input_dir.rglob("*.grib2.bz2") if not p.with_suffix("").exists())
    if not sources:
        parser.error(f"No .grib2 or .grib2.bz2 files found in {args.input_dir}")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    layers, errors = [], []
    for index, source in enumerate(sources, 1):
        try:
            converted = convert_file(source, args.input_dir, args.output_dir,
                                     args.blocksize, args.overwrite)
            layers.extend(converted)
            print(f"[{index}/{len(sources)}] {source.name}: {len(converted)} COG(s)", flush=True)
        except Exception as error:
            errors.append({"source": source.relative_to(args.input_dir).as_posix(), "error": str(error)})
            print(f"ERROR {source.name}: {error}", file=sys.stderr)
    # Only files from this input scan are published, so old runs are not advertised.
    write_json(args.output_dir / "catalog.json", {
        "schema_version": 1, "generated_at": datetime.now(timezone.utc).isoformat(),
        "attribution": "Deutscher Wetterdienst (DWD), ICON forecast",
        "layers": layers, "errors": errors})
    print(f"Published {len(layers)} COGs in {args.output_dir}; {len(errors)} error(s).")
    return int(bool(errors))


if __name__ == "__main__":
    raise SystemExit(main())
