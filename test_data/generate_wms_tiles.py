#!/usr/bin/env python3
"""Pre-render 256px PNG weather tiles; also usable by the WMS/XYZ server."""
import argparse
from datetime import datetime, timezone
from pathlib import Path

from raster_pipeline import DATA_DIR, cache_key, cached_tile, load_catalog, tiles_for_bbox, write_json


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cog-dir", type=Path, default=DATA_DIR / "cog")
    parser.add_argument("--output-dir", type=Path, default=DATA_DIR / "wms_tiles")
    parser.add_argument("--zoom", nargs=2, type=int, metavar=("MIN", "MAX"), default=[3, 6])
    parser.add_argument("--bbox", nargs=4, type=float, metavar=("WEST", "SOUTH", "EAST", "NORTH"),
                        default=[5.5, 47, 15.5, 55.5], help="Geographic bounds; default Germany.")
    parser.add_argument("--variables", nargs="+", help="Only these variables, e.g. t_2m clct.")
    parser.add_argument("--layers", nargs="+", help="Only these exact layer IDs from catalog.json.")
    parser.add_argument("--max-tiles", type=int, default=100000, help="Guard against accidental huge jobs.")
    args = parser.parse_args(argv)
    if not 0 <= args.zoom[0] <= args.zoom[1] <= 22:
        parser.error("Use zoom MIN MAX within 0..22.")
    try:
        catalog = load_catalog(args.cog_dir)
        layers = [layer for layer in catalog["layers"]
                  if (not args.variables or layer["variable"] in args.variables)
                  and (not args.layers or layer["id"] in args.layers)]
        if not layers:
            raise ValueError("No layers match the requested filters.")
        tiles = []
        for z in range(args.zoom[0], args.zoom[1] + 1):
            for tile in tiles_for_bbox(args.bbox, z):
                tiles.append(tile)
                if len(tiles) * len(layers) > args.max_tiles:
                    raise ValueError("Job exceeds --max-tiles. Reduce zoom/bounds/layers or increase the limit.")
        count = len(tiles) * len(layers)
        print(f"Rendering {count} tiles for {len(layers)} layers (existing tiles are reused).", flush=True)
        for index, layer in enumerate(layers, 1):
            for z, x, y in tiles:
                cached_tile(args.cog_dir, args.output_dir, layer, z, x, y)
            print(f"[{index}/{len(layers)}] {layer['id']}: {len(tiles)} tiles", flush=True)
        write_json(args.output_dir / "tiles.json", {
            "schema_version": 1, "generated_at": datetime.now(timezone.utc).isoformat(),
            "scheme": "xyz", "tile_size": 256, "zoom": args.zoom, "bounds": args.bbox,
            "tile_count": count, "layers": [
                {"id": layer["id"], "cache_key": cache_key(args.cog_dir, layer)} for layer in layers]})
        print(f"Tiles saved in {args.output_dir}. Start serve_wms.py to use them.")
    except ValueError as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
