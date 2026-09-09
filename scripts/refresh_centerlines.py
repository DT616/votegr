#!/usr/bin/env python3
# Released into the public domain under the Unlicense, see UNLICENSE.
"""Pull the street centerlines and write a normalized intermediate for
build_graph.py.

Source: the layer published on the City of Grand Rapids ArcGIS Online tenant,
which is not a city layer at all -- it is the REGIS/Kent County dataset, 39,209
segments across 48 jurisdictions, and the city's own service simply hosts it.
That discovery is what made the Kent County widening cheap: the streets were
already here, behind a filter.

It carries traffic DIRECTION (TRAFFIC_ALIGN) and POSTED_SPEED per segment,
which is what makes a legal client-side router possible, and address ranges
per side so the browser can geocode without any network call.

Everything is pulled, with no jurisdiction filter. Chunks are cut from the
precinct polygons rather than from this file, so segments beyond the county
line are not waste: they are the overlap ring that lets a route leave a
border jurisdiction instead of dead-ending at it.

Reproducible + guarded, vote-gr style: refuses to write if the pull looks
implausible (too few segments, or the one-way share collapses), so a bad
upstream day can't quietly ship a broken graph.

Polite: one page at a time, 2s between pages, single-purpose UA.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

LAYER = ("https://services2.arcgis.com/L81TiOwAPO1ZvU9b/arcgis/rest/services/"
         "Transport_Street_Centerlines/FeatureServer/6/query")
WHERE = "1=1"
OUT_FIELDS = [
    "OBJECTID", "PREFIX_DIRECTION", "STREET_NAME", "STREET_SUFFIX",
    "SUFFIX_DIRECTION", "TRAFFIC_ALIGN", "POSTED_SPEED",
    "FUNCTIONAL_CLASSIFICATION", "LEFT_START_ADDRESS", "LEFT_END_ADDRESS",
    "RIGHT_START_ADDRESS", "RIGHT_END_ADDRESS", "LEFT_ZIP_CODE",
    "RIGHT_ZIP_CODE", "FROM_GS", "TO_GS", "ONE_WAY_PAIR", "MGF_OID",
]
PAGE = 2000
DELAY_S = 2.0
UA = "vote-gr/1.0 (+https://github.com/DT616/votegr)"
# Build input, NOT a browser asset: it lives outside site/ so the deployed
# tree does not ship 6 MB nobody downloads.
OUT = Path(__file__).resolve().parent.parent / "build" / "centerlines.json"

# Guards
MIN_SEGMENTS = 35000         # the region is ~39.2k; well under this = bad pull
MIN_ONEWAY_SHARE = 0.02      # ~10% observed; a collapse to <2% = schema change


def _get(params):
    url = LAYER + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    OUT.parent.mkdir(exist_ok=True)
    base = {
        "where": WHERE,
        "outFields": ",".join(OUT_FIELDS),
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "json",
    }
    # Cheap count first (etiquette: know the size before paging).
    cnt = _get({**base, "returnCountOnly": "true"})
    total = cnt.get("count")
    print(f"upstream reports {total} segments for the region")
    if total is None:
        sys.exit("no count returned; aborting")

    feats = []
    offset = 0
    while True:
        page = _get({**base, "resultOffset": offset, "resultRecordCount": PAGE})
        if "error" in page:
            sys.exit(f"query error at offset {offset}: {page['error']}")
        got = page.get("features", [])
        feats.extend(got)
        print(f"  offset {offset}: +{len(got)} (total {len(feats)})")
        if len(got) < PAGE and not page.get("exceededTransferLimit"):
            break
        offset += PAGE
        time.sleep(DELAY_S)

    # Guards
    n = len(feats)
    if n < MIN_SEGMENTS:
        sys.exit(f"REFUSE: only {n} segments (< {MIN_SEGMENTS}); bad pull")
    oneway = sum(1 for f in feats
                 if (f["attributes"].get("TRAFFIC_ALIGN") or "") in ("+", "-"))
    share = oneway / n if n else 0
    print(f"one-way share: {oneway}/{n} = {share:.3f}")
    if share < MIN_ONEWAY_SHARE:
        sys.exit(f"REFUSE: one-way share {share:.3f} collapsed "
                 f"(< {MIN_ONEWAY_SHARE}); TRAFFIC_ALIGN schema changed?")

    OUT.write_text(json.dumps({"features": feats}, separators=(",", ":")))
    print(f"wrote {n} segments -> {OUT} "
          f"({OUT.stat().st_size/1048576:.2f} MB)")


if __name__ == "__main__":
    main()
