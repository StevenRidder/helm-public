# Streaming dev runbook — local == remote

The decoupled service from [../docs/STREAMING-API.md](../docs/STREAMING-API.md), built as a
testable vertical slice. The point of this increment: the client behaves **identically**
whether the engine is on this MacBook (localhost) or on a Mac mini / Raspberry Pi across the
cabin (a LAN IP) — because there is no "local mode," only a resolved address.

## Pieces

| File | Role |
|------|------|
| [web/server-endpoint.js](../web/server-endpoint.js) | **The resolver.** One place that turns "where's the engine" into a URL. Address comes from `?server=`, then the page's own host, then `127.0.0.1`. Scheme mirrors the page (https→wss). This module *is* the local/remote transparency. |
| [web/nav-client.js](../web/nav-client.js) | Robust WS client: snapshot/delta merge, **age watchdog** (LIVE<3s / LAGGING 3–10s / STALE>10s — judged on frame age, not socket state), reconnect+resume, honest staleness (never fakes position), sim fallback. |
| [mock-engine.js](mock-engine.js) | Dependency-free stand-in for the engine's **network surface** — one origin (default `0.0.0.0:8090`): WS `/nav` (snapshot+delta @ 2 Hz + ping), `GET /chart/{z}/{x}/{y}.png` (immutable-cached stand-in tile), `/health`, `/catalog`. Lets us build + prove the client without the heavy C++ build. |
| [stream-smoke.js](stream-smoke.js) | Dependency-free contract test. |

## Run

```bash
node engine/mock-engine.js                 # one origin on 0.0.0.0:8090
node engine/stream-smoke.js                # → localhost:8090   (the "local" path)
node engine/stream-smoke.js 192.168.1.x 8090   # → LAN IP        (the "remote" path — same code)
```

Both smoke runs pass identically — that equivalence is the deliverable.

## Verify in the browser (on a machine with network for the basemap)

```bash
node engine/mock-engine.js                 # terminal 1
cd web && python3 -m http.server 5173      # terminal 2
```

- **Local:** open `http://localhost:5173` → cockpit shows **LIVE** nav from the mock; the data
  badge title shows the resolved origin (`localhost:5173`). The translucent-blue stand-in ENC
  tiles render (the real engine renders true S-52 here).
- **Remote (the proof):** from an **iPad/iPhone on the same WiFi**, open
  `http://<this-mac-LAN-ip>:5173`. Identical behavior — same code, addressed remotely. The
  resolver derives the engine host from the page host, so no config changes.
- **Staleness is honest:** kill the mock (Ctrl-C). The badge goes **LAGGING → STALE → OFFLINE**
  and the instruments grey out — it never keeps showing the last fix as if it were live.
  Restart the mock and the client reconnects and resumes on its own.
- **Override:** `http://localhost:5173/?server=192.168.1.50:8090` forces a specific engine
  (when the UI is served separately from the engine).

## What's real vs. mocked

- **Real & reusable now:** `server-endpoint.js`, `nav-client.js` — these ship as-is against the
  real engine. The client already accepts the engine's current **legacy full-frame** shape
  (a frame with no `t`) as well as snapshot/delta, so it works against today's `helm-engine`
  unchanged.
- **Mocked:** `mock-engine.js` stands in for the engine's network surface only. It is **not**
  navigation and renders no real charts.

## Real engine — now speaks this contract ✅

The real engine ([README.md](README.md)) has been taught the streaming contract (overlay edits to
`vendor/cli/helm_engine.cpp` + `helm_tiles.cpp`, no patch-series changes):

- `helm-engine` emits `snapshot`+`delta`+`seq`+`ts` (was a full blob each tick); new clients get a
  snapshot baseline, established clients get deltas. **Verified** against the real `model/` core,
  identically over localhost and a LAN IP:
  ```bash
  HELM_BIND=0.0.0.0 HELM_PORT=8091 "$HELM_OCPN_DIR/build/cli/helm-engine"
  node engine/stream-smoke.js 127.0.0.1 8091 --ws-only      # ALL PASS
  node engine/stream-smoke.js <lan-ip>  8091 --ws-only      # ALL PASS (identical)
  ```
- `helm-tiles` binds configurably and serves immutable tiles (ETag + 304). The web client points the
  `enc` source at the resolved origin.

To connect the **web UI** to the real engine in this increment (still two ports: nav 8081, tiles 8082),
load it with `?server=<host>:8081` for nav. Collapsing both onto **one TLS origin** + Bonjour + pairing
is the next step — see [../docs/STREAMING-API.md](../docs/STREAMING-API.md) §5–8.
