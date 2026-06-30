#!/usr/bin/env python3
"""
Helm on-demand tiler — the heart of "lasso an area, fetch charts, cache offline."

Fetches XYZ raster tiles for a bounding box across a zoom range and packs them into
a single offline .mbtiles file (SQLite). Pure standard library — no GDAL needed.

This is the engine piece that carries over to ANY front-end (web or native Swift):
MapLibre (GL JS and Native) both read .mbtiles raster sources the same way.

Usage:
    python3 fetch_tiles.py --source "https://.../{z}/{x}/{y}.png" \
        --bbox "-81.86,24.44,-81.68,24.60" --minzoom 9 --maxzoom 15 \
        --out ../web/data/key-west-charts.mbtiles --name "NOAA Key West"

Key correctness detail: .mbtiles stores rows in TMS convention (y=0 at south),
which is flipped from XYZ slippy tiles (y=0 at north). We flip on write.
"""
import argparse, math, os, sqlite3, sys, time, urllib.request, urllib.error

UA = "HelmTiler/0.1 (+https://github.com/StevenRidder/Helm)"

def deg2num(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="XYZ URL template with {z}/{x}/{y}")
    ap.add_argument("--bbox", required=True, help="W,S,E,N (lon/lat)")
    ap.add_argument("--minzoom", type=int, default=9)
    ap.add_argument("--maxzoom", type=int, default=15)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fmt", default="png", help="png | jpg")
    ap.add_argument("--name", default="Helm tiles")
    ap.add_argument("--delay", type=float, default=0.04, help="seconds between requests (be polite)")
    a = ap.parse_args()

    w, s, e, n = (float(v) for v in a.bbox.split(","))
    if os.path.exists(a.out):
        os.remove(a.out)
    con = sqlite3.connect(a.out)
    cur = con.cursor()
    cur.execute("CREATE TABLE metadata (name text, value text)")
    cur.execute("CREATE TABLE tiles (zoom_level int, tile_column int, tile_row int, tile_data blob)")
    cur.execute("CREATE UNIQUE INDEX tile_index on tiles (zoom_level, tile_column, tile_row)")
    for k, v in {"name": a.name, "format": a.fmt, "type": "baselayer", "version": "1.0",
                 "bounds": f"{w},{s},{e},{n}", "minzoom": str(a.minzoom),
                 "maxzoom": str(a.maxzoom)}.items():
        cur.execute("INSERT INTO metadata VALUES (?,?)", (k, v))

    got = miss = total = 0
    for z in range(a.minzoom, a.maxzoom + 1):
        x0, y0 = deg2num(w, n, z)   # NW corner
        x1, y1 = deg2num(e, s, z)   # SE corner
        zget = zmiss = ztot = 0     # per-zoom counters
        for x in range(min(x0, x1), max(x0, x1) + 1):
            for y in range(min(y0, y1), max(y0, y1) + 1):
                ztot += 1
                url = a.source.format(z=z, x=x, y=y)
                try:
                    data = fetch(url)
                except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as ex:
                    zmiss += 1
                    continue
                tms_y = (2 ** z - 1) - y   # XYZ -> TMS flip
                cur.execute("INSERT OR REPLACE INTO tiles VALUES (?,?,?,?)",
                            (z, x, tms_y, sqlite3.Binary(data)))
                zget += 1
                if a.delay:
                    time.sleep(a.delay)
        got += zget; miss += zmiss; total += ztot
        con.commit()
        print(f"  z{z}: {zget} kept, {zmiss} missing ({ztot} seen)", file=sys.stderr)

    con.commit()
    con.close()
    kb = os.path.getsize(a.out) // 1024
    print(f"done -> {a.out}  ({got}/{total} tiles, {kb} KB)")

if __name__ == "__main__":
    main()
