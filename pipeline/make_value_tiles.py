#!/usr/bin/env python3
"""
Helm — pipeline/make_value_tiles.py        WX epic · WX-10
--------------------------------------------------------------------------
Bake VALUE-ENCODED (Mercator) weather tiles: a Web-Mercator XYZ pyramid where each
pixel's RGB encodes a real physical value (wind kn, MSLP hPa, °C, mm, …) and alpha is
a NODATA mask. The browser (web/integrations/cog.js) decodes + colourises these
client-side, and the SAME tiles answer the deterministic sample(lat,lon,t) probe that
ROUTING-3 / AI-5 consume. This is the pan/zoomable replacement for the fixed-bbox
`field-*.json` blob — the "value-encoded (Mercator) tile contract" of WX-10.

Encoding "helm-wxv1" (the contract lives in web/wx-value-codec.js — this MIRRORS it):
    n      = clamp(round((value - offset) / scale), 0, 0xFFFFFF)
    R,G,B  = (n>>16)&255, (n>>8)&255, n&255      A = 255 valid | 0 NODATA
    value  = offset + ((R<<16)|(G<<8)|B) * scale     (only where A >= 128)
`scale`/`offset` are per-LAYER, constant across all time frames (so values + colours
are comparable along the scrubber), derived from the field's global [min,max] and
written into manifest.json. NODATA stays NODATA — Helm never fakes a value to fill a gap.

NO third-party deps — stdlib only (math, os, struct, zlib, json), exactly like
gen_demo_data.py, so it runs on the constrained system python3 and the bake is
offline + hash-stable. Source grids are the field-<layer>.json the Tier-1 fetcher
already writes (pipeline/fetch_weather.py) OR a GRIB-derived grid of the same shape
(pipeline/fetch_grib.py) — the renderer is invariant, only the fetcher changes.

Usage:
    # bake from the existing Open-Meteo demo fields (offline, no network):
    python3 make_value_tiles.py --layers wind,pressure --zmin 6 --zmax 9 --data ../web/data
    # an ocean-only layer, masking land (values <= 0 in the demo SST grid):
    python3 make_value_tiles.py --layers sst --mask-below 0.01 --data ../web/data
"""
import argparse, glob, json, math, os, struct, time, zlib

VMAX24 = 0xFFFFFF
ENCODING = "helm-wxv1"

# ---------------------------------------------------------------- web mercator (mirrors gen_demo_data.py + wx-value-codec.js)
def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    lr = math.radians(lat)
    y = (1.0 - math.log(math.tan(lr) + 1.0 / math.cos(lr)) / math.pi) / 2.0 * n
    return x, y

def pixel_to_lonlat(z, xt, yt, px, py, size=256):
    n = 2 ** z
    x = xt + px / size
    y = yt + py / size
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat

def tiles_for_bbox(z, bbox):                       # bbox = (west, south, east, north)
    x0, _ = lonlat_to_tile(bbox[0], bbox[1], z)
    x1, _ = lonlat_to_tile(bbox[2], bbox[3], z)
    _, y0 = lonlat_to_tile(bbox[0], bbox[3], z)     # north edge -> smaller y
    _, y1 = lonlat_to_tile(bbox[2], bbox[1], z)     # south edge -> larger y
    return [(z, x, y)
            for x in range(int(math.floor(x0)), int(math.floor(x1)) + 1)
            for y in range(int(math.floor(y0)), int(math.floor(y1)) + 1)]

# ---------------------------------------------------------------- PNG writer (verbatim from gen_demo_data.py)
def write_png(path, buf, size=256, alpha=False):
    ch = 4 if alpha else 3
    raw = bytearray()
    stride = size * ch
    for row in range(size):
        raw.append(0)                               # filter type 0 (None)
        raw.extend(buf[row * stride:(row + 1) * stride])
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6 if alpha else 2, 0, 0, 0)
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(png)

# ---------------------------------------------------------------- value encode (mirrors wx-value-codec.encodeValue)
def encode_value(v, scale, offset, bits=24):
    # Always quantise on the 24-bit grid (scale is the 24-bit step), then optionally drop the low
    # byte(s). At bits=16 the blue channel is constant 0 → the PNG compresses an order of magnitude
    # better while still resolving (max-min)/65535 per step — far below any weather display precision.
    # The decoder (wx-value-codec.decodeRGBA) is UNCHANGED: it reads all three channels × scale.
    n = int(round((v - offset) / scale))
    n = 0 if n < 0 else (VMAX24 if n > VMAX24 else n)
    if bits < 24:
        drop = 24 - bits
        n = (n >> drop) << drop
    return (n >> 16) & 255, (n >> 8) & 255, n & 255

# ---------------------------------------------------------------- source grid
class Grid:
    """A field-<layer>.json grid: row-major values, row0=north, col0=west, EPSG:4326 bbox."""
    def __init__(self, d):
        self.nx, self.ny = d["nx"], d["ny"]
        self.west, self.north = d["west"], d["north"]
        self.east, self.south = d["east"], d["south"]
        self.values = d["values"]
        self.unit = d.get("unit", "")
        self.stops = d.get("stops")
        self.layer = d.get("layer", "")

    def sample(self, lon, lat, mask_below, mask_above):
        """Bilinear value at lon/lat, or None outside coverage / masked (NODATA — never faked)."""
        fx = (lon - self.west) / ((self.east - self.west) or 1) * (self.nx - 1)
        fy = (self.north - lat) / ((self.north - self.south) or 1) * (self.ny - 1)
        if fx < -0.001 or fx > self.nx - 1 + 0.001 or fy < -0.001 or fy > self.ny - 1 + 0.001:
            return None
        x0 = max(0, min(self.nx - 1, int(math.floor(fx))))
        y0 = max(0, min(self.ny - 1, int(math.floor(fy))))
        x1 = min(self.nx - 1, x0 + 1); y1 = min(self.ny - 1, y0 + 1)
        gx, gy = fx - x0, fy - y0
        v = self.values
        v00, v10 = v[y0 * self.nx + x0], v[y0 * self.nx + x1]
        v01, v11 = v[y1 * self.nx + x0], v[y1 * self.nx + x1]
        val = (v00 * (1 - gx) + v10 * gx) * (1 - gy) + (v01 * (1 - gx) + v11 * gx) * gy
        if mask_below is not None and val < mask_below:
            return None
        if mask_above is not None and val > mask_above:
            return None
        return val


def load_frames(data_dir, layer):
    """Return (frames[list[Grid]], times[list[str]|None]). Per-hour frames if present, else single."""
    fc_path = os.path.join(data_dir, "forecast.json")
    t0 = os.path.join(data_dir, f"field-{layer}-t0.json")
    if os.path.exists(fc_path) and os.path.exists(t0):
        with open(fc_path) as f:
            fc = json.load(f)
        hours = fc.get("hours") or len(fc.get("times") or [])
        frames = []
        for i in range(hours):
            fp = os.path.join(data_dir, f"field-{layer}-t{i}.json")
            if not os.path.exists(fp):
                break
            with open(fp) as f:
                frames.append(Grid(json.load(f)))
        if frames:
            return frames, (fc.get("times") or [])[:len(frames)]
    single = os.path.join(data_dir, f"field-{layer}.json")
    if os.path.exists(single):
        with open(single) as f:
            return [Grid(json.load(f))], None
    return [], None


def bake_layer(data_dir, out_root, layer, zmin, zmax, mask_below, mask_above,
               source, model, pad=0.0, bits=24):
    """Production path: load field-<layer>.json from disk, then bake."""
    frames, times = load_frames(data_dir, layer)
    if not frames:
        print(f"  ! {layer}: no field-{layer}.json — skipping (run fetch_weather.py / fetch_grib.py)")
        return None
    return bake_frames(out_root, layer, frames, times, zmin, zmax,
                       mask_below, mask_above, source, model, pad, bits)


def bake_frames(out_root, layer, frames, times, zmin, zmax, mask_below, mask_above,
                source, model, pad=0.0, bits=24):
    g0 = frames[0]
    bbox = (g0.west, g0.south, g0.east, g0.north)
    if g0.west >= g0.east:
        # An antimeridian-crossing bbox (west >= east, e.g. 178..-178 around Fiji/180°) would make
        # tiles_for_bbox yield nothing and silently bake an empty pack. Fail loud, don't pretend.
        print(f"  ! {layer}: bbox crosses the antimeridian (west {g0.west} >= east {g0.east}) — "
              f"not supported yet; split into two sub-bboxes either side of 180°. Skipping.")
        return None
    # GLOBAL min/max across every frame so colours + decoded values are comparable along the scrubber.
    valid = []
    for g in frames:
        for val in g.values:
            if mask_below is not None and val < mask_below:
                continue
            if mask_above is not None and val > mask_above:
                continue
            valid.append(val)
    vmin, vmax = (min(valid), max(valid)) if valid else (0.0, 1.0)
    vmin -= pad; vmax += pad
    scale = (vmax - vmin) / VMAX24 if vmax > vmin else 1.0
    offset = vmin
    # Value tiles ALWAYS carry a NODATA mask (alpha). A tile straddling the data bbox edge has
    # out-of-coverage pixels; without alpha those would decode to offset==vmin (a real value) and
    # the client would paint phantom min-field weather in the margin. alpha=0 makes them honestly
    # transparent + sample as null. The alpha channel is near-constant (0 or 255) so it costs little.
    has_alpha = True
    layer_dir = os.path.join(out_root, layer)

    frame_meta, total_tiles = [], 0
    for fi, g in enumerate(frames):
        sub = f"t{fi}" if times is not None else "."
        for z in range(zmin, zmax + 1):
            for (zz, xt, yt) in tiles_for_bbox(z, bbox):
                ch = 4 if has_alpha else 3
                buf = bytearray(256 * 256 * ch)
                i = 0; any_valid = False
                for py in range(256):
                    for px in range(256):
                        lon, lat = pixel_to_lonlat(z, xt, yt, px, py)
                        val = g.sample(lon, lat, mask_below, mask_above)
                        if val is None:
                            buf[i + 3] = 0          # transparent NODATA (out-of-coverage / masked)
                            i += ch; continue
                        any_valid = True
                        r, gg, b = encode_value(val, scale, offset, bits)
                        buf[i] = r; buf[i + 1] = gg; buf[i + 2] = b; buf[i + 3] = 255
                        i += ch
                if not any_valid:
                    continue                         # don't write an all-NODATA tile
                path = os.path.join(layer_dir, sub, str(z), str(xt), f"{yt}.png") if times is not None \
                    else os.path.join(layer_dir, str(z), str(xt), f"{yt}.png")
                write_png(path, bytes(buf), alpha=has_alpha)
                total_tiles += 1
        if times is not None:
            frame_meta.append({"t": fi, "validTime": times[fi] if fi < len(times) else None,
                               "dir": f"t{fi}"})

    manifest = {
        "encoding": ENCODING, "bits": bits, "tileSize": 256,
        "layer": layer, "unit": g0.unit, "kind": "scalar",
        "scale": scale, "offset": offset, "nodata_alpha": 0, "has_alpha": has_alpha,
        "minzoom": zmin, "maxzoom": zmax,
        "bbox": [g0.west, g0.south, g0.east, g0.north],   # west, south, east, north (EPSG:4326)
        "vmin": round(vmin, 4), "vmax": round(vmax, 4),
        "ramp": g0.stops,
        "source": source, "model": model,
        # synthetic demo has no real fetch time (keeps the committed manifest deterministic);
        # production tags the issue/fetch time so the UI can show data-age honestly.
        "fetchedAt": None if source == "demo-synthetic" else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "times": times, "frames": frame_meta if times is not None else None,
        # tiles_template is relative to the manifest dir; {frame} is '' for single-frame sets.
        "tiles_template": "{frame}/{z}/{x}/{y}.png" if times is not None else "{z}/{x}/{y}.png",
        "horizon": "good ~0–7 d; beyond is climatology",
        "confidence": "fair",
        "disclaimer": "Forecast — cross-reference official sources. NOT FOR NAVIGATION.",
    }
    os.makedirs(layer_dir, exist_ok=True)
    with open(os.path.join(layer_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f)
    nframes = len(frames)
    print(f"  ✓ {layer}: {total_tiles} tiles  z{zmin}-{zmax} ×{nframes} frame(s)  "
          f"[{vmin:.2f}..{vmax:.2f} {g0.unit}]  scale={scale:.3e}  src={source}")
    return manifest


# ---------------------------------------------------------------- deterministic offline demo source
# Synthesize field-<layer>.json-shaped grids with NO network, so the committed demo tiles are
# REGENERABLE offline (like gen_demo_data.py's DEM) — `make_value_tiles.py --demo` reproduces them.
# Region = Key West, matching the rest of the committed demo pack (dem/relief/ais/radar). The shapes
# are invented (NOT FOR NAVIGATION) but in the exact format a real GFS/Open-Meteo field uses, so the
# renderer + probe code is identical to production. A drifting low animates the 12-frame scrubber.
DEMO_BBOX = (-82.02, 24.34, -81.52, 24.72)            # west, south, east, north
DEMO_HOURS = 12
DEMO_STOPS = {
    "wind": [[0, [98, 113, 183]], [5, [57, 131, 168]], [10, [52, 171, 151]], [16, [123, 183, 80]],
             [22, [225, 200, 60]], [30, [232, 130, 50]], [40, [214, 70, 74]], [55, [150, 60, 150]]],
    "pressure": [[980, [120, 80, 200]], [1000, [80, 160, 230]], [1013, [120, 205, 140]],
                 [1025, [240, 200, 80]], [1040, [230, 110, 55]]],
}

# Two synthetic ensemble members (WX-11). They AGREE at the analysis hour and DIVERGE as the
# forecast horizon grows — ECMWF places the low a little further ESE and deepens it more — so the
# GFS-vs-ECMWF spread is small now and large later, which is exactly the decision-relevant honesty
# the multi-model display exists to show. Pure offline synthetic — NOT FOR NAVIGATION.
DEMO_MEMBERS = {
    "gfs":   dict(lon=0.0,  lat=0.0,  amp=1.0),
    "ecmwf": dict(lon=0.045, lat=-0.03, amp=1.30),
}

def demo_frames(layer, member=None):
    w, s, e, n = DEMO_BBOX
    nx = ny = 24
    unit = "kn" if layer == "wind" else "hPa"
    bias = DEMO_MEMBERS.get(member, DEMO_MEMBERS["gfs"])
    frames, times = [], []
    for h in range(DEMO_HOURS):
        frac = h / (DEMO_HOURS - 1)                       # 0 at analysis -> 1 at the far horizon
        # a low-pressure centre drifts ENE across the region over the 12 hours; the member-specific
        # deviation is scaled by `frac`, so members start identical and spread apart with horizon.
        clon = w + (e - w) * (0.15 + 0.6 * h / (DEMO_HOURS - 1)) + bias["lon"] * frac
        clat = s + (n - s) * (0.35 + 0.25 * h / (DEMO_HOURS - 1)) + bias["lat"] * frac
        amp = 1.0 + (bias["amp"] - 1.0) * frac
        vals = []
        for j in range(ny):
            lat = n - (n - s) * j / (ny - 1)
            for i in range(nx):
                lon = w + (e - w) * i / (nx - 1)
                d = math.hypot((lon - clon) / 0.18, (lat - clat) / 0.14)
                if layer == "pressure":
                    # gentle high with the drifting low dimple (ECMWF deepens it more -> amp)
                    v = 1016.0 + 3.0 * math.sin((lon + 81.8) / 0.5) - 6.0 * amp * math.exp(-d * d)
                else:  # wind: prevailing SE breeze, freshening around the low
                    base = 11.0 + 3.0 * math.sin((lon + 81.7) / 0.22) + 2.0 * math.cos((lat - 24.5) / 0.2)
                    v = base + 9.0 * amp * math.exp(-((d - 1.0) ** 2))   # a band of stronger wind around the low
                vals.append(round(v, 2))
        frames.append(Grid({"layer": layer, "unit": unit, "kind": "scalar", "nx": nx, "ny": ny,
                            "west": w, "north": n, "east": e, "south": s,
                            "vmin": min(vals), "vmax": max(vals), "stops": DEMO_STOPS[layer], "values": vals}))
        times.append("2026-06-26T%02d:00" % h)
    return frames, times


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--layers", default="wind,pressure", help="comma list of field-<layer> names")
    ap.add_argument("--demo", action="store_true",
                    help="bake from a deterministic offline synthetic field (Key West) — regenerable demo")
    ap.add_argument("--demo-ensemble", action="store_true",
                    help="bake TWO synthetic members (gfs+ecmwf) per layer + ensemble.json (WX-11 spread demo)")
    ap.add_argument("--data", default="../web/data", help="dir holding field-<layer>.json")
    ap.add_argument("--out", default=None, help="output root (default: <data>/wxtiles)")
    ap.add_argument("--zmin", type=int, default=4)
    ap.add_argument("--zmax", type=int, default=7, help="bake to here; the client overzooms beyond it")
    ap.add_argument("--bits", type=int, default=16, choices=(16, 24),
                    help="value precision; 16 keeps tiles ~10x smaller (committed demo), 24 for max fidelity")
    ap.add_argument("--mask-below", type=float, default=None, help="NODATA where value < this")
    ap.add_argument("--mask-above", type=float, default=None, help="NODATA where value > this")
    ap.add_argument("--pad", type=float, default=0.0, help="widen [min,max] by this many units")
    ap.add_argument("--source", default="open-meteo", help="provenance tag (open-meteo|gfs|ecmwf-ifs|icon)")
    ap.add_argument("--model", default="Open-Meteo (GFS-seamless)", help="human model name shown in UI")
    a = ap.parse_args()
    out_root = a.out or os.path.join(a.data, "wxtiles")
    os.makedirs(out_root, exist_ok=True)
    layers = [x.strip() for x in a.layers.split(",") if x.strip()]

    if a.demo_ensemble:
        # WX-11: two synthetic members per layer (gfs + ecmwf) into <layer>-<member>/, paired in
        # ensemble.json so the spread display can decode GFS vs ECMWF and show where they disagree.
        MODEL_NAME = {"gfs": "GFS demo (synthetic, NOT FOR NAVIGATION)",
                      "ecmwf": "ECMWF demo (synthetic, NOT FOR NAVIGATION)"}
        print(f"Baking ENSEMBLE value tiles (gfs+ecmwf) -> {out_root}  [--demo-ensemble synthetic]")
        pairs = {}
        for layer in layers:
            members = {}
            for mem in ("gfs", "ecmwf"):
                frames, times = demo_frames(layer, mem)
                setid = f"{layer}-{mem}"
                m = bake_frames(out_root, setid, frames, times, a.zmin, a.zmax,
                                a.mask_below, a.mask_above, "demo-synthetic", MODEL_NAME[mem], a.pad, a.bits)
                if m:
                    members[mem] = {"manifest": f"{setid}/manifest.json", "model": MODEL_NAME[mem],
                                    "vmin": m["vmin"], "vmax": m["vmax"]}
            if len(members) == 2:
                pairs[layer] = {"unit": "kn" if layer == "wind" else "hPa", "members": members,
                                "frames": DEMO_HOURS}
        with open(os.path.join(out_root, "ensemble.json"), "w") as f:
            json.dump({"encoding": ENCODING, "pairs": pairs}, f)
        print(f"done — {len(pairs)} ensemble pair(s); ensemble.json lists them for the spread display.")
        return 0

    src = "demo-synthetic" if a.demo else a.source
    model = "Helm synthetic demo (NOT FOR NAVIGATION)" if a.demo else a.model
    print(f"Baking value-encoded weather tiles -> {out_root}" + ("  [--demo synthetic]" if a.demo else ""))
    index = {}
    for layer in layers:
        if a.demo:
            frames, times = demo_frames(layer)
            m = bake_frames(out_root, layer, frames, times, a.zmin, a.zmax,
                            a.mask_below, a.mask_above, src, model, a.pad, a.bits)
        else:
            m = bake_layer(a.data, out_root, layer, a.zmin, a.zmax,
                           a.mask_below, a.mask_above, src, model, a.pad, a.bits)
        if m:
            index[layer] = {"unit": m["unit"], "source": m["source"], "model": m["model"],
                            "minzoom": m["minzoom"], "maxzoom": m["maxzoom"],
                            "frames": len(m["times"]) if m["times"] else 1,
                            "manifest": f"{layer}/manifest.json"}
    with open(os.path.join(out_root, "index.json"), "w") as f:
        json.dump({"encoding": ENCODING, "layers": index}, f)
    print(f"done — {len(index)} layer(s); index.json lists them for the UI picker.")


if __name__ == "__main__":
    main()
