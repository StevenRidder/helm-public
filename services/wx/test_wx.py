#!/usr/bin/env python3
"""
helm-wx self-test — OFFLINE (no network; runs even while rate-limited).
Validates the full bake -> PNG -> decode -> value round-trip, the manifest contract, and caching.

    python3 test_wx.py
"""
import asyncio
import json
from pathlib import Path
import struct
import sys
import zlib

import app
from fastapi.testclient import TestClient


def decode_png_rgba(png: bytes):
    """Minimal decoder for the filter-0 RGBA PNGs write_png_bytes() emits. Returns (w, h, pixels[])."""
    assert png[:8] == b'\x89PNG\r\n\x1a\n', "not a PNG"
    i, idat = 8, bytearray()
    w = h = 0
    while i < len(png):
        ln = struct.unpack('>I', png[i:i + 4])[0]
        tag = png[i + 4:i + 8]
        data = png[i + 8:i + 8 + ln]
        if tag == b'IHDR':
            w, h = struct.unpack('>II', data[:8])
        elif tag == b'IDAT':
            idat.extend(data)
        i += 12 + ln
    raw = zlib.decompress(bytes(idat))
    stride = w * 4
    px = []
    for row in range(h):
        base = row * (stride + 1) + 1                 # skip the per-row filter byte (0 = None)
        line = raw[base:base + stride]
        for c in range(w):
            o = c * 4
            px.append((line[o], line[o + 1], line[o + 2], line[o + 3]))
    return w, h, px


def decode_value(r, g, b, a, scale, offset):
    if a < 128:
        return None
    return offset + ((r << 16) | (g << 8) | b) * scale


fails = 0


def check(cond, msg):
    global fails
    if cond:
        print("  ok   " + msg)
    else:
        fails += 1
        print("  FAIL " + msg)


def main():
    # isolate from any prior on-disk cache so the test is deterministic
    import tempfile
    app.CACHE_DIR = tempfile.mkdtemp(prefix="helmwx-test-")
    app._tiles = app.OrderedTileCache(app.TILE_MEM_MAX)

    # 1) encode/decode round-trip at the value level for every layer's fixed scale/offset
    for layer, cfg in app.LAYERS.items():
        scale, offset = app.layer_scale_offset(cfg)
        mid = (cfg["vmin"] + cfg["vmax"]) / 2.0
        r, g, b = app.encode_value(mid, scale, offset)
        back = decode_value(r, g, b, 255, scale, offset)
        check(abs(back - mid) <= 2 * scale + 1e-6, "%s: value round-trips (%.2f ~ %.2f)" % (layer, back, mid))

    # 2) bake a real tile from a SYNTHETIC grid (no network) and decode it back through the PNG.
    # The fake mirrors _fetch_grid's geometry (a grid over the coarse-cell bounds + margin) so it
    # always covers the requested tile — exactly like the real fetch, minus the network.
    UNIFORM = 23.5  # kn

    async def fake_fetch(layer, cz, cx, cy):
        w, s, e, n = app.tile_bounds(cz, cx, cy)
        mw, mh = (e - w) * 0.08, (n - s) * 0.08
        w, e, s, n = w - mw, e + mw, s - mh, n + mh
        return app.Grid(app.GRID_N, app.GRID_N, w, s, e, n, [UNIFORM] * (app.GRID_N * app.GRID_N))
    app._fetch_grid = fake_fetch                       # monkeypatch the only network call

    z, x = 6, app.lonlat_to_tile(177.4, -17.6, 6)[0]
    y = app.lonlat_to_tile(177.4, -17.6, 6)[1]
    xt, yt = int(x), int(y)
    calls0 = app._stats["openmeteo_calls"]
    png = asyncio.run(app.bake_tile("wind", z, xt, yt))
    check(png[:8] == b'\x89PNG\r\n\x1a\n', "bake_tile returns a PNG")
    w, h, px = decode_png_rgba(png)
    check((w, h) == (256, 256), "tile is 256x256 (%dx%d)" % (w, h))

    scale, offset = app.layer_scale_offset(app.LAYERS["wind"])
    cr, cg, cb, ca = px[128 * 256 + 128]               # centre pixel
    val = decode_value(cr, cg, cb, ca, scale, offset)
    check(val is not None and abs(val - UNIFORM) <= 2 * scale + 1e-6,
          "centre pixel decodes to the baked value (%.2f ~ %.2f kn)" % (val or -1, UNIFORM))
    check(app._stats["openmeteo_calls"] == calls0, "bake used the SYNTHETIC grid (no network call)")

    # 3) caching: re-baking the same tile is a cache hit (no re-bake)
    bakes0 = app._stats["bakes"]
    asyncio.run(app.bake_tile("wind", z, xt, yt))
    check(app._stats["bakes"] == bakes0, "second request is a cache hit (no re-bake)")

    # 4) manifest contract
    m = app.manifest_for("wind")
    check(m["encoding"] == "helm-wxv1", "manifest encoding is helm-wxv1")
    check(m["tiles_template"] == "{z}/{x}/{y}.png", "manifest tiles_template matches the client contract")
    check("scale" in m and "offset" in m and "ramp" in m, "manifest carries scale/offset/ramp")
    check("NOT FOR NAVIGATION" in m["disclaimer"], "manifest is honestly not-for-navigation")

    # 5) environmental bundle contract: the root fix for Windy-parity cache/render work.
    b = app.environment_bundle_manifest()
    check(b["schema"] == "helm.env.bundle.v1", "bundle manifest uses helm.env.bundle.v1")
    check(b["cachePolicy"]["upstreamFetchesAllowedDuringGesture"] is False,
          "bundle contract forbids upstream API fetches during pan/zoom/scrub")
    check(b["lod"]["parentFallback"] is True and "overzoom" in b["lod"],
          "bundle contract defines all-zoom parent fallback/overzoom behaviour")
    check(set(app.BUNDLE_LAYER_ORDER).issubset(set(b["layers"].keys())),
          "bundle advertises the full met-ocean layer catalog")
    wind = b["layers"]["wind"]
    current = b["layers"]["current"]
    check(wind["fieldTiles"]["urlTemplate"] == "/wind/{z}/{x}/{y}.png",
          "wind scalar colour field remains a numeric field-tile contract")
    check(wind["vectorField"]["type"] == "bbox-json-compatibility" and wind["vectorField"]["urlTemplate"].startswith("/velocity/wind"),
          "wind particles use an explicit vector-field endpoint")
    check(wind["vectorField"]["preparedComponentTiles"]["type"] == "component-tiles",
          "wind bundle advertises the prepared vector component-tile target")
    check(current["s100"]["productIdentifier"] == "S-111" and current["s100"]["officialProduct"] is False,
          "surface currents align to S-111 metadata without claiming official S-100 authority")
    check(b["layers"]["waves"]["s100"]["productIdentifier"] == "S-413",
          "wave layers align to the S-413 weather/wave family")
    idx = app.bundle_index()
    check(idx["bundles"][0]["manifest"] == "/bundles/open-meteo/latest/manifest.json",
          "bundle index points at the live Open-Meteo bundle manifest")
    client = TestClient(app.app)
    route_manifest = client.get("/bundles/open-meteo/latest/manifest.json")
    route_index = client.get("/index.json")
    check(route_manifest.status_code == 200 and route_manifest.json()["schema"] == "helm.env.bundle.v1",
          "bundle manifest endpoint returns the bundle contract")
    check(route_index.status_code == 200 and "bundles" in route_index.json(),
          "legacy index advertises bundle discovery without breaking layer discovery")
    fixture = json.loads((Path(__file__).parent / "fixtures" / "fiji-env-bundle-v1.json").read_text())
    check(fixture["schema"] == "helm.env.bundle.v1" and fixture["coverage"]["bbox"]["crossesAntimeridian"] is True,
          "Fiji/South Pacific fixture carries the bundle schema and antimeridian coverage")
    check(set(app.BUNDLE_LAYER_ORDER).issubset(set(fixture["layers"].keys())),
          "Fiji/South Pacific fixture includes the full met-ocean layer catalog")

    # 6) WX-18 prepared bundle materialization + cache-only replay.
    frame_order = {}

    async def fake_fetch_points(layer, qlat, qlon, valid_time=None):
        cfg = app.LAYERS[layer]
        frame_key = valid_time or "latest"
        frame_idx = frame_order.setdefault(frame_key, len(frame_order))
        mid = (cfg["vmin"] + cfg["vmax"]) / 2.0 + frame_idx
        nodes = []
        for _ in qlat:
            cur = {cfg["v"]: mid}
            if cfg.get("dir"):
                cur[cfg["dir"]] = 90.0
            nodes.append({"current": cur})
        return nodes

    app._fetch_points = fake_fetch_points
    route_bbox = app._parse_route_bbox("177,-18;-179,-17", 1.0)
    check(route_bbox is not None and route_bbox[0] > route_bbox[2],
          "route-corridor bbox handles antimeridian crossings")
    materialized = asyncio.run(app.materialize_environment_bundle(
        "fiji-test",
        list(app.BUNDLE_LAYER_ORDER),
        160.0, -35.0, -150.0, 5.0,
        minzoom=0,
        maxzoom=0,
        res=20.0,
        tile_budget=64,
    ))
    check(materialized["schema"] == "helm.env.bundle.v1", "materialized bundle writes helm.env.bundle.v1")
    check(materialized["run"]["mode"] == "model-run-cache", "materialized bundle is model-run-cache, not viewport fetch")
    check(materialized["coverage"]["bbox"]["crossesAntimeridian"] is True,
          "materialized Fiji bundle preserves antimeridian coverage")
    check(set(app.BUNDLE_LAYER_ORDER).issubset(set(materialized["layers"].keys())),
          "materialized bundle includes the full met-ocean layer catalog")
    check(materialized["layers"]["wind"]["vectorField"]["type"] == "component-tiles",
          "materialized wind vector field uses prepared component tiles")
    check(materialized["telemetry"]["gesturePathUpstreamFetches"] == 0,
          "materialized bundle telemetry locks gesture-path upstream fetches to zero")
    check(materialized["telemetry"]["tilesWritten"] >= len(app.BUNDLE_LAYER_ORDER),
          "materialized bundle writes scalar/vector tile files")

    # 7) WX-22 multi-frame bake: frame ids are stable path segments and replay remains cache-only.
    multiframe = asyncio.run(app.materialize_environment_bundle(
        "fiji-multiframe",
        ["wind", "temp"],
        160.0, -35.0, -150.0, 5.0,
        minzoom=0,
        maxzoom=0,
        res=20.0,
        tile_budget=16,
        frames=3,
        frame_hours="0,1,2",
    ))
    run = multiframe["run"]
    frames = multiframe.get("frames") or []
    frame_ids = [f["validTimeId"] for f in frames]
    check(run["frames"] == 3 and len(run["validTimes"]) == 3 and len(frames) == 3,
          "multi-frame bundle manifest lists three valid times")
    check(len(set(frame_ids)) == 3 and all(fid != "latest" for fid in frame_ids),
          "multi-frame bundle uses stable compact validTimeId path segments")
    check(all(f["time"] == f["validTime"] for f in frames) and frames[0]["latest"] is True and
          all(f["latest"] is False for f in frames[1:]),
          "multi-frame entries expose renderer-friendly time/latest aliases")
    check(all(run["frameIdByValidTime"][f["validTime"]] == f["validTimeId"] for f in frames),
          "multi-frame manifest maps validTime ISO strings to tile path ids")
    check(multiframe["telemetry"]["framesMaterialized"] == 3,
          "multi-frame telemetry records frame count")
    route_multiframe = client.get(
        "/bundles/open-meteo/latest/materialize"
        "?region=route-multiframe&layers=wind,temp&w=160&s=-35&e=-150&n=5"
        "&minzoom=0&maxzoom=0&res=20&tile_budget=16&frames=3&frame_hours=0,1,2"
    )
    route_multiframe_payload = route_multiframe.json()
    check(route_multiframe.status_code == 200 and
          route_multiframe_payload["bundle"]["run"]["frames"] == 3 and
          route_multiframe_payload["bundle"]["telemetry"]["framesMaterialized"] == 3,
          "materialize endpoint accepts frames/frame_hours for multi-frame warm jobs")

    async def exploding_fetch_async(*args, **kwargs):
        raise AssertionError("prepared replay must not call provider/grid fetch")

    app._fetch_grid = exploding_fetch_async
    app._fetch_velocity = exploding_fetch_async
    calls_before_replay = app._stats["openmeteo_calls"]
    route_index = client.get("/bundles/index.json").json()
    check(any(bun.get("manifest") == "/bundles/open-meteo/latest/fiji-test/manifest.json"
              for bun in route_index["bundles"]),
          "bundle index advertises the prepared Fiji test bundle")
    prepared_index = next(bun for bun in route_index["bundles"]
                          if bun.get("manifest") == "/bundles/open-meteo/latest/fiji-test/manifest.json")
    check(prepared_index["kind"] == "environmental-bundle" and "wind" in prepared_index["layers"],
          "prepared bundle index exposes offline-pack layer metadata")
    check(prepared_index["offlineReady"] is True and prepared_index["cacheOnlyReplay"] is True,
          "prepared bundle index advertises offline/cache-only replay")
    check(prepared_index["sample"]["probeHandle"] == "weather.bundle",
          "prepared bundle index exposes weather bundle sample handle")
    prepared_manifest = client.get("/bundles/open-meteo/latest/fiji-test/manifest.json")
    check(prepared_manifest.status_code == 200 and prepared_manifest.headers.get("x-helm-upstream-fetch") == "0",
          "prepared manifest replays from cache only")
    multi_manifest = client.get("/bundles/open-meteo/latest/fiji-multiframe/manifest.json")
    multi_payload = multi_manifest.json()
    multi_frames = multi_payload.get("frames") or []
    check(multi_manifest.status_code == 200 and multi_manifest.headers.get("x-helm-upstream-fetch") == "0" and
          len(multi_frames) == 3,
          "multi-frame manifest replays from cache only")
    scalar_resp = client.get("/bundles/open-meteo/latest/fiji-test/layers/wind/scalar/latest/0/0/0.png")
    vector_resp = client.get("/bundles/open-meteo/latest/fiji-test/layers/wind/vector/latest/u/0/0/0.png")
    check(scalar_resp.status_code == 200 and scalar_resp.headers.get("x-helm-bundle-cache") == "hit",
          "prepared scalar tile replays from cache")
    check(vector_resp.status_code == 200 and vector_resp.headers.get("x-helm-upstream-fetch") == "0",
          "prepared vector component tile replays from cache")
    m0, m1 = multi_frames[0]["validTimeId"], multi_frames[1]["validTimeId"]
    multi_w0 = client.get(f"/bundles/open-meteo/latest/fiji-multiframe/layers/wind/scalar/{m0}/0/0/0.png")
    multi_w1 = client.get(f"/bundles/open-meteo/latest/fiji-multiframe/layers/wind/scalar/{m1}/0/0/0.png")
    multi_latest = client.get("/bundles/open-meteo/latest/fiji-multiframe/layers/wind/scalar/latest/0/0/0.png")
    multi_temp1 = client.get(f"/bundles/open-meteo/latest/fiji-multiframe/layers/temp/scalar/{m1}/0/0/0.png")
    check(multi_w0.status_code == 200 and multi_w1.status_code == 200 and
          multi_w0.headers.get("x-helm-upstream-fetch") == "0" and
          multi_w1.headers.get("x-helm-bundle-cache") == "hit",
          "multi-frame wind frame N and N+1 tiles replay from cache")
    check(multi_latest.status_code == 200 and multi_latest.content == multi_w0.content,
          "legacy latest alias resolves to the first multi-frame tile")
    check(multi_temp1.status_code == 200 and multi_temp1.headers.get("x-helm-upstream-fetch") == "0",
          "multi-frame temp frame N+1 tile replays from cache")
    check(app._stats["openmeteo_calls"] == calls_before_replay,
          "prepared manifest/tile replay makes zero upstream calls")
    tw, th, tpx = decode_png_rgba(scalar_resp.content)
    fx, fy = app.lonlat_to_tile(177.4, -17.6, 0)
    px = max(0, min(255, int((fx - int(fx)) * 256)))
    py = max(0, min(255, int((fy - int(fy)) * 256)))
    wr, wg, wb, wa = tpx[py * tw + px]
    wind_scale, wind_offset = app.layer_scale_offset(app.LAYERS["wind"])
    wind_val = decode_value(wr, wg, wb, wa, wind_scale, wind_offset)
    check(wind_val is not None and abs(wind_val - 40.0) < 0.1,
          "prepared scalar tile decodes to the synthetic wind value")
    _, _, upx = decode_png_rgba(vector_resp.content)
    ur, ug, ub, ua = upx[py * tw + px]
    uscale, uoffset = app._vector_component_scale_offset(app.LAYERS["wind"])
    u_val = decode_value(ur, ug, ub, ua, uscale, uoffset)
    check(u_val is not None and u_val < -30.0,
          "prepared vector component tile decodes to wind-from eastward u component")
    route_materialize = client.get(
        "/bundles/open-meteo/latest/materialize"
        "?region=route-test&layers=wind&route=177,-18;-179,-17&minzoom=0&maxzoom=0&res=20&tile_budget=8"
    )
    route_payload = route_materialize.json()
    check(route_materialize.status_code == 200 and route_payload["bundle"]["coverage"]["bbox"]["crossesAntimeridian"] is True,
          "materialize endpoint supports route-corridor prewarm across the antimeridian")

    dateline_materialize = client.get(
        "/bundles/open-meteo/latest/materialize"
        "?region=dateline-test&layers=wind&w=160&s=-35&e=-150&n=5&minzoom=0&maxzoom=1&tile_budget=32"
    )
    dateline_payload = dateline_materialize.json()
    dateline_bundle = dateline_payload.get("bundle", {})
    source_grid = (dateline_bundle.get("telemetry") or {}).get("materializeSourceGrid") or {}
    check(dateline_materialize.status_code == 200 and dateline_bundle.get("coverage", {}).get("bbox", {}).get("crossesAntimeridian") is True,
          "materialize endpoint completes for Fiji/South-Pacific antimeridian bbox")
    check(source_grid.get("sourceResolutionAdjusted") is True and
          source_grid.get("sourcePointsPerLayer", 999999) <= source_grid.get("sourcePointBudget", 0),
          "wide materialize jobs coarsen provider source grids before fan-out")
    dateline_coords = app._tile_coords_for_bbox(1, 160.0, -35.0, -150.0, 5.0)
    dateline_xs = {x for (_z, x, _y) in dateline_coords}
    check(0 in dateline_xs and 1 in dateline_xs,
          "antimeridian materialize plans tiles on both sides of 180")
    east_tile = next((item for item in sorted(dateline_coords) if item[1] == 0), None)
    west_tile = next((item for item in sorted(dateline_coords) if item[1] == 1), None)
    east_resp = client.get(
        f"/bundles/open-meteo/latest/dateline-test/layers/wind/scalar/latest/{east_tile[0]}/{east_tile[1]}/{east_tile[2]}.png"
    ) if east_tile else None
    west_resp = client.get(
        f"/bundles/open-meteo/latest/dateline-test/layers/wind/scalar/latest/{west_tile[0]}/{west_tile[1]}/{west_tile[2]}.png"
    ) if west_tile else None
    check(east_resp is not None and east_resp.status_code == 200 and
          east_resp.headers.get("x-helm-upstream-fetch") == "0",
          "prepared tile east of 180 replays from cache")
    check(west_resp is not None and west_resp.status_code == 200 and
          west_resp.headers.get("x-helm-bundle-cache") == "hit",
          "prepared tile west of 180 replays from cache")

    # 8) NODATA honesty: a grid that samples None must emit a transparent pixel, never a fake value
    empty = app.Grid(2, 2, 0, 0, 1, 1, [None, None, None, None])
    check(empty.sample(0.5, 0.5) is None, "fully-missing grid samples to None (NODATA, not faked)")

    print("\nHELM-WX TESTS: " + ("all passed" if not fails else ("%d FAILED" % fails)))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
