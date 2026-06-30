"""Compile verified scale125 renders into atlas sheets and manifests.

FORGE-9 consumes only the valid, semantically accepted scale125 fixtures. It
regenerates and verifies the batch first, then packs every style/palette render
into deterministic PNG atlas sheets plus an aggregate manifest keyed by
(asset, style, palette).

Run:  python -m forge.scale125_atlas
"""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image

from . import scale125_generate, scale125_verify


ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out" / "scale125"
ATLAS_OUT = OUT / "atlas"
CATALOG = ROOT / "pilots" / "scale125.json"
PALETTES = ["day", "dusk", "night"]
CELL = 96
COLS = 8


def _dump_manifest(path: Path, manifest: dict) -> None:
    # The current C++ helm_s52_atlas parser matches compact JSON needles such as
    # `"pixel_rect":[`; keep these manifests machine-compact until that parser is
    # replaced with a full JSON reader.
    path.write_text(json.dumps(manifest, separators=(",", ":")) + "\n")


def _manifest_kind(asset_kind: str) -> str:
    if asset_kind == "line-style":
        return "line"
    if asset_kind == "pattern":
        return "pattern"
    return "symbol"


def _anchor_pixels(anchor: tuple[float, float], cell: int) -> list[int]:
    return [round(anchor[0] * cell), round(anchor[1] * cell)]


def _dash(entry: dict) -> list[int]:
    asset = entry["asset"].upper()
    if entry["asset_kind"] != "line-style":
        return []
    if "DOTT" in asset:
        return [1, 5]
    if "DASH" in asset:
        return [5, 4]
    return []


def _uv(rect: list[int], width: int, height: int) -> list[float]:
    x, y, w, h = rect
    return [
        round(x / width, 6),
        round(y / height, 6),
        round((x + w) / width, 6),
        round((y + h) / height, 6),
    ]


def _accepted_valid_rows() -> dict[tuple[str, str], dict]:
    report_path = OUT / "semantic_report.json"
    report = json.loads(report_path.read_text())
    if report["status"] != "pass":
        raise RuntimeError(f"semantic report is not pass: {report_path}")

    rows = {}
    for row in report["rows"]:
        if row["case"] == "valid":
            if row["observed"] != "accept" or not row["passed"]:
                raise RuntimeError(f"valid fixture not accepted: {row['asset']} {row['style']}")
            rows[(row["asset"], row["style"])] = row
    return rows


def _entry_provenance(entry: dict, semantic_row: dict) -> dict:
    return {
        "source": "iconforge-scale125",
        "catalog": "pilots/scale125.json",
        "object_class": entry["object_class"],
        "lookup_id": entry["lookup_id"],
        "rcid": entry["rcid"],
        "conditions": entry["conditions"],
        "instruction": entry["instruction"],
        "qa": {
            "structural_pass": True,
            "semantic_case": semantic_row["case"],
            "semantic_observed": semantic_row["observed"],
            "semantic_passed": semantic_row["passed"],
            "reason_codes": semantic_row["reason_codes"],
        },
    }


def _build_sheet(entries: list[dict], style: str, palette: str) -> tuple[dict, list[dict]]:
    rows = (len(entries) + COLS - 1) // COLS
    width, height = COLS * CELL, rows * CELL
    sheet = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    manifest_entries = []

    for i, entry in enumerate(entries):
        x, y = (i % COLS) * CELL, (i // COLS) * CELL
        png_path = OUT / "renders" / f"{scale125_generate._slug(entry['asset'])}_{style}_{palette}.png"
        img = Image.open(png_path).convert("RGBA").resize((CELL, CELL))
        sheet.paste(img, (x, y), img)

        anchor_unit = scale125_generate._spec(entry).invariants.anchor
        rect = [x, y, CELL, CELL]
        semantic_row = entry["_semantic_rows"][(entry["asset"], style)]
        manifest_entries.append({
            "name": entry["asset"],
            "kind": _manifest_kind(entry["asset_kind"]),
            "palette": palette,
            "style": style,
            "atlas": f"s52_scale125_{style}_{palette}.png",
            "pixel_rect": rect,
            "uv": _uv(rect, width, height),
            "anchor": _anchor_pixels(anchor_unit, CELL),
            "repeat": [0, 0],
            "dash": _dash(entry),
            "color": [0, 0, 0],
            "anchor_unit": {"x": anchor_unit[0], "y": anchor_unit[1]},
            "provenance": _entry_provenance(entry, semantic_row),
        })

    image_name = f"s52_scale125_{style}_{palette}.png"
    sheet.save(ATLAS_OUT / image_name)
    atlas = {
        "kind": "presentation",
        "style": style,
        "palette": palette,
        "image": image_name,
        "format": "png",
        "width": width,
        "height": height,
        "cell": CELL,
        "entry_count": len(entries),
    }
    per_sheet = {
        "schema_version": 1,
        "generator": "iconforge-scale125-atlas",
        "style": style,
        "palette": palette,
        "atlas": atlas,
        "entries": manifest_entries,
    }
    _dump_manifest(ATLAS_OUT / f"manifest_scale125_{style}_{palette}.json", per_sheet)
    return atlas, manifest_entries


def main() -> int:
    verify_rc = scale125_verify.main()
    if verify_rc:
        return verify_rc

    catalog = json.loads(CATALOG.read_text())
    semantic_rows = _accepted_valid_rows()
    entries = []
    for entry in catalog["entries"]:
        e = dict(entry)
        e["_semantic_rows"] = semantic_rows
        entries.append(e)

    styles = sorted({p.stem for p in (ROOT / "stylepacks").glob("*.json")})
    ATLAS_OUT.mkdir(parents=True, exist_ok=True)

    atlases = []
    manifest_entries = []
    for style in styles:
        for palette in PALETTES:
            atlas, sheet_entries = _build_sheet(entries, style, palette)
            atlases.append(atlas)
            manifest_entries.extend(sheet_entries)

    manifest = {
        "schema_version": 1,
        "generator": "iconforge-scale125-atlas",
        "source": {
            "catalog": "pilots/scale125.json",
            "semantic_report": "out/scale125/semantic_report.json",
            "structural_report": "out/scale125/report.json",
        },
        "styles": styles,
        "palettes": PALETTES,
        "cell": CELL,
        "atlases": atlases,
        "entries": manifest_entries,
    }
    _dump_manifest(ATLAS_OUT / "helm_s52_atlas_scale125.json", manifest)

    for style in styles:
        style_manifest = dict(manifest)
        style_manifest["styles"] = [style]
        style_manifest["atlases"] = [a for a in atlases if a["style"] == style]
        style_manifest["entries"] = [e for e in manifest_entries if e["style"] == style]
        _dump_manifest(ATLAS_OUT / f"helm_s52_atlas_scale125_{style}.json", style_manifest)

    print("scale125 atlas: PASS")
    print(f"styles: {len(styles)} palettes: {len(PALETTES)} atlases: {len(atlases)}")
    print(f"entries: {len(manifest_entries)} -> {ATLAS_OUT / 'helm_s52_atlas_scale125.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
