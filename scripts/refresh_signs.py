#!/usr/bin/env python3
"""Fetch the City of Grand Rapids turn-regulation signs.

The city publishes its whole sign inventory with Michigan MUTCD codes, which
includes the no-turn family. This is the authority that installs the signs,
and unlike volunteer mapping it also records which signs have been RETIRED,
so a restriction that no longer exists can be excluded rather than enforced
forever.

Only the codes that constrain a driver's movement are fetched, and only those
marked Active. No other sign class is pulled: this file exists to answer
"which turns are banned", not to mirror an asset register.
"""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

LAYER = ("https://services2.arcgis.com/L81TiOwAPO1ZvU9b/arcgis/rest/services/"
         "signs/FeatureServer/0/query")
UA = "vote-gr/1.0 (+https://github.com/DT616/votegr)"
OUT = Path(__file__).resolve().parent.parent / "build" / "signs.json"

# What each code does to a driver arriving at the intersection.
#   ban  : movements that are forbidden
#   only : the sole movement permitted (everything else forbidden)
CODES = {
    "R3-1":  {"ban": ["right"]},
    "R3-2":  {"ban": ["left"]},
    "R3-4":  {"ban": ["uturn"]},
    "R3-18": {"ban": ["left", "right"]},
    "R3-5R": {"only": "right"},
    "R3-5L": {"only": "left"},
    "R3-5A": {"only": "through"},
}
MIN_SIGNS = 40


def main():
    OUT.parent.mkdir(exist_ok=True)
    codes = ",".join("'%s'" % c for c in CODES)
    params = {
        "where": "MMUTCD IN (%s) AND STATUS = 'Active'" % codes,
        "outFields": "MMUTCD,SIGN,DIRECTION,LOCATION,STATUS,LASTDATE",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "json",
    }
    url = LAYER + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=90) as r:
        d = json.loads(r.read().decode("utf-8"))
    if "error" in d:
        sys.exit("query error: %s" % d["error"])

    out = []
    for f in d.get("features", []):
        a = f["attributes"]
        g = f.get("geometry") or {}
        if g.get("x") is None or g.get("y") is None:
            continue
        out.append({
            "code": a.get("MMUTCD"),
            "dir": (a.get("DIRECTION") or "").strip(),
            "loc": (a.get("LOCATION") or "").strip(),
            "lat": round(g["y"], 6),
            "lng": round(g["x"], 6),
        })

    if len(out) < MIN_SIGNS:
        sys.exit("REFUSE: only %d active turn signs; expected ~113" % len(out))

    OUT.write_text(json.dumps({
        "meta": {"source": "City of Grand Rapids sign inventory (MMUTCD)",
                 "count": len(out), "codes": sorted(CODES)},
        "signs": out,
    }, separators=(",", ":")))
    by = {}
    for s in out:
        by[s["code"]] = by.get(s["code"], 0) + 1
    print("wrote %d active turn signs -> %s" % (len(out), OUT))
    for k, n in sorted(by.items(), key=lambda x: -x[1]):
        print("  %4d  %s" % (n, k))
    nodir = sum(1 for s in out if not s["dir"])
    if nodir:
        print("  NOTE: %d have no DIRECTION and cannot be oriented" % nodir)


if __name__ == "__main__":
    main()
