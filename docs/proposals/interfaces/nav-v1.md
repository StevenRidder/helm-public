# Interface: Nav State, Commands, And Alarms v1

Schema family: `helm.nav.*.v1`  
Producer: `helm-navd`  
Consumers: gateway, web/native clients, tests  
Current code anchor: `helm-server.cpp` `/nav`, commands, AIS, alarms; OpenCPN `model/`

## Purpose

Expose navigation state, route state, AIS targets, tracks, and alarm state as a reliable stream.

## Owns

- Position/source freshness.
- Route activation and active-leg progress.
- XTE/ETA/DTG computations.
- Track capture state.
- AIS decode and risk classification.
- Alarm raise/clear/ack state.
- Staleness truth.

## Does Not Own

- Chart portrayal.
- Weather truth.
- UI styling.
- Autopilot actuation.
- Advisory/AI recommendations.

## WebSocket Endpoint

```text
WS /nav
```

Client hello:

```json
{
  "schema": "helm.nav.hello.v1",
  "lastSeq": 1042,
  "subscribe": ["nav", "route", "ais", "alarms"],
  "rates": {"nav": 2},
  "viewport": {"bbox": [-81.85, 24.43, -81.76, 24.57], "z": 13}
}
```

Snapshot:

```json
{
  "schema": "helm.nav.snapshot.v1",
  "t": "snapshot",
  "seq": 1043,
  "time": "2026-07-01T00:00:00Z",
  "source": {"kind": "nmea0183", "id": "local-relay", "status": "ok"},
  "nav": {
    "pos": {"lat": 24.4587, "lon": -81.8078},
    "sogKt": 6.1,
    "cogDeg": 15.0,
    "hdgDeg": 14.0,
    "depthM": 13.2,
    "status": "ok",
    "ageSeconds": 0.4
  },
  "route": {
    "active": true,
    "name": "Route to Marina",
    "nextWp": "WP2",
    "dtgNm": 6.1,
    "xteM": 0.0,
    "eta": "2026-07-01T23:43:00Z"
  },
  "alarms": []
}
```

Delta:

```json
{
  "schema": "helm.nav.delta.v1",
  "t": "delta",
  "seq": 1044,
  "time": "2026-07-01T00:00:01Z",
  "nav": {
    "pos": {"lat": 24.4589, "lon": -81.8077},
    "sogKt": 6.0,
    "cogDeg": 16.0
  }
}
```

Alarm:

```json
{
  "schema": "helm.nav.alarm.v1",
  "t": "alarm",
  "id": "a-9912",
  "kind": "anchor-drag",
  "severity": "critical",
  "seq": 1101,
  "time": "2026-07-01T00:10:00Z",
  "message": "Dragging - 38 m from set point",
  "needsAck": true,
  "data": {
    "radiusM": 30,
    "distanceM": 38
  }
}
```

Command example:

```json
{
  "schema": "helm.nav.command.v1",
  "command": "route.activate",
  "id": "route-123"
}
```

## Reliability Rules

- Snapshot on every connect.
- Deltas carry monotonically increasing `seq`.
- Alarms persist until acknowledged or cleared.
- Slow clients get latest-wins nav deltas, not queued stale positions.
- `stale` must be visible; frozen live-looking ownship is forbidden.

