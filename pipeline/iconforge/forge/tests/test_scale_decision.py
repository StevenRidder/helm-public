"""Contract checks for the FORGE scale decision.

Run:  python -m forge.tests.test_scale_decision
"""
from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent.parent
DECISION = ROOT / "pilots" / "scale_decision.json"


def main():
    d = json.loads(DECISION.read_text())
    assert d["status"] == "go"

    basis = d["basis"]
    assert basis["stress20_valid_accepts"] == basis["stress20_valid_total"] == 40
    assert basis["stress20_broken_rejects"] == basis["stress20_broken_total"] == 80
    assert basis["hard_pile_entries"] == 80

    inv = d["local_s52_inventory"]
    assert inv["symbol_definitions"] >= 1000
    assert inv["presentation_asset_definitions"] == (
        inv["symbol_definitions"] + inv["patterns"] + inv["line_styles"]
    )

    targets = d["coverage_targets"]
    assert targets["symbol_definition_99_percent"] == int(inv["symbol_definitions"] * 0.99)
    assert targets["presentation_asset_definition_99_percent"] == int(inv["presentation_asset_definitions"] * 0.99)
    assert targets["unique_presentation_asset_99_percent"] == int(inv["unique_presentation_assets"] * 0.99)

    nxt = d["next_batch"]
    assert nxt["size"]["minimum_assets"] >= 100
    assert nxt["size"]["maximum_assets"] <= 150
    assert nxt["expected_svg_outputs"]["target"] == nxt["size"]["target_assets"] * nxt["style_count"]
    assert nxt["expected_png_outputs"]["target"] == (
        nxt["size"]["target_assets"] * nxt["style_count"] * nxt["palette_count"]
    )

    gates = d["go_no_go_thresholds"]
    assert gates["silent_safety_misses_allowed"] == 0
    assert gates["deliberate_broken_reject_rate_minimum"] == 1.0
    assert gates["valid_accept_rate_minimum"] >= 0.98

    print("scale decision: OK")


if __name__ == "__main__":
    main()
