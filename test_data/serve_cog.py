#!/usr/bin/env python3
"""Serve the COG catalog and TIFFs with HTTP byte ranges and browser CORS."""
import argparse
from pathlib import Path
from urllib.parse import urlsplit

from http_common import LocalHandler, run_server, safe_path

DATA_DIR = Path(__file__).resolve().parent


def make_handler(root: Path, grib_root: Path | None = None):
    grib_root = grib_root or DATA_DIR / "grib2"
    class CogHandler(LocalHandler):
        def do_GET(self):
            if self.serve_metrics():
                return
            route = urlsplit(self.path).path
            if route in ("/", "/health"):
                self.send_json({"service": "cog", "catalog": "/catalog.json",
                                "files": "/cog/<path>.tif", "grib2": "/grib2/<path>.grib2"})
                return
            try:
                if route == "/catalog.json":
                    path = root / "catalog.json"
                elif route.startswith("/cog/"):
                    path = safe_path(root, route[len("/cog/"):])
                    if path.suffix.lower() != ".tif":
                        raise ValueError("Only COG TIFF files are served here.")
                elif route.startswith("/grib2/"):
                    path = safe_path(grib_root, route[len("/grib2/"):])
                    if path.suffix.lower() != ".grib2":
                        raise ValueError("Serve decompressed .grib2 files; .bz2 is not supported by the browser decoder.")
                else:
                    self.send_error(404, "Use /catalog.json, /cog/<path>.tif or /grib2/<path>.grib2")
                    return
                if not path.is_file():
                    self.send_error(404, "File not found. Run grib2_to_cog.py first.")
                    return
                self.serve_file(path, ranges=True)
            except ValueError as error:
                self.send_error(400, str(error))
            except (BrokenPipeError, ConnectionResetError):
                pass
    return CogHandler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DATA_DIR / "cog")
    parser.add_argument("--grib-dir", type=Path, default=DATA_DIR / "grib2")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    args = parser.parse_args()
    if not args.root.is_dir():
        parser.error(f"Directory missing: {args.root}. Run grib2_to_cog.py first.")
    run_server(args.host, args.port, make_handler(args.root.resolve(), args.grib_dir.resolve()))


if __name__ == "__main__":
    main()
