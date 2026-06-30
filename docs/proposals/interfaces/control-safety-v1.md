# Interface: Control Safety Boundary v1

Schema family: `helm.control.*.v1`  
Producer: future `helm-controld`  
Consumers: nav service, clients, audit tools  
Status: future boundary, not current implementation

## Purpose

Keep vessel actuation separate from display, route planning, AI, and chart rendering.

## Owns

- Explicit skipper approval.
- Output interlocks.
- Command audit log.
- Hardware adapter status.
- Control-mode state.

## Does Not Own

- Route planning by itself.
- AI recommendations.
- Chart portrayal.
- UI-only preview paths.

## Command Proposal

Schema: `helm.control.proposal.v1`

```json
{
  "schema": "helm.control.proposal.v1",
  "id": "proposal-001",
  "source": "helm-navd",
  "kind": "autopilot-course",
  "summary": "Steer to active leg bearing 042",
  "requiresApproval": true,
  "interlocks": [
    {"id": "manual-enable", "status": "ok"},
    {"id": "fresh-nav", "status": "ok"}
  ]
}
```

## Approval

Schema: `helm.control.approval.v1`

```json
{
  "schema": "helm.control.approval.v1",
  "proposalId": "proposal-001",
  "approvedBy": "owner-token-id",
  "time": "2026-07-01T00:00:00Z"
}
```

## Failure Rules

- No implicit actuation.
- No AI-generated actuation.
- No stale navigation input may drive actuation.
- Every output command must be auditable.

