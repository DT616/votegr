#!/usr/bin/env python3
"""Build a street-name index for the jurisdictions that surround Grand Rapids.

More than half the road segments carrying a Grand Rapids ZIP are not in the
City of Grand Rapids. People in Wyoming, Kentwood, Walker, East Grand Rapids
and, most confusingly, Grand Rapids CHARTER TOWNSHIP all have Grand Rapids
mailing addresses and vote somewhere this tool does not cover.

Without this index those people get "no street matches that", which reads as
a bug in the tool rather than what it is. With it the page can say which
jurisdiction the street is in and send them to the right place.

Names only, no geometry and no address ranges: this exists to explain a miss,
not to answer a lookup.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from provenance import provenance

LAYER = ("https://gisagocss.state.mi.us/arcgis/rest/services/OpenData/"
         "michigan_geographic_framework/MapServer/20/query")
UA = "vote-gr/1.0 (+https://github.com/DT616/votegr)"
OUT = Path(__file__).resolve().parent.parent / "site" / "data" / "neighbors.json"
DELAY = 2.0
PAGE = 1000          # the layer caps maxRecordCount at 1000

# Jurisdictions that share Grand Rapids postal ZIPs, by MGF minor civil
# division code. Grand Rapids city itself (34000) is deliberately absent.
# Codes verified against the MGF minor-civil-division layer, not recalled.
# Two that were guessed first time round were wrong in ways that would have
# mislabelled real streets: 240 is Ada, not Algoma, and 33340 is Grand Haven,
# a city in Ottawa County with no connection to Grand Rapids at all.
NEIGHBORS = {
    88940: "Wyoming",                 # city
    42820: "Kentwood",                # city
    82960: "Walker",                  # city
    23980: "East Grand Rapids",       # city
    34160: "Grandville",              # city
    34020: "Grand Rapids Township",   # NOT the city; shares its name
    13660: "Cascade Township",
    64660: "Plainfield Township",
    31240: "Gaines Township",
    12240: "Byron Township",
    77980: "Tallmadge Township",
    240:   "Ada Township",
    1840:  "Alpine Township",
    1160:  "Algoma Township",
    34560: "Grattan Township",
}


def get(params):
    url = LAYER + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    # One jurisdiction at a time. A single IN clause across all of them,
    # paged, is what the layer refused; per-code distinct queries it answers
    # happily and they are small.
    idx, empty = {}, []
    for code, who in NEIGHBORS.items():
        # This layer rejects resultOffset together with returnDistinctValues,
        # and it rejects a NULL test on RDNAME, so the query stays as plain as
        # possible: one distinct pull per jurisdiction, empties dropped here.
        # No paging, so a jurisdiction with more than maxRecordCount distinct
        # names would truncate; that is reported rather than passed over.
        page = get({
            "where": f"FMCDL={code}",
            "outFields": "RDNAME",
            "returnGeometry": "false",
            "returnDistinctValues": "true",
            "f": "json",
        })
        if "error" in page:
            print(f"  {who}: query error {page['error'].get('message')}")
            time.sleep(DELAY)
            empty.append(f"{who} ({code})")
            continue
        got = page.get("features", [])
        for f in got:
            name = (f["attributes"].get("RDNAME") or "").strip().upper()
            if not name:
                continue
            lst = idx.setdefault(name, [])
            if who not in lst:
                lst.append(who)
        got_here = len(got)
        trunc = " TRUNCATED" if page.get("exceededTransferLimit") else ""
        print(f"  {who:24s} {got_here:5d} street names{trunc}")
        if got_here == 0 and f"{who} ({code})" not in empty:
            empty.append(f"{who} ({code})")
        time.sleep(DELAY)

    if empty:
        print(f"  NOTE: no rows for {', '.join(empty)} -- check the MCD code")
    if len(idx) < 500:
        sys.exit(f"REFUSE: only {len(idx)} names; expected thousands")

    OUT.write_text(json.dumps({
        "meta": {"source": "Michigan Geographic Framework, All Roads",
                 "note": "Street names in jurisdictions bordering Grand Rapids, "
                         "used only to explain an address this tool cannot answer.",
                 "streets": len(idx)},
        "provenance": provenance(
            source="State of Michigan, Michigan Geographic Framework "
                   "(All Roads layer).",
            source_url=LAYER,
            licence="Public record of the State of Michigan, redistributed as published.",
            made_by="refresh_neighbors.py",
            how_to_update="Run refresh_neighbors.py.",
            why="Street names in the jurisdictions AROUND Grand Rapids, so an "
                "address this tool cannot answer reads as out of area rather "
                "than as a bug."),
        "streets": idx,
    }, separators=(",", ":")))
    print(f"wrote {len(idx)} street names -> {OUT} "
          f"({OUT.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
