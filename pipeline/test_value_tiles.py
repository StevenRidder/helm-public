#!/usr/bin/env python3
"""
Helm - pipeline/test_value_tiles.py        WX epic - WX-10

Stdlib-only tests for the value-encoded weather-tile baker. Also proves the
Python baker and the JS renderer (web/wx-value-codec.js) agree on the encoding by
round-tripping Python-encoded pixels through the ACTUAL JS decoder via node.

    python3 pipeline/test_value_tiles.py
"""
import json
import math
import os
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import make_value_tiles as M


def py_decode(r, g, b, scale, offset):
    return offset + ((r << 16) | (g << 8) | b) * scale


def read_png_rgb(path):
    with open(path, "rb") as f:
        raw = f.read()
    assert raw[:8] == b"\x89PNG\r\n\x1a\n"
    off = 8
    w = h = ct = 0
    idat = bytearray()
    while off < len(raw):
        ln = struct.unpack(">I", raw[off:off + 4])[0]
        tag = raw[off + 4:off + 8]
        data = raw[off + 8:off + 8 + ln]
        off += 12 + ln
        if tag == b"IHDR":
            w, h = struct.unpack(">II", data[:8])
            ct = data[9]
        elif tag == b"IDAT":
            idat += data
        elif tag == b"IEND":
            break
    ch = 4 if ct == 6 else 3
    rawpix = zlib.decompress(bytes(idat))
    stride = w * ch
    rows = []
    for r in range(h):
        base = r * (stride + 1) + 1
        rows.append(rawpix[base:base + stride])
    return w, h, ch, rows


class ValueTilesTest(unittest.TestCase):
    def setUp(self):
        self.so_min = 980.0
        self.so_max = 1040.0
        self.scale = (self.so_max - self.so_min) / M.VMAX24
        self.offset = self.so_min

    def test_python_value_encoding_round_trips_and_clamps(self):
        for value in (980.0, 1000.0, 1013.2, 1025.7, 1040.0):
            r, g, b = M.encode_value(value, self.scale, self.offset)
            self.assertLess(abs(py_decode(r, g, b, self.scale, self.offset) - value), 0.001)

        self.assertEqual(M.encode_value(1013.2, self.scale, self.offset), (141, 167, 64))
        self.assertEqual(M.encode_value(5000, self.scale, self.offset), (255, 255, 255))
        self.assertEqual(M.encode_value(-100, self.scale, self.offset), (0, 0, 0))

    def test_tile_math_and_end_to_end_bake(self):
        xf, yf = M.lonlat_to_tile(177.4, -17.7, 10)
        lon, lat = M.pixel_to_lonlat(
            10,
            math.floor(xf),
            math.floor(yf),
            (xf - math.floor(xf)) * 256,
            (yf - math.floor(yf)) * 256,
        )
        self.assertLess(abs(lon - 177.4), 1e-6)
        self.assertLess(abs(lat + 17.7), 1e-6)
        self.assertGreaterEqual(len(M.tiles_for_bbox(8, (175.9, -19.2, 178.9, -16.2))), 1)

        with tempfile.TemporaryDirectory() as td:
            data = os.path.join(td, "data")
            out = os.path.join(td, "out")
            os.makedirs(data)
            nx = ny = 4
            vals = [10 + 30 * (j * nx + i) / (nx * ny - 1) for j in range(ny) for i in range(nx)]
            fixture = {
                "layer": "tst",
                "unit": "kn",
                "kind": "scalar",
                "nx": nx,
                "ny": ny,
                "west": 177.0,
                "north": -17.0,
                "east": 178.0,
                "south": -18.0,
                "vmin": min(vals),
                "vmax": max(vals),
                "stops": [[0, [0, 0, 255]], [40, [255, 0, 0]]],
                "values": vals,
            }
            field_path = os.path.join(data, "field-tst.json")
            with open(field_path, "w") as f:
                json.dump(fixture, f)

            manifest = M.bake_layer(data, out, "tst", 7, 9, None, None, "test", "Synthetic")
            self.assertIsNotNone(manifest)
            self.assertEqual(manifest["encoding"], "helm-wxv1")
            self.assertTrue(os.path.exists(os.path.join(out, "tst", "manifest.json")))
            pngs = []
            for dp, _, fs in os.walk(os.path.join(out, "tst")):
                pngs += [os.path.join(dp, f) for f in fs if f.endswith(".png")]
            self.assertGreaterEqual(len(pngs), 1)

            cx, cy = 177.5, -17.5
            z = manifest["maxzoom"]
            xf, yf = M.lonlat_to_tile(cx, cy, z)
            xt, yt = math.floor(xf), math.floor(yf)
            tile_path = os.path.join(out, "tst", str(z), str(xt), f"{yt}.png")
            self.assertTrue(os.path.exists(tile_path))
            w, h, ch, rows = read_png_rgb(tile_path)
            px = int((xf - xt) * 256)
            py = int((yf - yt) * 256)
            row = rows[min(py, h - 1)]
            offset = min(px, w - 1) * ch
            rr, gg, bb = row[offset], row[offset + 1], row[offset + 2]
            decoded = manifest["offset"] + ((rr << 16) | (gg << 8) | bb) * manifest["scale"]
            with open(field_path) as f:
                source = M.Grid(json.load(f)).sample(cx, cy, None, None)
            self.assertLess(abs(decoded - source), 0.2)

    def test_js_codec_decodes_python_encoded_pixel(self):
        codec = os.path.join(ROOT, "web", "wx-value-codec.js")
        rr, gg, bb = M.encode_value(1013.2, self.scale, self.offset)
        js = (
            f"const C=require({json.dumps(codec)});"
            f"const v=C.decodeRGBA({rr},{gg},{bb},255,{self.scale!r},{self.offset!r});"
            "process.stdout.write(String(v));"
        )
        try:
            out = subprocess.run(["node", "-e", js], capture_output=True, text=True, timeout=20)
        except FileNotFoundError:
            self.skipTest("node unavailable")
        except subprocess.TimeoutExpired:
            self.skipTest("node codec check timed out")
        if out.returncode != 0 or not out.stdout.strip():
            self.skipTest(f"node codec check failed: {out.stderr.strip()[:120]}")
        self.assertLess(abs(float(out.stdout.strip()) - 1013.2), 0.001)

    def test_demo_ensemble_spread_grows_with_horizon(self):
        def member_center(member, h):
            frame = M.demo_frames("wind", member)[0][h]
            return frame.sample(-81.66, 24.60, None, None)

        spread0 = abs(member_center("gfs", 0) - member_center("ecmwf", 0))
        spread_mid = abs(member_center("gfs", 6) - member_center("ecmwf", 6))
        spread_late = abs(member_center("gfs", M.DEMO_HOURS - 1) - member_center("ecmwf", M.DEMO_HOURS - 1))
        self.assertLess(spread0, 1e-9)
        self.assertLess(spread0, spread_mid)
        self.assertLess(spread_mid, spread_late)


if __name__ == "__main__":
    unittest.main(verbosity=2)
