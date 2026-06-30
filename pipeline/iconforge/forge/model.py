"""Model adapter (FORGE-4 compose / FORGE-6 judge).

Two backends behind one interface:

  LiveModel    — real `claude-opus-4-8` calls (production path), coded per the
                 Claude API: structured outputs for typed results, vision image
                 blocks for the judge. Used when ANTHROPIC_API_KEY is present.

  FixtureModel — reads recorded model output from fixtures/. This is how the
                 POC runs offline. The recordings are genuine claude-opus-4-8
                 output (the same model the pipeline specifies), stored rather
                 than fetched over HTTP.

The deterministic stages (render, structural checks, atlas) never touch this —
they run for real regardless of backend.
"""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

from .schema import SymbolSpec, StylePack, Verdict, Criterion

PROMPT_VERSION = "forge-compose-v1"

COMPOSE_SYSTEM = (
    "You draw IHO S-52 / U.S. Chart No.1 nautical symbols as SVG. A symbol's "
    "MEANING is load-bearing: the colours, topmark shape and orientation, and "
    "the distinguishing geometry in INVARIANTS must be reproduced exactly — a "
    "wrong colour or a flipped topmark is a navigation hazard. Vary only the "
    "non-semantic look per the STYLE tokens. Use a 64x64 viewBox, colours as "
    "var(--token) CSS variables (never literal hex), no <text>, and set the "
    "anchor to the pivot in INVARIANTS. Return SVG markup and the anchor."
)


def input_hash(spec: SymbolSpec, style: StylePack) -> str:
    blob = json.dumps([spec.id, spec.__dict__.get("meaning"),
                       spec.invariants.__dict__, style.__dict__],
                      sort_keys=True, default=str).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


class FixtureModel:
    """Recorded claude-opus-4-8 output, replayed deterministically."""

    def __init__(self, fixtures_dir: str | Path):
        self.dir = Path(fixtures_dir)
        self.source = "fixture:claude-opus-4-8"

    def compose(self, spec: SymbolSpec, style: StylePack, variant: str = "") -> tuple[str, tuple[float, float]]:
        name = spec.id + (f"__{variant}" if variant else "")
        svg = (self.dir / "compose" / style.id / f"{name}.svg").read_text()
        return svg, spec.invariants.anchor

    def judge(self, spec: SymbolSpec, style: StylePack, variant: str = "") -> Verdict:
        name = spec.id + (f"__{variant}" if variant else "")
        d = json.loads((self.dir / "verdicts" / style.id / f"{name}.json").read_text())
        return Verdict.from_dict(d)


class LiveModel:
    """Production path — real Claude calls. Not exercised in the offline POC."""

    def __init__(self, model: str = "claude-opus-4-8", client=None):
        if client is None:
            import anthropic  # lazy: only needed on the live path
            client = anthropic.Anthropic()
        self.client = client          # injectable for offline wiring tests
        self.model = model
        self.source = f"live:{model}"

    def compose(self, spec: SymbolSpec, style: StylePack, variant: str = "") -> tuple[str, tuple[float, float]]:
        system = [
            {"type": "text", "text": COMPOSE_SYSTEM},
            {"type": "text", "text": f"STYLE: {json.dumps(style.__dict__)}",
             "cache_control": {"type": "ephemeral"}},  # cache the per-style prefix
        ]
        schema = {
            "type": "object", "additionalProperties": False,
            "properties": {"svg": {"type": "string"},
                           "anchor": {"type": "array", "items": {"type": "number"}}},
            "required": ["svg", "anchor"],
        }
        r = self.client.messages.create(
            model=self.model, max_tokens=4000, system=system,
            output_config={"format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content":
                       f"Compose '{spec.id}' ({spec.meaning}). "
                       f"INVARIANTS: {json.dumps(spec.invariants.__dict__)}"}],
        )
        out = json.loads(next(b.text for b in r.content if b.type == "text"))
        return out["svg"], tuple(out["anchor"])

    def judge(self, spec: SymbolSpec, style: StylePack, render_png: bytes,
              ref_png: bytes | None = None) -> Verdict:
        checklist = _checklist(spec)
        content = [{"type": "image", "source": {"type": "base64",
                    "media_type": "image/png",
                    "data": base64.standard_b64encode(render_png).decode()}}]
        if ref_png:
            content.append({"type": "image", "source": {"type": "base64",
                            "media_type": "image/png",
                            "data": base64.standard_b64encode(ref_png).decode()}})
        content.append({"type": "text", "text":
            "Check the candidate (first image) against EACH criterion; report "
            f"pass/fail with a reason. Be strict.\n{checklist}\n"
            f"Then say which of these it actually is: {[spec.id] + spec.siblings}"})
        schema = {
            "type": "object", "additionalProperties": False,
            "properties": {
                "criteria": {"type": "array", "items": {
                    "type": "object", "additionalProperties": False,
                    "properties": {"name": {"type": "string"},
                                   "passed": {"type": "boolean"},
                                   "reason": {"type": "string"}},
                    "required": ["name", "passed", "reason"]}},
                "overall_pass": {"type": "boolean"},
                "confidence": {"type": "number"},
                "sibling_pick": {"type": "string"}},
            "required": ["criteria", "overall_pass", "confidence", "sibling_pick"],
        }
        r = self.client.messages.create(
            model=self.model, max_tokens=1500,
            output_config={"format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content": content}])
        return Verdict.from_dict(json.loads(
            next(b.text for b in r.content if b.type == "text")))


def _checklist(spec: SymbolSpec) -> str:
    inv = spec.invariants
    items = [f"- colours present: {', '.join(inv.colors)} (and no wrong lateral colour)"]
    if inv.topmark:
        items.append(f"- topmark is exactly: {inv.topmark}")
    items.append(f"- light flare present: {inv.light_flare}")
    items.append(f"- distinguishing feature: {inv.distinguishing}")
    return "\n".join(items)
