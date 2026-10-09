#!/usr/bin/env python3
"""Local PNG tile service: WMS GetCapabilities/GetMap and cached XYZ tiles."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import threading
from urllib.parse import parse_qs, unquote, urlsplit
import xml.etree.ElementTree as ET

from http_common import LocalHandler, run_server
from raster_pipeline import (DATA_DIR, MERCATOR_LIMIT, atomic_write, cache_key,
                             cached_tile, load_catalog, render_png, tile_bounds, styled_layer, COLOR_TABLES)

XLINK = "http://www.w3.org/1999/xlink"
ET.register_namespace("xlink", XLINK)


def capabilities(catalog, endpoint, version):
    """Advertise one named layer for each variable, run, time and GRIB message."""
    modern = version == "1.3.0"
    root = ET.Element("WMS_Capabilities" if modern else "WMT_MS_Capabilities", version=version)
    if modern:
        root.set("xmlns", "http://www.opengis.net/wms")
    service = ET.SubElement(root, "Service")
    ET.SubElement(service, "Name").text = "WMS" if modern else "OGC:WMS"
    ET.SubElement(service, "Title").text = "Local DWD ICON weather"
    ET.SubElement(service, "Abstract").text = "PNG maps rendered from numeric COGs. One forecast per layer."
    def online(parent):
        ET.SubElement(parent, "OnlineResource", {f"{{{XLINK}}}type": "simple",
                      f"{{{XLINK}}}href": endpoint})
    online(service)
    cap = ET.SubElement(root, "Capability")
    request = ET.SubElement(cap, "Request")
    for operation, fmt in [("GetCapabilities", "text/xml"), ("GetMap", "image/png")]:
        op = ET.SubElement(request, operation)
        ET.SubElement(op, "Format").text = fmt
        online(ET.SubElement(ET.SubElement(ET.SubElement(op, "DCPType"), "HTTP"), "Get"))
    ET.SubElement(ET.SubElement(cap, "Exception"), "Format").text = "XML" if modern else "application/vnd.ogc.se_xml"
    parent = ET.SubElement(cap, "Layer")
    ET.SubElement(parent, "Title").text = "ICON forecasts"
    for crs in ["EPSG:3857", "EPSG:4326", "CRS:84"]:
        ET.SubElement(parent, "CRS" if modern else "SRS").text = crs
    for layer in catalog["layers"]:
        node = ET.SubElement(parent, "Layer", queryable="0")
        ET.SubElement(node, "Name").text = layer["id"]
        ET.SubElement(node, "Title").text = f"{layer['variable']} ({layer['units']}) — {layer['valid_time']}"
        west, south, east, north = layer["bounds"]
        if modern:
            bounds = ET.SubElement(node, "EX_GeographicBoundingBox")
            for tag, value in [("westBoundLongitude", west), ("eastBoundLongitude", east),
                               ("southBoundLatitude", south), ("northBoundLatitude", north)]:
                ET.SubElement(bounds, tag).text = str(value)
        else:
            ET.SubElement(node, "LatLonBoundingBox", minx=str(west), miny=str(south),
                          maxx=str(east), maxy=str(north))
        axes = (south, west, north, east) if modern else (west, south, east, north)
        ET.SubElement(node, "BoundingBox", **{"CRS" if modern else "SRS": "EPSG:4326",
                      "minx": str(axes[0]), "miny": str(axes[1]),
                      "maxx": str(axes[2]), "maxy": str(axes[3])})
        for name in ("default", "benchmark"):
            selected = styled_layer(layer, name)
            style = ET.SubElement(node, "Style")
            ET.SubElement(style, "Name").text = name
            ET.SubElement(style, "Title").text = selected["style"].get("colorTable", "Default value scale")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def parse_map(params, layers):
    version = params.get("VERSION", "1.3.0")
    if version not in ("1.1.1", "1.3.0"):
        raise ValueError("VERSION must be 1.1.1 or 1.3.0.")
    name = params.get("LAYERS", "")
    if name not in layers:
        raise ValueError("Request exactly one LAYERS name from GetCapabilities or /catalog.json.")
    layer = styled_layer(layers[name], params.get("STYLES", ""))
    if params.get("TIME"):
        raise ValueError("Select a forecast using its layer ID; TIME dimensions are not provided.")
    if params.get("FORMAT", "").lower() != "image/png":
        raise ValueError("FORMAT must be image/png.")
    crs = params.get("CRS" if version == "1.3.0" else "SRS", "").upper()
    if crs not in ("EPSG:3857", "EPSG:4326", "CRS:84"):
        raise ValueError("Supported CRS/SRS: EPSG:3857, EPSG:4326, CRS:84.")
    try:
        bbox = tuple(float(v) for v in params["BBOX"].split(","))
        width, height = int(params["WIDTH"]), int(params["HEIGHT"])
    except (KeyError, ValueError) as error:
        raise ValueError("BBOX, WIDTH and HEIGHT are required numeric values.") from error
    if len(bbox) != 4 or not all(math.isfinite(v) for v in bbox):
        raise ValueError("BBOX must contain four finite coordinates.")
    if version == "1.3.0" and crs == "EPSG:4326":
        bbox = (bbox[1], bbox[0], bbox[3], bbox[2])
    if bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
        raise ValueError("BBOX must have increasing coordinates.")
    if crs != "EPSG:3857" and not (-180 <= bbox[0] < bbox[2] <= 180 and -90 <= bbox[1] < bbox[3] <= 90):
        raise ValueError("Geographic BBOX is outside longitude/latitude bounds.")
    if not 1 <= width <= 2048 or not 1 <= height <= 2048:
        raise ValueError("WIDTH and HEIGHT must be in 1..2048.")
    transparency = params.get("TRANSPARENT", "FALSE").upper()
    if transparency not in ("TRUE", "FALSE"):
        raise ValueError("TRANSPARENT must be TRUE or FALSE.")
    color = params.get("BGCOLOR", "0xFFFFFF")
    if not re.fullmatch(r"0x[0-9a-fA-F]{6}", color):
        raise ValueError("BGCOLOR must be a 0xRRGGBB color.")
    background = tuple(int(color[i:i + 2], 16) for i in (2, 4, 6))
    return layer, bbox, width, height, "EPSG:4326" if crs == "CRS:84" else crs, transparency == "TRUE", background


def aligned_tile(bbox):
    """Use the same pre-rendered PNG for a WMS request on the XYZ grid."""
    span = bbox[2] - bbox[0]
    if span <= 0:
        return None
    z = round(math.log2(2 * MERCATOR_LIMIT / span))
    if not 0 <= z <= 22:
        return None
    step = 2 * MERCATOR_LIMIT / 2**z
    x = round((bbox[0] + MERCATOR_LIMIT) / step)
    y = round((MERCATOR_LIMIT - bbox[3]) / step)
    try:
        expected = tile_bounds(z, x, y)
    except ValueError:
        return None
    return (z, x, y) if all(abs(a - b) <= 0.00001 for a, b in zip(expected, bbox)) else None


def make_handler(root: Path, cache: Path, catalog=None):
    catalog = catalog or load_catalog(root)
    layers = {layer["id"]: layer for layer in catalog["layers"]}
    render_slots = threading.BoundedSemaphore(4)

    class WmsHandler(LocalHandler):
        def exception(self, message):
            report = ET.Element("ServiceExceptionReport", version="1.3.0",
                                xmlns="http://www.opengis.net/ogc")
            ET.SubElement(report, "ServiceException").text = message
            self.send_bytes(ET.tostring(report, encoding="utf-8", xml_declaration=True), "text/xml", 400)

        def do_GET(self):
            if self.serve_metrics():
                return
            url = urlsplit(self.path)
            try:
                if url.path in ("/", "/health"):
                    self.send_json({"service": "wms", "layers": len(layers), "catalog": "/catalog.json",
                                    "wms": "/wms", "xyz": "/tiles/<layer>/{z}/{x}/{y}.png",
                                    "colorTables": COLOR_TABLES})
                elif url.path == "/catalog.json":
                    self.send_json(catalog)
                elif url.path.startswith("/tiles/"):
                    match = re.fullmatch(r"/tiles/([^/]+)/(\d+)/(\d+)/(\d+)\.png", unquote(url.path))
                    if not match or match[1] not in layers:
                        self.send_error(404, "Unknown tile or layer")
                        return
                    z, x, y = (int(match[i]) for i in (2, 3, 4))
                    params = {key.upper(): values[-1] for key, values in
                              parse_qs(url.query, keep_blank_values=True).items()}
                    layer = styled_layer(layers[match[1]], params.get("STYLE", "default"))
                    with render_slots:
                        if self.isolated_request():
                            data = render_png(root, layer, tile_bounds(z, x, y))
                            self.send_bytes(data, "image/png")
                            return
                        path = cached_tile(root, cache, layer, z, x, y)
                    self.serve_file(path)
                elif url.path == "/wms":
                    self.wms({key.upper(): values[-1] for key, values in
                              parse_qs(url.query, keep_blank_values=True).items()})
                else:
                    self.send_error(404, "Use /wms, /tiles/<layer>/<z>/<x>/<y>.png or /catalog.json")
            except (ValueError, KeyError) as error:
                self.exception(str(error))
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as error:
                self.log_error("Raster request failed: %s", error)
                self.send_json({"error": "Raster rendering failed. Check the server log and input COGs."}, 500)

        def wms(self, params):
            if params.get("SERVICE", "WMS").upper() != "WMS":
                raise ValueError("SERVICE must be WMS.")
            request = params.get("REQUEST", "").lower()
            if request == "getcapabilities":
                version = params.get("VERSION", "1.3.0")
                if version not in ("1.1.1", "1.3.0"):
                    raise ValueError("VERSION must be 1.1.1 or 1.3.0.")
                # Derive from the configured listener, avoiding untrusted Host headers.
                host, port = self.server.server_address[:2]
                endpoint = f"http://{host}:{port}/wms?"
                self.send_bytes(capabilities(catalog, endpoint, version), "text/xml")
            elif request == "getmap":
                layer, bbox, width, height, crs, transparent, background = parse_map(params, layers)
                tile = aligned_tile(bbox) if crs == "EPSG:3857" and width == height == 256 and transparent else None
                with render_slots:
                    if self.isolated_request():
                        self.send_bytes(render_png(root, layer, bbox, width, height, crs,
                                                   transparent, background), "image/png")
                        return
                    if tile:
                        path = cached_tile(root, cache, layer, *tile)
                    else:
                        settings = [cache_key(root, layer), bbox, width, height, crs, transparent, background]
                        key = hashlib.sha256(json.dumps(settings).encode()).hexdigest()
                        path = cache / "_getmap" / f"{key}.png"
                        if not path.is_file():
                            atomic_write(path, render_png(root, layer, bbox, width, height, crs,
                                                          transparent, background))
                self.serve_file(path)
            else:
                raise ValueError("Supported REQUEST: GetCapabilities or GetMap.")
    return WmsHandler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cog-dir", type=Path, default=DATA_DIR / "cog")
    parser.add_argument("--tile-dir", type=Path, default=DATA_DIR / "wms_tiles")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8002)
    args = parser.parse_args()
    try:
        handler = make_handler(args.cog_dir.resolve(), args.tile_dir.resolve())
    except ValueError as error:
        parser.error(str(error))
    run_server(args.host, args.port, handler)


if __name__ == "__main__":
    main()
