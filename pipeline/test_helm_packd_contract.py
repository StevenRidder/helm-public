#!/usr/bin/env python3
"""Contract tests for the OFFLINE-16/17 C++ helm-packd daemon.

The Python pack server remains the broad reference/oracle. These tests pin the
runtime C++ parity slice: health, catalog privacy/URL shape, MBTiles XYZ->TMS,
PMTiles HEAD/Range, and OFFLINE-17 `/layers`/`/prefetch`/`/bundle` metadata.

Set HELM_PACKD_BIN to the built binary, for example:

    HELM_PACKD_BIN=/private/tmp/helm-offline16-ocpn/build/cli/helm-packd \
      python3 pipeline/test_helm_packd_contract.py
"""

from __future__ import annotations

import gzip
import json
import os
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_FIXTURE = ROOT / "services" / "wx" / "fixtures" / "fiji-env-bundle-v1.json"


def free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def write_mbtiles(path: Path) -> None:
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
            ("maxzoom", "1"),
            ("attribution", "test fixture"),
            ("source", "NOAA ENC fixture"),
            ("license", "public-domain-fixture"),
        ],
    )
    conn.execute("INSERT INTO tiles VALUES (0, 0, 0, ?)", (b"\x89PNG\r\n\x1a\nfixture",))
    conn.commit()
    conn.close()


def write_pmtiles(path: Path) -> None:
    metadata = gzip.compress(
        json.dumps(
            {
                "name": "Demo Satellite",
                "type": "raster",
                "bounds": [178.0, -18.0, 179.0, -17.0],
                "minzoom": 0,
                "maxzoom": 2,
                "attribution": "test fixture",
            }
        ).encode("utf-8")
    )
    header = bytearray(127)
    header[0:7] = b"PMTiles"
    header[7] = 3
    struct.pack_into("<Q", header, 24, 127)
    struct.pack_into("<Q", header, 32, len(metadata))
    struct.pack_into("<Q", header, 72, 1)
    struct.pack_into("<Q", header, 80, 1)
    struct.pack_into("<Q", header, 88, 1)
    header[97] = 2
    header[98] = 1
    header[99] = 2
    header[100] = 0
    header[101] = 2
    struct.pack_into("<i", header, 102, int(178.0 * 1e7))
    struct.pack_into("<i", header, 106, int(-18.0 * 1e7))
    struct.pack_into("<i", header, 110, int(179.0 * 1e7))
    struct.pack_into("<i", header, 114, int(-17.0 * 1e7))
    header[118] = 1
    struct.pack_into("<i", header, 119, int(178.5 * 1e7))
    struct.pack_into("<i", header, 123, int(-17.5 * 1e7))
    path.write_bytes(bytes(header) + metadata + b"tile-data")


def write_sidecar(path: Path) -> None:
    """Write public pack metadata plus one private field that must not leak."""

    path.write_text(
        json.dumps(
            {
                "renderer": "s52",
                "palette": "day",
                "display_category": "std",
                "chart_edition": "FJ-2026",
                "render_date": "2026-06-29T00:00:00Z",
                "staleness_status": "fresh",
                "tile_count": 1,
                "tile_count_expected": 2,
                "no_coverage_tile_count": 1,
                "coverage_status": "partial",
                "coverage_warning": "Fixture coverage gap.",
                "source_id": "FJ-FIXTURE",
                "source_updated": "2026-06-01T00:00:00Z",
                "source_confidence": "fixture",
                "inspection": {
                    "mode": "raster_metadata",
                    "semantic_objects": "unavailable",
                    "tap_action": "show_pack_source_metadata",
                    "private_path": "/private/tmp/should-not-leak",
                },
                "private_path": "/private/tmp/should-not-leak",
            }
        ),
        encoding="utf-8",
    )


def request_json(url: str) -> tuple[int, dict]:
    with urllib.request.urlopen(url, timeout=2) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


@unittest.skipUnless(os.environ.get("HELM_PACKD_BIN"), "set HELM_PACKD_BIN to the built helm-packd binary")
class HelmPackdContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.bin = Path(os.environ["HELM_PACKD_BIN"])
        if not self.bin.exists() or not os.access(self.bin, os.X_OK):
            self.skipTest(f"HELM_PACKD_BIN is not executable: {self.bin}")
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        write_mbtiles(self.tmp_path / "chart.mbtiles")
        write_sidecar(self.tmp_path / "chart.metadata.json")
        write_pmtiles(self.tmp_path / "sat.pmtiles")
        self.port = free_port()
        env = os.environ.copy()
        env["HELM_MBTILES_DIR"] = self.tmp.name
        env["HELM_ENV_BUNDLE_MANIFESTS"] = str(ENV_FIXTURE)
        env["HELM_BIND"] = "127.0.0.1"
        self.proc = subprocess.Popen(
            [str(self.bin), str(self.port)],
            cwd=str(ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        deadline = time.time() + 5
        last = None
        while time.time() < deadline:
            if self.proc.poll() is not None:
                out = self.proc.stdout.read() if self.proc.stdout else ""
                self.fail(f"helm-packd exited early with {self.proc.returncode}: {out}")
            try:
                status, data = request_json(f"http://127.0.0.1:{self.port}/health")
                if status == 200 and data.get("engine") == "helm-packd":
                    return
            except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
                last = exc
                time.sleep(0.05)
        self.fail(f"helm-packd did not become ready: {last}")

    def tearDown(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        if self.proc.stdout:
            self.proc.stdout.close()
        self.tmp.cleanup()

    def test_health_and_catalog_do_not_leak_filesystem_paths(self) -> None:
        status, health = request_json(f"http://127.0.0.1:{self.port}/health")
        self.assertEqual(status, 200)
        self.assertEqual(health["status"], "ok")
        self.assertEqual(health["packs"], 2)

        status, catalog = request_json(f"http://127.0.0.1:{self.port}/catalog")
        self.assertEqual(status, 200)
        self.assertEqual(catalog["chart"]["container"], "mbtiles")
        self.assertEqual(catalog["chart"]["title"], "Demo Chart")
        self.assertEqual(catalog["chart"]["format"], "png")
        self.assertEqual(catalog["chart"]["minzoom"], 0)
        self.assertEqual(catalog["chart"]["maxzoom"], 1)
        self.assertEqual(
            catalog["chart"]["tile_url"],
            f"http://127.0.0.1:{self.port}/chart/{{z}}/{{x}}/{{y}}.png",
        )
        self.assertEqual(catalog["sat"]["container"], "pmtiles")
        self.assertTrue(catalog["sat"]["range"])
        self.assertEqual(catalog["sat"]["pmtiles_version"], 3)
        self.assertEqual(catalog["sat"]["minzoom"], 0)
        self.assertEqual(catalog["sat"]["maxzoom"], 2)
        self.assertEqual(catalog["sat"]["pmtiles_url"], f"http://127.0.0.1:{self.port}/sat.pmtiles")
        self.assertNotIn(self.tmp.name, json.dumps(catalog))

    def test_catalog_applies_sidecar_metadata_without_private_paths(self) -> None:
        status, catalog = request_json(f"http://127.0.0.1:{self.port}/catalog")
        self.assertEqual(status, 200)
        chart = catalog["chart"]
        self.assertEqual(chart["renderer"], "s52")
        self.assertEqual(chart["palette"], "day")
        self.assertEqual(chart["source_info"]["id"], "FJ-FIXTURE")
        self.assertEqual(chart["coverage"]["status"], "partial")
        self.assertEqual(chart["staleness"]["status"], "fresh")
        self.assertEqual(chart["inspection"]["mode"], "raster_metadata")
        self.assertEqual(chart["inspection"]["chart_object_query"], "use_live_CHART_10_query_when_source_ENC_is_mounted")
        self.assertEqual(chart["warnings"][0]["code"], "pack_out_of_coverage")
        self.assertNotIn("private_path", json.dumps(chart))
        self.assertNotIn("/private/tmp/should-not-leak", json.dumps(chart))

    def test_mbtiles_tile_endpoint_serves_xyz_with_tms_flip(self) -> None:
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/chart/0/0/0.png", timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers.get("Content-Type"), "image/png")
            self.assertEqual(resp.read(), b"\x89PNG\r\n\x1a\nfixture")

    def test_pmtiles_endpoint_supports_range_and_head(self) -> None:
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/sat.pmtiles",
            headers={"Range": "bytes=0-6"},
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            self.assertEqual(resp.status, 206)
            self.assertEqual(resp.headers.get("Accept-Ranges"), "bytes")
            self.assertEqual(resp.headers.get("Content-Range"), "bytes 0-6/" + resp.headers.get("Content-Range").split("/")[-1])
            self.assertEqual(resp.read(), b"PMTiles")

        head = urllib.request.Request(f"http://127.0.0.1:{self.port}/sat.pmtiles", method="HEAD")
        with urllib.request.urlopen(head, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            self.assertGreater(int(resp.headers.get("Content-Length", "0")), 127)
            self.assertEqual(resp.read(), b"")

    def test_offline17_layers_prefetch_and_bundle_endpoints(self) -> None:
        status, layers = request_json(
            f"http://127.0.0.1:{self.port}/layers?"
            "bbox=178.0,-18.0,178.5,-17.5&minzoom=0&maxzoom=1&include_tiles=0"
        )
        self.assertEqual(status, 200)
        self.assertEqual(layers["schema"], "helm.maritime_layer_inventory.v1")
        self.assertIn("weather.bundle", layers["summary"]["sample_handles"])
        chart_layer = next(layer for layer in layers["layers"] if layer.get("component_id") == "pack:chart")
        self.assertEqual(chart_layer["product_identifier"], "S-52")
        self.assertEqual(chart_layer["sample"]["status"], "unavailable")
        self.assertEqual(chart_layer["inspection"]["mode"], "raster_metadata")
        env_bundle = next(layer for layer in layers["layers"] if layer["role"] == "environmental_bundle")
        self.assertEqual(env_bundle["product_identifier"], "helm.env.bundle.v1")
        self.assertFalse(env_bundle["environmental_bundle"]["upstreamFetchesAllowedDuringGesture"])
        wind = next(layer for layer in layers["layers"] if layer["id"].endswith(":wind"))
        self.assertEqual(wind["sample"]["probe_handle"], "weather.wind")
        current = next(layer for layer in layers["layers"] if layer["id"].endswith(":current"))
        self.assertEqual(current["product_identifier"], "S-111")
        self.assertNotIn(self.tmp.name, json.dumps(layers))
        self.assertNotIn("/private/tmp/should-not-leak", json.dumps(layers))

        status, prefetch = request_json(
            f"http://127.0.0.1:{self.port}/prefetch?"
            "bbox=178.0,-18.0,178.2,-17.8&minzoom=0&maxzoom=1&packs=chart,sat&env_layers=wind,current"
        )
        self.assertEqual(status, 200)
        self.assertEqual(prefetch["schema"], "helm.prefetch.manifest.v1")
        self.assertEqual(prefetch["totals"]["packs"], 2)
        self.assertEqual(prefetch["totals"]["environmental_layers"], 2)
        self.assertEqual(prefetch["packs"][0]["tiles"][0]["url"], f"http://127.0.0.1:{self.port}/chart/0/0/0.png")
        self.assertFalse(prefetch["environmental_bundles"][0]["upstream_fetches_allowed_during_gesture"])
        self.assertNotIn(self.tmp.name, json.dumps(prefetch))

        status, bundle = request_json(
            f"http://127.0.0.1:{self.port}/bundle?"
            "bundle_id=fiji&bbox=178.0,-18.0,178.5,-17.5&minzoom=0&maxzoom=1&include_tiles=0"
        )
        self.assertEqual(status, 200)
        self.assertEqual(bundle["schema"], "helm.region_bundle.manifest.v1")
        chart_component = next(component for component in bundle["components"] if component["id"] == "pack:chart")
        self.assertIn("out_of_coverage", chart_component["status"]["states"])
        self.assertEqual(len(chart_component["fingerprint"]), 64)
        self.assertNotIn(self.tmp.name, json.dumps(bundle))
        self.assertNotIn("/private/tmp/should-not-leak", json.dumps(bundle))


if __name__ == "__main__":
    unittest.main(verbosity=2)
