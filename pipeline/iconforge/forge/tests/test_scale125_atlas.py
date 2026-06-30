"""Smoke the scale125 atlas/manifest compile gate.

Run:  python -m forge.tests.test_scale125_atlas
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

from PIL import Image

from .. import scale125_atlas


ROOT = Path(__file__).resolve().parent.parent.parent
ATLAS = ROOT / "out" / "scale125" / "atlas"


def _overlaps(a: list[int], b: list[int]) -> bool:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return ax < bx + bw and ax + aw > bx and ay < by + bh and ay + ah > by


def main():
    rc = scale125_atlas.main()
    assert rc == 0, "scale125 atlas compile failed"

    manifest_text = (ATLAS / "helm_s52_atlas_scale125.json").read_text()
    assert '"pixel_rect":[' in manifest_text
    assert '"anchor":[' in manifest_text
    assert '"repeat":[' in manifest_text
    assert '"dash":[' in manifest_text
    assert '"color":[' in manifest_text
    manifest = json.loads(manifest_text)
    assert manifest["schema_version"] == 1
    assert manifest["generator"] == "iconforge-scale125-atlas"
    assert manifest["styles"] == ["open-bridge", "us-paper"]
    assert manifest["palettes"] == ["day", "dusk", "night"]
    assert manifest["cell"] == 96
    assert len(manifest["atlases"]) == 6
    assert len(manifest["entries"]) == 750

    atlas_keys = {(a["style"], a["palette"], a["image"]) for a in manifest["atlases"]}
    assert len(atlas_keys) == 6
    for atlas in manifest["atlases"]:
        assert atlas["kind"] == "presentation"
        path = ATLAS / atlas["image"]
        assert path.exists(), f"missing atlas image {path}"
        img = Image.open(path)
        assert img.size == (atlas["width"], atlas["height"])
        assert atlas["entry_count"] == 125
        per_sheet = ATLAS / f"manifest_scale125_{atlas['style']}_{atlas['palette']}.json"
        assert per_sheet.exists(), f"missing per-sheet manifest {per_sheet}"

    keys = set()
    by_atlas: dict[str, list[dict]] = defaultdict(list)
    for entry in manifest["entries"]:
        key = (entry["name"], entry["kind"], entry["style"], entry["palette"])
        assert key not in keys, f"duplicate manifest key {key}"
        keys.add(key)
        assert entry["kind"] in {"symbol", "pattern", "line"}
        assert entry["style"] in manifest["styles"]
        assert entry["palette"] in manifest["palettes"]
        assert entry["atlas"].endswith(f"{entry['style']}_{entry['palette']}.png")
        assert len(entry["pixel_rect"]) == 4
        assert len(entry["uv"]) == 4
        assert len(entry["anchor"]) == 2
        assert len(entry["repeat"]) == 2
        assert len(entry["color"]) == 3
        assert isinstance(entry["dash"], list)
        assert entry["provenance"]["qa"]["structural_pass"] is True
        assert entry["provenance"]["qa"]["semantic_passed"] is True
        assert entry["provenance"]["qa"]["semantic_observed"] == "accept"
        by_atlas[entry["atlas"]].append(entry)

    assert len(keys) == 750
    for style in manifest["styles"]:
        style_manifest = json.loads((ATLAS / f"helm_s52_atlas_scale125_{style}.json").read_text())
        assert style_manifest["styles"] == [style]
        assert len(style_manifest["atlases"]) == 3
        assert len(style_manifest["entries"]) == 375
        loader_keys = {
            (entry["name"], entry["kind"], entry["palette"])
            for entry in style_manifest["entries"]
        }
        assert len(loader_keys) == 375

    for atlas in manifest["atlases"]:
        entries = by_atlas[atlas["image"]]
        assert len(entries) == 125
        for i, a in enumerate(entries):
            ax, ay, aw, ah = a["pixel_rect"]
            assert ax >= 0 and ay >= 0 and aw == manifest["cell"] and ah == manifest["cell"]
            assert ax + aw <= atlas["width"]
            assert ay + ah <= atlas["height"]
            u0, v0, u1, v1 = a["uv"]
            assert 0 <= u0 < u1 <= 1
            assert 0 <= v0 < v1 <= 1
            for b in entries[i + 1:]:
                assert not _overlaps(a["pixel_rect"], b["pixel_rect"]), (
                    f"overlapping rects in {atlas['image']}: {a['name']} / {b['name']}"
                )

    print("scale125 atlas: OK")


if __name__ == "__main__":
    main()
