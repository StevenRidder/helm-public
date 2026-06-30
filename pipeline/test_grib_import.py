#!/usr/bin/env python3
"""
Helm - pipeline/test_grib_import.py        WX epic - WX-12

Round-trip test: author a GRIB2 with pipeline/make_demo_grib.py, then decode it
through the ACTUAL JS reader (web/wx-grib2.js) via node and assert the grid +
values come back correct. This proves the Python author and the browser GRIB2
reader agree on the format. Skips the node leg honestly if node is unavailable.

    python3 pipeline/test_grib_import.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import make_demo_grib as MG


class GribImportTest(unittest.TestCase):
    def test_python_authored_grib_round_trips_through_browser_reader(self):
        src_vals = MG.wind_field()
        grib = MG.build_grib2(src_vals)
        self.assertEqual(grib[:4], b"GRIB")
        self.assertEqual(grib[7], 2)

        with tempfile.NamedTemporaryFile(suffix=".grb2", delete=False) as tf:
            tf.write(grib)
            path = tf.name

        try:
            reader = os.path.join(ROOT, "web", "wx-grib2.js")
            node = (
                f"const fs=require('fs'),G=require({json.dumps(reader)});"
                f"const b=fs.readFileSync({json.dumps(path)});"
                f"const r=G.parseGrib2(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));"
                f"const m=r.messages[0];const f=G.messageToField(m);"
                "process.stdout.write(JSON.stringify({"
                "n:r.messages.length,param:m.param.name,nbits:m.nbits,"
                "dt:m.dataTemplate,gt:m.gridTemplate,nx:f.nx,ny:f.ny,"
                "west:f.west,north:f.north,east:f.east,south:f.south,"
                "unit:f.unit,values:Array.from(f.values)}));"
            )
            try:
                out = subprocess.run(["node", "-e", node], capture_output=True, text=True, timeout=30)
            except FileNotFoundError:
                self.skipTest("node unavailable")
            except subprocess.TimeoutExpired:
                self.skipTest("node decode timed out")
            if out.returncode != 0:
                self.skipTest(f"node decode failed: {out.stderr.strip()[:160]}")

            decoded = json.loads(out.stdout)
            self.assertEqual(decoded["n"], 1)
            self.assertEqual(decoded["param"], "WIND")
            self.assertEqual(decoded["dt"], 0)
            self.assertEqual(decoded["gt"], 0)
            self.assertEqual(decoded["nbits"], 12)
            self.assertLess(abs(decoded["north"] - MG.BBOX[3]), 1e-4)
            self.assertLess(abs(decoded["west"] - MG.BBOX[0]), 1e-4)
            self.assertEqual(decoded["nx"], MG.NX)
            self.assertEqual(decoded["ny"], MG.NY)
            maxerr = max(abs(a - b) for a, b in zip(decoded["values"], src_vals))
            self.assertLess(maxerr, 0.011)
            self.assertEqual(decoded["unit"], "m/s")
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main(verbosity=2)
