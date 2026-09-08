#!/usr/bin/env python3
"""Fetch the coordinates of every OpenStreetMap via-node the restriction
relations point at, and write build/osm_via_nodes.json.

This file had no producer. build_restrictions.py and build_graph_osm.py both
read it, the README says every data file is reproducible, and the script that
made it was not in the repository -- so a clean checkout could not rebuild the
graph's turn restrictions at all. This closes that hole.

A turn restriction is "from this way, via this node, to that way". The ways
arrive with refresh_osm_roads.py; the via NODES do not, because Overpass
returns relation members as bare ids. Their positions are what let
build_restrictions.py find the matching junction in our own graph, so they
have to be asked for separately, by id.

Usage: python3 refresh_osm_via_nodes.py   (after refresh_osm_roads.py)
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "build" / "osm_roads.json"
OUT = ROOT / "build" / "osm_via_nodes.json"

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
UA = "vote-gr/1.0 (+https://github.com/DT616/votegr)"
BATCH = 500               # node ids per query; keeps each URL sane
DELAY_S = 2.0


def via_node_ids(restrictions):
    ids = set()
    for r in restrictions:
        for m in r.get("members", []):
            if m.get("role") == "via" and m.get("type") == "node":
                ids.add(int(m["ref"]))
    return sorted(ids)


def query(ql):
    last = None
    for endpoint in ENDPOINTS:
        try:
            print(f"  trying {endpoint} ...", flush=True)
            data = ("data=" + urllib.parse.quote(ql)).encode("utf-8")
            request = urllib.request.Request(
                endpoint, data=data, headers={"User-Agent": UA})
            with urllib.request.urlopen(request, timeout=180) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as exc:                     # try the next mirror
            last = exc
            print(f"    failed: {exc}", flush=True)
    raise SystemExit(f"every Overpass endpoint failed, last: {last}")


def main():
    if not SRC.exists():
        sys.exit(f"missing {SRC}; run refresh_osm_roads.py first")
    restrictions = json.loads(SRC.read_text()).get("restrictions") or []
    ids = via_node_ids(restrictions)
    if not ids:
        sys.exit("no via nodes referenced by any restriction; nothing to do")
    print(f"{len(restrictions):,} restrictions reference {len(ids):,} via nodes")

    coords = {}
    for start in range(0, len(ids), BATCH):
        batch = ids[start:start + BATCH]
        ql = "[out:json][timeout:180];node(id:%s);out body qt;" % ",".join(map(str, batch))
        for element in query(ql).get("elements", []):
            if element.get("type") == "node" and element.get("lat") is not None:
                coords[str(element["id"])] = [round(element["lat"], 7),
                                              round(element["lon"], 7)]
        print(f"  {len(coords):,}/{len(ids):,} nodes", flush=True)
        if start + BATCH < len(ids):
            time.sleep(DELAY_S)

    # A via node that Overpass will not return is one we cannot place, and
    # build_restrictions.py already counts those as no_node. Refuse only if the
    # whole pull came back empty, which means the query shape broke.
    if not coords:
        sys.exit("REFUSING to write: no via nodes resolved")

    OUT.write_text(json.dumps(coords, separators=(",", ":")) + "\n")
    print(f"wrote {OUT} ({len(coords):,} nodes, "
          f"{OUT.stat().st_size/1024:.0f} KB); "
          f"{len(ids) - len(coords)} unresolved")


if __name__ == "__main__":
    main()
