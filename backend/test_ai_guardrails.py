#!/usr/bin/env python3
"""Tests for AI-13 advisory/citation/freshness/horizon guardrails."""

import os
import sys
import unittest

os.environ.pop("OPENAI_API_KEY", None)
sys.path.insert(0, os.path.dirname(__file__))

from fastapi.testclient import TestClient

import context
import main
from guardrails import build_guardrail_report
from probe_layers import build_default_registry


def fake_weather(lat, lon):
    return {
        "source": "Open-Meteo",
        "fetchedAt": "2026-06-29T00:00Z",
        "lat": lat,
        "lon": lon,
        "now": {"windKt": 12, "windFromDeg": 110, "gustKt": 18, "rainMm": 0},
        "next": [{"t": "2026-06-29T06:00", "windKt": 15, "windFromDeg": 120, "gustKt": 21, "rainMm": 1}],
        "sea": {"waveM": 0.8},
        "sst": {"sstC": 27.5},
        "current": {"velKn": 0.4, "dirDeg": 230},
    }


class AIGuardrailTest(unittest.TestCase):
    def setUp(self):
        self._original_probes = context.PROBES
        context.PROBES = build_default_registry(fake_weather)
        self.client = TestClient(main.app)

    def tearDown(self):
        context.PROBES = self._original_probes

    def test_narration_is_advisory_and_evidence_backed(self):
        res = self.client.post("/narrate", json={
            "lat": 24.553,
            "lon": -81.782,
            "t": "2026-06-29T03:00",
            "layers": ["weather", "depth", "ais"],
        }).json()

        guard = res["guardrails"]
        self.assertEqual(guard["status"], "ok")
        self.assertEqual(guard["actionClass"], "advisory")
        self.assertFalse(guard["mayAct"])
        self.assertTrue(guard["notForNavigation"])
        self.assertGreaterEqual(guard["evidence"]["sourceCount"], 1)
        self.assertGreaterEqual(guard["evidence"]["freshnessCount"], 1)
        self.assertGreaterEqual(guard["evidence"]["horizonCount"], 1)

    def test_missing_sample_horizon_is_visible_not_green(self):
        res = self.client.post("/narrate", json={
            "lat": 24.553,
            "lon": -81.782,
            "layers": ["places"],
        }).json()

        self.assertEqual(res["guardrails"]["status"], "needs_verification")
        self.assertIn("missing_freshness", res["guardrails"]["violations"])
        self.assertIn("missing_horizon", res["guardrails"]["violations"])

    def test_unsafe_action_language_blocks_action(self):
        guard = build_guardrail_report(
            "narration",
            text="Turn now to 090 and engage the autopilot.",
            contexts=[context.resolve_context(24.553, -81.782, layers=["weather"])],
        )

        self.assertEqual(guard["status"], "blocked_from_action")
        self.assertIn("unsafe_action_language", guard["violations"])
        self.assertFalse(guard["mayAct"])

    def test_dossier_sections_carry_guardrail_metadata(self):
        res = self.client.post("/dossier", json={"placeId": "osm-kw-garrison"}).json()

        self.assertEqual(res["guardrails"]["status"], "ok")
        self.assertTrue(res["guardrails"]["requiresHumanVerification"])
        for section in res["sections"].values():
            self.assertIn("fetchedAt", section)
            self.assertIn("horizon", section)

    def test_whereto_recommendations_are_advisory_only(self):
        res = self.client.post("/whereto", json={
            "query": "safe spot, strong NE wind",
            "position": {"lat": 24.5, "lon": -81.8},
            "boat": {"draft": 1.8},
            "forecast": {"windFromDeg": 45, "windKt": 25},
        }).json()

        self.assertEqual(res["guardrails"]["status"], "ok")
        first = res["recommendations"][0]
        self.assertEqual(first["advisory"]["mayAct"], False)
        self.assertIn("freshness", first)
        self.assertIn("horizon", first)


if __name__ == "__main__":
    unittest.main(verbosity=2)
