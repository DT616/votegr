#!/usr/bin/env python3
"""Fetch water, parks and railways for Grand Rapids from OpenStreetMap.

These are what separate a street diagram from something that reads as a map.
The Grand River runs straight through the middle of the city and is how most
people orient themselves; without it every intersection looks alike.

Build-time only, like every other refresh script here: the output is a static
file the browser already holds, so drawing the basemap costs no requests.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from provenance import provenance

# Paths are anchored to the repository root, one level up from this
# file, since these scripts live in scripts/ and write into site/data.
ROOT = Path(__file__).resolve().parent.parent
BOUNDARY = ROOT / "site" / "data" / "boundary.json"
OUT = ROOT / "site" / "data" / "landcover.json"
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
UA = "vote-gr/1.0 (+https://github.com/DT616/votegr)"
SIMPLIFY_DEG = 0.00004      # ~4m; a basemap needs no more than that


def bbox():
    b = json.loads(BOUNDARY.read_text())
    lats, lngs = [], []
    for ring in b["rings"]:
        for p in ring:
            lngs.append(p[0]); lats.append(p[1])
    pad = 0.02
    return (min(lats)-pad, min(lngs)-pad, max(lats)+pad, max(lngs)+pad)


def query(ql):
    for ep in ENDPOINTS:
        try:
            print(f"  trying {ep} ...")
            data = ("data=" + urllib.parse.quote(ql)).encode()
            req = urllib.request.Request(ep, data=data, headers={
                "User-Agent": UA,
                "Content-Type": "application/x-www-form-urlencoded"})
            with urllib.request.urlopen(req, timeout=240) as r:
                j = json.loads(r.read().decode())
            if "remark" in j and "timed out" in j["remark"].lower():
                time.sleep(3); continue
            return j
        except Exception as e:  # noqa: BLE001
            print(f"    failed: {e}")
            time.sleep(3)
    raise SystemExit("REFUSE: no complete Overpass result")


def simplify(pts):
    """Drop points closer than the tolerance; keep the first and last."""
    if len(pts) < 3:
        return pts
    out = [pts[0]]
    for p in pts[1:-1]:
        if (abs(p[0]-out[-1][0]) > SIMPLIFY_DEG or
                abs(p[1]-out[-1][1]) > SIMPLIFY_DEG):
            out.append(p)
    out.append(pts[-1])
    return out


def rings_from(el):
    g = el.get("geometry") or []
    pts = [[round(p["lat"], 5), round(p["lon"], 5)] for p in g]
    return simplify(pts) if len(pts) >= 3 else None


def main():
    bb = ",".join(f"{v:.5f}" for v in bbox())
    print(f"bbox {bb}")

    print("water ...")
    water = query(f'[out:json][timeout:230];('
                  f'way["natural"="water"]({bb});'
                  f'way["waterway"="riverbank"]({bb});'
                  f'relation["natural"="water"]({bb});'
                  f');out geom;')
    print("waterways ...")
    time.sleep(3)
    lines = query(f'[out:json][timeout:230];('
                  f'way["waterway"~"^(river|stream|canal)$"]({bb});'
                  f');out geom;')
    print("green space ...")
    time.sleep(3)
    green = query(f'[out:json][timeout:230];('
                  f'way["leisure"~"^(park|golf_course|nature_reserve)$"]({bb});'
                  f'way["landuse"~"^(forest|grass|recreation_ground|cemetery)$"]({bb});'
                  f'way["natural"="wood"]({bb});'
                  f');out geom;')
    print("rail ...")
    time.sleep(3)
    rail = query(f'[out:json][timeout:230];('
                 f'way["railway"~"^(rail|light_rail)$"]({bb});'
                 f');out geom;')

    def collect(res, want_closed):
        out = []
        for el in res.get("elements", []):
            r = rings_from(el)
            if not r:
                continue
            if want_closed and len(r) < 4:
                continue
            out.append(r)
        return out

    payload = {
        "meta": {"source": "OpenStreetMap (ODbL)", "bbox": bbox()},
        "provenance": provenance(
            source="OpenStreetMap, queried through Overpass for water, "
                   "waterways, green space and railways.",
            source_url=ENDPOINTS[0],
            licence="OpenStreetMap contributors, ODbL. Derived data must credit OSM.",
            made_by="refresh_landcover.py",
            how_to_update="Run refresh_boundary.py first: the bounding box is "
                          "read from boundary.json. Then refresh_landcover.py.",
            endpoint_fallbacks=ENDPOINTS[1:],
            simplified_degrees=SIMPLIFY_DEG),
        "water": collect(water, True),
        "waterways": collect(lines, False),
        "green": collect(green, True),
        "rail": collect(rail, False),
    }
    counts = {k: len(v) for k, v in payload.items() if isinstance(v, list)}
    if not payload["water"] and not payload["green"]:
        sys.exit("REFUSE: no water or green space returned")
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"wrote {counts} -> {OUT} ({OUT.stat().st_size/1048576:.2f} MB)")


if __name__ == "__main__":
    main()
