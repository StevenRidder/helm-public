#!/usr/bin/env python3
"""Bake local satellite tiles so the basemap is OFFLINE-by-default — no CDN at runtime.

Reads BBOX + SRC_SAT from a local region.env when present, otherwise from the
public sample. Writes web/data/sat/{z}/{x}/{y}.jpg (standard XYZ), which the
one-origin helm-server serves as static files. Idempotent, threaded, polite.

Usage: python3 pipeline/fetch_sat_tiles.py [zmin] [zmax]   (default 8 13)
"""
import math, os, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "data", "sat")


def env(name, default=""):
    for filename in ("region.env", "region.env.example"):
        path = os.path.join(ROOT, "pipeline", filename)
        try:
            lines = open(path).read().splitlines()
        except OSError:
            continue
        for line in lines:
            line = line.strip()
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return default


def deg2tile(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_r = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n)
    return x, y


def main():
    zmin = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    zmax = int(sys.argv[2]) if len(sys.argv) > 2 else 13
    W, S, E, N = [float(v) for v in env("BBOX", "-82.02,24.34,-81.52,24.72").split(",")]
    src = env("SRC_SAT", "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg")

    jobs = []
    for z in range(zmin, zmax + 1):
        x0, y0 = deg2tile(W, N, z)
        x1, y1 = deg2tile(E, S, z)
        for x in range(min(x0, x1), max(x0, x1) + 1):
            for y in range(min(y0, y1), max(y0, y1) + 1):
                jobs.append((z, x, y))
    print(f"sat tiles: {len(jobs)} for z{zmin}-{zmax}  bbox {W},{S},{E},{N}")

    done = [0]; skip = [0]; fail = [0]

    def fetch(job):
        z, x, y = job
        dst = os.path.join(OUT, str(z), str(x), f"{y}.jpg")
        if os.path.exists(dst) and os.path.getsize(dst) > 0:
            skip[0] += 1; return
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        url = src.format(z=z, x=x, y=y)
        for attempt in range(2):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "helm-pipeline/1.0"})
                with urllib.request.urlopen(req, timeout=20) as r:
                    data = r.read()
                if data:
                    with open(dst, "wb") as f:
                        f.write(data)
                    done[0] += 1; return
            except Exception:
                if attempt == 1:
                    fail[0] += 1

    with ThreadPoolExecutor(max_workers=16) as ex:
        for _ in ex.map(fetch, jobs):
            pass
    print(f"done: {done[0]} fetched, {skip[0]} skipped, {fail[0]} failed -> {OUT}")


if __name__ == "__main__":
    main()
