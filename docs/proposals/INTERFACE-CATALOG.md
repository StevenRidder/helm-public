# Helm/OpenCPN/Vulkan Interface Catalog

Status: Draft  
Date: 2026-07-01  
Scope: service boundaries for the target microservices architecture

## Purpose

This catalog turns the target service architecture into concrete interfaces.

The goal is the same style of artifact OpenCPN maintainers can react to usefully: small contracts, clear ownership, explicit non-goals, and testable examples. These are not broad standards claims. They are implementation contracts for decoupled building blocks.

## Interface Map

| Interface | File | Producers | Consumers | Authority boundary |
|---|---|---|---|---|
| Gateway, pairing, discovery | [interfaces/gateway-v1.md](interfaces/gateway-v1.md) | `helm-gateway` | all clients, local services | Owns one-origin access, not domain semantics. |
| Nav state, commands, alarms | [interfaces/nav-v1.md](interfaces/nav-v1.md) | `helm-navd` | gateway, clients, tests | Owns route/nav/AIS/alarm state. |
| Chart service | [interfaces/chart-service-v1.md](interfaces/chart-service-v1.md) | `helm-chartd` | gateway, WebGPU/browser, debug | Owns chart portrayal execution and queries. |
| Render backend | [interfaces/render-backend-v1.md](interfaces/render-backend-v1.md) | `helm-renderd` / backend module | chart service, cache | Draw-only. Does not own chart semantics. |
| Local package service | [interfaces/package-service-v1.md](interfaces/package-service-v1.md) | `helm-packd` | gateway, clients, offline tooling | Owns local pack/catalog/prefetch contracts. |
| Environmental bundle service | [interfaces/environment-bundle-v1.md](interfaces/environment-bundle-v1.md) | `helm-envd` / `helm-wx` reference | clients, WebGPU, AI probes | Owns prepared field bundles, not weather truth. |
| Layer manifest service | [interfaces/layer-manifest-v1.md](interfaces/layer-manifest-v1.md) | `helm-layerd`, `helm-packd` | clients, debug, AI probes | Owns overlay metadata and inspection envelopes. |
| Source-to-render inspection | [interfaces/inspection-trace-v1.md](interfaces/inspection-trace-v1.md) | chart/render/cache services | debug UI, tests, agents | Owns provenance trace, not portrayal authority. |
| Symbol library manifest | [interfaces/symbol-library-v1.md](interfaces/symbol-library-v1.md) | symbol asset pipeline | chart, render, cache, UI | Owns assets/provenance, not cartography. |
| Control safety boundary | [interfaces/control-safety-v1.md](interfaces/control-safety-v1.md) | future `helm-controld` | nav, clients, audit | Owns actuation approvals and audit. |

## Cross-Cutting Contract Rules

Every interface must define:

- Version field.
- Producer.
- Consumer.
- Authority boundary.
- Required fields.
- Error and stale/offline behavior.
- Provenance fields where data originated outside the service.
- Fixture examples.
- Explicit non-goals.

## Versioning

Interface names use a stable schema name:

```text
helm.<domain>.<name>.v1
```

Examples:

```text
helm.nav.snapshot.v1
helm.chart.catalog.v1
helm.package.catalog.v1
helm.env.bundle.v1
helm.debug.trace.v1
```

Breaking changes require a new version suffix. Additive fields may be added if consumers ignore unknown fields.

## Status Values

Common status values:

- `ok`
- `not_available`
- `not_configured`
- `stale`
- `offline`
- `out_of_coverage`
- `blocked`
- `error`

Services must not hide missing data behind synthetic success.

## Authority Rule

Each interface must say what it owns and what it refuses to own. This prevents accidental cartography, accidental actuation, and accidental safety authority.
