"""Offline wiring test for the live vision judge.

Stubs the Anthropic client so we can prove — without an API key or the SDK —
that LiveModel.judge builds a correct request (model id, structured-output
schema, base64 vision block, per-symbol checklist) and parses the typed Verdict
back. This is what makes "wire the live judge" verifiable here; the real model
call is a transport swap on top of this validated plumbing.

Run:  python -m forge.tests.test_live_judge_wiring
"""
from __future__ import annotations

import base64
import json
from pathlib import Path

from ..schema import SymbolSpec, StylePack
from ..model import LiveModel

ROOT = Path(__file__).resolve().parent.parent.parent


class _Block:
    def __init__(self, text):
        self.type, self.text = "text", text


class _Resp:
    def __init__(self, text):
        self.content = [_Block(text)]


class _Messages:
    def __init__(self, outer):
        self.outer = outer

    def create(self, **kw):
        self.outer.captured = kw
        return _Resp(self.outer.canned)


class StubClient:
    def __init__(self, canned):
        self.canned, self.captured = canned, None
        self.messages = _Messages(self)


def main():
    spec = SymbolSpec.from_dict(json.loads(
        (ROOT / "catalog" / "BOYCAR_north.json").read_text()))
    style = StylePack.from_dict(json.loads(
        (ROOT / "stylepacks" / "us-paper.json").read_text()))

    canned = json.dumps({
        "criteria": [{"name": "topmark_correct", "passed": False,
                      "reason": "cones point down — reads as south cardinal"}],
        "overall_pass": False, "confidence": 0.92, "sibling_pick": "BOYCAR_south"})
    client = StubClient(canned)
    live = LiveModel(client=client)

    png = b"\x89PNG\r\n\x1a\nFAKEPNGBYTES"
    verdict = live.judge(spec, style, png)

    # response parsing
    assert verdict.overall_pass is False, "parsed overall_pass"
    assert verdict.sibling_pick == "BOYCAR_south", "parsed sibling_pick"
    assert verdict.criteria[0].name == "topmark_correct", "parsed criteria"

    # request building
    kw = client.captured
    assert kw["model"] == "claude-opus-4-8", "model id"
    assert kw["output_config"]["format"]["type"] == "json_schema", "structured output"
    schema = kw["output_config"]["format"]["schema"]
    assert schema["additionalProperties"] is False, "strict schema"
    assert set(schema["required"]) >= {"criteria", "overall_pass", "sibling_pick"}, "schema fields"

    content = kw["messages"][0]["content"]
    img = next(b for b in content if b.get("type") == "image")
    assert img["source"]["type"] == "base64", "vision block is base64"
    assert img["source"]["media_type"] == "image/png", "media type"
    assert base64.b64decode(img["source"]["data"]) == png, "image round-trips"
    text = next(b["text"] for b in content if b.get("type") == "text")
    assert "topmark is exactly: two_cones_point_up" in text, "checklist carries the invariant"
    assert "BOYCAR_south" in text, "sibling forced-choice list present"

    print("live-judge wiring: OK  (request built + verdict parsed; transport swap only)")


if __name__ == "__main__":
    main()
