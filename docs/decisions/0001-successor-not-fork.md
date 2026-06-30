# ADR-0001 — Build a successor, not a fork of OpenCPN

- **Status:** Accepted
- **Date:** 2026-06-23

## Context

The goal is OpenCPN's full capability, modernized, native on macOS + iPad + iPhone, with
new integrations (fused weather, on-demand charts, routing import). "Modernize OpenCPN"
could mean: (1) contribute upstream, (2) fork the C++/wxWidgets codebase, or (3) build a
fresh successor that carries the feature set forward.

## Decision

Build **Helm as a successor** — a shared C++ nav core under native Apple UIs — reusing
OpenCPN's chart engine only where licensing allows (and only on macOS at first).

## Why not the others

- **Contribute upstream:** locked to wxWidgets desktop, no iOS path, slow governance,
  can't restyle a mature project freely.
- **Fork:** inherits the chart engine + plugins but still desktop-only, drags 20 years of
  wxWidgets legacy onto a touchscreen, and GPL contaminates a possible future commercial
  version.

## Consequences

- We are **not** modernizing OpenCPN's code; we're building its modern successor and
  borrowing its engine where clean to do so.
- iOS/iPadOS are clean re-implementations (a port is impossible — wxWidgets/GPL/serial).
- Forces the ENC-engine and license decisions ([ADR-0002](0002-enc-engine.md), [LEGAL](../LEGAL.md)).
- Most upfront work, but the only path that reaches the phone natively.
