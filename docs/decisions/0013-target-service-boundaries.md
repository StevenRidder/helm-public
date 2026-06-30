# 0013: Define Target Service Boundaries Before Interface RFCs

Date: 2026-07-01

Status: Proposed

## Context

Helm already has several runtime and tooling surfaces: the one-origin C++
`helm-server`, C++ package/cache services, browser clients, data pipelines, and
renderer proof code. That can look like a mixed source tree unless the intended
C++ runtime ownership boundaries are made explicit.

The target architecture should be grounded in the public OpenCPN repository, not
only in Helm's current vendored or transitional code. The relevant public
OpenCPN seams are `model/`, `gui/include/gui`, `s57`, `data/s57data`,
`include/ocpn_plugin.h`, and `cli`.

The current public runnable path remains the C++ `helm-server` plus browser
client. The service architecture is a target shape, not a claim that every box is
already a production daemon.

## Decision

Document a broad C++ target service architecture first, then define interface
contracts for the boundaries between those services.

The target service proposal lives at
[../proposals/TARGET-SERVICE-ARCHITECTURE.md](../proposals/TARGET-SERVICE-ARCHITECTURE.md).

## Rules

- Required boat-runtime services should be C++/CMake/OpenCPN-native where
  practical.
- A boundary may start as a C++ module before it becomes a separate daemon.
- The browser/WebGPU client consumes contracts; it does not own chart semantics.
- Official chart portrayal remains in the chart/presentation layer.

## Consequences

The public repo can expose the target architecture without pretending the current
tree is already cleanly buildable on every platform. Contributors can review the
direction, propose contract improvements, and help extract seams one at a time.
