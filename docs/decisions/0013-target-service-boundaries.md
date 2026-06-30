# 0013: Define Target Service Boundaries Before Interface RFCs

Date: 2026-07-01

Status: Proposed

## Context

Helm already has several runtime and tooling surfaces: the one-origin C++
`helm-server`, C++ package/cache services, Python reference services, browser
clients, data pipelines, and renderer proof code. That can look like a mixed
half-Python/half-C++ codebase unless the intended ownership boundaries are made
explicit.

The current public runnable path remains the C++ `helm-server` plus browser
client. The service architecture is a target shape, not a claim that every box is
already a production daemon.

## Decision

Document a broad target service architecture first, then define interface
contracts for the boundaries between those services.

The target service proposal lives at
[../proposals/TARGET-SERVICE-ARCHITECTURE.md](../proposals/TARGET-SERVICE-ARCHITECTURE.md).

## Rules

- Required boat-runtime services should be C++/CMake/OpenCPN-native where
  practical.
- Python remains acceptable for offline tooling, reference bakers, experiments,
  and optional AI/community services.
- A boundary may start as a C++ module before it becomes a separate daemon.
- The browser/WebGPU client consumes contracts; it does not own chart semantics.
- Official chart portrayal remains in the chart/presentation layer.

## Consequences

The public repo can expose the target architecture without pretending the current
tree is already cleanly buildable on every platform. Contributors can review the
direction, propose contract improvements, and help extract seams one at a time.
