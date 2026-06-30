#!/usr/bin/env python3
"""
Helm — pipeline/fetch_grib.py        WX epic · WX-10  (Tier-2 raw GRIB ingestion)
--------------------------------------------------------------------------
Fetch RAW GRIB2 from the free public models (the Tier-2 path of docs/WEATHER-DATA.md) and write
field-<layer>.json grids in the EXACT shape pipeline/fetch_weather.py (Tier-1 Open-Meteo) produces —
so pipeline/make_value_tiles.py bakes value tiles from either source unchanged. "The renderer doesn't
change between Tier 1 and Tier 2, only the fetcher" (docs/WEATHER-DATA.md). The result feeds the same
value-encoded (Mercator) tile contract + sample(lat,lon,t) probe as the Open-Meteo path.

SOURCES (free, offline-cacheable, commercial-clean):
  --source gfs    NOAA NOMADS GFS 0.25° (atmosphere) — US public domain. Implemented (grib-filter subset).
  --source ecmwf  ECMWF open-data IFS 0.25° — GRIB2, CC-BY-4.0 (ATTRIBUTION REQUIRED). Scaffolded.
  --source icon   DWD ICON open data — free. Scaffolded.
GFS-Wave/WW3 (waves/swell) and RTOFS (currents/SST) are separate products — noted, not yet wired.

DECODING: GRIB2 needs a real decoder. We use pygrib or cfgrib/xarray IF installed (the production
boat image ships one); if neither is present — or there's no network — we DEGRADE HONESTLY: print
exactly what we would have fetched and tell you to use the Tier-1 fetcher or `make_value_tiles.py
--demo`. We NEVER fabricate values to stand in for a real model; missing live data degrades visibly.

Usage:
    python3 fetch_grib.py --bbox="-87,19,-77,29" --nx 24 --ny 24 --layers wind,pressure --hours 12 --out ../web/data
    python3 fetch_grib.py --bbox="-87,19,-77,29" --layers wind --dry-run        # print URLs, fetch nothing
"""
import argparse, json, math, os, sys, time, urllib.request, urllib.parse, urllib.error

UA = "HelmWeather/0.1 (+https://github.com/StevenRidder/Helm)"

# layer -> GFS grib-filter variable selectors (docs/WEATHER-DATA.md Tier-2 column). Each entry:
#   vars: grib-filter var_* selectors; lev: level selector; kind/unit/conv/stops mirror fetch_weather.
GFS = {
    "wind":     dict(vars=["UGRD", "VGRD"], lev="lev_10_m_above_ground", unit="kn", kind="vector", conv="uv",
                     stops=[[0,[56,189,248]],[8,[45,212,191]],[16,[250,204,21]],[24,[249,115,22]],[34,[239,68,68]],[48,[217,33,154]]]),
    "gust":     dict(vars=["GUST"], lev="lev_surface", unit="kn", kind="scalar", conv="ms2kn",
                     stops=[[0,[56,189,248]],[10,[45,212,191]],[20,[250,204,21]],[30,[249,115,22]],[42,[239,68,68]],[60,[217,33,154]]]),
    "pressure": dict(vars=["PRMSL"], lev="lev_mean_sea_level", unit="hPa", kind="scalar", conv="pa2hpa",
                     stops=[[980,[120,80,200]],[1000,[80,160,230]],[1013,[120,205,140]],[1025,[240,200,80]],[1040,[230,110,55]]]),
    "temp":     dict(vars=["TMP"], lev="lev_2_m_above_ground", unit="°C", kind="scalar", conv="k2c",
                     stops=[[-10,[70,90,200]],[0,[80,180,235]],[10,[70,200,130]],[20,[245,205,60]],[30,[240,120,40]],[42,[210,40,40]]]),
    "clouds":   dict(vars=["TCDC"], lev="lev_entire_atmosphere", unit="%", kind="scalar", conv="none",
                     stops=[[0,[150,170,190,0]],[40,[200,210,222,0.4]],[80,[235,240,246,0.75]],[100,[250,252,255,0.9]]]),
    "cape":     dict(vars=["CAPE"], lev="lev_surface", unit="J/kg", kind="scalar", conv="none",
                     stops=[[0,[56,160,200,0]],[300,[120,200,120,0.5]],[1000,[245,205,60,0.8]],[2500,[240,120,40,0.9]],[4000,[220,40,40,0.95]]]),
}
NOMADS = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"


def gfs_cycle(now):
    """Most recent GFS cycle (00/06/12/18Z) with a safety lag for availability."""
    t = now - 5 * 3600                      # ~5 h lag: the cycle is usually posted by then
    cyc = (t // (6 * 3600)) * (6 * 3600)
    g = time.gmtime(cyc)                        # cyc is 6h-aligned, so tm_hour ∈ {0,6,12,18}
    return time.strftime("%Y%m%d", g), "%02d" % g.tm_hour


def gfs_url(bbox, cycle_day, cycle_hr, fhour, sel):
    w, s, e, n = (float(v) for v in bbox.split(","))
    q = [("file", f"gfs.t{cycle_hr}z.pgrb2.0p25.f{fhour:03d}"),
         (sel["lev"], "on")]
    for v in sel["vars"]:
        q.append((f"var_{v}", "on"))
    q += [("subregion", ""), ("leftlon", w), ("rightlon", e), ("toplat", n), ("bottomlat", s),
          ("dir", f"/gfs.{cycle_day}/{cycle_hr}/atmos")]
    return NOMADS + "?" + urllib.parse.urlencode(q)


def have_decoder():
    try:
        import pygrib  # noqa: F401
        return "pygrib"
    except Exception:
        pass
    try:
        import cfgrib  # noqa: F401
        return "cfgrib"
    except Exception:
        pass
    return None


def grid_axes(bbox, nx, ny):
    w, s, e, n = (float(v) for v in bbox.split(","))
    lats = [n - (n - s) * j / (ny - 1) for j in range(ny)]
    lons = [w + (e - w) * i / (nx - 1) for i in range(nx)]
    return (w, s, e, n), lats, lons


def convert(name, conv, vals):
    if conv == "pa2hpa": return [v / 100.0 for v in vals]
    if conv == "k2c":    return [v - 273.15 for v in vals]
    if conv == "ms2kn":  return [v * 1.943844 for v in vals]
    return vals


def write_field(out, name, sel, geom, scal, suffix=""):
    (w, s, e, n, nx, ny) = geom
    vals = [round(float(v), 2) for v in scal]
    vmin, vmax = (min(vals), max(vals)) if vals else (0, 1)
    field = {"layer": name, "unit": sel["unit"], "kind": "scalar", "nx": nx, "ny": ny,
             "west": w, "north": n, "east": e, "south": s, "vmin": vmin, "vmax": vmax,
             "stops": sel["stops"], "values": vals}
    json.dump(field, open(os.path.join(out, f"field-{name}{suffix}.json"), "w"))
    return vmin, vmax


def degrade(reason, urls):
    print(f"\n  ⚠ Tier-2 GRIB unavailable: {reason}")
    print("    This is honest degradation — Helm never fabricates model data to stand in for GRIB.")
    print("    What this run WOULD have fetched (inspect / fetch manually with wgrib2/eccodes):")
    for u in urls:
        print("      " + u)
    print("\n    Fallbacks:")
    print("      • Tier-1 (no GRIB tooling needed):  python3 fetch_weather.py --bbox=... --hours 12")
    print("        then:                             python3 make_value_tiles.py --layers wind,pressure")
    print("      • Offline demo (no network/tools):  python3 make_value_tiles.py --demo")
    return 2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", required=True, help="west,south,east,north (deg)")
    ap.add_argument("--nx", type=int, default=24)
    ap.add_argument("--ny", type=int, default=24)
    ap.add_argument("--layers", default="wind,pressure")
    ap.add_argument("--hours", type=int, default=1, help="forecast frames (f000, f001, …)")
    ap.add_argument("--source", default="gfs", choices=("gfs", "ecmwf", "icon"))
    ap.add_argument("--out", default="../web/data")
    ap.add_argument("--dry-run", action="store_true", help="print the GRIB URLs and exit (no fetch/decode)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    if a.source != "gfs":
        print(f"  source '{a.source}' is scaffolded but not yet wired (GFS is implemented).")
        print("    ECMWF open-data = CC-BY-4.0 (attribution required); DWD ICON = free. See docs/WEATHER-DATA.md.")
        return 3

    names = [x.strip() for x in a.layers.split(",") if x.strip()]
    unknown = [n for n in names if n not in GFS]
    if unknown:
        print(f"  ! GFS-atmos source has no selector for {unknown} (waves/swell=GFS-Wave, current/sst=RTOFS — not yet wired)")
        names = [n for n in names if n in GFS]
    if not names:
        print("  ! no supported GFS-atmos layers requested — nothing to fetch.")
        return 3                                     # don't report false success producing zero output

    cyc_day, cyc_hr = gfs_cycle(int(time.time()))
    # Build the URL list (always — used for --dry-run and for the honest-degradation message).
    urls, plan = [], []
    for name in names:
        sel = GFS[name]
        for h in range(a.hours):
            u = gfs_url(a.bbox, cyc_day, cyc_hr, h, sel)
            urls.append(u); plan.append((name, sel, h, u))

    if a.dry_run:
        print(f"GFS cycle {cyc_day} {cyc_hr}Z · {len(names)} layer(s) × {a.hours} hour(s):")
        for u in urls:
            print("  " + u)
        return 0

    dec = have_decoder()
    if not dec:
        return degrade("no GRIB2 decoder importable (pip install pygrib OR cfgrib)", urls)

    # Real fetch + decode path (runs on a boat image with pygrib/cfgrib + network).
    (w, s, e, n), lats, lons = grid_axes(a.bbox, a.nx, a.ny)
    geom = (w, s, e, n, a.nx, a.ny)
    times = []
    try:
        for (name, sel, h, u) in plan:
            tmp = os.path.join(a.out, f"_grib_{name}_f{h:03d}.grib2")
            req = urllib.request.Request(u, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=90) as r, open(tmp, "wb") as f:
                f.write(r.read())
            scal = decode_grib(dec, tmp, sel, lats, lons)
            os.remove(tmp)
            suffix = f"-t{h}" if a.hours > 1 else ""
            vmin, vmax = write_field(a.out, name, sel, geom, scal, suffix)
            if a.hours > 1 and name == names[0]:
                times.append(time.strftime("%Y-%m-%dT%H:%M", time.gmtime(int(time.time()) + h * 3600)))
            print(f"  ✓ {name} f{h:03d}: [{vmin:.1f}..{vmax:.1f} {sel['unit']}]  src=gfs")
            time.sleep(0.5)
        if a.hours > 1:
            json.dump({"hours": a.hours, "times": times}, open(os.path.join(a.out, "forecast.json"), "w"))
        print(f"done -> {a.out}/field-*.json  (now: python3 make_value_tiles.py --source gfs --model 'NOAA GFS 0.25°')")
        return 0
    except (urllib.error.URLError, OSError, RuntimeError) as ex:
        return degrade(f"fetch/decode failed ({ex})", urls)


def decode_grib(dec, path, sel, lats, lons):
    """Decode the subset GRIB2 to a scalar grid sampled at (lats×lons). Vector wind -> speed magnitude
    (in m/s here; converted to the layer unit by the caller via convert())."""
    if dec == "pygrib":
        import pygrib
        gribs = pygrib.open(path)
        msgs = {m.shortName: m for m in gribs}
        def at(short, strict=False):
            m = msgs.get(short)
            if m is None:
                # Never silently substitute the wrong field (that would fabricate a plausible-but-wrong
                # value — the exact thing the honesty contract forbids). Fail loud for the components
                # we explicitly asked for; the caller degrades.
                if strict:
                    raise RuntimeError(f"GRIB shortName '{short}' not in subset {list(msgs.keys())}")
                m = list(msgs.values())[0]
            data, glat, glon = m.data()
            return _nearest(data, glat, glon, lats, lons)
        if sel["kind"] == "vector":
            us = at("10u", strict=True); vs = at("10v", strict=True)
            scal = [math.hypot(u, v) for u, v in zip(us, vs)]
        else:
            scal = at(list(msgs.keys())[0])
    else:  # cfgrib via xarray
        import xarray as xr
        ds = xr.open_dataset(path, engine="cfgrib")
        var = list(ds.data_vars)[0]
        arr = ds[var]
        scal = [float(arr.interp(latitude=la, longitude=(lo % 360)).values) for la in lats for lo in lons]
        if sel["kind"] == "vector" and len(ds.data_vars) >= 2:
            v2 = ds[list(ds.data_vars)[1]]
            us = scal
            vs = [float(v2.interp(latitude=la, longitude=(lo % 360)).values) for la in lats for lo in lons]
            scal = [math.hypot(u, v) for u, v in zip(us, vs)]
    # GFS UGRD/VGRD are m/s; the vector-magnitude wind needs m/s->kn (conv="uv" alone would leave it
    # in m/s, ~2x understated). Scalars use their declared conv.
    conv = "ms2kn" if sel["kind"] == "vector" else sel.get("conv")
    return convert(sel["unit"], conv, scal)


def _nearest(data, glat, glon, lats, lons):
    """Nearest-grid-point sample of a 2-D field at each (lat,lon). Stdlib-only fallback resampler."""
    import numpy as np
    glat = np.asarray(glat); glon = np.asarray(glon); data = np.asarray(data)
    out = []
    for la in lats:
        for lo in lons:
            lo360 = lo % 360
            d = (glat - la) ** 2 + (np.minimum(abs(glon - lo360), abs(glon - lo360 - 360))) ** 2
            j, i = np.unravel_index(int(d.argmin()), d.shape)
            out.append(float(data[j, i]))
    return out


if __name__ == "__main__":
    sys.exit(main())
