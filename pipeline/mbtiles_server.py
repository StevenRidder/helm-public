#!/usr/bin/env python3
"""Helm local pack server for BYO offline MBTiles and PMTiles chart packs.

  GET /{name}/{z}/{x}/{y}.{ext}   -> MBTiles tile_data (TMS y is flipped)
  GET /{name}.pmtiles             -> PMTiles archive with HTTP Range support
  HEAD /{name}.pmtiles            -> PMTiles headers for protocol probes
  GET /catalog                    -> JSON of available packs + bounds/zoom/URLs
  GET /layers                     -> local maritime layer inventory

Offline-first: everything is local and read-only. Bind 0.0.0.0 so an iPad or
phone on the boat LAN can load the same packs through the boat server.

Configuration:
  HELM_MBTILES_DIR=/path/to/local/packs
  HELM_MBTILES_PACKS='{"chart":"my-chart.mbtiles","sat":"my-sat.pmtiles"}'

If HELM_MBTILES_PACKS is omitted, every *.mbtiles and *.pmtiles file in
HELM_MBTILES_DIR is exposed by its filename stem. Keep license-bound commercial
packs local; do not commit them.
"""
from __future__ import annotations

import datetime as _dt
import glob
import gzip
import http.server
import json
import os
import re
import socketserver
import sqlite3
import struct
import sys
import threading
from typing import Optional, Tuple
import urllib.parse
import urllib.request

from layer_inventory import LayerInventoryError, build_layer_inventory
from prefetch_manifest import PrefetchError, build_prefetch_manifest
from region_bundle import BundleError, build_region_bundle

BASE = os.path.abspath(os.path.expanduser(os.environ.get("HELM_MBTILES_DIR", "web/data")))
ENV_BUNDLE_SOURCES = os.environ.get("HELM_ENV_BUNDLE_MANIFESTS", "").strip()

PMTILE_TYPES = {
    1: ("mvt", "vector"),
    2: ("png", "raster"),
    3: ("jpg", "raster"),
    4: ("webp", "raster"),
    5: ("avif", "raster"),
}

CONTENT_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "avif": "image/avif",
    "mvt": "application/vnd.mapbox-vector-tile",
    "pbf": "application/vnd.mapbox-vector-tile",
    "pmtiles": "application/vnd.pmtiles",
}

PACK_METADATA_KEYS = (
    "helm_pack_schema",
    "pack_role",
    "renderer",
    "palette",
    "display_category",
    "chart_edition",
    "chart_epoch",
    "render_date",
    "stale_after_days",
    "stale_at",
    "staleness_status",
    "z_range",
    "tile_count",
    "tile_count_expected",
    "no_coverage_tile_count",
    "missing_tile_count",
    "coverage_status",
    "coverage_warning",
    "palette_pack_group",
    "palette_pack_count",
    "palette_variants",
    "generated_by",
)

SOURCE_METADATA_KEYS = (
    "source_id",
    "source_url",
    "source_ref",
    "source_format",
    "source_created",
    "source_updated",
    "source_downloaded",
    "source_freshness",
    "source_confidence",
    "edition",
    "update",
    "updated",
    "created",
    "coverage_note",
)

INSPECTION_METADATA_KEYS = (
    "mode",
    "semantic_objects",
    "tap_action",
    "message",
    "chart_object_query",
    "depth_source",
    "confidence",
    "source_ref",
    "feature_layer",
    "sidecar_metadata",
    "sidecar_name",
)

SIDECAR_METADATA_KEYS = PACK_METADATA_KEYS + SOURCE_METADATA_KEYS + (
    "name",
    "title",
    "kind",
    "source",
    "license",
    "attribution",
    "description",
    "bounds",
    "minzoom",
    "maxzoom",
    "center",
    "inspection",
)


def _pack_map() -> dict[str, str]:
    raw = os.environ.get("HELM_MBTILES_PACKS", "").strip()
    if raw:
        try:
            packs = json.loads(raw)
        except json.JSONDecodeError as e:
            print(f"FATAL: HELM_MBTILES_PACKS is not valid JSON: {e}", file=sys.stderr)
            sys.exit(2)
        return {str(name): str(filename) for name, filename in packs.items()}

    packs: dict[str, str] = {}
    for pattern in ("*.mbtiles", "*.pmtiles"):
        for path in sorted(glob.glob(os.path.join(BASE, pattern))):
            name = os.path.splitext(os.path.basename(path))[0]
            packs[name] = os.path.basename(path)
    return packs


def _pack_path(filename: str) -> str:
    expanded = os.path.abspath(os.path.expanduser(filename))
    if os.path.isabs(filename) or filename.startswith("~"):
        return expanded
    return os.path.abspath(os.path.join(BASE, filename))


def _safe_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _maybe_int(value) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _parse_iso_utc(value) -> Optional[_dt.datetime]:
    if not value:
        return None
    try:
        parsed = _dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_dt.timezone.utc)
    return parsed.astimezone(_dt.timezone.utc)


def _bool_value(value) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in ("1", "true", "yes"):
        return True
    if text in ("0", "false", "no"):
        return False
    return None


def _bounds_array(bounds):
    if bounds is None:
        return None
    if isinstance(bounds, (list, tuple)) and len(bounds) == 4:
        try:
            return [float(v) for v in bounds]
        except (TypeError, ValueError):
            return None
    if isinstance(bounds, str):
        parts = [p.strip() for p in bounds.split(",")]
        if len(parts) == 4:
            try:
                return [float(p) for p in parts]
            except ValueError:
                return None
    return None


def _bounds_string(bounds) -> Optional[str]:
    arr = _bounds_array(bounds)
    if not arr:
        return None
    return ",".join(f"{v:.7g}" for v in arr)


def _mtime_iso(path: str) -> str:
    ts = os.path.getmtime(path)
    return _dt.datetime.fromtimestamp(ts, _dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _etag(path: str) -> str:
    st = os.stat(path)
    return f'"{st.st_mtime_ns:x}-{st.st_size:x}"'


def _kind_for(name: str, title: str, fmt: str, pack_type: str) -> str:
    text = f"{name} {title} {fmt}".lower()
    if any(term in text for term in ("sat", "sentinel", "bing", "google", "arcgis", "imagery", "photo")):
        return "satellite"
    if any(term in text for term in ("chart", "navionics", "noaa", "kap", "rnc", "enc")):
        return "chart"
    return "vector" if pack_type == "vector" else "raster"


def _content_type(ext: str) -> str:
    return CONTENT_TYPES.get(ext.lower(), "application/octet-stream")


def _read_sqlite_metadata(conn: sqlite3.Connection) -> dict[str, str]:
    try:
        return dict(conn.execute("SELECT name, value FROM metadata").fetchall())
    except sqlite3.DatabaseError:
        return {}


def _json_object(value) -> Optional[dict]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text.startswith("{") or not text.endswith("}"):
        return None
    try:
        loaded = json.loads(text)
    except json.JSONDecodeError:
        return None
    return loaded if isinstance(loaded, dict) else None


def _read_json_source(source: str) -> Optional[dict]:
    try:
        if source.startswith("http://") or source.startswith("https://"):
            with urllib.request.urlopen(source, timeout=5) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        else:
            with open(os.path.expanduser(source), "r", encoding="utf-8") as f:
                payload = json.load(f)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        print(f"warning: cannot read environmental bundle manifest {source!r}: {e}", file=sys.stderr)
        return None
    return payload if isinstance(payload, dict) else None


def _load_environmental_bundles() -> list[dict]:
    if not ENV_BUNDLE_SOURCES:
        return []
    manifests = []
    for source in [p.strip() for p in ENV_BUNDLE_SOURCES.split(",") if p.strip()]:
        expanded = os.path.expanduser(source)
        candidates = []
        if not source.startswith(("http://", "https://")) and os.path.isdir(expanded):
            candidates.extend(sorted(glob.glob(os.path.join(expanded, "**", "manifest.json"), recursive=True)))
        else:
            candidates.append(source)
        for candidate in candidates:
            payload = _read_json_source(candidate)
            if payload and payload.get("schema") == "helm.env.bundle.v1":
                manifests.append(payload)
            elif payload:
                print(f"warning: environmental bundle manifest {candidate!r} has unsupported schema", file=sys.stderr)
    return manifests


def _inspection_override(value) -> Optional[dict]:
    override = _json_object(value)
    if not override:
        return None
    return {key: override[key] for key in INSPECTION_METADATA_KEYS if key in override}


def _load_sidecar_metadata(path: str) -> dict:
    base, _ = os.path.splitext(path)
    candidates = (
        f"{base}.metadata.json",
        f"{base}.sidecar.json",
        f"{path}.metadata.json",
        f"{path}.sidecar.json",
    )
    for candidate in candidates:
        if not os.path.exists(candidate):
            continue
        try:
            with open(candidate, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
            print(f"warning: cannot read pack metadata sidecar for {os.path.basename(path)!r}: {e}", file=sys.stderr)
            return {}
        if not isinstance(raw, dict):
            print(f"warning: pack metadata sidecar for {os.path.basename(path)!r} is not a JSON object", file=sys.stderr)
            return {}
        public = {}
        for key in SIDECAR_METADATA_KEYS:
            if key not in raw:
                continue
            public[key] = _inspection_override(raw[key]) if key == "inspection" else raw[key]
        public["sidecar_metadata"] = True
        public["sidecar_name"] = os.path.basename(candidate)
        return public
    return {}


def _parse_pmtiles_metadata(path: str) -> dict:
    with open(path, "rb") as f:
        header = f.read(127)
        if len(header) < 127 or header[0:7] != b"PMTiles":
            raise ValueError("not a PMTiles v3 archive")

        version = header[7]
        metadata_offset = struct.unpack_from("<Q", header, 24)[0]
        metadata_length = struct.unpack_from("<Q", header, 32)[0]
        addressed_tiles = struct.unpack_from("<Q", header, 72)[0]
        tile_entries = struct.unpack_from("<Q", header, 80)[0]
        tile_contents = struct.unpack_from("<Q", header, 88)[0]
        internal_compression = header[97]
        tile_compression = header[98]
        tile_type = header[99]
        minzoom = header[100]
        maxzoom = header[101]
        bounds = [
            struct.unpack_from("<i", header, 102)[0] / 1e7,
            struct.unpack_from("<i", header, 106)[0] / 1e7,
            struct.unpack_from("<i", header, 110)[0] / 1e7,
            struct.unpack_from("<i", header, 114)[0] / 1e7,
        ]
        center = [
            struct.unpack_from("<i", header, 119)[0] / 1e7,
            struct.unpack_from("<i", header, 123)[0] / 1e7,
            header[118],
        ]

        metadata = {}
        if metadata_offset and metadata_length:
            f.seek(metadata_offset)
            blob = f.read(metadata_length)
            if internal_compression == 2:
                blob = gzip.decompress(blob)
            elif internal_compression not in (0, 1):
                blob = b"{}"
            try:
                metadata = json.loads(blob.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                metadata = {}

    fmt, pack_type = PMTILE_TYPES.get(tile_type, ("bin", "raster"))
    parsed = {
        "version": version,
        "format": fmt,
        "type": metadata.get("type") or pack_type,
        "minzoom": _safe_int(metadata.get("minzoom"), minzoom),
        "maxzoom": _safe_int(metadata.get("maxzoom"), maxzoom),
        "bounds_array": _bounds_array(metadata.get("bounds")) or bounds,
        "center": metadata.get("center") or center,
        "attribution": metadata.get("attribution"),
        "description": metadata.get("description"),
        "name": metadata.get("name"),
        "tile_compression": tile_compression,
        "addressed_tiles": addressed_tiles,
        "tile_entries": tile_entries,
        "tile_contents": tile_contents,
    }
    for key in PACK_METADATA_KEYS + SOURCE_METADATA_KEYS + ("kind", "source", "license", "inspection", "sidecar_metadata", "sidecar_name"):
        if metadata.get(key) is not None:
            parsed[key] = metadata[key]
    return parsed


def _base_record(name: str, path: str, fmt: str, pack_type: str, title: str, metadata: dict) -> dict:
    bounds_arr = _bounds_array(metadata.get("bounds_array") or metadata.get("bounds"))
    rec = {
        "id": name,
        "name": name,
        "title": title or name,
        "format": fmt,
        "extension": "jpg" if fmt == "jpeg" else fmt,
        "type": pack_type,
        "kind": metadata.get("kind") or _kind_for(name, title or name, fmt, pack_type),
        "source": metadata.get("source") or "local",
        "size_bytes": os.path.getsize(path),
        "modified": _mtime_iso(path),
        "modified_epoch": int(os.path.getmtime(path)),
        "license": metadata.get("license") or "local-user-owned",
    }
    if bounds_arr:
        rec["bounds_array"] = bounds_arr
        rec["bounds"] = _bounds_string(bounds_arr)
    for key in ("minzoom", "maxzoom", "attribution", "description", "center", "scheme", "sidecar_metadata", "sidecar_name") + PACK_METADATA_KEYS + SOURCE_METADATA_KEYS:
        if metadata.get(key) is not None:
            rec[key] = metadata[key]
    if metadata.get("inspection") is not None:
        rec["inspection"] = metadata["inspection"]
    return rec


def _warning(code: str, severity: str, message: str) -> dict:
    return {"code": code, "severity": severity, "message": message}


def _coverage_summary(rec: dict) -> tuple[dict, list[dict]]:
    tile_count = _maybe_int(rec.get("tile_count") or rec.get("addressed_tiles"))
    expected = _maybe_int(rec.get("tile_count_expected"))
    no_coverage = _maybe_int(rec.get("no_coverage_tile_count")) or 0
    missing = _maybe_int(rec.get("missing_tile_count")) or 0
    warnings = []

    if expected is None or expected <= 0:
        status = rec.get("coverage_status") or "unknown"
        coverage = {"status": status}
        if tile_count is not None:
            coverage["tile_count"] = tile_count
        return coverage, warnings

    gaps = max(0, no_coverage) + max(0, missing)
    if tile_count is not None:
        gaps = max(gaps, expected - tile_count)
    status = rec.get("coverage_status") or ("complete" if gaps == 0 else "partial")
    ratio = gaps / expected if expected else 0.0
    coverage = {
        "status": status,
        "tile_count": tile_count,
        "tile_count_expected": expected,
        "no_coverage_tile_count": no_coverage,
        "missing_tile_count": missing,
        "gap_count": gaps,
        "gap_ratio": round(ratio, 6),
    }
    if status != "complete" or gaps:
        message = rec.get("coverage_warning") or (
            f"Pack has coverage gaps: {no_coverage} no-coverage tile(s), "
            f"{missing} failed tile request(s), {expected} requested tile(s)."
        )
        coverage["warning"] = message
        warnings.append(_warning("pack_out_of_coverage", "warning", message))
    return coverage, warnings


def _staleness_summary(rec: dict) -> tuple[dict, list[dict]]:
    render_dt = _parse_iso_utc(rec.get("render_date"))
    stale_after = _maybe_int(rec.get("stale_after_days"))
    stale_at = _parse_iso_utc(rec.get("stale_at"))
    warnings = []

    if render_dt is None:
        message = "Pack has no render_date; freshness cannot be verified."
        return {"status": "unknown", "warning": message}, [
            _warning("pack_freshness_unknown", "warning", message)
        ]

    now = _dt.datetime.now(_dt.timezone.utc)
    age_days = max(0, int((now - render_dt).total_seconds() // 86400))
    if stale_after is not None and stale_after > 0 and stale_at is None:
        stale_at = render_dt + _dt.timedelta(days=stale_after)

    forced_stale = _bool_value(rec.get("is_stale"))
    if forced_stale is None and str(rec.get("staleness_status", "")).lower() == "stale":
        forced_stale = True

    stale = bool(forced_stale)
    if stale_at is not None and now >= stale_at:
        stale = True
    status = "stale" if stale else "fresh"
    staleness = {
        "status": status,
        "render_date": rec.get("render_date"),
        "age_days": age_days,
    }
    if stale_after is not None:
        staleness["stale_after_days"] = stale_after
    if stale_at is not None:
        staleness["stale_at"] = stale_at.isoformat().replace("+00:00", "Z")
    if stale:
        message = "Pack render date is older than the configured freshness window."
        staleness["warning"] = message
        warnings.append(_warning("pack_stale", "warning", message))
    return staleness, warnings


def _enrich_pack_record(rec: dict) -> dict:
    coverage, coverage_warnings = _coverage_summary(rec)
    staleness, staleness_warnings = _staleness_summary(rec)
    rec["coverage"] = coverage
    rec["staleness"] = staleness
    rec["source_info"] = _source_summary(rec)
    rec["inspection"] = _inspection_summary(rec)
    rec["warnings"] = coverage_warnings + staleness_warnings
    return rec


def _source_summary(rec: dict) -> dict:
    info = {
        "label": rec.get("source") or "local",
        "kind": rec.get("kind"),
        "container": rec.get("container"),
        "format": rec.get("format"),
        "license": rec.get("license"),
        "attribution": rec.get("attribution"),
        "modified": rec.get("modified"),
    }
    fields = {
        "id": "source_id",
        "url": "source_url",
        "ref": "source_ref",
        "format": "source_format",
        "created": "source_created",
        "updated": "source_updated",
        "downloaded": "source_downloaded",
        "freshness": "source_freshness",
        "confidence": "source_confidence",
        "chart_edition": "chart_edition",
        "chart_epoch": "chart_epoch",
        "render_date": "render_date",
        "edition": "edition",
        "update": "update",
        "coverage_note": "coverage_note",
    }
    for out_key, rec_key in fields.items():
        if rec.get(rec_key) is not None:
            info[out_key] = rec[rec_key]
    if "created" not in info and rec.get("created") is not None:
        info["created"] = rec["created"]
    if "updated" not in info and rec.get("updated") is not None:
        info["updated"] = rec["updated"]
    return {k: v for k, v in info.items() if v is not None}


def _inspection_summary(rec: dict) -> dict:
    kind = str(rec.get("kind") or "").lower()
    override = _inspection_override(rec.get("inspection"))
    if override:
        override.setdefault("sidecar_metadata", bool(rec.get("sidecar_metadata")))
        if rec.get("sidecar_name") is not None:
            override.setdefault("sidecar_name", rec.get("sidecar_name"))
        if kind == "chart" and rec.get("renderer") == "s52":
            override.setdefault("chart_object_query", "use_live_CHART_10_query_when_source_ENC_is_mounted")
        return override

    pack_type = str(rec.get("type") or "").lower()
    fmt = str(rec.get("format") or "").lower()
    is_vector = pack_type == "vector" or fmt in ("mvt", "pbf")
    has_sidecar = bool(rec.get("sidecar_metadata"))

    base = {
        "sidecar_metadata": has_sidecar,
        "sidecar_name": rec.get("sidecar_name"),
    }
    if kind == "depth":
        base.update({
            "mode": "depth_sample",
            "semantic_objects": "depth_values",
            "tap_action": "show_depth_source_confidence",
            "message": "Depth packs may expose sampled value/source/confidence; they are not chart-object attributes.",
        })
    elif is_vector:
        base.update({
            "mode": "vector_features",
            "semantic_objects": "available",
            "tap_action": "query_vector_features",
            "message": "Vector packs may expose feature attributes when the client layer supports picking.",
        })
    elif has_sidecar:
        base.update({
            "mode": "sidecar_metadata",
            "semantic_objects": "sidecar",
            "tap_action": "show_sidecar_then_pack_metadata",
            "message": "Raster pixels are not semantic objects; sidecar metadata may provide curated object hints.",
        })
    else:
        base.update({
            "mode": "raster_metadata",
            "semantic_objects": "unavailable",
            "tap_action": "show_pack_source_metadata",
            "message": "Raster packs contain pixels only; object inspection is unavailable unless a sidecar metadata layer is present.",
        })
    if kind == "chart" and rec.get("renderer") == "s52":
        base["chart_object_query"] = "use_live_CHART_10_query_when_source_ENC_is_mounted"
    return {k: v for k, v in base.items() if v is not None}


def _build_pack_records():
    records, conns, locks = {}, {}, {}
    for name, filename in _pack_map().items():
        path = _pack_path(filename)
        if not os.path.exists(path):
            print(f"warning: pack {name!r} not found at {path}", file=sys.stderr)
            continue
        ext = os.path.splitext(path)[1].lower()
        if ext == ".mbtiles":
            try:
                conn = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True, check_same_thread=False)
                m = _read_sqlite_metadata(conn)
            except sqlite3.DatabaseError as e:
                print(f"warning: cannot open MBTiles pack {name!r}: {e}", file=sys.stderr)
                continue
            fmt = (m.get("format") or "png").lower()
            if fmt == "jpeg":
                fmt = "jpg"
            pack_type = "vector" if fmt in ("pbf", "mvt") else "raster"
            title = m.get("name") or name
            metadata = dict(m)
            metadata.update(_load_sidecar_metadata(path))
            metadata.update({
                "bounds": m.get("bounds"),
                "minzoom": _safe_int(m.get("minzoom"), 0),
                "maxzoom": _safe_int(m.get("maxzoom"), 17),
                "attribution": metadata.get("attribution") or m.get("attribution"),
                "description": metadata.get("description") or m.get("description"),
                "scheme": m.get("scheme", "tms"),
            })
            rec = _base_record(name, path, fmt, pack_type, title, metadata)
            rec["container"] = "mbtiles"
            rec["_path"] = path
            records[name] = _enrich_pack_record(rec)
            conns[name] = conn
            locks[name] = threading.Lock()
        elif ext == ".pmtiles":
            try:
                pm = _parse_pmtiles_metadata(path)
            except (OSError, ValueError, struct.error, gzip.BadGzipFile) as e:
                print(f"warning: cannot open PMTiles pack {name!r}: {e}", file=sys.stderr)
                continue
            pm.update(_load_sidecar_metadata(path))
            fmt = pm["format"]
            pack_type = "vector" if pm["type"] == "vector" or fmt == "mvt" else "raster"
            title = pm.get("name") or name
            rec = _base_record(name, path, fmt, pack_type, title, pm)
            rec["container"] = "pmtiles"
            rec["range"] = True
            rec["pmtiles_version"] = pm["version"]
            rec["addressed_tiles"] = pm["addressed_tiles"]
            rec["tile_entries"] = pm["tile_entries"]
            rec["tile_contents"] = pm["tile_contents"]
            rec["_path"] = path
            records[name] = _enrich_pack_record(rec)
        else:
            print(f"warning: unsupported pack extension for {name!r}: {path}", file=sys.stderr)
    return records, conns, locks


PACKS, CONNS, LOCKS = _build_pack_records()
ENV_BUNDLES = _load_environmental_bundles()


def _origin(handler: http.server.BaseHTTPRequestHandler) -> str:
    proto = handler.headers.get("X-Forwarded-Proto", "http").split(",")[0].strip() or "http"
    host = handler.headers.get("Host") or f"127.0.0.1:{handler.server.server_port}"
    return f"{proto}://{host}"


def _catalog(origin: str) -> dict:
    catalog = {}
    for name, rec in sorted(PACKS.items()):
        item = {k: v for k, v in rec.items() if not k.startswith("_")}
        quoted = urllib.parse.quote(name, safe="")
        if rec["container"] == "mbtiles":
            item["tile_url"] = f"{origin}/{quoted}/{{z}}/{{x}}/{{y}}.{rec['extension']}"
            item["url"] = item["tile_url"]
        else:
            pmtiles_url = f"{origin}/{quoted}.pmtiles"
            item["pmtiles_url"] = pmtiles_url
            item["protocol_url"] = f"pmtiles://{pmtiles_url}"
            item["url"] = pmtiles_url
        catalog[name] = item
    return catalog


def _parse_range(value: Optional[str], size: int) -> Optional[Tuple[int, int]]:
    if not value:
        return None
    match = re.match(r"^bytes=(\d*)-(\d*)$", value.strip())
    if not match:
        raise ValueError("unsupported range")
    start_s, end_s = match.groups()
    if not start_s and not end_s:
        raise ValueError("empty range")
    if not start_s:
        suffix_len = int(end_s)
        if suffix_len <= 0:
            raise ValueError("empty suffix range")
        start = max(0, size - suffix_len)
        end = size - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s else size - 1
    if start >= size or start > end:
        raise ValueError("unsatisfiable range")
    return start, min(end, size - 1)


def _copy_bytes(wfile, path: str, start: int, length: int) -> None:
    remaining = length
    with open(path, "rb") as f:
        f.seek(start)
        while remaining > 0:
            chunk = f.read(min(1024 * 256, remaining))
            if not chunk:
                break
            wfile.write(chunk)
            remaining -= len(chunk)


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range, ETag")

    def _empty(self, code: int, *, content_range: Optional[str] = None):
        self.send_response(code)
        self._cors()
        if content_range:
            self.send_header("Content-Range", content_range)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _catalog_response(self):
        body = json.dumps(_catalog(_origin(self)), sort_keys=True).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json_response(self, code: int, payload: dict):
        body = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _prefetch_response(self, query: dict):
        try:
            payload = build_prefetch_manifest(_catalog(_origin(self)), query, environmental_bundles=ENV_BUNDLES)
        except PrefetchError as e:
            self._json_response(400, {"error": "bad_prefetch_request", "message": str(e)})
            return
        self._json_response(200, payload)

    def _bundle_response(self, query: dict):
        try:
            payload = build_region_bundle(_catalog(_origin(self)), query)
        except BundleError as e:
            self._json_response(400, {"error": "bad_bundle_request", "message": str(e)})
            return
        self._json_response(200, payload)

    def _layers_response(self, query: dict):
        try:
            payload = build_layer_inventory(_catalog(_origin(self)), query, environmental_bundles=ENV_BUNDLES)
        except LayerInventoryError as e:
            self._json_response(400, {"error": "bad_layer_inventory_request", "message": str(e)})
            return
        self._json_response(200, payload)

    def _serve_mbtiles(self, name: str, parts: list[str]):
        if len(parts) != 4 or name not in CONNS:
            self._empty(404)
            return
        try:
            z, x = int(parts[1]), int(parts[2])
            y = int(parts[3].split(".")[0])
        except ValueError:
            self._empty(404)
            return
        tms_y = (1 << z) - 1 - y
        with LOCKS[name]:
            row = CONNS[name].execute(
                "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                (z, x, tms_y),
            ).fetchone()
        if not row:
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        fmt = PACKS[name]["extension"]
        self.send_response(200)
        self.send_header("Content-Type", _content_type(fmt))
        self._cors()
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("Content-Length", str(len(row[0])))
        self.end_headers()
        self.wfile.write(row[0])

    def _serve_pmtiles(self, name: str, head_only: bool = False):
        if name not in PACKS or PACKS[name]["container"] != "pmtiles":
            self._empty(404)
            return
        path = PACKS[name]["_path"]
        size = os.path.getsize(path)
        try:
            rng = _parse_range(self.headers.get("Range"), size)
        except ValueError:
            self._empty(416, content_range=f"bytes */{size}")
            return
        if rng:
            start, end = rng
            length = end - start + 1
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            start, length = 0, size
            self.send_response(200)
        self.send_header("Content-Type", _content_type("pmtiles"))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("ETag", _etag(path))
        self._cors()
        self.send_header("Content-Length", str(length))
        self.end_headers()
        if not head_only:
            _copy_bytes(self.wfile, path, start, length)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        path = urllib.parse.urlparse(self.path).path.strip("/")
        if path.endswith(".pmtiles"):
            name = urllib.parse.unquote(path[:-8])
            self._serve_pmtiles(name, head_only=True)
            return
        if path == "catalog":
            body = json.dumps(_catalog(_origin(self)), sort_keys=True).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return
        if path == "layers":
            try:
                body = json.dumps(
                    build_layer_inventory(_catalog(_origin(self)), {}, environmental_bundles=ENV_BUNDLES),
                    sort_keys=True,
                ).encode("utf-8")
            except LayerInventoryError:
                self._empty(400)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return
        self._empty(404)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.strip("/")
        if path == "catalog":
            self._catalog_response()
            return
        if path == "prefetch":
            self._prefetch_response(urllib.parse.parse_qs(parsed.query))
            return
        if path == "bundle":
            self._bundle_response(urllib.parse.parse_qs(parsed.query))
            return
        if path == "layers":
            self._layers_response(urllib.parse.parse_qs(parsed.query))
            return
        if path.endswith(".pmtiles"):
            name = urllib.parse.unquote(path[:-8])
            self._serve_pmtiles(name)
            return
        parts = [urllib.parse.unquote(p) for p in path.split("/") if p]
        if not parts:
            self._empty(404)
            return
        self._serve_mbtiles(parts[0], parts)


class TS(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8091
    if not PACKS:
        print(f"FATAL: no .mbtiles or .pmtiles packs found under {BASE}", file=sys.stderr)
        print("Set HELM_MBTILES_DIR or HELM_MBTILES_PACKS to point at your local packs.", file=sys.stderr)
        sys.exit(1)
    print(f"local pack server :{port} - packs: {list(PACKS.keys())}")
    for k, v in PACKS.items():
        zoom = f"z{v.get('minzoom', 0)}-{v.get('maxzoom', 17)}"
        print(f"  {k}: {v['title']}  {v['container']}  {zoom}  {v['format']}")
    if ENV_BUNDLES:
        print(f"  environmental bundles: {len(ENV_BUNDLES)}")
    TS(("0.0.0.0", port), H).serve_forever()
