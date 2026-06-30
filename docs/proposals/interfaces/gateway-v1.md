# Interface: Gateway, Pairing, And Discovery v1

Schema family: `helm.gateway.*.v1`  
Producer: `helm-gateway`  
Consumers: browser/native clients, local service clients, tests  
Current code anchor: `helm-server.cpp` TLS, pairing, Bonjour, static serving, auth checks

## Purpose

Provide one safe origin for clients while allowing the runtime to split into multiple local services behind it.

## Owns

- TLS termination.
- Pairing and bearer-token issuance.
- Bonjour/mDNS advertisement.
- Static client serving.
- Reverse proxy/routing to local services.
- Common `/health` aggregation.

## Does Not Own

- Chart semantics.
- Navigation decisions.
- Alarm generation.
- Weather or chart data truth.
- Autopilot actuation.

## Public Endpoints

```text
GET  /
GET  /health
GET  /services
POST /pair
WS   /nav
GET  /chart/{z}/{x}/{y}.png
GET  /query?lat={lat}&lon={lon}
GET  /catalog
GET  /layers
GET  /bundle
```

The gateway may route these to separate local services. Clients should not need to know process topology.

## `/health`

Response schema: `helm.gateway.health.v1`

```json
{
  "schema": "helm.gateway.health.v1",
  "ok": true,
  "version": "0.1.0",
  "time": "2026-07-01T00:00:00Z",
  "services": {
    "nav": {"status": "ok"},
    "chart": {"status": "ok"},
    "pack": {"status": "not_configured"},
    "env": {"status": "offline"}
  }
}
```

## `/services`

Response schema: `helm.gateway.services.v1`

```json
{
  "schema": "helm.gateway.services.v1",
  "origin": "https://helm.local",
  "services": [
    {"id": "nav", "schema": "helm.nav.v1", "path": "/nav", "required": true},
    {"id": "chart", "schema": "helm.chart.v1", "path": "/chart", "required": true},
    {"id": "pack", "schema": "helm.package.v1", "path": "/packs", "required": false}
  ]
}
```

## Pairing

Request:

```json
{
  "pin": "123456",
  "name": "iPad cockpit"
}
```

Response:

```json
{
  "schema": "helm.gateway.pairing.v1",
  "ok": true,
  "token": "opaque-token",
  "role": "owner",
  "serverFingerprint": "sha256:..."
}
```

## Failure Rules

- `/health` remains unauthenticated and tiny.
- Domain endpoints require auth when pairing is enabled.
- Gateway must not convert downstream `stale`, `offline`, or `out_of_coverage` into `ok`.

