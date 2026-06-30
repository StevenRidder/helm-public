"""Contract checks for the 125-asset scale batch selection.

Run:  python -m forge.tests.test_scale125_selection
"""
from __future__ import annotations

import json
from pathlib import Path

from .. import scale125_select


ROOT = Path(__file__).resolve().parent.parent.parent
CATALOG = ROOT / "pilots" / "scale125.json"


def main():
    rc = scale125_select.main()
    assert rc == 0
    data = json.loads(CATALOG.read_text())

    assert data["selected_assets"] == 125
    assert data["next_batch_outputs"]["svg_outputs"] == 250
    assert data["next_batch_outputs"]["png_outputs"] == 750

    counts = data["family_counts"]
    assert counts["buoy_beacon_marks"] >= 40
    assert counts["wreck_rock_obstruction"] >= 20
    assert counts["areas_patterns_lines"] >= 20
    assert counts["ugly_attribute_edges"] >= 10

    kinds = data["asset_kind_counts"]
    assert kinds.get("symbol", 0) >= 80
    assert kinds.get("line-style", 0) + kinds.get("pattern", 0) + kinds.get("conditional-procedure", 0) >= 20

    entries = data["entries"]
    assert len({e["asset"] for e in entries}) == len(entries), "asset names must be unique"
    assert any("cardinal_orientation" in e["stress_reasons"] for e in entries)
    assert any("conditional_danger_variant" in e["stress_reasons"] for e in entries)
    assert any("conditional_symbology" in e["stress_reasons"] for e in entries)
    assert any(e["asset_kind"] == "line-style" for e in entries)
    assert any(e["asset_kind"] == "pattern" for e in entries)

    for e in entries:
        assert e["asset"]
        assert e["asset_kind"]
        assert e["family"]
        assert e["object_class"]
        assert e["lookup_id"]
        assert e["instruction"]
        assert e["stress_reasons"]

    print("scale125 selection: OK")


if __name__ == "__main__":
    main()
