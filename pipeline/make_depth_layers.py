#!/usr/bin/env python3
"""Synthesize the S-52 "depth on satellite" layers from the baked DEM bathymetry, so the
depth-area fill / depth contours / soundings work for regions with NO NOAA ENC cell.

Outputs under HELM_USER_DATA_ROOT, HELM_CONFIG/data, or ~/.helm/data
(S-57 attribute names the style reads):
  depare.geojson  depth-area fill polygons   (DRVAL1 = shallow depth of the band)
  depcnt.geojson  depth contour lines        (VALDCO = contour depth)
  soundg.geojson  spot soundings (points)    (DEPTH  = sounding depth)

Depths are positive metres below datum (S-57 convention); DEM water = negative elevation.
"""
import os, math, json
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DEM_DIR = os.path.join(HERE, "..", "web", "data", "dem")
OUT_DIR = (
    os.environ.get("HELM_USER_DATA_ROOT")
    or os.path.join(os.environ.get("HELM_CONFIG", os.path.expanduser("~/.helm")), "data")
)
Z = 12
BLUR = 1.8
BANDS = [2, 5, 10, 20, 40]                  # DRVAL1 thresholds (m): real nearshore bathymetry only
SOUND_STEP = 12                             # sample every N px for spot soundings (~ a couple hundred m)


def region():
    for filename in ("region.env", "region.env.example"):
        try:
            env = open(os.path.join(HERE, filename)).read()
            break
        except OSError:
            env = ""
    for line in env.splitlines():
        if line.startswith("BBOX="):
            return [float(v) for v in line.split("=", 1)[1].strip().strip('"').split(",")]
    return [-82.02, 24.34, -81.52, 24.72]


def deg2tile(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2.0 * n)
    return x, y


def gpix_to_lonlat(px, py, z):
    n = 2 ** z * 256.0
    lon = px / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * py / n))))
    return round(lon, 6), round(lat, 6)


def gaussian2d(a, r):
    if r <= 0:
        return a
    k = max(1, int(r * 3))
    xs = np.arange(-k, k + 1)
    g = np.exp(-(xs ** 2) / (2 * r * r)); g /= g.sum()
    out = np.apply_along_axis(lambda m: np.convolve(m, g, mode="same"), 0, a)
    return np.apply_along_axis(lambda m: np.convolve(m, g, mode="same"), 1, out)


def mosaic(W, S, E, N):
    x0, y1 = deg2tile(W, S, Z)
    x1, y0 = deg2tile(E, N, Z)
    elev = np.zeros(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256), np.float32)
    for tx in range(x0, x1 + 1):
        for ty in range(y0, y1 + 1):
            p = os.path.join(DEM_DIR, str(Z), str(tx), f"{ty}.png")
            if not os.path.exists(p):
                continue
            a = np.asarray(Image.open(p).convert("RGB")).astype(np.float32)
            e = (a[:, :, 0] * 256 + a[:, :, 1] + a[:, :, 2] / 256) - 32768
            elev[(ty - y0) * 256:(ty - y0) * 256 + 256, (tx - x0) * 256:(tx - x0) * 256 + 256] = e
    return elev, x0, y0


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    W, S, E, N = region()
    elev, x0, y0 = mosaic(W, S, E, N)
    depth = -gaussian2d(elev, BLUR)            # positive = deeper; land is negative
    depth = np.clip(depth, -50, 500)           # drop the rare -1297 m NODATA artifact

    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt

    def ll(seg):
        return [list(gpix_to_lonlat(x0 * 256 + px, y0 * 256 + py, Z)) for px, py in seg]

    # --- depare: nested "deeper than band" fills, drawn shallow->deep so the deepest band wins ---
    depare = []
    for d in BANDS:
        cf = plt.contourf(depth, levels=[d, 1e5])
        for path in cf.collections[0].get_paths():
            rings = [ll(r) for r in path.to_polygons() if len(r) >= 4]
            if rings:
                depare.append({"type": "Feature", "properties": {"DRVAL1": d},
                               "geometry": {"type": "Polygon", "coordinates": rings}})
        plt.clf()

    # --- depcnt: contour lines (VALDCO) ---
    depcnt = []
    cs = plt.contour(depth, levels=[b for b in BANDS if b > 0])
    for lvl, segs in zip(cs.levels, cs.allsegs):
        for seg in segs:
            if len(seg) >= 4:
                depcnt.append({"type": "Feature", "properties": {"VALDCO": int(round(float(lvl)))},
                               "geometry": {"type": "LineString", "coordinates": ll(seg)}})

    # --- soundg: spot soundings on a grid, water only ---
    soundg = []
    H, Wd = depth.shape
    for py in range(SOUND_STEP, H - SOUND_STEP, SOUND_STEP):
        for px in range(SOUND_STEP, Wd - SOUND_STEP, SOUND_STEP):
            d = float(depth[py, px])
            if d <= 0.3:            # land / waterline — skip
                continue
            lon, lat = gpix_to_lonlat(x0 * 256 + px, y0 * 256 + py, Z)
            soundg.append({"type": "Feature", "properties": {"DEPTH": round(d, 1)},
                           "geometry": {"type": "Point", "coordinates": [lon, lat]}})

    for name, feats in (("depare", depare), ("depcnt", depcnt), ("soundg", soundg)):
        path = os.path.join(OUT_DIR, name + ".geojson")
        json.dump({"type": "FeatureCollection", "features": feats}, open(path, "w"), separators=(",", ":"))
        print(f"  {name}.geojson: {len(feats)} features, {os.path.getsize(path)//1024} KB")


if __name__ == "__main__":
    main()
