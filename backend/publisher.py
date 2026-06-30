"""
Helm backend — give-back publishers (the outbound, sanctioned direction).

Two targets, both honest about being mock-first in the public-alpha prototype:

- NFLPublisher: pushes the user's OWN position/track to NoForeignLand using the user's own
  boat key (Helm -> NFL only). Runs in MOCK mode unless NFL_BOAT_KEY + NFL_PUSH_ENABLED are
  set, in which case it would POST in the signalk-to-nfl pattern (endpoint left as a TODO to
  fill from that plugin — we do not guess it here). Offline -> queue -> flush on reconnect.

- OSMNotes: the low-risk Tier-1 give-back. Drops a Note at a location (a suggestion a human
  OSM editor acts on; no edit privileges, no vandalism risk). Scaffolds without posting unless
  OSM_NOTES_ENABLED is set.

Nothing here stores a credential beyond the user's own env-provided key; nothing is committed.
"""
import os
import time

QUEUE = []  # in-memory outbound queue for the prototype


class NFLPublisher:
    def __init__(self):
        self.key = os.environ.get("NFL_BOAT_KEY", "").strip()
        self.enabled = os.environ.get("NFL_PUSH_ENABLED", "false").lower() == "true"
        self.mode = "live" if (self.key and self.enabled) else "mock"
        self.last = None

    def push(self, lat, lon, sog=None, cog=None):
        item = {"target": "nfl", "lat": lat, "lon": lon, "sog": sog, "cog": cog,
                "ts": int(time.time()), "mode": self.mode, "status": "queued"}
        if self.mode == "mock":
            item["status"] = "sent-mock"  # prove the publisher + queue without hitting NFL
            self.last = item
            return item
        # LIVE: replicate the signalk-to-nfl POST here once the endpoint/payload is confirmed.
        # Until then, queue it so nothing is silently dropped.
        QUEUE.append(item)
        self.last = item
        return item

    def status(self):
        return {"mode": self.mode, "enabled": self.enabled, "hasKey": bool(self.key),
                "last": self.last, "queued": len([q for q in QUEUE if q["status"] == "queued"])}


class OSMNotes:
    def __init__(self):
        self.enabled = os.environ.get("OSM_NOTES_ENABLED", "false").lower() == "true"
        self.mode = "live" if self.enabled else "scaffold"

    def create_note(self, lat, lon, text):
        item = {"target": "osm-note", "lat": lat, "lon": lon, "text": text,
                "ts": int(time.time()), "mode": self.mode}
        if self.mode == "scaffold":
            item["status"] = "would-create"  # show the user exactly what we'd post
            return item
        # LIVE (Tier 1): POST https://api.openstreetmap.org/api/0.6/notes?lat=&lon=&text=
        # (app-authenticated). ODbL attribution; gentle rate limits. Implement on go-live.
        item["status"] = "queued"
        QUEUE.append(item)
        return item

    def status(self):
        return {"mode": self.mode, "enabled": self.enabled}
