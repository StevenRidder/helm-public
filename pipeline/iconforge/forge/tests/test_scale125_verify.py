"""Smoke the scale125 semantic QA gate.

Run:  python -m forge.tests.test_scale125_verify
"""
from __future__ import annotations

import json
from pathlib import Path

from .. import scale125_verify


ROOT = Path(__file__).resolve().parent.parent.parent
FAMILIES = {
    "buoy_beacon_marks",
    "wreck_rock_obstruction",
    "areas_patterns_lines",
    "lights_daymarks_topmarks",
    "ugly_attribute_edges",
}


def main():
    rc = scale125_verify.main()
    assert rc == 0, "scale125 semantic QA failed"

    report = json.loads((ROOT / "out" / "scale125" / "semantic_report.json").read_text())
    hard_pile = json.loads((ROOT / "out" / "scale125" / "semantic_hard_pile.json").read_text())

    assert report["status"] == "pass"
    assert report["assets"] == 125
    assert report["styles"] == 2
    assert report["fixture_valid_cases"] == 250
    assert report["valid_accepts"] == report["valid_total"] == 250
    assert report["broken_rejects"] == report["broken_total"] == 250
    assert report["hard_pile_entries"] == len(hard_pile) == 250
    assert set(report["family_coverage"]) == FAMILIES

    for family, coverage in report["family_coverage"].items():
        assert coverage["valid_cases"] > 0, f"{family} missing valid cases"
        assert coverage["broken_cases"] > 0, f"{family} missing broken cases"
        assert coverage["valid_accepts"] == coverage["valid_cases"], f"{family} valid accepts mismatch"
        assert coverage["broken_rejects"] == coverage["broken_cases"], f"{family} broken rejects mismatch"

    reason_codes = {code for row in hard_pile for code in row["reason_codes"]}
    expected_reason_families = {
        "wrong_cardinal_orientation",
        "wrong_obstruction_family",
        "missing_or_wrong_light_flare",
        "wrong_pattern_tile",
        "wrong_line_cadence",
        "wrong_area_pattern",
    }
    assert expected_reason_families <= reason_codes
    print("scale125 semantic QA: OK")


if __name__ == "__main__":
    main()
