#!/usr/bin/env python3
"""
make_demo_cog.py — bake a LOCAL georeferenced GeoTIFF for the cog:// Lab toggle.

The maplibre-cog-protocol demo normally streams a remote .tif; to stay
offline-first we generate one from a real Helm field (SST) and ship it under
web/data/. The value-encoded single-band raster is colourised client-side by
the cog:// protocol's #color fragment — exactly the pattern, no CDN.

Pure-Python (numpy + tifffile, build-time only); the .tif is the shipped
artifact. EPSG:4326, tiled, with GeoKeyDirectory/ModelPixelScale/ModelTiepoint
so geotiff.js georeferences it correctly.
"""
import json, os, sys
import numpy as np

sys.path.insert(0, "/tmp/helm-pylibs")  # tifffile installed here at build time
import tifffile

SRC = os.path.join(os.path.dirname(__file__), "..", "web", "data", "field-sst.json")
OUT = os.path.join(os.path.dirname(__file__), "..", "web", "data", "demo-sst-cog.tif")
UP = 20  # bilinear upsample factor for a smooth overlay


def bilinear(grid, fy, fx):
    ny, nx = grid.shape
    out = np.empty((fy, fx), np.float32)
    ys = np.linspace(0, ny - 1, fy)
    xs = np.linspace(0, nx - 1, fx)
    for j, y in enumerate(ys):
        y0 = int(np.floor(y)); y1 = min(y0 + 1, ny - 1); ty = y - y0
        row0 = grid[y0]; row1 = grid[y1]
        for i, x in enumerate(xs):
            x0 = int(np.floor(x)); x1 = min(x0 + 1, nx - 1); tx = x - x0
            top = row0[x0] * (1 - tx) + row0[x1] * tx
            bot = row1[x0] * (1 - tx) + row1[x1] * tx
            out[j, i] = top * (1 - ty) + bot * ty
    return out


def main():
    f = json.load(open(SRC))
    nx, ny = f["nx"], f["ny"]
    g = np.array(f["values"], np.float32).reshape(ny, nx)
    g[g <= 0] = np.nan                       # land / no-data -> transparent in the COG
    fy, fx = ny * UP, nx * UP
    arr = bilinear(g, fy, fx)

    west, north, east, south = f["west"], f["north"], f["east"], f["south"]
    sx = (east - west) / fx                  # ModelPixelScale (deg/px)
    sy = (north - south) / fy
    geokeys = (1, 1, 0, 3,                    # version, rev, minor, num_keys
               1024, 0, 1, 2,                 # GTModelType = Geographic
               1025, 0, 1, 1,                 # GTRasterType = PixelIsArea
               2048, 0, 1, 4326)              # GeographicType = WGS84
    extratags = [
        (34735, 3, len(geokeys), geokeys, True),                 # GeoKeyDirectory
        (33550, 12, 3, (sx, sy, 0.0), True),                     # ModelPixelScale
        (33922, 12, 6, (0.0, 0.0, 0.0, west, north, 0.0), True), # ModelTiepoint (px 0,0 -> NW)
    ]
    tifffile.imwrite(OUT, arr, photometric="minisblack", dtype=np.float32,
                     tile=(128, 128), compression="zlib", extratags=extratags)
    lo = float(np.nanmin(arr)); hi = float(np.nanmax(arr))
    print(f"wrote {OUT}  {fx}x{fy}  SST {lo:.1f}..{hi:.1f}{f['unit']}  ({os.path.getsize(OUT)//1024} KB)")
    print(f"  cog.js ramp suggestion: cog://data/demo-sst-cog.tif#color:Turbo,{lo:.0f},{hi:.0f}")


if __name__ == "__main__":
    main()
