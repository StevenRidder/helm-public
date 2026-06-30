"""Build provenance and cache records for the verified scale125 atlas pack.

FORGE-10 is the gate before a full-library run. It makes the scale125 pack
auditable: exact input hashes, QA output hashes, atlas hashes, clean-IP source
policy, and a content-addressed cache key.

Run:  python -m forge.scale125_provenance
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from . import scale125_atlas


ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out" / "scale125"
ATLAS_OUT = OUT / "atlas"
PROVENANCE_OUT = OUT / "provenance"
CACHE = ROOT / ".cache" / "scale125"

INPUTS = [
    ROOT / "pilots" / "scale125.json",
    ROOT / "stylepacks" / "open-bridge.json",
    ROOT / "stylepacks" / "us-paper.json",
    ROOT / "forge" / "scale125_generate.py",
    ROOT / "forge" / "scale125_verify.py",
    ROOT / "forge" / "scale125_atlas.py",
]

OUTPUTS = [
    OUT / "report.json",
    OUT / "semantic_report.json",
    OUT / "semantic_hard_pile.json",
    ATLAS_OUT / "helm_s52_atlas_scale125.json",
    ATLAS_OUT / "helm_s52_atlas_scale125_open-bridge.json",
    ATLAS_OUT / "helm_s52_atlas_scale125_us-paper.json",
]


def _rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _file_hashes(paths: list[Path]) -> dict[str, str]:
    return {_rel(path): _sha256(path) for path in paths}


def _atlas_image_paths() -> list[Path]:
    return sorted(ATLAS_OUT.glob("s52_scale125_*.png"))


def _signature(input_hashes: dict[str, str]) -> str:
    body = json.dumps(input_hashes, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _cache_path(input_signature: str) -> Path:
    return CACHE / f"{input_signature}.json"


def build_manifest() -> dict:
    atlas_rc = scale125_atlas.main()
    if atlas_rc:
        raise RuntimeError(f"scale125 atlas build failed: {atlas_rc}")

    input_hashes = _file_hashes(INPUTS)
    input_signature = _signature(input_hashes)
    output_hashes = _file_hashes(OUTPUTS + _atlas_image_paths())
    cache_path = _cache_path(input_signature)
    cache_hit = cache_path.exists()

    manifest = {
        "schema_version": 1,
        "generator": "iconforge-scale125-provenance",
        "status": "pass",
        "input_signature": input_signature,
        "inputs": input_hashes,
        "outputs": output_hashes,
        "cache": {
            "key": input_signature,
            "path": _rel(cache_path),
            "hit_previous": cache_hit,
        },
        "qa": {
            "structural_report": _rel(OUT / "report.json"),
            "semantic_report": _rel(OUT / "semantic_report.json"),
            "semantic_hard_pile": _rel(OUT / "semantic_hard_pile.json"),
            "atlas_manifest": _rel(ATLAS_OUT / "helm_s52_atlas_scale125.json"),
        },
        "clean_ip": {
            "allowed_sources": [
                "public-domain U.S. Chart No.1 references",
                "local chartsymbols.xml / S-52 lookup metadata",
                "Helm-authored generator primitives and stylepacks",
                "fresh generated SVG artwork produced by Icon Forge",
            ],
            "forbidden_sources": [
                "OpenCPN GPL rastersymbols-*.png extraction",
                "copied IHO proprietary chart-publication artwork",
                "private ENC/S-63/oeSENC data or generated caches",
            ],
            "distribution_gate": "Counsel review required before treating the generated pack as redistributable owned artwork.",
            "current_boundary": "Keep raw generated artwork engine-side until counsel approves the clean-IP placement.",
        },
    }
    return manifest


def main() -> int:
    PROVENANCE_OUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)

    manifest = build_manifest()
    provenance_path = PROVENANCE_OUT / "scale125_provenance.json"
    provenance_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")

    cache_record = {
        "schema_version": 1,
        "input_signature": manifest["input_signature"],
        "inputs": manifest["inputs"],
        "outputs": manifest["outputs"],
        "status": manifest["status"],
    }
    _cache_path(manifest["input_signature"]).write_text(
        json.dumps(cache_record, indent=2, sort_keys=True) + "\n"
    )

    print("scale125 provenance: PASS")
    print(f"input_signature: {manifest['input_signature']}")
    print(f"cache_hit_previous: {manifest['cache']['hit_previous']}")
    print(f"provenance -> {provenance_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
