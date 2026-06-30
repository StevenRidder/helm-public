#!/usr/bin/env python3
"""Tests for the backend probe sample() contract."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import context
from probe_contract import LayerSample, ProbeContractError, ProbeLayer, ProbeRegistry, SampleRequest
from probe_layers import build_default_registry


def fake_weather(lat, lon):
    return {
        "source": "Open-Meteo",
        "fetchedAt": "2026-06-29T00:00Z",
        "lat": lat,
        "lon": lon,
        "now": {"windKt": 12, "windFromDeg": 110, "gustKt": 18, "rainMm": 0},
        "next": [
            {"t": "2026-06-29T00:00", "windKt": 12, "windFromDeg": 110, "gustKt": 18, "rainMm": 0},
            {"t": "2026-06-29T06:00", "windKt": 15, "windFromDeg": 120, "gustKt": 21, "rainMm": 1},
        ],
        "sea": {"waveM": 0.8},
        "sst": {"sstC": 27.5},
        "current": {"velKn": 0.4, "dirDeg": 230},
    }


class ProbeContractTest(unittest.TestCase):
    def test_default_registry_exposes_required_probe_faces(self):
        registry = build_default_registry(fake_weather)
        registry.require(["weather", "climate", "depth", "ais", "tides"])
        self.assertEqual(registry.layer_ids(), ["ais", "climate", "depth", "tides", "weather"])
        metadata = {item["layer"]: item for item in registry.metadata()}
        self.assertEqual(metadata["weather"]["productId"], "weather.open-meteo.forecast")
        self.assertEqual(metadata["tides"]["datasetName"], "Tides and currents sample face")

    def test_samples_have_required_provenance_and_status(self):
        registry = build_default_registry(fake_weather)
        samples = registry.sample_many(
            ["weather", "depth", "ais", "climate", "tides"],
            24.553,
            -81.782,
            "2026-06-29T03:00",
        )

        weather = samples["weather"]
        self.assertEqual(weather["status"], "ok")
        self.assertEqual(weather["validTime"], "2026-06-29T06:00")
        self.assertEqual(weather["sourceRef"]["productId"], "weather.open-meteo.forecast")
        self.assertEqual(weather["freshness"], "2026-06-29T00:00Z")
        self.assertEqual(weather["coverage"]["status"], "point")

        self.assertEqual(samples["depth"]["status"], "ok")
        self.assertEqual(samples["depth"]["unit"], "m")
        self.assertGreater(samples["ais"]["value"]["count"], 0)
        self.assertEqual(samples["climate"]["status"], "not_implemented")
        self.assertEqual(samples["tides"]["status"], "not_implemented")
        self.assertIn("not implemented", samples["tides"]["note"])

    def test_registry_rejects_layers_without_contract(self):
        registry = ProbeRegistry()

        class NoSample:
            layer_id = "bad"

        with self.assertRaises(ProbeContractError):
            registry.register(NoSample())

        class BadSampleLayer(ProbeLayer):
            layer_id = "bad-sample"
            product_id = "bad"
            dataset_name = "Bad"
            producer = "Test"

            def sample(self, req: SampleRequest):
                return LayerSample(layer="bad-sample", status="ok", freshness="", confidence="", coverage={})

        registry.register(BadSampleLayer())
        with self.assertRaises(ProbeContractError):
            registry.sample("bad-sample", 24.5, -81.8)

    def test_context_resolver_attaches_sample_envelopes(self):
        original = context.PROBES
        context.PROBES = build_default_registry(fake_weather)
        try:
            ctx = context.resolve_context(
                24.553,
                -81.782,
                "2026-06-29T03:00",
                layers=["weather", "depth", "ais", "climate", "tides"],
            )
        finally:
            context.PROBES = original

        self.assertEqual(set(ctx["layers"]), {"weather", "depth", "ais", "climate", "tides"})
        self.assertEqual(ctx["layers"]["weather"]["sample"]["sourceRef"]["producer"], "Open-Meteo")
        self.assertEqual(ctx["layers"]["weather"]["atTime"]["windKt"], 15)
        self.assertIsNotNone(ctx["layers"]["depth"]["nearestChartedM"])
        self.assertEqual(ctx["layers"]["ais"]["sample"]["trace"], "probe:ais")
        self.assertEqual(ctx["layers"]["tides"]["sample"]["status"], "not_implemented")


if __name__ == "__main__":
    unittest.main(verbosity=2)
