"""Contract checks for the 20-symbol Icon Forge stress pilot.

This is intentionally a catalog QA test, not an image verifier. It prevents the
pilot from quietly becoming a set of easy icons with no provenance or hard-pile
expectations.

Run:  python -m forge.tests.test_stress20_catalog
"""
from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent.parent
CATALOG = ROOT / "pilots" / "stress20.json"


def main():
    pilot = json.loads(CATALOG.read_text())
    entries = pilot["entries"]

    assert len(entries) == 20, "stress pilot must contain exactly 20 symbols"
    ids = [e["id"] for e in entries]
    assert len(set(ids)) == len(ids), "symbol ids must be unique"

    stress_classes = {c for e in entries for c in e["stress_class"]}
    required = set(pilot["required_stress_classes"])
    missing_classes = sorted(required - stress_classes)
    assert not missing_classes, f"missing stress classes: {missing_classes}"

    for entry in entries:
        assert entry["reference_crop"].startswith("references/us-chart-1/"), entry["id"]
        assert entry["s52"]["object_class"], entry["id"]
        assert entry["s52"]["lookup_id"], entry["id"]
        assert entry["s52"]["instruction"], entry["id"]
        assert entry["symbol"]["name"], entry["id"]
        assert entry["invariants"]["colors"], entry["id"]
        assert entry["siblings"], entry["id"]
        assert entry["deliberate_failures"], entry["id"]
        assert entry["hard_pile_codes"], entry["id"]

    assert any(e["id"] == "BOYCAR_north" for e in entries), "north cardinal gate missing"
    assert any(e["id"] == "BOYCAR_north" and "flip_topmark_down" in e["deliberate_failures"]
               for e in entries), "north cardinal broken-topmark case missing"
    assert any(e["id"] == "WRECKS_dangerous" for e in entries), "dangerous wreck missing"
    assert any(e["id"] == "WRECKS_nondangerous" for e in entries), "non-dangerous wreck missing"
    assert any(e["invariants"].get("light_flare") is True for e in entries), "light flare missing"

    print("stress20 catalog: OK")


if __name__ == "__main__":
    main()
