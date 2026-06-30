"""Smoke the scale125 provenance/cache and clean-IP gate.

Run:  python -m forge.tests.test_scale125_provenance
"""
from __future__ import annotations

import json
from pathlib import Path

from .. import scale125_provenance


ROOT = Path(__file__).resolve().parent.parent.parent
PROVENANCE = ROOT / "out" / "scale125" / "provenance" / "scale125_provenance.json"


def main():
    rc1 = scale125_provenance.main()
    assert rc1 == 0
    first = json.loads(PROVENANCE.read_text())

    rc2 = scale125_provenance.main()
    assert rc2 == 0
    second = json.loads(PROVENANCE.read_text())

    assert first["status"] == second["status"] == "pass"
    assert first["input_signature"] == second["input_signature"]
    assert first["inputs"] == second["inputs"]
    assert first["outputs"] == second["outputs"]
    assert second["cache"]["hit_previous"] is True

    required_inputs = {
        "pilots/scale125.json",
        "stylepacks/open-bridge.json",
        "stylepacks/us-paper.json",
        "forge/scale125_generate.py",
        "forge/scale125_verify.py",
        "forge/scale125_atlas.py",
    }
    assert required_inputs <= set(second["inputs"])
    assert "out/scale125/semantic_report.json" in second["outputs"]
    assert "out/scale125/atlas/helm_s52_atlas_scale125.json" in second["outputs"]
    assert any(path.endswith(".png") for path in second["outputs"])

    clean_ip = second["clean_ip"]
    assert any("Chart No.1" in s for s in clean_ip["allowed_sources"])
    assert any("chartsymbols.xml" in s for s in clean_ip["allowed_sources"])
    assert any("rastersymbols" in s for s in clean_ip["forbidden_sources"])
    assert "Counsel review required" in clean_ip["distribution_gate"]
    print("scale125 provenance: OK")


if __name__ == "__main__":
    main()
