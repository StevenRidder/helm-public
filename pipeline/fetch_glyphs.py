#!/usr/bin/env python3
"""
fetch_glyphs.py — bake LOCAL map-label glyphs (offline-first).

MapLibre fetches label glyphs as per-range .pbf files. Out of the box the style
points at demotiles.maplibre.org (a CDN) — so labels vanish on a boat with no
internet. We download the Latin + punctuation ranges ONCE at build time into
web/fonts/{fontstack}/{range}.pbf and the style reads them locally.

Only the ranges Latin place-names / depth numbers actually use are vendored
(~250 KB). If a label needs an un-vendored range offline it simply doesn't draw
that glyph — non-fatal.
"""
import os, sys, urllib.parse, urllib.request

FONTSTACKS = ["Noto Sans Regular"]
RANGES = ["0-255", "256-511", "512-767", "8192-8447"]   # Latin-1, Latin-Ext-A, General Punctuation
SRC = "https://demotiles.maplibre.org/font/{stack}/{rng}.pbf"
OUT = os.path.join(os.path.dirname(__file__), "..", "web", "fonts")


def main():
    got = failed = 0
    for stack in FONTSTACKS:
        d = os.path.join(OUT, stack)
        os.makedirs(d, exist_ok=True)
        for rng in RANGES:
            dst = os.path.join(d, f"{rng}.pbf")
            url = SRC.format(stack=urllib.parse.quote(stack), rng=rng)
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "helm-pipeline/1.0"})
                with urllib.request.urlopen(req, timeout=20) as r:
                    data = r.read()
                with open(dst, "wb") as f:
                    f.write(data)
                got += 1
            except Exception as e:
                print(f"  ! {stack}/{rng}: {e}", file=sys.stderr); failed += 1
    print(f"glyphs done: {got} fetched, {failed} failed  ->  web/fonts/")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
