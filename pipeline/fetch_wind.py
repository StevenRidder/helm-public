#!/usr/bin/env python3
"""
Helm wind fetcher — real gridded wind for the bbox, for the weather overlay.

Pulls current 10 m wind on a grid from Open-Meteo (free, no key) and writes:
  - web/data/wind.json          velocity format (u/v components) for particle layers
                                (leaflet-velocity / windgl / maplibre-gl-wind)
  - web/data/wind_points.geojson  one point per node (speed_kn, dir_deg) for arrow rendering

Pure standard library. Production swaps the source for GFS/ECMWF GRIB (NOMADS), but the
output formats stay identical — so the front-end code does not change.

Usage:
    python3 fetch_wind.py --bbox "-81.86,24.44,-81.68,24.60" --nx 9 --ny 9 --out ../web/data
"""
import argparse, json, math, os, urllib.request, urllib.parse

UA = "HelmWind/0.1 (+https://github.com/StevenRidder/Helm)"

def met_to_uv(speed, direction_from_deg):
    # meteorological: direction is where wind comes FROM
    r = math.radians(direction_from_deg)
    u = -speed * math.sin(r)   # eastward
    v = -speed * math.cos(r)   # northward
    return u, v

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", required=True, help="W,S,E,N")
    ap.add_argument("--nx", type=int, default=9)
    ap.add_argument("--ny", type=int, default=9)
    ap.add_argument("--out", default="../web/data")
    a = ap.parse_args()
    w, s, e, n = (float(v) for v in a.bbox.split(","))
    os.makedirs(a.out, exist_ok=True)

    # grid from NW (north,west) going east then south — the order velocity JSON expects
    lats = [n - (n - s) * j / (a.ny - 1) for j in range(a.ny)]
    lons = [w + (e - w) * i / (a.nx - 1) for i in range(a.nx)]
    qlat, qlon = [], []
    for la in lats:
        for lo in lons:
            qlat.append(round(la, 4))
            qlon.append(round(lo, 4))

    # Open-Meteo multi-point GET has a URL-length limit (~HTTP 414), so batch the grid.
    CHUNK = 90
    nodes = []
    for off in range(0, len(qlat), CHUNK):
        params = {
            "latitude": ",".join(map(str, qlat[off:off + CHUNK])),
            "longitude": ",".join(map(str, qlon[off:off + CHUNK])),
            "current": "wind_speed_10m,wind_direction_10m",
            "wind_speed_unit": "kn",
        }
        url = "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=40) as r:
            payload = json.load(r)
        nodes.extend(payload if isinstance(payload, list) else [payload])
    if len(nodes) != a.nx * a.ny:
        raise SystemExit(f"Open-Meteo returned {len(nodes)} nodes, expected {a.nx * a.ny} "
                         f"(grid {a.nx}x{a.ny}); retry.")

    us, vs, feats = [], [], []
    for k, node in enumerate(nodes):
        cur = node.get("current", {})
        spd = float(cur.get("wind_speed_10m", 0) or 0)
        deg = float(cur.get("wind_direction_10m", 0) or 0)
        u, v = met_to_uv(spd, deg)
        us.append(u); vs.append(v)
        feats.append({"type": "Feature",
                      "geometry": {"type": "Point", "coordinates": [qlon[k], qlat[k]]},
                      "properties": {"speed_kn": round(spd, 1), "dir_deg": round(deg)}})

    dx = (e - w) / (a.nx - 1)
    dy = (n - s) / (a.ny - 1)
    header = {"nx": a.nx, "ny": a.ny, "lo1": w, "la1": n, "lo2": e, "la2": s,
              "dx": dx, "dy": dy, "refTime": nodes[0].get("current", {}).get("time", "") if nodes else ""}
    velocity = [
        {"header": {**header, "parameterCategory": 2, "parameterNumber": 2, "parameterNumberName": "U-component_of_wind"}, "data": us},
        {"header": {**header, "parameterCategory": 2, "parameterNumber": 3, "parameterNumberName": "V-component_of_wind"}, "data": vs},
    ]
    with open(os.path.join(a.out, "wind.json"), "w") as f:
        json.dump(velocity, f)
    with open(os.path.join(a.out, "wind_points.geojson"), "w") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f)
    print(f"done -> {a.out}/wind.json + wind_points.geojson  ({len(feats)} nodes)")

if __name__ == "__main__":
    main()
