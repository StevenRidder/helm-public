#!/usr/bin/env python3
"""Build region bundle manifests and update plans for local Helm packs.

The bundle manifest is the offline planning layer above the raw pack catalog:
it groups charts, basemaps, depth, places, and route/bbox cache advice into one
portable JSON document. It does not fetch tiles or mutate local storage.
"""
from __future__ import annotations

import argparse
import copy
import datetime as _dt
import hashlib
import json
import os
import sys
import urllib.request

from prefetch_manifest import PrefetchError, build_prefetch_manifest

REGION_BUNDLE_SCHEMA = "helm.region_bundle.manifest.v1"
REGION_BUNDLE_DIFF_SCHEMA = "helm.region_bundle.diff.v1"

DEFAULT_BUNDLE_ID = "local-region"
DEFAULT_TITLE = "Local Region Bundle"

PACK_COMPONENT_KEYS = (
    "id",
    "name",
    "title",
    "kind",
    "container",
    "type",
    "format",
    "extension",
    "bounds",
    "bounds_array",
    "minzoom",
    "maxzoom",
    "size_bytes",
    "modified",
    "modified_epoch",
    "license",
    "attribution",
    "description",
    "source",
    "source_info",
    "coverage",
    "staleness",
    "inspection",
    "warnings",
    "renderer",
    "palette",
    "display_category",
    "chart_edition",
    "chart_epoch",
    "render_date",
    "helm_pack_schema",
    "pack_role",
    "tile_count",
    "tile_count_expected",
    "no_coverage_tile_count",
    "missing_tile_count",
    "coverage_status",
    "palette_pack_group",
    "palette_pack_count",
    "palette_variants",
    "url",
    "tile_url",
    "pmtiles_url",
    "protocol_url",
)

DATASET_COMPONENT_KEYS = (
    "id",
    "title",
    "kind",
    "role",
    "schema",
    "url",
    "bounds",
    "bounds_array",
    "feature_count",
    "size_bytes",
    "modified",
    "license",
    "attribution",
    "source_info",
    "coverage",
    "staleness",
    "inspection",
    "warnings",
)

FINGERPRINT_KEYS = (
    "role",
    "pack_id",
    "dataset_id",
    "kind",
    "container",
    "type",
    "format",
    "bounds_array",
    "minzoom",
    "maxzoom",
    "size_bytes",
    "modified_epoch",
    "source_info",
    "coverage",
    "staleness",
    "renderer",
    "palette",
    "display_category",
    "chart_edition",
    "chart_epoch",
    "render_date",
    "url",
    "tile_url",
    "pmtiles_url",
)

PRIVATE_KEYS = {
    "_path",
    "path",
    "file_path",
    "filepath",
    "local_path",
    "private_path",
    "directory",
    "dir",
}


class BundleError(ValueError):
    pass


def _first(query: dict, name: str, default=None):
    value = query.get(name, default)
    if isinstance(value, list):
        return value[0] if value else default
    return value


def _utcnow_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _json_safe(value):
    return json.loads(json.dumps(value, sort_keys=True))


def _public_json(value):
    if isinstance(value, dict):
        public = {}
        for key, child in value.items():
            key_text = str(key)
            if key_text.startswith("_") or key_text.lower() in PRIVATE_KEYS:
                continue
            public[key] = _public_json(child)
        return public
    if isinstance(value, list):
        return [_public_json(child) for child in value]
    return _json_safe(value)


def _bounds_array(value) -> list[float] | None:
    if value is None:
        return None
    if isinstance(value, (list, tuple)) and len(value) == 4:
        try:
            west, south, east, north = [float(v) for v in value]
        except (TypeError, ValueError):
            return None
    elif isinstance(value, str):
        parts = [p.strip() for p in value.split(",")]
        if len(parts) != 4:
            return None
        try:
            west, south, east, north = [float(p) for p in parts]
        except ValueError:
            return None
    else:
        return None
    if west >= east or south >= north:
        return None
    return [west, south, east, north]


def _bbox_string(bbox: list[float]) -> str:
    return ",".join(f"{v:.7g}" for v in bbox)


def _selected_pack_names(catalog: dict, query: dict) -> list[str]:
    raw = _first(query, "packs", "")
    if not raw:
        return sorted(catalog)
    names = [p.strip() for p in str(raw).split(",") if p.strip()]
    missing = [name for name in names if name not in catalog]
    if missing:
        raise BundleError("unknown pack(s): " + ", ".join(missing))
    return names


def _catalog_bbox(catalog: dict, names: list[str]) -> list[float] | None:
    bounds = []
    for name in names:
        pack = catalog.get(name) or {}
        bbox = _bounds_array(pack.get("bounds_array") or pack.get("bounds"))
        if bbox:
            bounds.append(bbox)
    if not bounds:
        return None
    return [
        min(b[0] for b in bounds),
        min(b[1] for b in bounds),
        max(b[2] for b in bounds),
        max(b[3] for b in bounds),
    ]


def _query_for_prefetch(catalog: dict, query: dict, pack_names: list[str]) -> dict:
    prefetch_query = copy.deepcopy(query)
    if "packs" not in prefetch_query:
        prefetch_query["packs"] = [",".join(pack_names)]
    if not _first(prefetch_query, "include_tiles"):
        prefetch_query["include_tiles"] = ["0"]
    if not _first(prefetch_query, "route") and not _first(prefetch_query, "bbox"):
        bbox = _catalog_bbox(catalog, pack_names)
        if bbox is None:
            raise BundleError("provide route=lon,lat;lon,lat or bbox=W,S,E,N; selected packs have no bounds")
        prefetch_query["bbox"] = [_bbox_string(bbox)]
    return prefetch_query


def _component_role(pack: dict) -> str:
    role = str(pack.get("pack_role") or "").lower()
    kind = str(pack.get("kind") or "").lower()
    fmt = str(pack.get("format") or "").lower()
    pack_type = str(pack.get("type") or "").lower()
    renderer = str(pack.get("renderer") or "").lower()
    if kind == "depth" or "depth" in role:
        return "depth"
    if kind in ("satellite", "imagery") or "sat" in role or "imagery" in role:
        return "basemap"
    if "chart" in role or kind in ("chart", "enc", "rnc") or renderer == "s52":
        return "chart"
    if pack_type == "vector" or fmt in ("mvt", "pbf"):
        return "vector"
    return kind or "pack"


def _fingerprint(payload: dict) -> str:
    data = json.dumps(_json_safe(payload), sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def _public_pack_fields(pack: dict) -> dict:
    return {key: _public_json(pack[key]) for key in PACK_COMPONENT_KEYS if pack.get(key) is not None}


def _public_dataset_fields(dataset: dict) -> dict:
    return {key: _public_json(dataset[key]) for key in DATASET_COMPONENT_KEYS if dataset.get(key) is not None}


def _warning_codes(component: dict) -> list[str]:
    codes = []
    for warning in component.get("warnings") or []:
        if isinstance(warning, dict) and warning.get("code"):
            codes.append(str(warning["code"]))
    return codes


def _component_status(component: dict) -> dict:
    coverage = component.get("coverage") or {}
    staleness = component.get("staleness") or {}
    coverage_status = coverage.get("status")
    freshness_status = staleness.get("status")
    warning_codes = _warning_codes(component)
    status = {
        "freshness": freshness_status or "unknown",
        "coverage": coverage_status or "unknown",
        "warning_codes": warning_codes,
    }
    states = []
    if freshness_status == "stale" or "pack_stale" in warning_codes:
        states.append("stale")
    if coverage_status not in (None, "complete", "unknown") or "pack_out_of_coverage" in warning_codes:
        states.append("out_of_coverage")
    if not states:
        states.append("current")
    status["states"] = states
    return status


def _component_fingerprint_input(component: dict) -> dict:
    return {key: component[key] for key in FINGERPRINT_KEYS if component.get(key) is not None}


def _pack_component(name: str, pack: dict, prefetch_entry: dict | None) -> dict:
    fields = _public_pack_fields(pack)
    fields["id"] = f"pack:{name}"
    fields["pack_id"] = name
    fields["type"] = fields.get("type") or "tile_pack"
    fields["role"] = _component_role(pack)
    fields["title"] = fields.get("title") or name
    if prefetch_entry:
        fields["prefetch"] = {
            key: _json_safe(prefetch_entry[key])
            for key in (
                "minzoom",
                "maxzoom",
                "pack_bounds",
                "prefetch_bbox",
                "tile_count",
                "truncated_tile_count",
                "truncated",
                "estimated_bytes",
                "skipped",
            )
            if prefetch_entry.get(key) is not None
        }
    fields["status"] = _component_status(fields)
    fields["fingerprint"] = _fingerprint(_component_fingerprint_input(fields))
    return fields


def _as_list(value) -> list[dict]:
    if value is None:
        return []
    if isinstance(value, list):
        return [v for v in value if isinstance(v, dict)]
    if isinstance(value, dict):
        return [value]
    return []


def _dataset_component(dataset: dict, default_role: str) -> dict:
    fields = _public_dataset_fields(dataset)
    dataset_id = str(fields.get("id") or fields.get("title") or default_role)
    fields["id"] = f"{default_role}:{dataset_id}"
    fields["dataset_id"] = dataset_id
    fields["type"] = "dataset"
    fields["role"] = str(fields.get("role") or default_role)
    fields["title"] = fields.get("title") or dataset_id
    fields["status"] = _component_status(fields)
    fields["fingerprint"] = _fingerprint(_component_fingerprint_input(fields))
    return fields


def _summary(components: list[dict], prefetch: dict) -> dict:
    by_role: dict[str, int] = {}
    stale = 0
    out_of_coverage = 0
    warnings = 0
    for component in components:
        role = component.get("role") or "unknown"
        by_role[role] = by_role.get(role, 0) + 1
        states = component.get("status", {}).get("states", [])
        if "stale" in states:
            stale += 1
        if "out_of_coverage" in states:
            out_of_coverage += 1
        if component.get("warnings"):
            warnings += 1
    summary = {
        "components": len(components),
        "tile_packs": len([c for c in components if c.get("type") != "dataset"]),
        "datasets": len([c for c in components if c.get("type") == "dataset"]),
        "roles": by_role,
        "stale": stale,
        "out_of_coverage": out_of_coverage,
        "warnings": warnings,
        "prefetch_tiles": prefetch.get("totals", {}).get("tiles", 0),
        "prefetch_truncated": bool(prefetch.get("totals", {}).get("truncated")),
    }
    if prefetch.get("totals", {}).get("estimated_bytes") is not None:
        summary["estimated_bytes"] = prefetch["totals"]["estimated_bytes"]
    return summary


def build_region_bundle(
    catalog: dict,
    query: dict | None = None,
    *,
    generated_at: str | None = None,
    places: list[dict] | dict | None = None,
    depth: list[dict] | dict | None = None,
) -> dict:
    """Build a region bundle from a public pack catalog and request query."""

    query = copy.deepcopy(query or {})
    pack_names = _selected_pack_names(catalog, query)
    prefetch_query = _query_for_prefetch(catalog, query, pack_names)
    try:
        prefetch = build_prefetch_manifest(catalog, prefetch_query)
    except PrefetchError as e:
        raise BundleError(str(e))

    prefetch_by_id = {entry.get("id"): entry for entry in prefetch.get("packs", [])}
    components = [
        _pack_component(name, catalog[name], prefetch_by_id.get(name))
        for name in pack_names
    ]
    components.extend(_dataset_component(dataset, "places") for dataset in _as_list(places))
    components.extend(_dataset_component(dataset, "depth") for dataset in _as_list(depth))
    components.sort(key=lambda c: (str(c.get("role")), str(c.get("id"))))

    request = {
        "packs": pack_names,
        "minzoom": _first(prefetch_query, "minzoom", 0),
        "maxzoom": _first(prefetch_query, "maxzoom", 12),
        "radius_nm": _first(prefetch_query, "radius_nm", 2.0),
        "include_tiles": _first(prefetch_query, "include_tiles", "0"),
    }
    if _first(prefetch_query, "route"):
        request["route"] = _first(prefetch_query, "route")
    if _first(prefetch_query, "bbox"):
        request["bbox"] = _first(prefetch_query, "bbox")

    return {
        "schema": REGION_BUNDLE_SCHEMA,
        "id": str(_first(query, "bundle_id", _first(query, "id", DEFAULT_BUNDLE_ID))),
        "title": str(_first(query, "title", DEFAULT_TITLE)),
        "generated_at": generated_at or _utcnow_iso(),
        "request": request,
        "corridor": prefetch.get("corridor", {}),
        "prefetch": prefetch,
        "components": components,
        "summary": _summary(components, prefetch),
    }


def _component_map(bundle: dict | None) -> dict[str, dict]:
    if not bundle:
        return {}
    return {
        str(component.get("id")): component
        for component in bundle.get("components", [])
        if component.get("id")
    }


def _brief(component: dict) -> dict:
    return {
        key: component[key]
        for key in ("id", "title", "role", "type", "fingerprint")
        if component.get(key) is not None
    }


def _is_stale(component: dict) -> bool:
    states = component.get("status", {}).get("states", [])
    return "stale" in states


def _is_out_of_coverage(component: dict) -> bool:
    states = component.get("status", {}).get("states", [])
    return "out_of_coverage" in states


def diff_region_bundles(available: dict, installed: dict | None = None, *, generated_at: str | None = None) -> dict:
    """Compare an available bundle with an installed bundle manifest."""

    available_map = _component_map(available)
    installed_map = _component_map(installed)

    missing = [_brief(available_map[key]) for key in sorted(set(available_map) - set(installed_map))]
    removed = [_brief(installed_map[key]) for key in sorted(set(installed_map) - set(available_map))]
    changed = []
    for key in sorted(set(available_map) & set(installed_map)):
        available_fp = available_map[key].get("fingerprint")
        installed_fp = installed_map[key].get("fingerprint")
        if available_fp != installed_fp:
            item = _brief(available_map[key])
            item["available_fingerprint"] = available_fp
            item["installed_fingerprint"] = installed_fp
            changed.append(item)

    stale = [_brief(component) for component in available_map.values() if _is_stale(component)]
    out_of_coverage = [_brief(component) for component in available_map.values() if _is_out_of_coverage(component)]
    current = not missing and not changed and not stale

    return {
        "schema": REGION_BUNDLE_DIFF_SCHEMA,
        "generated_at": generated_at or _utcnow_iso(),
        "available_id": available.get("id"),
        "installed_id": installed.get("id") if installed else None,
        "current": current,
        "coverage_complete": not out_of_coverage,
        "missing": missing,
        "changed": changed,
        "stale": stale,
        "out_of_coverage": out_of_coverage,
        "removed": removed,
        "summary": {
            "missing": len(missing),
            "changed": len(changed),
            "stale": len(stale),
            "out_of_coverage": len(out_of_coverage),
            "removed": len(removed),
            "needs_update": not current,
        },
    }


def _read_json_source(source: str):
    if source == "-":
        return json.load(sys.stdin)
    if source.startswith("http://") or source.startswith("https://"):
        with urllib.request.urlopen(source, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    with open(os.path.expanduser(source), "r", encoding="utf-8") as f:
        return json.load(f)


def _write_json(payload: dict, output: str | None) -> None:
    data = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if output:
        with open(os.path.expanduser(output), "w", encoding="utf-8") as f:
            f.write(data)
    else:
        sys.stdout.write(data)


def _query_from_args(args: argparse.Namespace) -> dict:
    query = {
        "bundle_id": [args.bundle_id],
        "title": [args.title],
        "minzoom": [str(args.minzoom)],
        "maxzoom": [str(args.maxzoom)],
        "radius_nm": [str(args.radius_nm)],
        "include_tiles": ["1" if args.include_tiles else "0"],
    }
    if args.bbox:
        query["bbox"] = [args.bbox]
    if args.route:
        query["route"] = [args.route]
    if args.packs:
        query["packs"] = [args.packs]
    return query


def _load_optional_json(path: str | None):
    return _read_json_source(path) if path else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build Helm offline region bundle manifests and delta plans.")
    ap.add_argument("--catalog", required=True, help="Path/URL to a /catalog JSON document, or '-' for stdin.")
    ap.add_argument("--bundle-id", default=DEFAULT_BUNDLE_ID)
    ap.add_argument("--title", default=DEFAULT_TITLE)
    ap.add_argument("--bbox", help="W,S,E,N corridor; defaults to the union of selected pack bounds.")
    ap.add_argument("--route", help="lon,lat;lon,lat route corridor.")
    ap.add_argument("--radius-nm", type=float, default=2.0)
    ap.add_argument("--minzoom", type=int, default=0)
    ap.add_argument("--maxzoom", type=int, default=12)
    ap.add_argument("--packs", help="Comma-separated pack ids to include.")
    ap.add_argument("--include-tiles", action="store_true", help="Include explicit z/x/y tile URLs.")
    ap.add_argument("--places-json", help="Optional public places dataset descriptor JSON.")
    ap.add_argument("--depth-json", help="Optional public depth dataset descriptor JSON.")
    ap.add_argument("--diff-against", help="Optional installed bundle JSON to compare against.")
    ap.add_argument("--output", help="Write JSON here instead of stdout.")
    args = ap.parse_args(argv)

    try:
        catalog = _read_json_source(args.catalog)
        bundle = build_region_bundle(
            catalog,
            _query_from_args(args),
            places=_load_optional_json(args.places_json),
            depth=_load_optional_json(args.depth_json),
        )
        payload = bundle
        if args.diff_against:
            payload = {
                "bundle": bundle,
                "diff": diff_region_bundles(bundle, _read_json_source(args.diff_against)),
            }
        _write_json(payload, args.output)
        return 0
    except (OSError, json.JSONDecodeError, BundleError) as e:
        print(f"region_bundle: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
