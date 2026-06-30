#!/usr/bin/env python3
"""
Helm — pipeline/make_demo_grib.py        WX epic · WX-12
--------------------------------------------------------------------------
Author a tiny, VALID GRIB2 file (edition 2, regular lat/lon grid template 3.0, simple-packing data
template 5.0) plus a PredictWind-style GPX route — the demo/test fixtures for the device-local
PredictWind import (web/wx-grib2.js decodes the GRIB; web/wx-import.js renders both). Pure stdlib
(struct/math), so the fixtures are regenerable offline and the GRIB reader has a known-good input to
test against. The field is invented — NOT FOR NAVIGATION — but byte-for-byte a conformant GRIB2.

Encoding choice (must match web/wx-grib2.js): simple packing with binScale E=0, decScale D=2,
reference R=0.0, nbits=12 → Y = (0 + X)·10^-2 = X/100, X = round(100·Y), MSB-first bit packing.

    python3 make_demo_grib.py --out ../web/data
"""
import argparse, math, os, struct

BBOX = (-82.02, 24.34, -81.52, 24.72)   # west, south, east, north (Key West — matches the demo pack)
NX, NY = 18, 14


def wind_field():
    """A smooth invented wind-speed field (m/s), row-major NORTH->SOUTH, WEST->EAST."""
    w, s, e, n = BBOX
    vals = []
    for j in range(NY):                              # j=0 -> north (scan mode 0)
        lat = n - (n - s) * j / (NY - 1)
        for i in range(NX):
            lon = w + (e - w) * i / (NX - 1)
            d = math.hypot((lon + 81.77) / 0.18, (lat - 24.52) / 0.14)
            v = 6.0 + 3.0 * math.sin((lon + 81.8) / 0.2) + 4.5 * math.exp(-((d - 1.0) ** 2))
            vals.append(max(0.0, v))
    return vals


def sm32(v):
    """4-byte sign-magnitude int (GRIB2 lat/lon/scale convention)."""
    if v < 0:
        return struct.pack('>I', 0x80000000 | (-v))
    return struct.pack('>I', v)

def sm16(v):
    if v < 0:
        return struct.pack('>H', 0x8000 | (-v))
    return struct.pack('>H', v)


def pack_bits(values, nbits):
    out = bytearray(); acc = 0; nacc = 0
    mask = (1 << nbits) - 1
    for v in values:
        acc = (acc << nbits) | (v & mask); nacc += nbits
        while nacc >= 8:
            nacc -= 8; out.append((acc >> nacc) & 0xFF)
    if nacc > 0:
        out.append((acc << (8 - nacc)) & 0xFF)
    return bytes(out)


def build_grib2(vals):
    w, s, e, n = BBOX
    npts = NX * NY
    nbits, D = 12, 2
    X = [int(round(v * (10 ** D))) for v in vals]     # R=0, E=0 -> X = round(100*Y)

    # --- Section 1: identification (21 bytes) ---
    s1 = struct.pack('>IB', 21, 1) + struct.pack('>HHBBBHBBBBBBB',
        0, 0, 2, 0, 1, 2026, 6, 26, 0, 0, 0, 0, 1)    # centre/sub/tablesV.../reftime/status/type

    # --- Section 3: grid definition (template 3.0) ---
    body3 = (struct.pack('>B', 6)                     # shape of earth = 6 (sphere R=6371229)
             + struct.pack('>B', 0) + struct.pack('>I', 0)     # radius scale + value (unused for shape 6)
             + struct.pack('>B', 0) + struct.pack('>I', 0)     # major axis
             + struct.pack('>B', 0) + struct.pack('>I', 0)     # minor axis
             + struct.pack('>I', NX) + struct.pack('>I', NY)
             + struct.pack('>I', 0)                   # basic angle = 0 -> units of 1e-6 deg
             + struct.pack('>I', 0xFFFFFFFF)          # subdivisions = missing
             + sm32(int(round(n * 1e6))) + sm32(int(round(w * 1e6)))   # La1 (north), Lo1 (west)
             + struct.pack('>B', 0x30)                # res/comp flags: i & j increments given
             + sm32(int(round(s * 1e6))) + sm32(int(round(e * 1e6)))   # La2 (south), Lo2 (east)
             + sm32(int(round((e - w) / (NX - 1) * 1e6)))              # Di
             + sm32(int(round((n - s) / (NY - 1) * 1e6)))              # Dj
             + struct.pack('>B', 0))                  # scan mode 0: +i (W->E), -j (N->S)
    s3 = struct.pack('>IB', 14 + len(body3), 3) + struct.pack('>BIBBH', 0, npts, 0, 0, 0) + body3

    # --- Section 4: product definition (template 4.0): UGRD-style 10 m wind speed ---
    body4 = struct.pack('>BBBBBHBBIBBIBBI',
        2, 1,        # discipline 0, category 2 (momentum), number 1 (wind speed) -> "0.2.1"
        2, 0, 0,     # gen process type / bg / id
        0, 0,        # hours+min cutoff
        1, 0,        # time unit = hour, forecast time = 0
        103, 0, 10,  # 1st surface: 103 = specified height above ground, scale 0, value 10 (m)
        255, 0, 0)   # 2nd surface: missing
    s4 = struct.pack('>IB', 9 + len(body4), 4) + struct.pack('>HH', 0, 0) + body4

    # --- Section 5: data representation (template 5.0 simple packing) ---
    s5 = (struct.pack('>IB', 21, 5) + struct.pack('>IH', npts, 0)
          + struct.pack('>f', 0.0) + sm16(0) + sm16(D) + struct.pack('>BB', nbits, 0))

    # --- Section 6: no bitmap ---
    s6 = struct.pack('>IBB', 6, 6, 255)

    # --- Section 7: data ---
    data = pack_bits(X, nbits)
    s7 = struct.pack('>IB', 5 + len(data), 7) + data

    s8 = b'7777'
    body = s1 + s3 + s4 + s5 + s6 + s7 + s8
    total = 16 + len(body)
    s0 = b'GRIB' + struct.pack('>HBB', 0, 0, 2) + struct.pack('>Q', total)   # disc 0, edition 2
    return s0 + body


GPX = """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PredictWind Offshore" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>PredictWind demo route — Key West</name></metadata>
  <rte>
    <name>PW Optimal Route (demo)</name>
    <rtept lat="24.34" lon="-82.00"><name>Start</name></rtept>
    <rtept lat="24.45" lon="-81.92"><name>WP1</name></rtept>
    <rtept lat="24.55" lon="-81.80"><name>WP2</name></rtept>
    <rtept lat="24.62" lon="-81.66"><name>WP3</name></rtept>
    <rtept lat="24.66" lon="-81.55"><name>Finish</name></rtept>
  </rte>
  <wpt lat="24.566" lon="-81.807"><name>Key West Bight</name></wpt>
</gpx>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="../web/data")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    grib = build_grib2(wind_field())
    gp = os.path.join(a.out, "predictwind-demo.grb2")
    with open(gp, "wb") as f:
        f.write(grib)
    xp = os.path.join(a.out, "predictwind-demo-route.gpx")
    with open(xp, "w") as f:
        f.write(GPX)
    print(f"  ✓ {gp}: {len(grib)} bytes  ({NX}x{NY} wind-speed, simple-packed GRIB2)")
    print(f"  ✓ {xp}: PredictWind-style GPX route (5 rtept + 1 wpt)")
    print("done — device-local import fixtures (NOT FOR NAVIGATION).")


if __name__ == "__main__":
    main()
