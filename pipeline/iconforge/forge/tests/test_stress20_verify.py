"""Smoke the 20-symbol semantic QA and hard-pile stage.

Run:  python -m forge.tests.test_stress20_verify
"""
from __future__ import annotations

import json
from pathlib import Path

from .. import stress20_verify


ROOT = Path(__file__).resolve().parent.parent.parent


def main():
    rc = stress20_verify.main()
    assert rc == 0, "stress20 semantic QA failed"

    report = json.loads((ROOT / "out" / "stress20" / "semantic_report.json").read_text())
    hard_pile = json.loads((ROOT / "out" / "stress20" / "hard_pile.json").read_text())

    assert report["status"] == "pass"
    assert report["valid_accepts"] == 40
    assert report["valid_total"] == 40
    assert report["broken_rejects"] == report["broken_total"]
    assert hard_pile, "deliberate rejects should be written to hard pile"
    assert any(r["id"] == "BOYCAR_north" and r["case"] == "broken:flip_topmark_down"
               for r in hard_pile), "north-cardinal flipped-cone reject missing"
    print("stress20 semantic QA: OK")


if __name__ == "__main__":
    main()
