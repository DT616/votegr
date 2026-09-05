#!/usr/bin/env python3
"""Fetch the drivable road network for Grand Rapids from OpenStreetMap.

An alternative build input to refresh_centerlines.py. OSM carries two things
the city's own centerline layer does not: turn restrictions (no-left-turn and
friends, as relations) and a network that exists everywhere, so the same
pipeline works for any city rather than only where an Act 51 agency publishes
direction attributes.

Fetched once at build time. Nothing here runs in a browser.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

# Paths are anchored to the repository root, one level up from this
# file, since these scripts live in scripts/ and write into site/data.
ROOT = Path(__file__).resolve().parent.parent
BOUNDARY = ROOT / "site" / "data" / "boundary.json"
OUT = ROOT / "build" / "osm_roads.json"

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
UA = "vote-gr/1.0 (+https://github.com/DT616/votegr)"

# Everything a car may legally drive on. `service` is included because
# driveways and parking aisles connect real addresses to the street, but it is
# down-weighted later at graph build time.
DRIVABLE = ("motorway|trunk|primary|secondary|tertiary|unclassified|residential|"
            "living_street|service|motorway_link|trunk_link|primary_link|"
            "secondary_link|tertiary_link|road")

MIN_WAYS = 3000


def bbox_from_boundary():
    b = json.loads(BOUNDARY.read_text())
    lats, lngs = [], []
    for ring in b["rings"]:
        for p in ring:
            lngs.append(p[0]); lats.append(p[1])
    pad = 0.004
    return (min(lats) - pad, min(lngs) - pad, max(lats) + pad, max(lngs) + pad)


def query(ql):
    last = None
    for ep in ENDPOINTS:
        try:
            print(f"  trying {ep} ...")
            data = ("data=" + urllib.parse.quote(ql)).encode("utf-8")
            req = urllib.request.Request(
                ep, data=data,
                headers={"User-Agent": UA,
                         "Content-Type": "application/x-www-form-urlencoded"})
            with urllib.request.urlopen(req, timeout=300) as r:
                j = json.loads(r.read().decode("utf-8"))
            if "remark" in j and ("timed out" in j["remark"].lower()
                                  or "truncated" in j["remark"].lower()):
                print(f"    truncated: {j['remark']!r}")
                last = None
                time.sleep(3)
                continue
            return j
        except Exception as e:  # noqa: BLE001
            print(f"    failed: {e}")
            last = e
            time.sleep(3)
    raise SystemExit(f"REFUSE: no complete Overpass result ({last})")


def main():
    OUT.parent.mkdir(exist_ok=True)
    bb = bbox_from_boundary()
    bbs = ",".join(f"{v:.5f}" for v in bb)
    print(f"bbox {bbs}")

    print("fetching ways ...")
    ways = query(f'[out:json][timeout:280];'
                 f'(way["highway"~"^({DRIVABLE})$"]({bbs}););'
                 f'out geom tags;')
    w = [e for e in ways.get("elements", []) if e.get("type") == "way"]
    print(f"  {len(w)} ways")
    if len(w) < MIN_WAYS:
        sys.exit(f"REFUSE: only {len(w)} ways (< {MIN_WAYS})")

    time.sleep(3)
    print("fetching turn restrictions ...")
    res = query(f'[out:json][timeout:280];'
                f'(relation["type"="restriction"]({bbs}););'
                f'out body;')
    rels = [e for e in res.get("elements", []) if e.get("type") == "relation"]
    print(f"  {len(rels)} restriction relations")

    slim_ways = []
    for e in w:
        t = e.get("tags", {})
        slim_ways.append({
            "id": e["id"],
            "nodes": e.get("nodes") or [],
            "geom": [[round(g["lat"], 6), round(g["lon"], 6)]
                     for g in (e.get("geometry") or [])],
            "highway": t.get("highway"),
            "name": t.get("name") or t.get("ref") or "",
            "oneway": t.get("oneway"),
            "junction": t.get("junction"),
            "maxspeed": t.get("maxspeed"),
            "access": t.get("access"),
            "service": t.get("service"),
        })

    slim_rels = []
    for r in rels:
        t = r.get("tags", {})
        slim_rels.append({
            "id": r["id"],
            "restriction": t.get("restriction") or t.get("restriction:motorcar"),
            "members": [{"type": m.get("type"), "ref": m.get("ref"),
                         "role": m.get("role")} for m in (r.get("members") or [])],
        })

    OUT.write_text(json.dumps({"ways": slim_ways, "restrictions": slim_rels},
                              separators=(",", ":")))
    print(f"wrote {len(slim_ways)} ways + {len(slim_rels)} restrictions -> {OUT} "
          f"({OUT.stat().st_size/1048576:.1f} MB)")


if __name__ == "__main__":
    main()
