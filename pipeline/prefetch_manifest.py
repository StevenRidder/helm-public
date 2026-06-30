#!/usr/bin/env python3
"""Build route/bbox tile prefetch manifests for local Helm packs.

The manifest is advisory: clients decide how aggressively to warm HTTP,
PMTiles, browser, or native caches. This module does only deterministic tile
math and never reads pack files.
"""
from __future__ import annotations

import math
from typing import Iterable

WEB_MERCATOR_LAT_LIMIT = 85.05112878
DEFAULT_RADIUS_NM = 2.0
DEFAULT_MINZOOM = 0
DEFAULT_MAXZOOM = 12
DEFAULT_MAX_TILES = 50000


class PrefetchError(ValueError):
    pass


def _first(query: dict, name: str, default=None):
    value = query.get(name, default)
    if isinstance(value, list):
        return value[0] if value else default
    return value


def _parse_bool(query: dict, name: str, default: bool) -> bool:
    value = str(_first(query, name, "1" if default else "0")).strip().lower()
    if value in ("1", "true", "yes", "on"):
        return True
    if value in ("0", "false", "no", "off"):
        return False
    raise PrefetchError(f"{name} must be true/false")


def _parse_int(query: dict, name: str, default: int, *, min_value: int, max_value: int) -> int:
    raw = _first(query, name, default)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise PrefetchError(f"{name} must be an integer")
    if value < min_value or value > max_value:
        raise PrefetchError(f"{name} must be between {min_value} and {max_value}")
    return value


def _parse_float(query: dict, name: str, default: float, *, min_value: float, max_value: float) -> float:
    raw = _first(query, name, default)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise PrefetchError(f"{name} must be a number")
    if value < min_value or value > max_value:
        raise PrefetchError(f"{name} must be between {min_value:g} and {max_value:g}")
    return value


def _parse_bbox(value) -> list[float]:
    try:
        vals = [float(v.strip()) for v in str(value).split(",")]
    except ValueError:
        raise PrefetchError("bbox must be W,S,E,N")
    if len(vals) != 4:
        raise PrefetchError("bbox must be W,S,E,N")
    w, s, e, n = vals
    if not (-180 <= w <= 180 and -180 <= e <= 180 and -90 <= s <= 90 and -90 <= n <= 90):
        raise PrefetchError("bbox coordinates are outside lon/lat limits")
    if w >= e or s >= n:
        raise PrefetchError("bbox must have west < east and south < north")
    return [_clamp_lon(w), _clamp_lat(s), _clamp_lon(e), _clamp_lat(n)]


def _bounds_array(value) -> list[float] | None:
    if value is None:
        return None
    if isinstance(value, (list, tuple)) and len(value) == 4:
        try:
            return _parse_bbox(",".join(str(v) for v in value))
        except PrefetchError:
            return None
    if isinstance(value, str):
        try:
            return _parse_bbox(value)
        except PrefetchError:
            return None
    return None


def _as_env_bundle_list(value) -> list[dict]:
    if value is None:
        return []
    if isinstance(value, list):
        out = []
        for item in value:
            out.extend(_as_env_bundle_list(item))
        return out
    if not isinstance(value, dict):
        return []
    if value.get("schema") == "helm.env.bundle.v1":
        return [value]
    if isinstance(value.get("bundles"), list):
        out = []
        for item in value["bundles"]:
            if isinstance(item, dict):
                out.extend(_as_env_bundle_list(item.get("manifestObject") or item.get("bundle") or item))
        return out
    return []


def _env_bundle_bbox(manifest: dict) -> dict | None:
    coverage = manifest.get("coverage") if isinstance(manifest.get("coverage"), dict) else {}
    bbox = coverage.get("bbox")
    if isinstance(bbox, dict):
        try:
            west = float(bbox["west"])
            south = float(bbox["south"])
            east = float(bbox["east"])
            north = float(bbox["north"])
        except (KeyError, TypeError, ValueError):
            return None
        return {
            "bbox": [west, south, east, north],
            "crosses_antimeridian": bool(bbox.get("crossesAntimeridian")) or west > east,
        }
    arr = _bounds_array(bbox)
    if arr:
        return {"bbox": arr, "crosses_antimeridian": False}
    return None


def _env_bundle_z_range(manifest: dict, request_min: int, request_max: int) -> tuple[int, int]:
    lod = manifest.get("lod") if isinstance(manifest.get("lod"), dict) else {}
    mins, maxs = [], []
    if lod.get("dataMinZoom") is not None:
        mins.append(lod.get("dataMinZoom"))
    if lod.get("dataMaxZoom") is not None:
        maxs.append(lod.get("dataMaxZoom"))
    levels = lod.get("levels") if isinstance(lod.get("levels"), dict) else {}
    for level in levels.values():
        if not isinstance(level, dict):
            continue
        if level.get("minzoom") is not None:
            mins.append(level.get("minzoom"))
        if level.get("maxzoom") is not None:
            maxs.append(level.get("maxzoom"))
    try:
        bundle_min = int(min(mins)) if mins else request_min
    except (TypeError, ValueError):
        bundle_min = request_min
    try:
        bundle_max = int(max(maxs)) if maxs else request_max
    except (TypeError, ValueError):
        bundle_max = request_max
    return max(request_min, bundle_min), min(request_max, bundle_max)


def _select_env_layers(manifest: dict, query: dict) -> list[str]:
    layers = manifest.get("layers") if isinstance(manifest.get("layers"), dict) else {}
    raw = _first(query, "env_layers", _first(query, "weather_layers", ""))
    if not raw:
        return sorted(layers)
    selected = [p.strip() for p in str(raw).split(",") if p.strip()]
    missing = [name for name in selected if name not in layers]
    if missing:
        raise PrefetchError("unknown environmental layer(s): " + ", ".join(missing))
    return selected


def _env_bundle_entry(manifest: dict, query: dict, bbox: list[float], request_min: int, request_max: int) -> dict:
    bundle_id = str(manifest.get("bundleId") or manifest.get("id") or "environmental-bundle")
    run = manifest.get("run") if isinstance(manifest.get("run"), dict) else {}
    policy = manifest.get("cachePolicy") if isinstance(manifest.get("cachePolicy"), dict) else {}
    cache = manifest.get("cacheState") if isinstance(manifest.get("cacheState"), dict) else {}
    coverage = _env_bundle_bbox(manifest)
    entry = {
        "id": bundle_id,
        "title": manifest.get("title") or bundle_id,
        "kind": "environmental-bundle",
        "schema": manifest.get("schema"),
        "manifest": manifest.get("manifest") or manifest.get("manifest_url"),
        "provider": (manifest.get("source") or {}).get("provider") if isinstance(manifest.get("source"), dict) else None,
        "model": run.get("model"),
        "run_time": run.get("runTime"),
        "valid_times": run.get("validTimes") or [],
        "cache_only_replay": bool(policy.get("cacheOnlyReplay", True)),
        "upstream_fetches_allowed_during_gesture": bool(policy.get("upstreamFetchesAllowedDuringGesture", False)),
        "offline_ready": bool(cache.get("offlineReady")),
        "freshness": {"status": cache.get("state") or "unknown",
                      "materialized_at": cache.get("materializedAt") or manifest.get("generatedAt")},
    }
    entry = {k: v for k, v in entry.items() if v is not None}
    if coverage:
        entry["coverage"] = coverage["bbox"]
        entry["crosses_antimeridian"] = coverage["crosses_antimeridian"]
        if coverage["crosses_antimeridian"]:
            # Antimeridian bundles intentionally span west>east; keep the requested corridor as-is.
            prefetch_bbox = bbox
        else:
            prefetch_bbox = _intersect_bbox(bbox, coverage["bbox"])
            if prefetch_bbox is None:
                entry.update({"layers": [], "skipped": "outside_bundle_coverage"})
                return entry
        entry["prefetch_bbox"] = prefetch_bbox
    layers = _select_env_layers(manifest, query)
    eff_min, eff_max = _env_bundle_z_range(manifest, request_min, request_max)
    entry["minzoom"] = eff_min
    entry["maxzoom"] = eff_max
    if eff_min > eff_max:
        entry.update({"layers": [], "skipped": "outside_bundle_zoom_range"})
        return entry
    entry["layers"] = layers
    entry["layer_count"] = len(layers)
    entry["sample"] = {"probe_handle": "weather.bundle", "contract": "sample(lat, lon, t)"}
    return entry


def _intersect_bbox(a: list[float], b: list[float]) -> list[float] | None:
    west = max(a[0], b[0])
    south = max(a[1], b[1])
    east = min(a[2], b[2])
    north = min(a[3], b[3])
    if west >= east or south >= north:
        return None
    return [west, south, east, north]


def _parse_route(value) -> list[list[float]]:
    points = []
    for part in str(value).replace("|", ";").split(";"):
        part = part.strip()
        if not part:
            continue
        bits = [p.strip() for p in part.split(",")]
        if len(bits) != 2:
            raise PrefetchError("route must be lon,lat;lon,lat")
        try:
            lon, lat = float(bits[0]), float(bits[1])
        except ValueError:
            raise PrefetchError("route must be lon,lat;lon,lat")
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise PrefetchError("route coordinates are outside lon/lat limits")
        points.append([_clamp_lon(lon), _clamp_lat(lat)])
    if len(points) < 2:
        raise PrefetchError("route requires at least two lon,lat points")
    return points


def _clamp_lat(lat: float) -> float:
    return max(-WEB_MERCATOR_LAT_LIMIT, min(WEB_MERCATOR_LAT_LIMIT, lat))


def _clamp_lon(lon: float) -> float:
    return max(-180.0, min(180.0, lon))


def _expand_bbox_for_radius(points: Iterable[list[float]], radius_nm: float) -> list[float]:
    pts = list(points)
    west = min(p[0] for p in pts)
    east = max(p[0] for p in pts)
    south = min(p[1] for p in pts)
    north = max(p[1] for p in pts)
    lat_pad = radius_nm / 60.0
    mid_lat = (south + north) / 2.0
    cos_lat = max(0.2, abs(math.cos(math.radians(mid_lat))))
    lon_pad = radius_nm / (60.0 * cos_lat)
    return [
        _clamp_lon(west - lon_pad),
        _clamp_lat(south - lat_pad),
        _clamp_lon(east + lon_pad),
        _clamp_lat(north + lat_pad),
    ]


def deg2num(lon: float, lat: float, z: int) -> tuple[int, int]:
    lat = _clamp_lat(lat)
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def _tiles_for_bbox(bbox: list[float], minzoom: int, maxzoom: int, max_tiles: int) -> tuple[list[dict], int]:
    w, s, e, n = bbox
    tiles = []
    total = 0
    for z in range(minzoom, maxzoom + 1):
        x0, y0 = deg2num(w, n, z)
        x1, y1 = deg2num(e, s, z)
        for x in range(min(x0, x1), max(x0, x1) + 1):
            for y in range(min(y0, y1), max(y0, y1) + 1):
                total += 1
                if len(tiles) < max_tiles:
                    tiles.append({"z": z, "x": x, "y": y})
    return tiles, max(0, total - len(tiles))


def _pack_zoom_bounds(pack: dict, request_min: int, request_max: int) -> tuple[int, int]:
    try:
        pack_min = int(pack.get("minzoom", request_min))
    except (TypeError, ValueError):
        pack_min = request_min
    try:
        pack_max = int(pack.get("maxzoom", request_max))
    except (TypeError, ValueError):
        pack_max = request_max
    return max(request_min, pack_min), min(request_max, pack_max)


def _pack_tile_url(pack: dict, tile: dict) -> str | None:
    z, x, y = tile["z"], tile["x"], tile["y"]
    if pack.get("container") == "pmtiles":
        proto = pack.get("protocol_url")
        return f"{proto}/{z}/{x}/{y}" if proto else None
    template = pack.get("tile_url") or pack.get("url")
    if not template:
        return None
    return template.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))


def _estimate_bytes(pack: dict, tile_count: int) -> int | None:
    try:
        size = int(pack.get("size_bytes"))
    except (TypeError, ValueError):
        return None
    candidates = (
        pack.get("tile_count"),
        pack.get("addressed_tiles"),
        pack.get("tile_entries"),
    )
    for value in candidates:
        try:
            source_tiles = int(value)
        except (TypeError, ValueError):
            continue
        if source_tiles > 0:
            return int(round((size / source_tiles) * tile_count))
    return None


def _select_packs(catalog: dict, query: dict) -> list[str]:
    raw = _first(query, "packs", "")
    if not raw:
        return sorted(catalog)
    names = [p.strip() for p in str(raw).split(",") if p.strip()]
    missing = [p for p in names if p not in catalog]
    if missing:
        raise PrefetchError("unknown pack(s): " + ", ".join(missing))
    return names


def build_prefetch_manifest(catalog: dict, query: dict, environmental_bundles: list[dict] | dict | None = None) -> dict:
    minzoom = _parse_int(query, "minzoom", DEFAULT_MINZOOM, min_value=0, max_value=24)
    maxzoom = _parse_int(query, "maxzoom", DEFAULT_MAXZOOM, min_value=0, max_value=24)
    if minzoom > maxzoom:
        raise PrefetchError("minzoom must be <= maxzoom")
    radius_nm = _parse_float(query, "radius_nm", DEFAULT_RADIUS_NM, min_value=0, max_value=200)
    max_tiles = _parse_int(query, "max_tiles", DEFAULT_MAX_TILES, min_value=1, max_value=250000)
    include_tiles = _parse_bool(query, "include_tiles", True)
    include_environment = _parse_bool(query, "include_environment", True)

    route_raw = _first(query, "route")
    if route_raw:
        route = _parse_route(route_raw)
        bbox = _expand_bbox_for_radius(route, radius_nm)
        source = "route"
        route_points = len(route)
    else:
        bbox_raw = _first(query, "bbox")
        if not bbox_raw:
            raise PrefetchError("provide route=lon,lat;lon,lat or bbox=W,S,E,N")
        bbox = _parse_bbox(bbox_raw)
        source = "bbox"
        route_points = 0

    pack_names = _select_packs(catalog, query)
    packs = []
    total_tiles = 0
    total_truncated = 0
    total_estimated = 0
    estimated_known = False

    for name in pack_names:
        pack = catalog[name]
        eff_min, eff_max = _pack_zoom_bounds(pack, minzoom, maxzoom)
        entry = {
            "id": name,
            "title": pack.get("title") or name,
            "container": pack.get("container"),
            "kind": pack.get("kind"),
            "format": pack.get("format"),
            "minzoom": eff_min,
            "maxzoom": eff_max,
        }
        pack_bounds = _bounds_array(pack.get("bounds_array") or pack.get("bounds"))
        prefetch_bbox = bbox
        if pack_bounds is not None:
            entry["pack_bounds"] = pack_bounds
            prefetch_bbox = _intersect_bbox(bbox, pack_bounds)
            if prefetch_bbox is None:
                entry.update({"tile_count": 0, "tiles": [], "skipped": "outside_pack_bounds"})
                packs.append(entry)
                continue
        entry["prefetch_bbox"] = prefetch_bbox
        if pack.get("url") is not None:
            entry["url"] = pack.get("url")
        if pack.get("pmtiles_url") is not None:
            entry["pmtiles_url"] = pack.get("pmtiles_url")
        if pack.get("protocol_url") is not None:
            entry["protocol_url"] = pack.get("protocol_url")

        if eff_min > eff_max:
            entry.update({"tile_count": 0, "tiles": [], "skipped": "outside_pack_zoom_range"})
            packs.append(entry)
            continue

        tiles, truncated = _tiles_for_bbox(prefetch_bbox, eff_min, eff_max, max_tiles)
        entry["tile_count"] = len(tiles) + truncated
        entry["truncated_tile_count"] = truncated
        entry["truncated"] = truncated > 0
        estimated = _estimate_bytes(pack, entry["tile_count"])
        if estimated is not None:
            estimated_known = True
            total_estimated += estimated
            entry["estimated_bytes"] = estimated
        if include_tiles:
            entry["tiles"] = [
                dict(tile, url=_pack_tile_url(pack, tile))
                for tile in tiles
            ]
        total_tiles += entry["tile_count"]
        total_truncated += truncated
        packs.append(entry)

    env_entries = []
    if include_environment:
        for manifest in _as_env_bundle_list(environmental_bundles):
            env_entries.append(_env_bundle_entry(manifest, query, bbox, minzoom, maxzoom))

    totals = {
        "packs": len(packs),
        "tiles": total_tiles,
        "truncated_tile_count": total_truncated,
        "truncated": total_truncated > 0,
        "environmental_bundles": len(env_entries),
        "environmental_layers": sum(len(entry.get("layers") or []) for entry in env_entries),
    }
    if estimated_known:
        totals["estimated_bytes"] = total_estimated

    payload = {
        "schema": "helm.prefetch.manifest.v1",
        "source": source,
        "request": {
            "minzoom": minzoom,
            "maxzoom": maxzoom,
            "radius_nm": radius_nm,
            "max_tiles": max_tiles,
            "include_tiles": include_tiles,
            "include_environment": include_environment,
        },
        "corridor": {
            "bbox": bbox,
            "route_points": route_points,
        },
        "packs": packs,
        "totals": totals,
    }
    if env_entries:
        payload["environmental_bundles"] = env_entries
    return payload
