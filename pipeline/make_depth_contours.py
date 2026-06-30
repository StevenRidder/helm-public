#!/usr/bin/env python3
"""
make_depth_contours.py — SMOOTH depth contours, the Windy way (build-time).

maplibre-contour does raw marching-squares on the DEM at runtime in a worker -> blocky
stair-steps + flaky over-zoom. Windy instead precomputes smooth isolines (interpolate the
grid, spline-smooth the polylines) server-side and renders them as plain map lines. We do
the same here, once, offline:

  mosaic the local z12 terrarium DEM tiles  ->  gaussian-smooth the bathymetry surface
  ->  matplotlib contour at navigation depth levels  ->  Chaikin-smooth each polyline
  ->  HELM_USER_DATA_ROOT/depth-contours.geojson, HELM_CONFIG/data/depth-contours.geojson,
      or ~/.helm/data/depth-contours.geojson  (LineString features: {depth, major})

The app renders that as a MapLibre line layer — smooth at ANY zoom (vector geometry),
offline, no worker. Resolution is DEM-limited (free global bathymetry is coarse over reef),
but the curves are smooth instead of stair-stepped.
"""
import json, math, os, re
import numpy as np
from PIL import Image


def gaussian2d(a, sigma):
    """Separable gaussian blur on a float array (vectorised, no scipy)."""
    r = max(1, int(3 * sigma))
    x = np.arange(-r, r + 1, dtype=np.float32)
    k = np.exp(-(x * x) / (2 * sigma * sigma)); k /= k.sum()
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]; pad[axis] = (r, r)
        ap = np.pad(a, pad, mode="edge")
        out = np.zeros_like(a)
        for i, w in enumerate(k):
            sl = [slice(None), slice(None)]; sl[axis] = slice(i, i + a.shape[axis])
            out += w * ap[tuple(sl)]
        a = out
    return a

HERE = os.path.dirname(__file__)
OUT_DIR = (
    os.environ.get("HELM_USER_DATA_ROOT")
    or os.path.join(os.environ.get("HELM_CONFIG", os.path.expanduser("~/.helm")), "data")
)
OUT = os.path.join(OUT_DIR, "depth-contours.geojson")
DEM_DIR = os.path.join(HERE, "..", "web", "data", "dem")
Z = 12                                  # mosaic the finest baked DEM zoom
BLUR = 1.8                              # gaussian radius (px) — de-stair without smearing the coast
CHAIKIN = 3                             # polyline smoothing iterations
# navigation depth levels (metres, negative = below sea level) — fine in the shallow
# anchorage range, coarser deeper; majors are labelled + bold.
LEVELS = [-2, -4, -6, -8, -10, -15, -20, -25, -30, -40, -50,
          -75, -100, -150, -200, -300, -500, -1000, -2000]
MAJOR = {-10, -20, -50, -100, -200, -500, -1000}


def bbox():
    for filename in ("region.env", "region.env.example"):
        try:
            m = re.search(r'BBOX="([^"]+)"', open(os.path.join(HERE, filename)).read())
        except OSError:
            m = None
        if m:
            return tuple(float(x) for x in m.group(1).split(","))   # W,S,E,N
    return -82.02, 24.34, -81.52, 24.72


def deg2tile(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2.0 * n)
    return x, y


def gpix_to_lonlat(gx, gy, z):
    n = 2 ** z * 256.0
    lon = gx / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * gy / n))))
    return lon, lat


def chaikin(pts, iters):
    for _ in range(iters):
        if len(pts) < 3:
            break
        out = [pts[0]]
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            out.append((a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25))
            out.append((a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75))
        out.append(pts[-1])
        pts = out
    return pts


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    W, S, E, N = bbox()
    x0, y1 = deg2tile(W, S, Z)
    x1, y0 = deg2tile(E, N, Z)
    cols, rows = (x1 - x0 + 1), (y1 - y0 + 1)
    H, Wd = rows * 256, cols * 256
    elev = np.zeros((H, Wd), np.float32)
    missing = 0
    for tx in range(x0, x1 + 1):
        for ty in range(y0, y1 + 1):
            p = os.path.join(DEM_DIR, str(Z), str(tx), f"{ty}.png")
            if not os.path.exists(p):
                missing += 1
                continue
            a = np.asarray(Image.open(p).convert("RGB")).astype(np.float32)
            e = (a[:, :, 0] * 256 + a[:, :, 1] + a[:, :, 2] / 256) - 32768
            ry, rx = (ty - y0) * 256, (tx - x0) * 256
            elev[ry:ry + 256, rx:rx + 256] = e

    # smooth the surface to kill the coarse-DEM stair-steps before contouring
    elev = gaussian2d(elev, BLUR)

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    cs = plt.contour(elev, levels=sorted(LEVELS))

    feats = []
    for lvl, segs in zip(cs.levels, cs.allsegs):
        depth = int(round(float(lvl)))
        major = depth in MAJOR
        for seg in segs:
            if len(seg) < 4:
                continue
            # seg points are (col,row) in mosaic px -> global px -> lon/lat
            ll = [gpix_to_lonlat(x0 * 256 + px, y0 * 256 + py, Z) for px, py in seg]
            ll = chaikin(ll, CHAIKIN)
            coords = [[round(lon, 6), round(lat, 6)] for lon, lat in ll]
            feats.append({"type": "Feature",
                          "properties": {"depth": depth, "major": major},
                          "geometry": {"type": "LineString", "coordinates": coords}})

    fc = {"type": "FeatureCollection", "features": feats}
    json.dump(fc, open(OUT, "w"), separators=(",", ":"))
    kb = os.path.getsize(OUT) // 1024
    print(f"wrote {OUT}: {len(feats)} smooth contour lines, {len(LEVELS)} levels, {kb} KB"
          + (f"  ({missing} DEM tiles missing)" if missing else ""))


if __name__ == "__main__":
    main()
