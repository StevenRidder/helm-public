# Helm Engine

The C++ boat-server layer for Helm. It reuses OpenCPN's `model/` navigation
core and S-52/S-57 renderer headlessly, then exposes a browser/mobile-friendly
HTTP/WebSocket interface.

## Current Product Path

`helm-server` is the normal runtime:

```text
GET /                         static web client from HELM_WEB_ROOT
WS  /nav                      snapshot/delta nav stream
GET /chart/{z}/{x}/{y}.png    S-52 ENC raster tiles
GET /catalog                  chart-cell catalog
GET /health                   liveness/version
POST/GET /pair                pairing/token flow
```

It is a one-origin server on `HELM_PORT` (default `8080`). In shared development
environments, use a private port such as `9001` unless you explicitly own the
stable live instance.

## Build

```bash
engine/bootstrap.sh
```

The bootstrap is the source of truth. It clones the pinned OpenCPN commit into
`~/.helm/build/helm-opencpn`, applies `engine/patches/`, overlays `engine/vendor/cli/`,
and builds the Helm targets:

```text
~/.helm/build/helm-opencpn/build/cli/helm-server
~/.helm/build/helm-opencpn/build/cli/helm-engine
~/.helm/build/helm-opencpn/build/cli/helm-tiles
~/.helm/build/helm-opencpn/build/cli/helm-tides-smoke
```

It also runs the GPL containment guard. A clean bootstrap should produce
`build/cli/helm-server`; if it does not, the checkout is behind the current
engine build posture.

## Run

```bash
scripts/install-sample-enc.sh
scripts/start-helm.sh --port 8080 --fill
```

Open `http://127.0.0.1:8080/`.

The UI loads without live data. To see movement, feed NMEA/SignalK or configure
connections. First-run config seeds a local NMEA TCP relay on `127.0.0.1:10110`:

```bash
cat engine/test/fixtures/ais_sample.nmea | nc 127.0.0.1 10110
```

## Verify

```bash
engine/test-engine.sh
```

The test starts private ports and verifies the one-origin server, nav-stream
framing, S-52 tiles, immutable tile caching, source tags, auto-advance, GPL
containment, and tide smoke coverage.

## Split-Process Debug Path

These targets still exist for lower-level debugging:

```bash
~/.helm/build/helm-opencpn/build/cli/helm-engine   # nav-only WebSocket server
~/.helm/build/helm-opencpn/build/cli/helm-tiles    # chart-tile HTTP server
```

They are not the public-alpha default. Use `helm-server` unless you are
isolating a nav-only or chart-only bug.

## Important Invariants

- OpenCPN-derived code stays in the GPL engine process.
- Browser/native clients talk through documented HTTP/WebSocket surfaces only.
- Client code must not link, embed, or port OpenCPN source expression.
- The engine never silently labels simulated/stale data as live.
- Public or paid distribution remains gated on the legal/licensing checks in
  `docs/LEGAL.md`, `docs/CLIENT-LICENSE-REGISTER.md`, `LICENSE`, and `LICENSE.BSL`.

See also: [../docs/RUNBOOK.md](../docs/RUNBOOK.md),
[VENDORING.md](VENDORING.md), and [../docs/STREAMING-API.md](../docs/STREAMING-API.md).
