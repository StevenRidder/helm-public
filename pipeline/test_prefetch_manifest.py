#!/usr/bin/env python3
"""Tests for OFFLINE-9 route/bbox prefetch manifests."""

import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "pipeline" / "mbtiles_server.py"
ENV_FIXTURE = ROOT / "services" / "wx" / "fixtures" / "fiji-env-bundle-v1.json"
sys.path.insert(0, str(ROOT / "pipeline"))

from prefetch_manifest import build_prefetch_manifest


def free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def write_mbtiles(path):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE metadata (name TEXT, value TEXT)")
    conn.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
    conn.executemany(
        "INSERT INTO metadata VALUES (?, ?)",
        [
            ("name", "Demo Chart"),
            ("format", "png"),
            ("bounds", "178.0,-18.0,179.0,-17.0"),
            ("minzoom", "0"),
            ("maxzoom", "2"),
            ("attribution", "test fixture"),
            ("tile_count", "4"),
        ],
    )
    conn.execute("INSERT INTO tiles VALUES (0, 0, 0, ?)", (b"\x89PNG\r\n\x1a\nfixture",))
    conn.commit()
    conn.close()


def request_json(url):
    try:
        with urllib.request.urlopen(url, timeout=2) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


class PrefetchManifestTest(unittest.TestCase):
    def test_builds_bbox_manifest_for_mbtiles_and_pmtiles(self):
        env_bundle = json.loads(ENV_FIXTURE.read_text(encoding="utf-8"))
        catalog = {
            "chart": {
                "title": "Chart",
                "container": "mbtiles",
                "kind": "chart",
                "format": "png",
                "minzoom": 0,
                "maxzoom": 2,
                "bounds_array": [178.0, -18.0, 179.0, -17.0],
                "size_bytes": 4096,
                "tile_count": 4,
                "tile_url": "http://boat.local/chart/{z}/{x}/{y}.png",
                "url": "http://boat.local/chart/{z}/{x}/{y}.png",
            },
            "sat": {
                "title": "Satellite",
                "container": "pmtiles",
                "kind": "satellite",
                "format": "jpg",
                "minzoom": 0,
                "maxzoom": 1,
                "bounds_array": [178.0, -18.0, 179.0, -17.0],
                "size_bytes": 2048,
                "addressed_tiles": 2,
                "pmtiles_url": "http://boat.local/sat.pmtiles",
                "protocol_url": "pmtiles://http://boat.local/sat.pmtiles",
                "url": "http://boat.local/sat.pmtiles",
            },
        }
        manifest = build_prefetch_manifest(
            catalog,
            {
                "bbox": ["178.0,-18.0,178.2,-17.8"],
                "minzoom": ["0"],
                "maxzoom": ["1"],
                "packs": ["chart,sat"],
                "env_layers": ["wind,current"],
            },
            environmental_bundles=env_bundle,
        )
        self.assertEqual(manifest["schema"], "helm.prefetch.manifest.v1")
        self.assertEqual(manifest["source"], "bbox")
        self.assertEqual(manifest["corridor"]["route_points"], 0)
        self.assertEqual(manifest["totals"]["packs"], 2)
        chart = next(p for p in manifest["packs"] if p["id"] == "chart")
        sat = next(p for p in manifest["packs"] if p["id"] == "sat")
        self.assertEqual(chart["tile_count"], 2)
        self.assertEqual(chart["pack_bounds"], [178.0, -18.0, 179.0, -17.0])
        self.assertEqual(chart["prefetch_bbox"], [178.0, -18.0, 178.2, -17.8])
        self.assertEqual(chart["tiles"][0]["url"], "http://boat.local/chart/0/0/0.png")
        self.assertEqual(sat["tile_count"], 2)
        self.assertEqual(sat["tiles"][0]["url"], "pmtiles://http://boat.local/sat.pmtiles/0/0/0")
        self.assertGreater(manifest["totals"]["estimated_bytes"], 0)
        self.assertEqual(manifest["totals"]["environmental_bundles"], 1)
        self.assertEqual(manifest["totals"]["environmental_layers"], 2)
        env = manifest["environmental_bundles"][0]
        self.assertEqual(env["kind"], "environmental-bundle")
        self.assertEqual(env["layers"], ["wind", "current"])
        self.assertFalse(env["upstream_fetches_allowed_during_gesture"])
        self.assertTrue(env["crosses_antimeridian"])
        self.assertEqual(env["sample"]["probe_handle"], "weather.bundle")

    def test_skips_pack_when_corridor_is_outside_pack_bounds(self):
        manifest = build_prefetch_manifest(
            {
                "chart": {
                    "title": "Chart",
                    "container": "mbtiles",
                    "format": "png",
                    "minzoom": 0,
                    "maxzoom": 2,
                    "bounds": "10.0,10.0,11.0,11.0",
                    "tile_url": "http://boat.local/chart/{z}/{x}/{y}.png",
                }
            },
            {
                "bbox": ["178.0,-18.0,178.2,-17.8"],
                "minzoom": ["0"],
                "maxzoom": ["1"],
            },
        )
        self.assertEqual(manifest["packs"][0]["tile_count"], 0)
        self.assertEqual(manifest["packs"][0]["skipped"], "outside_pack_bounds")
        self.assertEqual(manifest["totals"]["tiles"], 0)

    def test_server_prefetch_endpoint_returns_route_manifest_without_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_mbtiles(Path(tmp) / "chart.mbtiles")
            port = free_port()
            env = os.environ.copy()
            env["HELM_MBTILES_DIR"] = tmp
            env["HELM_ENV_BUNDLE_MANIFESTS"] = str(ENV_FIXTURE)
            proc = subprocess.Popen(
                [sys.executable, str(SERVER), str(port)],
                cwd=str(ROOT),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            try:
                deadline = time.time() + 5
                while time.time() < deadline:
                    try:
                        status, catalog = request_json(f"http://127.0.0.1:{port}/catalog")
                        if status == 200 and "chart" in catalog:
                            break
                    except (OSError, json.JSONDecodeError):
                        time.sleep(0.05)
                else:
                    out = proc.stdout.read() if proc.stdout else ""
                    self.fail(f"server did not become ready: {out}")

                query = urllib.parse.urlencode(
                    {
                        "route": "178.0,-18.0;178.2,-17.8",
                        "radius_nm": "1",
                        "minzoom": "0",
                        "maxzoom": "0",
                        "packs": "chart",
                    }
                )
                status, manifest = request_json(f"http://127.0.0.1:{port}/prefetch?{query}")
                self.assertEqual(status, 200)
                self.assertEqual(manifest["source"], "route")
                self.assertEqual(manifest["corridor"]["route_points"], 2)
                self.assertEqual(manifest["packs"][0]["tile_count"], 1)
                self.assertEqual(manifest["packs"][0]["tiles"][0]["url"], f"http://127.0.0.1:{port}/chart/0/0/0.png")
                self.assertEqual(manifest["totals"]["environmental_bundles"], 1)
                self.assertIn("wind", manifest["environmental_bundles"][0]["layers"])
                self.assertFalse(manifest["environmental_bundles"][0]["upstream_fetches_allowed_during_gesture"])
                self.assertNotIn(tmp, json.dumps(manifest))

                status, err = request_json(f"http://127.0.0.1:{port}/prefetch")
                self.assertEqual(status, 400)
                self.assertEqual(err["error"], "bad_prefetch_request")
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                if proc.stdout:
                    proc.stdout.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
