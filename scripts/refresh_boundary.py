#!/usr/bin/env python3
"""Fetch the City of Grand Rapids limits and write site/data/boundary.json.

Drawn on the map so the covered area is obvious: routing stops at the city
line, and without the outline a route that stops there looks like a bug rather
than the edge of the data.

Source is the Michigan Geographic Framework, the state's authoritative civic
boundary layer (the same lines NG-911 uses). Public, no key.
"""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

MGF_CITIES = ("https://gisagocss.state.mi.us/arcgis/rest/services/OpenData/"
              "michigan_geographic_framework/MapServer/1/query")
PLACE_FIPS = "34000"          # Grand Rapids; matches the centerline filter
UA = "vote-gr/1.0 (+https://github.com/DT616/votegr)"
OUT = Path(__file__).resolve().parent.parent / "site" / "data" / "boundary.json"


def fetch(where):
    params = {
        "where": where,
        "outFields": "*",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "json",
    }
    url = MGF_CITIES + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    data = None
    for where in ("FIPSCODE='%s'" % PLACE_FIPS,
                  "NAME='Grand Rapids'",
                  "UPPER(NAME) LIKE '%GRAND RAPIDS%'"):
        try:
            d = fetch(where)
        except Exception as e:  # noqa: BLE001
            print("query failed (%s): %s" % (where, e))
            continue
        if d.get("features"):
            print("matched with: %s -> %d feature(s)" % (where, len(d["features"])))
            data = d
            break
        print("no features for: %s" % where)

    if not data:
        sys.exit("REFUSE: could not fetch the Grand Rapids boundary")

    # Keep the largest ring set; a city can ship as several fragments.
    rings = []
    for f in data["features"]:
        rings.extend((f.get("geometry") or {}).get("rings") or [])
    if not rings:
        sys.exit("REFUSE: feature carried no rings")

    # Round to ~1m. An outline needs no more precision than that.
    out_rings = [[[round(p[0], 5), round(p[1], 5)] for p in ring] for ring in rings]
    total = sum(len(r) for r in out_rings)
    if total < 50:
        sys.exit("REFUSE: only %d boundary points; looks wrong" % total)

    OUT.write_text(json.dumps({
        "meta": {"source": "Michigan Geographic Framework, cities layer",
                 "place_fips": PLACE_FIPS, "rings": len(out_rings),
                 "points": total},
        "rings": out_rings,
    }, separators=(",", ":")))
    print("wrote %d rings / %d points -> %s (%.1f KB)"
          % (len(out_rings), total, OUT, OUT.stat().st_size / 1024))


if __name__ == "__main__":
    main()
