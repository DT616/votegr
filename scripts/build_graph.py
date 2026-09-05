#!/usr/bin/env python3
"""Compile site/data/centerlines.json into site/data/graph.json: the routing
graph the browser loads.

Nodes are segment endpoints, keyed by quantized coordinate PLUS grade-separation
level so an overpass endpoint never fuses with the street beneath it. Edges
carry a direction flag (from TRAFFIC_ALIGN), travel seconds (from POSTED_SPEED),
address ranges per side (for client-side geocoding), and a drawable polyline.

Cameras are NOT baked in here -- they live in cameras.json and are assigned to
edges in the browser, which keeps the two files independent (a daily camera
refresh never touches the graph).
"""
import json
import math
from pathlib import Path

# Paths are anchored to the repository root, one level up from this
# file, since these scripts live in scripts/ and write into site/data.
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "build" / "centerlines.json"
OUT = ROOT / "site" / "data" / "graph.json"

Q = 5  # coord rounding for node identity (~1.1m)

# Fallback speeds (mph) by MI functional class when POSTED_SPEED is null/0.
FC_DEFAULT_MPH = {
    "1": 55, "2": 45, "3": 40, "4": 35, "5": 30, "6": 25, "7": 25,
}
DEFAULT_MPH = 25


def hav(a, b):
    """meters between [lng,lat] a and b."""
    R = 6371000.0
    lon1, lat1, lon2, lat2 = map(math.radians, [a[0], a[1], b[0], b[1]])
    dlon, dlat = lon2 - lon1, lat2 - lat1
    h = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    return 2 * R * math.asin(math.sqrt(h))


def path_len(path):
    return sum(hav(path[i], path[i+1]) for i in range(len(path)-1))


# Cartographic class, so the map can draw a hierarchy instead of 10,000
# identical lines. Collapsed from the Act 51 functional classification.
FC_CLASS = {
    "Urban Principal Arterial - Interstate": 1,
    "Rural Principal Arterial - Interstate": 1,
    "Urban Principal Arterial - Other Freeway": 1,
    "Rural Principal - Other Freeway": 1,
    "Urban Principal Arterial - Other": 2,
    "Rural Principal Arterial - Other": 2,
    "Urban Minor Arterial": 3,
    "Urban Collector": 4,
    "Urban Local Road": 5,
    "Rural Local Road": 5,
    "Non-Public - Private": 6,
}


def road_class(a):
    return FC_CLASS.get((a.get("FUNCTIONAL_CLASSIFICATION") or "").strip(), 5)


def street_name(a):
    parts = [a.get("PREFIX_DIRECTION"), a.get("STREET_NAME"),
             a.get("STREET_SUFFIX"), a.get("SUFFIX_DIRECTION")]
    return " ".join(p for p in parts if p).strip()


def main():
    data = json.loads(SRC.read_text())
    feats = data["features"]

    node_ids = {}
    nodes = []  # id -> [lat,lng]

    def node_id(lng, lat, gs):
        key = (round(lat, Q), round(lng, Q), gs or 0)
        if key not in node_ids:
            node_ids[key] = len(nodes)
            nodes.append([round(lat, 6), round(lng, 6)])
        return node_ids[key]

    edges = []
    skipped = 0
    minlat = minlng = 1e9
    maxlat = maxlng = -1e9

    for f in feats:
        a = f["attributes"]
        geom = f.get("geometry") or {}
        paths = geom.get("paths") or []
        if not paths:
            skipped += 1
            continue
        # Most segments are a single path; if multipart, take the longest.
        path = max(paths, key=path_len)
        if len(path) < 2:
            skipped += 1
            continue

        start, end = path[0], path[-1]  # [lng,lat]
        na = node_id(start[0], start[1], a.get("FROM_GS"))
        nb = node_id(end[0], end[1], a.get("TO_GS"))
        if na == nb:
            skipped += 1
            continue

        length_m = path_len(path)
        mph = a.get("POSTED_SPEED") or 0
        if not mph or mph <= 0:
            fc = str(a.get("FUNCTIONAL_CLASSIFICATION") or "").strip()
            mph = FC_DEFAULT_MPH.get(fc, DEFAULT_MPH)
        sec = length_m / (mph * 0.44704)  # mph -> m/s

        ta = (a.get("TRAFFIC_ALIGN") or "").strip()
        # 0 = two-way, 1 = forward only (a->b along digitized), 2 = reverse only
        direction = 1 if ta == "+" else 2 if ta == "-" else 0

        # polyline for drawing: [lat,lng] rounded (delta-encode later if needed)
        poly = [[round(p[1], 5), round(p[0], 5)] for p in path]
        for p in poly:
            minlat = min(minlat, p[0]); maxlat = max(maxlat, p[0])
            minlng = min(minlng, p[1]); maxlng = max(maxlng, p[1])

        edges.append({
            "a": na, "b": nb,
            "d": direction,
            "l": round(length_m, 1),
            "t": round(sec, 1),
            "n": street_name(a),
            "c": road_class(a),
            # address ranges: [Lfrom, Lto, Rfrom, Rto]
            "r": [a.get("LEFT_START_ADDRESS"), a.get("LEFT_END_ADDRESS"),
                  a.get("RIGHT_START_ADDRESS"), a.get("RIGHT_END_ADDRESS")],
            "z": [a.get("LEFT_ZIP_CODE"), a.get("RIGHT_ZIP_CODE")],
            "p": poly,
        })

    payload = {
        "meta": {
            "built_from": "GR Street_Centerlines (AGoL)",
            "bbox": [round(minlat, 6), round(minlng, 6),
                     round(maxlat, 6), round(maxlng, 6)],
            "nodes": len(nodes),
            "edges": len(edges),
            "skipped": skipped,
            "oneway": sum(1 for e in edges if e["d"]),
        },
        "nodes": nodes,
        "edges": edges,
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    sz = OUT.stat().st_size
    print(f"nodes={len(nodes)} edges={len(edges)} oneway={payload['meta']['oneway']} "
          f"skipped={skipped}")
    print(f"wrote {OUT} ({sz/1048576:.2f} MB raw)")


if __name__ == "__main__":
    main()
