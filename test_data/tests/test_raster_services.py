"""Integration checks using real ecCodes, COG IO and HTTP requests."""
from contextlib import contextmanager
import bz2
from http.server import ThreadingHTTPServer
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

import eccodes
import numpy as np
from PIL import Image
import rasterio

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from grib2_to_cog import convert_file, grib_messages
from raster_pipeline import styled_layer, COLOR_TABLES, cache_key, cached_tile, load_catalog, tile_bounds, tiles_for_bbox, write_json
from serve_cog import make_handler as cog_handler
from serve_wms import make_handler as wms_handler
from serve_metrics import make_handler as metrics_handler, cpu_counters
from collections import namedtuple


@contextmanager
def service(handler):
    class QuietHandler(handler):
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def request(url, headers=None, method="GET"):
    try:
        response = urlopen(Request(url, headers=headers or {}, method=method), timeout=10)
    except HTTPError as error:
        response = error
    with response:
        return response.status, response.headers, response.read()


class RasterServicesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.base = Path(cls.temporary.name)
        cls.input = cls.base / "grib2"
        cls.cog = cls.base / "cog"
        cls.cache = cls.base / "tiles"
        cls.input.mkdir()
        cls.source = cls.input / "icon-eu_europe_regular-lat-lon_single-level_2026100500_003_T_2M.grib2"
        handle = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2")
        try:
            for key, value in {
                "Ni": 8, "Nj": 8, "latitudeOfFirstGridPointInDegrees": 47,
                "longitudeOfFirstGridPointInDegrees": 5,
                "latitudeOfLastGridPointInDegrees": 54,
                "longitudeOfLastGridPointInDegrees": 12,
                "iDirectionIncrementInDegrees": 1, "jDirectionIncrementInDegrees": 1,
                "jScansPositively": 1, "iScansNegatively": 0,
                "dataDate": 20261005, "dataTime": 0, "forecastTime": 3,
                "bitmapPresent": 1,
            }.items():
                eccodes.codes_set(handle, key, value)
            cls.values = np.arange(64, dtype=float).reshape(8, 8) + 270
            cls.values[0, 0] = 9999
            eccodes.codes_set_values(handle, cls.values.ravel())
            cls.message = eccodes.codes_get_message(handle)
            cls.source.write_bytes(cls.message)
        finally:
            eccodes.codes_release(handle)
        cls.layer = convert_file(cls.source, cls.input, cls.cog, 128, False)[0]
        write_json(cls.cog / "catalog.json", {"schema_version": 1, "layers": [cls.layer]})
        # XYZ files must exist before the server starts.
        cached_tile(cls.cog, cls.cache, cls.layer, 5, 16, 10)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_cog_values_orientation_units_and_bz2(self):
        with rasterio.open(self.cog / self.layer["path"]) as ds:
            self.assertEqual(ds.tags(ns="IMAGE_STRUCTURE")["LAYOUT"], "COG")
            self.assertEqual(ds.crs.to_epsg(), 4326)
            self.assertEqual(ds.block_shapes, [(128, 128)])
            expected = self.values[::-1].astype("float32")
            expected[-1, 0] = -9999
            np.testing.assert_array_equal(ds.read(1), expected)
            self.assertEqual(ds.bounds, (4.5, 46.5, 12.5, 54.5))
            self.assertEqual(ds.xy(0, 0), (5, 54))
            self.assertEqual(ds.units, ("K",))
        compressed = self.input / "sample.grib2.bz2"
        compressed.write_bytes(bz2.compress(self.message))
        decoded = list(grib_messages(compressed))[0][0]
        np.testing.assert_array_equal(decoded, expected)

    def test_reuse_does_not_rewrite_and_stale_output_requires_overwrite(self):
        path = self.cog / self.layer["path"]
        before = path.stat().st_mtime_ns
        convert_file(self.source, self.input, self.cog, 128, False)
        self.assertEqual(path.stat().st_mtime_ns, before)
        with self.assertRaisesRegex(ValueError, "overwrite"):
            convert_file(self.source, self.input, self.cog, 256, False)

    def test_multiple_grib_messages_are_separate_cogs(self):
        source = self.input / "multiple.grib2"
        source.write_bytes(self.message + self.message)
        layers = convert_file(source, self.input, self.base / "multi", 128, False)
        self.assertEqual(len(layers), 2)
        self.assertEqual([layer["message"] for layer in layers], [1, 2])
        self.assertEqual(len({layer["path"] for layer in layers}), 2)

    def test_ranges_head_cors_and_conditional_requests(self):
        payload = (self.cog / self.layer["path"]).read_bytes()
        with service(cog_handler(self.cog)) as base:
            url = f"{base}/cog/{self.layer['path']}"
            for range_header, expected in [("bytes=0-31", payload[:32]),
                                           ("bytes=32-", payload[32:]),
                                           ("bytes=-24", payload[-24:]),
                                           ("bytes=0-99999999", payload)]:
                status, headers, data = request(url, {"Range": range_header})
                self.assertEqual(status, 206)
                self.assertEqual(data, expected)
                self.assertEqual(headers["Accept-Ranges"], "bytes")
                self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
                self.assertEqual(int(headers["Content-Length"]), len(data))
                self.assertIn("Content-Range", headers["Access-Control-Expose-Headers"])
            for header in ["bytes=99999999-", "bytes=-0", "bytes=10-5", "bytes=x-y"]:
                status, headers, data = request(url, {"Range": header})
                self.assertEqual(status, 416)
                self.assertEqual(headers["Content-Range"], f"bytes */{len(payload)}")
                self.assertEqual(data, b"")
            status, headers, data = request(url, {"Range": "bytes=0-31"}, method="HEAD")
            self.assertEqual(status, 200)
            self.assertEqual(int(headers["Content-Length"]), len(payload))
            self.assertEqual(data, b"")
            self.assertEqual(request(url, method="OPTIONS")[0], 204)
            self.assertEqual(request(url, {"If-None-Match": headers["ETag"]})[0], 304)
            self.assertEqual(request(url, {"Range": "bytes=0-31", "If-Range": '"stale"'})[0], 200)
            self.assertEqual(request(url, {"Range": "bytes=0-31", "If-Range": headers["ETag"]})[0], 206)
            self.assertEqual(request(url, {"Range": "bytes=0-4,10-14"})[0], 200)

    def test_cog_catalog_and_path_traversal(self):
        with service(cog_handler(self.cog)) as base:
            status, _, data = request(base + "/catalog.json")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(data)["layers"][0]["id"], self.layer["id"])
            for path in ["/cog/%2e%2e/secret.tif", "/cog/..%5csecret.tif", "/cog/C:%5csecret.tif"]:
                self.assertEqual(request(base + path)[0], 400)
            self.assertEqual(request(base + "/cog/missing.tif")[0], 404)

    def test_independent_map_files_are_no_store_and_never_revalidated_from_cache(self):
        payload = (self.cog / self.layer["path"]).read_bytes()
        with service(cog_handler(self.cog, self.input)) as base:
            url = f"{base}/cog/{self.layer['path']}"
            etag = request(url, method="HEAD")[1]["ETag"]
            for index in range(1, 21):
                isolated = url + f"?_map_request=trial-map-{index}&_map={index}"
                status, headers, body = request(isolated, {"Range": "bytes=0-31", "If-None-Match": etag})
                self.assertEqual(status, 206)
                self.assertEqual(body, payload[:32])
                self.assertEqual(headers["Cache-Control"], "no-store")
            status, headers, body = request(url + "?_map_request=new-load&_map=1", {"If-None-Match": etag})
            self.assertEqual(status, 200)
            self.assertEqual(body, payload)
            counters = json.loads(request(base + "/metrics")[2])
            self.assertTrue(counters["cacheIsolationSupported"])
            self.assertEqual(counters["getRequestCount"], 21)
            self.assertEqual(counters["rangeGetRequestCount"], 20)
            self.assertEqual(counters["bodyBytesSent"], 20 * 32 + len(payload))
            self.assertNotIn("304", counters["responseStatuses"])
            grib = base + f"/grib2/{self.source.name}?_map_request=grib-map-2&_map=2"
            status, headers, body = request(grib, {"If-None-Match": "*"})
            self.assertEqual(status, 200)
            self.assertEqual(body, self.message)
            self.assertEqual(headers["Cache-Control"], "no-store")

    def test_original_grib_is_served_without_decoding(self):
        with service(cog_handler(self.cog, self.input)) as base:
            url = f"{base}/grib2/{self.source.name}"
            status, headers, body = request(url)
            self.assertEqual(status, 200)
            self.assertEqual(body, self.message)
            self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
            self.assertEqual(request(url, {"Range": "bytes=0-15"})[2], self.message[:16])
            self.assertEqual(request(base + "/grib2/%2e%2e/secret.grib2")[0], 400)
            self.assertEqual(request(base + "/grib2/missing.grib2")[0], 404)
            self.assertEqual(request(base + "/grib2/file.grib2.bz2")[0], 400)

    def map_url(self, base, **changes):
        params = dict(SERVICE="WMS", REQUEST="GetMap", VERSION="1.1.1", LAYERS=self.layer["id"],
                      STYLES="", FORMAT="image/png", TRANSPARENT="TRUE", SRS="EPSG:4326",
                      BBOX="4.5,46.5,12.5,54.5", WIDTH="64", HEIGHT="64")
        params.update(changes)
        return base + "/wms?" + urlencode(params)

    def test_wms_capabilities_and_version_axis_order(self):
        with service(wms_handler(self.cog, self.cache)) as base:
            for version in ["1.1.1", "1.3.0"]:
                status, _, data = request(base + f"/wms?service=WMS&request=GetCapabilities&version={version}")
                self.assertEqual(status, 200)
                xml = ET.fromstring(data)
                self.assertEqual(xml.attrib["version"], version)
                names = [node.text for node in xml.iter() if node.tag.split('}')[-1] == "Name"]
                self.assertIn(self.layer["id"], names)
            status, _, classic = request(self.map_url(base))
            self.assertEqual(status, 200)
            modern = request(self.map_url(base, VERSION="1.3.0", CRS="EPSG:4326",
                                          BBOX="46.5,4.5,54.5,12.5"))[2]
            crs84 = request(self.map_url(base, VERSION="1.3.0", CRS="CRS:84"))[2]
            self.assertEqual(classic, modern)
            self.assertEqual(classic, crs84)
            image = np.array(Image.open(io.BytesIO(classic)))
            self.assertEqual(image.shape, (64, 64, 4))
            self.assertEqual(image[0, -1, 3], 255)
            self.assertEqual(image[-1, 0, 3], 0)

    def test_xyz_and_grid_aligned_wms_reuse_same_png(self):
        with service(wms_handler(self.cog, self.cache)) as base:
            url = f"{base}/tiles/{self.layer['id']}/5/16/10.png"
            status, _, tile = request(url)
            self.assertEqual(status, 200)
            path = self.cache / self.layer["id"] / cache_key(self.cog, self.layer) / "5/16/10.png"
            self.assertEqual(tile, path.read_bytes())
            modified = path.stat().st_mtime_ns
            bbox = ",".join(map(str, tile_bounds(5, 16, 10)))
            status, _, wms = request(self.map_url(base, SRS="EPSG:3857", BBOX=bbox,
                                                 WIDTH=256, HEIGHT=256))
            self.assertEqual(status, 200)
            self.assertEqual(tile, wms)
            self.assertEqual(request(url)[2], tile)
            self.assertEqual(path.stat().st_mtime_ns, modified)
            self.assertEqual(request(url, method="HEAD")[2], b"")

    def test_wms_validation_and_opaque_background(self):
        with service(wms_handler(self.cog, self.cache)) as base:
            for change in [{"WIDTH": 1000000}, {"BBOX": "nan,0,1,2"}, {"LAYERS": "unknown"},
                           {"FORMAT": "image/jpeg"}, {"VERSION": "1.2.3"}, {"SRS": "EPSG:9999"},
                           {"TRANSPARENT": "maybe"}, {"TIME": "2026-10-05"}]:
                status, _, data = request(self.map_url(base, **change))
                self.assertEqual(status, 400)
                self.assertIn(b"ServiceException", data)
            status, _, data = request(self.map_url(base, BBOX="-10,0,-9,1",
                                                  TRANSPARENT="FALSE", BGCOLOR="0x123456"))
            self.assertEqual(status, 200)
            image = np.array(Image.open(io.BytesIO(data)))
            np.testing.assert_array_equal(image[0, 0], [0x12, 0x34, 0x56, 255])
            self.assertEqual(request(base + f"/tiles/{self.layer['id']}/5/999/10.png")[0], 400)

    def test_independent_xyz_reads_precomputed_files_while_wms_renders(self):
        import serve_wms
        cache = self.base / "isolated-output-cache"
        tile = cached_tile(self.cog, cache, self.layer, 5, 16, 10)
        expected = tile.read_bytes()
        files = {path: path.stat().st_mtime_ns for path in cache.rglob("*.png")}
        with service(wms_handler(self.cog, cache)) as base:
            url = f"{base}/tiles/{self.layer['id']}/5/16/10.png"
            bbox = ",".join(map(str, tile_bounds(5, 16, 10)))
            with patch("serve_wms.cached_tile", side_effect=AssertionError("Runtime tile generation used")), \
                    patch("serve_wms.render_png", wraps=serve_wms.render_png) as render:
                for index in [1, 2]:
                    status, headers, body = request(url + f"?_map_request=xyz-{index}&_map={index}",
                                                    {"If-None-Match": "*"})
                    self.assertEqual(status, 200)
                    self.assertEqual(headers["Cache-Control"], "no-store")
                    self.assertEqual(body, expected)
                self.assertEqual(render.call_count, 0)
                for index in [1, 2]:
                    status, headers, body = request(self.map_url(base, SRS="EPSG:3857", BBOX=bbox,
                                                                WIDTH=256, HEIGHT=256,
                                                                _map_request=f"wms-{index}", _map=index))
                    self.assertEqual(status, 200)
                    self.assertEqual(headers["Cache-Control"], "no-store")
                    self.assertEqual(body, expected)
                self.assertEqual(render.call_count, 2)
            self.assertEqual(files, {path: path.stat().st_mtime_ns for path in cache.rglob("*.png")})

    def test_missing_xyz_and_restyle_requests_never_render_or_write(self):
        cache = self.base / "missing-precomputed"
        with service(wms_handler(self.cog, cache)) as base:
            health = json.loads(request(base + "/health")[2])
            self.assertEqual(health["xyzDelivery"], "precomputed-only")
            self.assertFalse(health["xyzColorRestyleSupported"])
            url = f"{base}/tiles/{self.layer['id']}/5/16/10.png"
            with patch("serve_wms.render_png", side_effect=AssertionError("XYZ must not render")), \
                    patch("serve_wms.cached_tile", side_effect=AssertionError("XYZ must not generate")):
                for suffix in ("", "?_map_request=missing&_map=1"):
                    status, _, body = request(url + suffix)
                    self.assertEqual(status, 404)
                    self.assertIn(b"generate_wms_tiles.py", body)
                for style in ("benchmark", "unknown"):
                    self.assertEqual(request(url + "?style=" + style)[0], 400)
                self.assertEqual(request(url, method="HEAD")[0], 404)
            self.assertFalse(cache.exists())

    def test_parameter_table_changes_png_values_and_keeps_alpha_and_separate_cache(self):
        alternative = styled_layer(self.layer, "benchmark")
        self.assertEqual(alternative["style"]["min"], self.layer["style"]["min"])
        self.assertEqual(alternative["style"]["max"], self.layer["style"]["max"])
        self.assertNotEqual(alternative["style"]["colors"], self.layer["style"]["colors"])
        self.assertNotEqual(cache_key(self.cog, alternative), cache_key(self.cog, self.layer))
        self.assertNotEqual(alternative["style"]["colors"],
                            styled_layer({**self.layer, "variable": "clct"}, "benchmark")["style"]["colors"])
        with service(wms_handler(self.cog, self.cache)) as base:
            self.assertEqual(json.loads(request(base + "/health")[2])["colorTables"], COLOR_TABLES)
            initial = np.array(Image.open(io.BytesIO(request(self.map_url(base))[2])))
            status, _, body = request(self.map_url(base, STYLES="benchmark"))
            self.assertEqual(status, 200)
            restyled = np.array(Image.open(io.BytesIO(body)))
            self.assertFalse(np.array_equal(initial[:, :, :3], restyled[:, :, :3]))
            np.testing.assert_array_equal(initial[:, :, 3], restyled[:, :, 3])
            url = f"{base}/tiles/{self.layer['id']}/5/16/10.png"
            tile_path = self.cache / self.layer["id"] / cache_key(self.cog, self.layer) / "5/16/10.png"
            default_tile = request(url)[2]
            modified = tile_path.stat().st_mtime_ns
            self.assertEqual(request(url + "?style=benchmark")[0], 400)
            bbox = ",".join(map(str, tile_bounds(5, 16, 10)))
            status, _, wms_tile = request(self.map_url(base, STYLES="benchmark", SRS="EPSG:3857",
                                                       BBOX=bbox, WIDTH=256, HEIGHT=256))
            self.assertEqual(status, 200)
            self.assertNotEqual(default_tile, wms_tile)
            import serve_wms
            with patch("serve_wms.cached_tile", side_effect=AssertionError("Shared cache used")):
                for index in (1, 2):
                    status, headers, isolated = request(self.map_url(base, STYLES="benchmark", SRS="EPSG:3857",
                        BBOX=bbox, WIDTH=256, HEIGHT=256, _map_request=f"restyle-{index}", _map=index))
                    self.assertEqual(status, 200)
                    self.assertEqual(headers["Cache-Control"], "no-store")
                    self.assertEqual(isolated, wms_tile)
            self.assertEqual(request(url)[2], default_tile)
            self.assertEqual(tile_path.stat().st_mtime_ns, modified)
            self.assertEqual(request(self.map_url(base, STYLES="unknown"))[0], 400)
            self.assertEqual(request(url + "?style=unknown")[0], 400)

    def test_tile_geometry(self):
        self.assertEqual(tile_bounds(0, 0, 0)[0], -20037508.342789244)
        self.assertEqual(list(tiles_for_bbox([5.5, 47, 15.5, 55.5], 3)), [(3, 4, 2)])
        with self.assertRaises(ValueError):
            list(tiles_for_bbox([170, 0, -170, 10], 3))

    def test_received_requests_and_bytes_are_counted_separately_from_metrics_calls(self):
        with service(cog_handler(self.cog, self.input)) as base:
            metrics = lambda: json.loads(request(base + "/metrics")[2])
            initial = metrics()
            self.assertEqual(initial["requestCount"], 0)
            self.assertEqual(metrics()["requestCount"], 0)
            url = base + "/grib2/" + self.source.name
            status, headers, data = request(url, {"Range": "bytes=0-31"})
            self.assertEqual(status, 206)
            self.assertEqual(len(data), 32)
            self.assertEqual(headers["Timing-Allow-Origin"], "*")
            self.assertEqual(request(url, {"If-None-Match": headers["ETag"]})[0], 304)
            self.assertEqual(request(url, method="HEAD")[2], b"")
            self.assertEqual(request(url, method="OPTIONS")[0], 204)
            counters = metrics()
            self.assertEqual(counters["instance"], initial["instance"])
            self.assertEqual(counters["requestCount"], 4)
            self.assertEqual(counters["getRequestCount"], 2)
            self.assertEqual(counters["rangeGetRequestCount"], 1)
            self.assertEqual(counters["completedRequestCount"], 4)
            self.assertEqual(counters["bodyBytesSent"], 32)
            self.assertEqual(counters["responseStatuses"], {"206": 1, "304": 1, "200": 1, "204": 1})

    def test_wms_metrics_count_png_bodies_and_errors_without_catalog_or_capabilities(self):
        with service(wms_handler(self.cog, self.cache)) as base:
            request(base + "/catalog.json")
            request(base + "/wms?SERVICE=WMS&REQUEST=GetCapabilities")
            _, headers, tile = request(f"{base}/tiles/{self.layer['id']}/5/16/10.png")
            self.assertEqual(headers["Timing-Allow-Origin"], "*")
            status, _, error = request(self.map_url(base, LAYERS="missing"))
            self.assertEqual(status, 400)
            counters = json.loads(request(base + "/metrics")[2])
            self.assertEqual(counters["getRequestCount"], 2)
            self.assertEqual(counters["bodyBytesSent"], len(tile) + len(error))
            self.assertEqual(counters["responseStatuses"], {"200": 1, "400": 1})

    def test_cpu_helper_exposes_system_only_counters_and_validates_timestamps(self):
        class Sampler:
            def snapshot(self, since):
                return {"scope": "system", "monotonicMs": 2000, "since": since,
                        "cpuTotalSeconds": 100, "cpuIdleSeconds": 60, "samples": []}
        with service(metrics_handler(Sampler())) as base:
            status, headers, payload = request(base + "/cpu?since=1000")
            self.assertEqual(status, 200)
            result = json.loads(payload)
            self.assertEqual(result["scope"], "system")
            self.assertEqual(result["since"], 1000)
            self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
            for invalid in ["nan", "inf", "-1", "abc"]:
                self.assertEqual(request(base + "/cpu?since=" + invalid)[0], 400)
        Times = namedtuple("Times", "user system idle iowait guest guest_nice")
        self.assertEqual(cpu_counters(Times(20, 10, 60, 5, 2, 1)), (95, 65))


if __name__ == "__main__":
    unittest.main()
