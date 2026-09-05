#!/usr/bin/env python3
"""Pull known ALPR camera positions in the Grand Rapids area from OpenStreetMap
via Overpass, and write the cached camera floor (site/data/cameras.json).

This is the DEFAULT camera source and the completeness floor. The browser can
optionally re-query Overpass live, but it may only ADD to this set, never show
fewer than it (see the design's add-only / safety rule). So this file must be
complete: the pull walks an endpoint fallback chain and REFUSES to write a
truncated result (Overpass signals truncation with a 'remark' at HTTP 200, and
its main front 504s under load -- the same lesson Blotter's ALPR ingest encodes).

Every ALPR node counts, all operators and zones: police, Flock, retail, HOA.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from provenance import provenance

# GR city bbox with ~2km margin (S, W, N, E) for Overpass.
BBOX = (42.87, -85.78, 43.05, -85.55)

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
UA = "vote-gr/1.0 (+https://github.com/DT616/votegr)"
OUT = Path(__file__).resolve().parent.parent / "site" / "data" / "cameras.json"
MIN_CAMERAS = 20   # GR metro has hundreds; a handful back = truncated/broken

QL = f"""[out:json][timeout:60];
(
  node["surveillance:type"="ALPR"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});
  way["surveillance:type"="ALPR"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});
);
out center tags meta;
"""

# What we publish per camera. OSM carries far more about these than an operator
# name: manufacturer is present on ~96% of them where operator is on ~31%, and
# mount/type/zone/direction together describe what a camera actually watches.
#
# Deliberately NOT carried over: the OSM contributor's username and id, which
# arrive with `meta`. Those identify a person, and a page about surveillance
# should not publish the name of whoever mapped a camera.
KEEP_TAGS = [
    "manufacturer", "model", "brand",
    "camera:type", "camera:mount", "camera:direction",
    "surveillance", "surveillance:zone", "surveillance:type",
    "direction", "operator", "operator:type",
    "electricity", "height", "level", "support",
    "note", "description", "survey:date", "check_date", "start_date", "ref",
]


def _query(endpoint):
    data = ("data=" + urllib.parse.quote(QL)).encode("utf-8")
    req = urllib.request.Request(
        endpoint, data=data,
        headers={"User-Agent": UA,
                 "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    result = None
    for ep in ENDPOINTS:
        try:
            print(f"trying {ep} ...")
            j = _query(ep)
        except Exception as e:  # noqa: BLE001 - fall through to next endpoint
            print(f"  failed: {e}")
            time.sleep(2)
            continue
        if "remark" in j and ("timed out" in j["remark"].lower()
                              or "truncated" in j["remark"].lower()):
            print(f"  REMARK signals truncation: {j['remark']!r}; next endpoint")
            time.sleep(2)
            continue
        result = j
        break

    if result is None:
        sys.exit("REFUSE: no complete Overpass result from any endpoint")

    cams = []
    for el in result.get("elements", []):
        tags = el.get("tags", {})
        if el["type"] == "node":
            lat, lng = el.get("lat"), el.get("lon")
        else:  # way -> center
            c = el.get("center", {})
            lat, lng = c.get("lat"), c.get("lon")
        if lat is None or lng is None:
            continue
        fields = {}
        for k in KEEP_TAGS:
            v = tags.get(k)
            if v not in (None, ""):
                fields[k] = str(v)[:120]
        cams.append({
            "id": f"{el['type'][0]}{el['id']}",
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            "f": fields,
            # OSM object version and edit time: a v1 object's timestamp is when
            # the camera was first mapped, which is the best available proxy for
            # when it appeared. No contributor identity is carried.
            "v": el.get("version"),
            "t": el.get("timestamp"),
        })

    if len(cams) < MIN_CAMERAS:
        sys.exit(f"REFUSE: only {len(cams)} cameras (< {MIN_CAMERAS}); "
                 "likely truncated or wrong bbox")

    payload = {
        "meta": {
            "bbox": BBOX,
            "count": len(cams),
            "source": "OpenStreetMap via Overpass (surveillance:type=ALPR)",
        },
        "provenance": provenance(
            source="OpenStreetMap, queried through Overpass for "
                   "surveillance:type=ALPR. All operators and zones.",
            source_url=ENDPOINTS[0],
            licence="OpenStreetMap contributors, ODbL. Derived data must credit OSM.",
            made_by="refresh_cameras.py",
            how_to_update="Runs itself daily at 06:17 UTC via "
                          ".github/workflows/refresh-cameras.yml, which commits "
                          "only when the set changed. Run by hand to force it.",
            endpoint_fallbacks=ENDPOINTS[1:],
            floor_note="This file is the completeness FLOOR. The browser may "
                       "add to it from a live query but must never show fewer."),
        "cameras": cams,
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"wrote {len(cams)} cameras -> {OUT} "
          f"({OUT.stat().st_size/1024:.1f} KB)")
    counts = {}
    for c in cams:
        for k in c["f"]:
            counts[k] = counts.get(k, 0) + 1
    print("  field coverage:")
    for k, n in sorted(counts.items(), key=lambda x: -x[1]):
        print(f"    {k:22s} {n:4d}  ({100*n/len(cams):.0f}%)")


if __name__ == "__main__":
    main()
