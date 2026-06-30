#!/usr/bin/env python3
"""
Helm weather fetcher — Windy-style multi-layer fields from Open-Meteo (free; same models
Windy uses). See docs/WEATHER-DATA.md.

For each layer it writes web/data/field-<layer>.json (a scalar grid + color ramp for the
heatmap overlay) and, for VECTOR layers, a velocity grid web/data/<layer>.json
(leaflet-velocity format) for the animated particles.

With --hours N it also writes per-hour frames field-<layer>-t<i>.json (+ <layer>-t<i>.json)
and web/data/forecast.json (the shared time axis) for the time scrubber. Open-Meteo returns
the whole hourly series in one request, so more hours cost no extra requests.

Usage:
    python3 fetch_weather.py --bbox="-87,19,-77,29" --nx 14 --ny 14 \
        --layers wind,rain,temp,waves --hours 12 --out ../web/data
"""
import argparse, json, math, os, time, urllib.request, urllib.parse, urllib.error

UA = "HelmWeather/0.1 (+https://github.com/StevenRidder/Helm)"
FORECAST = "https://api.open-meteo.com/v1/forecast"
MARINE = "https://marine-api.open-meteo.com/v1/marine"

LAYERS = {
  "wind":     dict(api="forecast", var="wind_speed_10m",  dir="wind_direction_10m", conv="from", unit="kn", kind="vector",
                   stops=[[0,[56,189,248]],[8,[45,212,191]],[16,[250,204,21]],[24,[249,115,22]],[34,[239,68,68]],[48,[217,33,154]]]),
  "gust":     dict(api="forecast", var="wind_gusts_10m",  unit="kn", kind="scalar",
                   stops=[[0,[56,189,248]],[10,[45,212,191]],[20,[250,204,21]],[30,[249,115,22]],[42,[239,68,68]],[60,[217,33,154]]]),
  "rain":     dict(api="forecast", var="precipitation",   unit="mm", kind="scalar",
                   stops=[[0,[80,160,220,0]],[0.2,[90,180,255,0.55]],[2,[40,120,235,0.8]],[6,[120,90,235,0.85]],[15,[175,60,200,0.9]]]),
  "temp":     dict(api="forecast", var="temperature_2m",  unit="°C", kind="scalar",
                   stops=[[-10,[70,90,200]],[0,[80,180,235]],[10,[70,200,130]],[20,[245,205,60]],[30,[240,120,40]],[42,[210,40,40]]]),
  "clouds":   dict(api="forecast", var="cloud_cover",     unit="%", kind="scalar",
                   stops=[[0,[150,170,190,0]],[40,[200,210,222,0.4]],[80,[235,240,246,0.75]],[100,[250,252,255,0.9]]]),
  "pressure": dict(api="forecast", var="pressure_msl",    unit="hPa", kind="scalar",
                   stops=[[980,[120,80,200]],[1000,[80,160,230]],[1013,[120,205,140]],[1025,[240,200,80]],[1040,[230,110,55]]]),
  "cape":     dict(api="forecast", var="cape",            unit="J/kg", kind="scalar",
                   stops=[[0,[56,160,200,0]],[300,[120,200,120,0.5]],[1000,[245,205,60,0.8]],[2500,[240,120,40,0.9]],[4000,[220,40,40,0.95]]]),
  "waves":    dict(api="marine", var="wave_height",        dir="wave_direction", conv="from", unit="m", kind="vector",
                   stops=[[0,[60,120,205]],[1,[60,200,205]],[2,[80,220,120]],[3,[245,210,70]],[5,[240,120,50]],[7,[220,40,40]]]),
  "swell":    dict(api="marine", var="swell_wave_height",  dir="swell_wave_direction", conv="from", unit="m", kind="vector",
                   stops=[[0,[60,120,205]],[1,[60,200,205]],[2,[80,220,120]],[3,[245,210,70]],[5,[240,120,50]],[7,[220,40,40]]]),
  "current":  dict(api="marine", var="ocean_current_velocity", dir="ocean_current_direction", conv="to", unit="km/h", kind="vector",
                   stops=[[0,[40,90,170]],[1,[60,180,205]],[2,[120,210,120]],[4,[240,200,70]],[6,[230,90,50]]]),
  "sst":      dict(api="marine", var="sea_surface_temperature", unit="°C", kind="scalar",
                   stops=[[16,[70,90,200]],[22,[80,180,235]],[26,[70,200,130]],[29,[245,205,60]],[31,[240,120,40]],[34,[210,40,40]]]),
}


def grid(bbox, nx, ny):
    w, s, e, n = (float(v) for v in bbox.split(","))
    lats = [n - (n - s) * j / (ny - 1) for j in range(ny)]
    lons = [w + (e - w) * i / (nx - 1) for i in range(nx)]
    qlat, qlon = [], []
    for la in lats:
        for lo in lons:
            qlat.append(round(la, 4)); qlon.append(round(lo, 4))
    return (w, s, e, n), qlat, qlon


def fetch(api, qlat, qlon, vars_, hours):
    base = FORECAST if api == "forecast" else MARINE
    nodes, times, CHUNK = [], [], 90
    for off in range(0, len(qlat), CHUNK):
        p = {"latitude": ",".join(map(str, qlat[off:off+CHUNK])),
             "longitude": ",".join(map(str, qlon[off:off+CHUNK]))}
        if hours > 1:
            p["hourly"] = ",".join(vars_); p["forecast_days"] = (hours + 23) // 24; p["timezone"] = "GMT"
        else:
            p["current"] = ",".join(vars_)
        if api == "forecast":
            p["wind_speed_unit"] = "kn"
        url = base + "?" + urllib.parse.urlencode(p)
        payload = None
        for attempt in range(5):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=40) as r:
                    payload = json.load(r)
                break
            except urllib.error.HTTPError as ex:
                if ex.code == 429 and attempt < 4:
                    time.sleep(4 + attempt * 4); continue
                raise
        chunk = payload if isinstance(payload, list) else [payload]
        nodes.extend(chunk)
        if hours > 1 and not times and chunk:
            times = (chunk[0].get("hourly", {}).get("time") or [])[:hours]
        time.sleep(0.4)
    return nodes, times


def getval(node, var, hour):
    if hour is None:
        return (node.get("current") or {}).get(var)
    a = (node.get("hourly") or {}).get(var)
    return a[hour] if isinstance(a, list) and hour < len(a) else None


def write_frame(out, name, L, geom, nodes, hour, suffix, write_points):
    w, s, e, n, nx, ny, dx, dy = geom
    vals, us, vs, feats = [], [], [], []
    for k, node in enumerate(nodes):
        mag = getval(node, L["var"], hour); mag = float(mag) if mag is not None else 0.0
        vals.append(round(mag, 2))
        if L["kind"] == "vector":
            d = getval(node, L["dir"], hour); d = float(d) if d is not None else 0.0
            r = math.radians(d); sgn = -1.0 if L.get("conv", "from") == "from" else 1.0
            us.append(sgn * mag * math.sin(r)); vs.append(sgn * mag * math.cos(r))
            if write_points:
                feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [node.get("longitude"), node.get("latitude")]},
                              "properties": {"value": round(mag, 2), "dir_deg": round(d)}})
    vmin, vmax = (min(vals), max(vals)) if vals else (0, 1)
    field = {"layer": name, "unit": L["unit"], "kind": L["kind"], "nx": nx, "ny": ny,
             "west": w, "north": n, "east": e, "south": s, "vmin": vmin, "vmax": vmax,
             "stops": L["stops"], "values": vals}
    json.dump(field, open(os.path.join(out, f"field-{name}{suffix}.json"), "w"))
    if L["kind"] == "vector":
        hdr = {"nx": nx, "ny": ny, "lo1": w, "la1": n, "lo2": e, "la2": s, "dx": dx, "dy": dy}
        vel = [{"header": {**hdr, "parameterCategory": 2, "parameterNumber": 2}, "data": us},
               {"header": {**hdr, "parameterCategory": 2, "parameterNumber": 3}, "data": vs}]
        fn = ("wind" if name == "wind" else name) + suffix + ".json"
        json.dump(vel, open(os.path.join(out, fn), "w"))
        if write_points:
            ptfn = "wind_points.geojson" if name == "wind" else f"{name}-points.geojson"
            json.dump({"type": "FeatureCollection", "features": feats}, open(os.path.join(out, ptfn), "w"))
    return vmin, vmax


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", required=True)
    ap.add_argument("--nx", type=int, default=20)
    ap.add_argument("--ny", type=int, default=20)
    ap.add_argument("--layers", default="wind,rain,temp,waves")
    ap.add_argument("--hours", type=int, default=1, help="forecast frames for the time scrubber")
    ap.add_argument("--out", default="../web/data")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    (w, s, e, n), qlat, qlon = grid(a.bbox, a.nx, a.ny)
    dx = (e - w) / (a.nx - 1); dy = (n - s) / (a.ny - 1)
    geom = (w, s, e, n, a.nx, a.ny, dx, dy)
    # node coords for the points geojson (Open-Meteo doesn't always echo lat/lon, so attach)
    nodes_geo = list(zip(qlat, qlon))

    all_times = None
    for name in [x.strip() for x in a.layers.split(",") if x.strip()]:
        L = LAYERS.get(name)
        if not L:
            print(f"  ? unknown layer '{name}' — skipping"); continue
        vars_ = [L["var"]] + ([L["dir"]] if L.get("dir") else [])
        nodes, times = fetch(L["api"], qlat, qlon, vars_, a.hours)
        if len(nodes) != a.nx * a.ny:
            print(f"  ! {name}: got {len(nodes)} nodes, expected {a.nx*a.ny} — skipping"); continue
        for i, (la, lo) in enumerate(nodes_geo):     # ensure coords present for points
            nodes[i].setdefault("latitude", la); nodes[i].setdefault("longitude", lo)

        if a.hours > 1:
            for i in range(a.hours):
                write_frame(a.out, name, L, geom, nodes, i, f"-t{i}", write_points=False)
            write_frame(a.out, name, L, geom, nodes, 0, "", write_points=True)   # default = frame 0
            if times: all_times = times
            print(f"  ✓ {name}: {a.nx}x{a.ny}  {L['unit']}  x{a.hours} frames")
        else:
            vmin, vmax = write_frame(a.out, name, L, geom, nodes, None, "", write_points=True)
            print(f"  ✓ {name}: {a.nx}x{a.ny}  {L['unit']}  [{vmin}..{vmax}]")
        time.sleep(1.0)

    if a.hours > 1 and all_times:
        json.dump({"hours": a.hours, "times": all_times}, open(os.path.join(a.out, "forecast.json"), "w"))
        print(f"  ✓ forecast.json: {a.hours} frames ({all_times[0]} … {all_times[-1]})")
    print(f"done -> {a.out}/field-*.json")


if __name__ == "__main__":
    main()
