"""Regenerate site/data/addresses.json from Kent County's parcel layer.

The page answers a lookup without geocoding anything: every parcel address in
the city is matched to its precinct here, once, offline. The browser then does
a dictionary lookup instead of calling a geocoding service. That is why the
page keeps working when a county or city GIS server goes down, and why the
address never leaves the browser.

Only three things per address are published: the house number, the precinct,
and how many metres the parcel sits from the precinct edge. Owner names,
parcel ids and valuations are read and thrown away. Do not add them: this file
is served to browsers, and an address-to-owner index is not something a voting
page should hand out.

Verifies before writing: every precinct must gain addresses, the total must be
plausible, and the boundary file must be the current one.

Usage: python3 refresh_addresses.py
"""
import datetime
import json
import math
import pathlib
import sys
import time

import requests
from shapely.geometry import shape, Point
from shapely.ops import transform
from shapely.strtree import STRtree

PARCELS = ("https://gis.kentcountymi.gov/agisprod/rest/services/"
           "ParcelsWithCondos/FeatureServer/0/query")
CITY = "GRAND RAPIDS"          # postal city; reaches beyond the city limits
UA = {"User-Agent": "vote-gr/1.0 (+https://github.com/DT616/votegr)"}
PAGE = 2000
DELAY_SECONDS = 2              # be a polite guest on someone else's server

# Paths are anchored to the repository root, one level up from this
# file, since these scripts live in scripts/ and write into site/data.
ROOT = pathlib.Path(__file__).resolve().parent.parent
BOUNDARIES = ROOT / "site" / "data" / "precincts.geojson"
OUT = ROOT / "site" / "data" / "addresses.json"

EXPECTED_PRECINCTS = 59
MIN_ADDRESSES = 45_000         # ~64k today; a big drop means upstream changed
NEAR_CAP_M = 60                # beyond this we only ever say "not near a line"


def fetch_parcels():
    """Every parcel with our postal city, as (address_text, lng, lat).

    returnCentroid keeps polygons off the wire: we need a point, not a shape,
    and asking for geometry would move tens of megabytes for no reason.
    """
    rows, offset = [], 0
    while True:
        params = {
            "where": f"PROPADDRESSCITY='{CITY}'",
            "outFields": "PROPERTYADDRESS",
            "returnGeometry": "false",
            "returnCentroid": "true",
            "outSR": "4326",
            "orderByFields": "OBJECTID ASC",
            "resultRecordCount": str(PAGE),
            "resultOffset": str(offset),
            "f": "json",
        }
        response = requests.get(PARCELS, params=params, headers=UA, timeout=90)
        response.raise_for_status()
        data = response.json()
        if "error" in data:
            raise SystemExit(f"upstream error at offset {offset}: {data['error']}")
        features = data.get("features") or []
        for feature in features:
            address = (feature.get("attributes") or {}).get("PROPERTYADDRESS")
            centroid = feature.get("centroid") or {}
            if address and centroid.get("x") is not None:
                rows.append((address.strip(), centroid["x"], centroid["y"]))
        print(f"  {len(rows):,} parcels", flush=True)
        if not data.get("exceededTransferLimit") or not features:
            return rows
        offset += len(features)
        time.sleep(DELAY_SECONDS)


def split_address(text):
    """'250 MONROE AVE NW' -> (250, 'MONROE AVE NW').

    The street half keeps its quadrant, which is the whole point: a lookup
    that loses the NE/SE distinction can put a voter on the wrong side of the
    city, and Grand Rapids addresses are quadrant-heavy.
    """
    number, _, street = text.partition(" ")
    street = " ".join(street.split()).upper()
    if not street:
        return None
    try:
        return int(number), street
    except ValueError:
        return None


def metre_frame(polygon):
    """A local flat projection for one precinct, in metres from its centre.

    Returns the projection and the precinct's own boundary already projected,
    so the per-address work is one point transform and one distance.

    Precincts are about a kilometre across, so a per-precinct equirectangular
    frame is accurate to well under a metre. This avoids a pyproj dependency
    for what is, at this scale, arithmetic. `boundary` rather than `exterior`
    so a precinct with a hole measures against the hole too.
    """
    lng0, lat0 = polygon.centroid.x, polygon.centroid.y
    xs = 111_320 * math.cos(math.radians(lat0))
    ys = 110_540

    def to_metres(lng, lat, _z=None):
        return (lng - lng0) * xs, (lat - lat0) * ys

    return to_metres, transform(to_metres, polygon.boundary)


def main():
    if not BOUNDARIES.exists():
        raise SystemExit(f"missing {BOUNDARIES}; run refresh_precincts.py first")
    boundaries = json.loads(BOUNDARIES.read_text())
    features = boundaries["features"]
    polygons = [shape(f["geometry"]) for f in features]
    numbers = [str(f["properties"]["precinct"]) for f in features]
    tree = STRtree(polygons)

    # Each precinct's boundary in its own local metre frame, built once.
    frames = [metre_frame(p) for p in polygons]

    print("fetching parcels from Kent County...")
    parcels = fetch_parcels()
    print(f"fetched {len(parcels):,} parcels")

    streets, outside, unparsed = {}, 0, 0
    for text, lng, lat in parcels:
        parsed = split_address(text)
        if not parsed:
            unparsed += 1
            continue
        number, street = parsed
        point = Point(lng, lat)
        index = next((i for i in tree.query(point) if polygons[i].contains(point)), None)
        if index is None:
            outside += 1          # a postal-city address out in the townships
            continue
        to_metres, edge = frames[index]
        edge_m = min(int(round(edge.distance(Point(*to_metres(lng, lat))))), NEAR_CAP_M)
        streets.setdefault(street, []).append([number, numbers[index], edge_m])

    # One row per house number. Condo buildings file a parcel per unit, so the
    # same address arrives many times; those agree and collapse. A handful
    # genuinely straddle a precinct line (a parcel either side of the same
    # address), and those must not silently resolve to whichever we saw first.
    # They carry the rival precincts so the page can say the address is
    # ambiguous rather than answer with false confidence.
    ambiguous = 0
    for street, rows in streets.items():
        merged = {}
        for number, precinct, edge_m in rows:
            if number in merged:
                merged[number][2] = min(merged[number][2], edge_m)
                merged[number][3].add(precinct)
            else:
                merged[number] = [number, precinct, edge_m, {precinct}]
        collapsed = []
        for number, precinct, edge_m, seen in merged.values():
            if len(seen) > 1:
                ambiguous += 1
                collapsed.append([number, precinct, edge_m, sorted(seen, key=int)])
            else:
                collapsed.append([number, precinct, edge_m])
        collapsed.sort()
        streets[street] = collapsed

    placed = sum(len(v) for v in streets.values())
    # Ambiguous rows carry a fourth element, so take the precinct positionally.
    covered = {row[1] for rows in streets.values() for row in rows}
    print(f"placed {placed:,} addresses on {len(streets):,} streets")
    print(f"  outside the city limits : {outside:,}")
    print(f"  unparsable address text : {unparsed:,}")
    print(f"  spanning two precincts  : {ambiguous:,}")

    if placed < MIN_ADDRESSES:
        raise SystemExit(f"REFUSING to write: only {placed:,} addresses placed "
                         f"(expected at least {MIN_ADDRESSES:,})")
    missing = {n for n in numbers} - covered
    if missing:
        raise SystemExit(f"REFUSING to write: no addresses landed in precinct(s) "
                         f"{sorted(missing, key=int)}")
    if len(covered) != EXPECTED_PRECINCTS:
        raise SystemExit(f"REFUSING to write: {len(covered)} precincts covered, "
                         f"expected {EXPECTED_PRECINCTS}")

    document = {
        "provenance": {
            "description": "Grand Rapids parcel addresses, each matched to its "
                           "voting precinct. Generated, not edited by hand.",
            "source": "Kent County ParcelsWithCondos FeatureServer",
            "source_url": PARCELS.rsplit("/query", 1)[0],
            "matched_against": "site/data/precincts.geojson",
            "generated": datetime.date.today().isoformat(),
            "address_count": placed,
            "ambiguous_count": ambiguous,
            "street_count": len(streets),
            "format": "street -> [[house number, precinct, metres from the "
                      f"precinct edge (capped at {NEAR_CAP_M})], ...]. A "
                      "fourth element, when present, lists every precinct "
                      "the address touches: it straddles a line and the "
                      "answer is genuinely ambiguous.",
            "licence": "Public record of Kent County, redistributed as published.",
            "how_to_update": "Run refresh_addresses.py. Re-run it after "
                             "refresh_precincts.py, since the precinct a parcel "
                             "falls in is baked in here.",
            "deliberately_omitted": "Owner names, parcel ids and valuations are "
                                    "read from the source and discarded. This "
                                    "file is served to browsers.",
        },
        # Precinct -> ward, so the page never needs the boundary file. With the
        # lookup answered from this index, the geometry is a build input only:
        # shipping it to browsers would be 60 KB nothing reads.
        "wards": {str(f["properties"]["precinct"]): f["properties"]["ward"]
                  for f in features},
        "streets": streets,
    }
    OUT.write_text(json.dumps(document, separators=(",", ":")) + "\n")
    print(f"wrote {OUT} ({OUT.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    sys.exit(main())
