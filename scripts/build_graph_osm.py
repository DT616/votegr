#!/usr/bin/env python3
"""Compile build/osm_roads.json into a routing graph, same shape as
build_graph.py produces from the city centerlines, plus turn restrictions.

Differences from the centerline build, and why:
  * Direction comes from OSM `oneway` (and `junction=roundabout`, which implies
    oneway), rather than the city's TRAFFIC_ALIGN.
  * Turn restrictions are carried through. The city layer has none at all, so
    this is the thing OSM buys us.
  * Topology joins on OSM node ids rather than snapped coordinates, which is
    exact rather than approximate.
"""
import json
import math
import sys
from pathlib import Path

# Paths are anchored to the repository root, one level up from this
# file, since these scripts live in scripts/ and write into site/data.
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "build" / "osm_roads.json"
BOUNDARY = ROOT / "site" / "data" / "boundary.json"
OUT = ROOT / "build" / "graph_osm.json"

# Default speeds (mph) when maxspeed is absent, by highway class.
SPEED = {
    "motorway": 70, "trunk": 55, "primary": 40, "secondary": 35,
    "tertiary": 30, "unclassified": 25, "residential": 25,
    "living_street": 15, "service": 15, "road": 25,
    "motorway_link": 45, "trunk_link": 35, "primary_link": 30,
    "secondary_link": 30, "tertiary_link": 25,
}


def hav(a, b):
    R = 6371000.0
    lat1, lon1, lat2, lon2 = map(math.radians, [a[0], a[1], b[0], b[1]])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    return 2 * R * math.asin(math.sqrt(h))


def parse_speed(v, hw):
    if v:
        try:
            return float(str(v).split()[0])
        except ValueError:
            pass
    return SPEED.get(hw, 25)


def point_in_rings(lat, lng, rings):
    inside = False
    for ring in rings:
        n = len(ring)
        j = n - 1
        for i in range(n):
            xi, yi = ring[i][0], ring[i][1]
            xj, yj = ring[j][0], ring[j][1]
            if (yi > lat) != (yj > lat) and \
               lng < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
    return inside


def main():
    data = json.loads(SRC.read_text())
    rings = json.loads(BOUNDARY.read_text())["rings"]
    ways = data["ways"]

    # Overpass `out geom` returns coordinates but not node ids, so topology is
    # keyed on the coordinate itself. OSM ways that meet at a junction share
    # the SAME node, hence identical coordinates, so this joins exactly rather
    # than approximately.
    node_ids, nodes = {}, []

    def ckey(lat, lng):
        return (round(lat, 6), round(lng, 6))

    def nid(lat, lng):
        k = ckey(lat, lng)
        if k not in node_ids:
            node_ids[k] = len(nodes)
            nodes.append([k[0], k[1]])
        return node_ids[k]

    # A coordinate touched by more than one way is a junction, and that is
    # where a way has to be split so a turn can happen there.
    use = {}
    for w in ways:
        for g in w["geom"]:
            k = ckey(g[0], g[1])
            use[k] = use.get(k, 0) + 1

    via_coords = json.loads((ROOT / "build" / "osm_via_nodes.json").read_text())

    edges = []
    way_edges = {}          # osm way id -> [edge indices], for restrictions
    skipped_outside = 0
    for w in ways:
        gs = w["geom"]
        if len(gs) < 2:
            continue
        if (w.get("access") or "") in ("private", "no"):
            continue
        # Service ways are 71% of the OSM data here and 99% of them have no
        # name: driveways, parking aisles, alleys behind houses. They triple
        # the graph, wreck the step list ("turn left onto <blank>"), and are
        # not how anyone describes a drive across town. Addresses are geocoded
        # from the centerline address ranges rather than from these, so
        # dropping them costs no coverage that matters.
        if w.get("highway") == "service":
            continue
        # Clip to the city so this is comparable with the centerline build.
        mid = gs[len(gs) // 2]
        if not point_in_rings(mid[0], mid[1], rings):
            skipped_outside += 1
            continue

        ow = (w.get("oneway") or "").lower()
        if w.get("junction") in ("roundabout", "circular") and ow not in ("no", "false", "0"):
            ow = "yes"
        direction = 1 if ow in ("yes", "true", "1") else 2 if ow == "-1" else 0

        mph = parse_speed(w.get("maxspeed"), w.get("highway"))
        name = w.get("name") or ""

        # Split the way at every junction node.
        start = 0
        for i in range(1, len(gs)):
            if i == len(gs) - 1 or use.get(ckey(gs[i][0], gs[i][1]), 0) > 1:
                seg_geom = gs[start:i+1]
                if len(seg_geom) >= 2:
                    length = sum(hav(seg_geom[k], seg_geom[k+1])
                                 for k in range(len(seg_geom)-1))
                    if length > 0:
                        a = nid(seg_geom[0][0], seg_geom[0][1])
                        b = nid(seg_geom[-1][0], seg_geom[-1][1])
                        if a != b:
                            eid = len(edges)
                            edges.append({
                                "a": a, "b": b, "d": direction,
                                "l": round(length, 1),
                                "t": round(length / (mph * 0.44704), 1),
                                "n": name,
                                "r": [None, None, None, None],
                                "z": [None, None],
                                "p": [[round(p[0], 5), round(p[1], 5)] for p in seg_geom],
                                "hw": w.get("highway"),
                            })
                            way_edges.setdefault(w["id"], []).append(eid)
                start = i

    # Turn restrictions -> (from_edge, via_node, to_edge). Only the ones whose
    # from/to ways both survived the clip are useful.
    restrictions = []
    kept_no, kept_only = 0, 0
    for r in data["restrictions"]:
        kind = (r.get("restriction") or "").lower()
        if not kind:
            continue
        frm = [m for m in r["members"] if m["role"] == "from" and m["type"] == "way"]
        to = [m for m in r["members"] if m["role"] == "to" and m["type"] == "way"]
        via = [m for m in r["members"] if m["role"] == "via"]
        if not frm or not to or not via:
            continue
        fe = way_edges.get(frm[0]["ref"])
        te = way_edges.get(to[0]["ref"])
        if not fe or not te:
            continue
        v = via[0]
        vnode = None
        if v["type"] == "node":
            c = via_coords.get(str(v["ref"]))
            if c:
                vnode = node_ids.get(ckey(c[0], c[1]))
        if vnode is None:
            continue
        restrictions.append({"from": fe, "via": vnode, "to": te,
                             "no": kind.startswith("no_")})
        if kind.startswith("no_"):
            kept_no += 1
        else:
            kept_only += 1

    payload = {
        "meta": {
            "built_from": "OpenStreetMap (ODbL)",
            "nodes": len(nodes), "edges": len(edges),
            "oneway": sum(1 for e in edges if e["d"]),
            "restrictions": len(restrictions),
            "clipped_outside_city": skipped_outside,
        },
        "nodes": nodes, "edges": edges, "restrictions": restrictions,
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"nodes={len(nodes)} edges={len(edges)} "
          f"oneway={payload['meta']['oneway']} "
          f"restrictions={len(restrictions)} (no_*={kept_no}, only_*={kept_only})")
    print(f"clipped outside city: {skipped_outside}")
    print(f"wrote {OUT} ({OUT.stat().st_size/1048576:.2f} MB raw)")


if __name__ == "__main__":
    main()
