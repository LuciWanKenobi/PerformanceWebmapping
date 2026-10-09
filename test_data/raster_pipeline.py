"""Shared raster IO, styling and tile geometry for the local weather tools."""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
from pathlib import Path
import tempfile

import numpy as np
from PIL import Image
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT

DATA_DIR = Path(__file__).resolve().parent
COLOR_TABLES = json.loads((DATA_DIR / "color_tables.json").read_text(encoding="utf-8"))
NODATA = -9999.0
MERCATOR_LIMIT = 20037508.342789244
# Identical stops are exposed to the browser's raw-COG renderer.
COLORS = [[49, 54, 149], [69, 117, 180], [116, 173, 209],
          [254, 224, 144], [215, 48, 39]]
STYLE_RANGES = {
    "t_2m": (253.15, 313.15), "t": (253.15, 313.15),
    "clct": (0, 100), "clch": (0, 100), "clcm": (0, 100),
    "clcl": (0, 100), "relhum_2m": (0, 100),
    "ps": (90000, 105000), "pmsl": (95000, 105000),
    "cape_con": (0, 4000), "cape_ml": (0, 4000),
    "tot_prec": (0, 50), "rain_gsp": (0, 50), "snow_gsp": (0, 50),
    "vmax_10m": (0, 40), "ww": (0, 99),
}


def write_json(path: Path, value: dict) -> None:
    atomic_write(path, (json.dumps(value, indent=2, allow_nan=False) + "\n").encode())


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".part", delete=False) as f:
        temporary = Path(f.name)
        try:
            f.write(data)
        except BaseException:
            f.close()
            temporary.unlink(missing_ok=True)
            raise
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load_catalog(root: Path) -> dict:
    path = root / "catalog.json"
    if not path.is_file():
        raise ValueError(f"Missing {path}. Run grib2_to_cog.py first.")
    catalog = json.loads(path.read_text(encoding="utf-8"))
    if catalog.get("schema_version") != 1 or not catalog.get("layers"):
        raise ValueError(f"Empty or unsupported catalog: {path}")
    return catalog


def layer_path(root: Path, layer: dict) -> Path:
    path = (root / layer["path"]).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError(f"Invalid or missing COG: {layer['path']}")
    return path


def style_for(variable: str, minimum: float, maximum: float) -> dict:
    lo, hi = STYLE_RANGES.get(variable, (minimum, maximum))
    if hi <= lo:
        hi = lo + 1
    return {"min": lo, "max": hi, "colors": COLORS,
            "resampling": "nearest" if variable == "ww" else "bilinear"}


def styled_layer(layer: dict, name: str = "default") -> dict:
    if name in ("", "default"):
        return layer
    if name != "benchmark":
        raise ValueError("Supported styles: default, benchmark.")
    variable = COLOR_TABLES["aliases"].get(layer["variable"], layer["variable"])
    table = COLOR_TABLES["tables"].get(variable, COLOR_TABLES["fallback"])
    return {**layer, "style": {**layer["style"], "colors": table["colors"],
                             "colorTable": COLOR_TABLES["id"] + "/" + table["name"]}}


def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    if not 0 <= z <= 22 or not 0 <= x < 2**z or not 0 <= y < 2**z:
        raise ValueError("XYZ tile coordinates outside the grid (zoom 0..22).")
    span = 2 * MERCATOR_LIMIT / 2**z
    return (-MERCATOR_LIMIT + x * span, MERCATOR_LIMIT - (y + 1) * span,
            -MERCATOR_LIMIT + (x + 1) * span, MERCATOR_LIMIT - y * span)


def tiles_for_bbox(bbox: list[float], z: int):
    west, south, east, north = bbox
    if not (-180 <= west < east <= 180 and -85.05112878 <= south < north <= 85.05112878):
        raise ValueError("Use west south east north within Web Mercator, without crossing the dateline.")
    n = 2**z
    def tx(lon):
        return (lon + 180) / 360 * n
    def ty(lat):
        return (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    x0, x1 = max(0, math.floor(tx(west))), min(n - 1, math.ceil(tx(east)) - 1)
    y0, y1 = max(0, math.floor(ty(north))), min(n - 1, math.ceil(ty(south)) - 1)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            yield z, x, y


def render_png(root: Path, layer: dict, bbox, width=256, height=256,
               crs="EPSG:3857", transparent=True, background=(255, 255, 255)) -> bytes:
    """Read just the necessary raster windows/overviews through a virtual warp."""
    style = layer["style"]
    with rasterio.open(layer_path(root, layer)) as src:
        with WarpedVRT(src, crs=crs, transform=from_bounds(*bbox, width, height),
                       width=width, height=height, nodata=NODATA,
                       resampling=Resampling[style["resampling"]]) as vrt:
            data = vrt.read(1, masked=True)
    values = data.filled(style["min"])
    valid = ~np.ma.getmaskarray(data) & np.isfinite(values)
    scaled = np.clip((values - style["min"]) / (style["max"] - style["min"]), 0, 1)
    stops = np.linspace(0, 1, len(style["colors"]))
    rgba = np.empty((height, width, 4), dtype=np.uint8)
    colors = np.asarray(style["colors"])
    for channel in range(3):
        rgba[:, :, channel] = np.rint(np.interp(scaled, stops, colors[:, channel]))
        rgba[:, :, channel][~valid] = 0 if transparent else background[channel]
    rgba[:, :, 3] = np.where(valid | (not transparent), 255, 0)
    output = io.BytesIO()
    Image.fromarray(rgba).save(output, format="PNG")
    return output.getvalue()


def cache_key(root: Path, layer: dict) -> str:
    stat = layer_path(root, layer).stat()
    settings = json.dumps([layer["path"], stat.st_size, stat.st_mtime_ns,
                           layer["style"], "renderer-v1"], sort_keys=True)
    return hashlib.sha256(settings.encode()).hexdigest()[:16]


def cached_tile(root: Path, cache: Path, layer: dict, z: int, x: int, y: int) -> Path:
    bbox = tile_bounds(z, x, y)
    path = cache / layer["id"] / cache_key(root, layer) / str(z) / str(x) / f"{y}.png"
    if not path.is_file():
        atomic_write(path, render_png(root, layer, bbox))
    return path
