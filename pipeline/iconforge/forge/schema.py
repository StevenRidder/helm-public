"""Presentation Asset Pack schemas (FORGE-1).

Durable, reviewable truth for the icon-generation pipeline. Dataclasses +
plain JSON so the pack stays diffable and dependency-light. The live API path
(forge/model.py LiveModel) mirrors these as structured-output schemas.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path


@dataclass
class Invariants:
    """The semantic axis — machine-checked, never invented by the model."""
    colors: list[str]            # load-bearing colour tokens, e.g. ["black","yellow"]
    topmark: str | None          # "two_cones_point_up" | "single_sphere" | None
    light_flare: bool            # is a magenta light flare present
    shape_class: str             # "buoy" | "beacon" | "area_pattern" | "wreck"
    distinguishing: str          # prose: what separates this from its siblings
    anchor: tuple[float, float]  # pivot in unit space (0..1, 0..1)


@dataclass
class SymbolSpec:
    id: str
    s52_token: str | None
    name: str
    category: str
    meaning: str                 # plain language, from U.S. Chart No.1
    invariants: Invariants
    reference: str | None        # path to a reference crop (optional in POC)
    siblings: list[str] = field(default_factory=list)
    source_refs: dict | None = None
    geometry: dict | None = None

    @staticmethod
    def from_dict(d: dict) -> "SymbolSpec":
        inv = dict(d["invariants"])
        inv["anchor"] = tuple(inv["anchor"])
        return SymbolSpec(
            id=d["id"], s52_token=d.get("s52_token"), name=d["name"],
            category=d["category"], meaning=d["meaning"],
            invariants=Invariants(**inv), reference=d.get("reference"),
            siblings=d.get("siblings", []), source_refs=d.get("source_refs"),
            geometry=d.get("geometry"),
        )


@dataclass
class StylePack:
    id: str
    stroke_width: float
    corner_radius: float
    fill_mode: str               # "filled" | "outline" | "duotone"
    line_treatment: str          # "crisp" | "engraved" | "soft"
    shadow: bool
    palettes: dict               # {"day": {token: hex}, "dusk": {...}, "night": {...}}

    @staticmethod
    def from_dict(d: dict) -> "StylePack":
        return StylePack(**d)


@dataclass
class Criterion:
    name: str
    passed: bool
    reason: str


@dataclass
class Verdict:
    criteria: list[Criterion]
    overall_pass: bool
    confidence: float
    sibling_pick: str | None = None   # forced-choice identity from the sibling test

    @staticmethod
    def from_dict(d: dict) -> "Verdict":
        return Verdict(
            criteria=[Criterion(**c) for c in d["criteria"]],
            overall_pass=d["overall_pass"], confidence=d["confidence"],
            sibling_pick=d.get("sibling_pick"),
        )


@dataclass
class Provenance:
    catalog_id: str
    style: str
    source: str                  # "fixture:claude-opus-4-8" or "live:claude-opus-4-8"
    input_hash: str
    prompt_version: str
    human_approved: bool = False


def load_json(p: str | Path) -> dict:
    return json.loads(Path(p).read_text())


def dump(obj) -> dict:
    return asdict(obj)
