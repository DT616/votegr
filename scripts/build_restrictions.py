#!/usr/bin/env python3
"""Attach OpenStreetMap turn restrictions to the city-centerline graph.

Run AFTER build_graph.py: it reads site/data/graph.json and writes the
restrictions back into it. Keeping them inside that one file is deliberate --
a restriction refers to edges by index, so if it lived in a separate file a
graph rebuild would silently invalidate it.

Why OSM for this and the city layer for everything else: the city centerlines
are the better source (99.8% named, address ranges per side, authoritative
posted speeds, freeways correctly modeled as one-way carriageways) but they
carry no turn restrictions at all. OSM carries them and nothing else here
beats the city data, so we take exactly the one thing that is missing.

Matching is geometric, not by id: the two datasets share no keys. For each OSM
restriction we find the city node nearest its via point, then pick the incident
city edges whose bearings at that node best match the OSM from- and to-ways.
A restriction whose geometry does not match cleanly is DROPPED rather than
guessed, because a wrong restriction silently forbids a legal turn.
"""
import json
import math
import sys
from pathlib import Path

# Paths are anchored to the repository root, one level up from this
# file, since these scripts live in scripts/ and write into site/data.
ROOT = Path(__file__).resolve().parent.parent
GRAPH = ROOT / "site" / "data" / "graph.json"
OSM = ROOT / "build" / "osm_roads.json"
VIA = ROOT / "build" / "osm_via_nodes.json"

VIA_TOL_M = 30.0        # how far a city node may sit from the OSM via node
BEARING_TOL = 40.0      # degrees of slack when matching an approach/exit
AMBIGUITY_MARGIN = 20.0 # runner-up must be at least this much worse
VIA_CANDIDATES = 6      # nearby city nodes to try before giving up


def hav(a, b):
    R = 6371000.0
    lat1, lon1, lat2, lon2 = map(math.radians, [a[0], a[1], b[0], b[1]])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    return 2 * R * math.asin(math.sqrt(h))


def bearing(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, [a[0], a[1], b[0], b[1]])
    y = math.sin(lon2 - lon1) * math.cos(lat2)
    x = math.cos(lat1)*math.sin(lat2) - math.sin(lat1)*math.cos(lat2)*math.cos(lon2-lon1)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def angdiff(a, b):
    return abs((a - b + 180) % 360 - 180)


COMPASS = {
    "N": 0, "NORTH": 0, "NE": 45, "NORTHEAST": 45,
    "E": 90, "EAST": 90, "SE": 135, "SOUTHEAST": 135,
    "S": 180, "SOUTH": 180, "SW": 225, "SOUTHWEST": 225,
    "W": 270, "WEST": 270, "NW": 315, "NORTHWEST": 315,
}

# What each MUTCD code forbids, expressed as movements.
SIGN_RULES = {
    "R3-1":  {"ban": ["right"]},
    "R3-2":  {"ban": ["left"]},
    "R3-4":  {"ban": ["uturn"]},
    "R3-18": {"ban": ["left", "right"]},
    "R3-5R": {"only": "right"},
    "R3-5L": {"only": "left"},
    "R3-5A": {"only": "through"},
}


def movement(arrive_bearing, exit_bearing):
    """Classify a turn from the bearing you arrived on to the one you leave on."""
    d = ((exit_bearing - arrive_bearing + 540) % 360) - 180
    a = abs(d)
    if a < 35:
        return "through"
    if a > 150:
        return "uturn"
    return "right" if d > 0 else "left"


def sign_restrictions(graph, nodes, edges, incident, signs, flip):
    """Turn each sign into (from_edge, via_node, to_edge) bans.

    `flip` selects how the DIRECTION column is read: False treats it as the
    direction of travel the sign governs, True as the direction the sign
    FACES (so travel is the reverse). Which one is correct is decided by
    measurement against the OSM restrictions, not by assumption -- the two
    give opposite answers and a wrong reading would forbid legal turns while
    permitting banned ones.
    """
    out, unplaced = [], 0
    for sg in signs:
        rule = SIGN_RULES.get(sg.get("code"))
        brg = COMPASS.get((sg.get("dir") or "").upper())
        if not rule or brg is None:
            unplaced += 1
            continue
        travel = (brg + 180) % 360 if flip else brg

        # The intersection this sign governs is the one AHEAD of it in the
        # direction of travel, not merely the closest node.
        best = None
        for ni, nd in enumerate(nodes):
            d = hav([sg["lat"], sg["lng"]], nd)
            if d > 60:
                continue
            to_node = bearing([sg["lat"], sg["lng"]], nd)
            if angdiff(to_node, travel) > 55:      # behind or beside the sign
                continue
            if best is None or d < best[0]:
                best = (d, ni)
        if best is None:
            unplaced += 1
            continue
        via = best[1]
        cands = incident.get(via, [])
        if len(cands) < 3:                          # not a real junction
            unplaced += 1
            continue

        # The approach is the edge you arrive on travelling that way.
        appr = min(cands, key=lambda c: angdiff(c["in"], travel))
        if angdiff(appr["in"], travel) > BEARING_TOL:
            unplaced += 1
            continue

        exits = [c for c in cands if c["edge"] != appr["edge"]]
        if not exits:
            unplaced += 1
            continue
        for ex in exits:
            mv = movement(travel, ex["out"])
            banned = (mv in rule["ban"]) if "ban" in rule else (mv != rule["only"])
            if banned:
                out.append({"f": appr["edge"], "v": via, "t": ex["edge"],
                            "no": True, "src": "sign"})
    return out, unplaced


def main():
    graph = json.loads(GRAPH.read_text())
    osm = json.loads(OSM.read_text())
    via_coords = json.loads(VIA.read_text())
    nodes, edges = graph["nodes"], graph["edges"]

    ways = {w["id"]: w for w in osm["ways"]}

    # City edges incident to each node, with the bearing of their far end as
    # seen FROM that node (i.e. which way the road leaves).
    incident = {}
    for i, e in enumerate(edges):
        for end in ("a", "b"):
            n = e[end]
            poly = e["p"] if end == "a" else list(reversed(e["p"]))
            if len(poly) < 2:
                continue
            # poly is oriented so poly[0] IS this node. "out" is the bearing
            # of leaving it; "in" is the bearing of ARRIVING at it, which is
            # the reverse of the first step -- not the bearing at the far end.
            incident.setdefault(n, []).append(
                {"edge": i, "out": bearing(poly[0], poly[1]),
                 "in": (bearing(poly[0], poly[1]) + 180) % 360})

    out, dropped = [], {"no_via": 0, "no_node": 0, "no_match": 0, "no_kind": 0}
    for r in osm["restrictions"]:
        kind = (r.get("restriction") or "").lower()
        if not kind:
            dropped["no_kind"] += 1
            continue
        frm = [m for m in r["members"] if m["role"] == "from" and m["type"] == "way"]
        to = [m for m in r["members"] if m["role"] == "to" and m["type"] == "way"]
        via = [m for m in r["members"] if m["role"] == "via" and m["type"] == "node"]
        if not (frm and to and via):
            dropped["no_via"] += 1
            continue
        vc = via_coords.get(str(via[0]["ref"]))
        fw, tw = ways.get(frm[0]["ref"]), ways.get(to[0]["ref"])
        if not vc or not fw or not tw or len(fw["geom"]) < 2 or len(tw["geom"]) < 2:
            dropped["no_via"] += 1
            continue

        # Candidate city nodes near the OSM via point, nearest first.
        #
        # Taking only the single nearest node dropped 70 of 115 in-city
        # restrictions: the two datasets split streets differently, so the
        # closest node is often a nearby vertex rather than the intersection
        # the restriction is about. Trying several and keeping whichever
        # actually resolves both the from- and to-way recovers most of them
        # without loosening the tolerances that keep bad matches out.
        near = []
        for ni, nd in enumerate(nodes):
            d = hav(vc, nd)
            if d <= VIA_TOL_M:
                near.append((d, ni))
        if not near:
            dropped["no_node"] += 1
            continue
        near.sort()
        near = near[:VIA_CANDIDATES]

        # Which end of each OSM way touches the via point, so we can take the
        # bearing of the approach into it and the exit out of it.
        def approach(way):
            g = way["geom"]
            if hav(g[0], vc) <= hav(g[-1], vc):
                return bearing(g[1], g[0]), bearing(g[0], g[1])   # via at start
            return bearing(g[-2], g[-1]), bearing(g[-1], g[-2])   # via at end
        f_in, _ = approach(fw)
        _, t_out = approach(tw)

        # Score every candidate node and keep the best clean resolution.
        chosen = None
        for _d, cand_node in near:
            cands = incident.get(cand_node, [])
            if len(cands) < 2:
                continue
            fr = sorted(cands, key=lambda c: angdiff(c["in"], f_in))
            tr = sorted(cands, key=lambda c: angdiff(c["out"], t_out))
            fe_, te_ = fr[0], tr[0]
            f_err = angdiff(fe_["in"], f_in)
            t_err = angdiff(te_["out"], t_out)
            f_amb = angdiff(fr[1]["in"], f_in) - f_err
            t_amb = angdiff(tr[1]["out"], t_out) - t_err
            if (fe_["edge"] == te_["edge"]
                    or f_err > BEARING_TOL or t_err > BEARING_TOL
                    or f_amb < AMBIGUITY_MARGIN or t_amb < AMBIGUITY_MARGIN):
                continue
            score = f_err + t_err
            if chosen is None or score < chosen[0]:
                chosen = (score, cand_node, fe_, te_)
        if chosen is None:
            dropped["no_match"] += 1
            continue
        _score, best_n, fe, te = chosen


        out.append({"f": fe["edge"], "v": best_n, "t": te["edge"],
                    "no": kind.startswith("no_")})

    # De-duplicate; several OSM relations can land on the same city turn.
    seen, uniq = set(), []
    for r in out:
        k = (r["f"], r["v"], r["t"], r["no"])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(r)

    # ---- second tier: the city's own sign inventory ----
    signs_path = ROOT / "build" / "signs.json"
    sign_rows, sign_stats = [], {}
    if signs_path.exists():
        signs = json.loads(signs_path.read_text())["signs"]
        osm_keys = set((r["f"], r["v"], r["t"]) for r in uniq)
        scored = {}
        for flip in (False, True):
            rows, unplaced = sign_restrictions(graph, nodes, edges, incident,
                                               signs, flip)
            keys = set((r["f"], r["v"], r["t"]) for r in rows)
            agree = len(keys & osm_keys)
            # A wrong reading of DIRECTION does not merely miss agreements, it
            # bans the OPPOSITE movement. Contradiction is the sharper signal:
            # a ban on a turn OSM explicitly permits at the same junction.
            contradict = sum(
                1 for r in rows
                if any(o["f"] == r["f"] and o["v"] == r["v"] and o["t"] != r["t"]
                       and not o["no"] for o in uniq))
            scored[flip] = (agree, -contradict, rows, unplaced)
            print("  DIRECTION as %s: %d restrictions, %d agree with OSM, "
                  "%d contradict, %d unplaced"
                  % ("facing" if flip else "travel", len(rows), agree,
                     contradict, unplaced))
        best_flip = max(scored, key=lambda k: (scored[k][0], scored[k][1]))
        sign_rows = scored[best_flip][2]
        sign_stats = {"reading": "facing" if best_flip else "travel",
                      "agree": scored[best_flip][0]}
        print("  -> reading DIRECTION as %s" % sign_stats["reading"])

        seen2 = set((r["f"], r["v"], r["t"]) for r in uniq)
        added = 0
        for r in sign_rows:
            k = (r["f"], r["v"], r["t"])
            if k in seen2:
                continue
            seen2.add(k)
            uniq.append(r)
            added += 1
        print("  added %d restrictions from signs (%d already known from OSM)"
              % (added, len(sign_rows) - added))

    graph["restrictions"] = uniq
    graph["meta"]["restrictions"] = len(uniq)
    graph["meta"]["restrictions_source"] = (
        "OpenStreetMap (ODbL) + City of Grand Rapids sign inventory")
    GRAPH.write_text(json.dumps(graph, separators=(",", ":")))

    print(f"attached {len(uniq)} turn restrictions "
          f"({sum(1 for r in uniq if r['no'])} no_*, "
          f"{sum(1 for r in uniq if not r['no'])} only_*)")
    print(f"dropped: {dropped}")
    print(f"graph.json now {GRAPH.stat().st_size/1048576:.2f} MB raw")
    if not uniq:
        sys.exit("REFUSE: no restrictions matched; check the build order")


if __name__ == "__main__":
    main()
