# Released into the public domain under the Unlicense, see UNLICENSE.
"""Regenerate the per-jurisdiction address chunks under site/data/addresses/.

The page answers a lookup without geocoding anything: every parcel address in
Kent County is matched to its precinct here, once, offline. The browser then
does a dictionary lookup instead of calling a geocoding service. That is why
the page keeps working when a county or city GIS server goes down, and why the
address never leaves the browser.

One file per jurisdiction, named by its MCD FIPS code, because a county-wide
index is too much for a phone to parse: 232,000 parcels is about 2.2 MB of
JSON and tens of megabytes of heap once parsed. Chunked, the worst case is
Grand Rapids -- which is exactly the payload that already works today -- and
every other jurisdiction is a fraction of it. Which chunk to load comes from
the jurisdictions index in precincts.json.

Only three things per address are published: the house number, the precinct,
and how many metres the parcel sits from the precinct edge. Owner names,
parcel ids and valuations are read and thrown away. Do not add them: these
files are served to browsers, and an address-to-owner index is not something a
voting page should hand out.

Precincts are referenced by their position in the chunk's own `precincts`
list rather than by the state's 13-digit code, which would otherwise be
repeated 150,000 times for no gain.

Verifies before writing: every precinct in the county must gain addresses,
every jurisdiction must produce a chunk, and the total must be plausible.

Usage: python3 refresh_addresses.py
"""
import datetime
import json
import math
import pathlib
import sys
import time
from collections import defaultdict

import requests
from shapely.geometry import shape, Point
from shapely.ops import transform
from shapely.strtree import STRtree

PARCELS = ("https://gis.kentcountymi.gov/agisprod/rest/services/"
           "ParcelsWithCondos/FeatureServer/0/query")
WHERE = "PROPERTYADDRESS IS NOT NULL"
UA = {"User-Agent": "vote-gr/1.0 (+https://github.com/DT616/votegr)"}
PAGE = 1000                    # the layer's own maxRecordCount; asking more is clamped
DELAY_SECONDS = 1.5            # be a polite guest on someone else's server

# Paths are anchored to the repository root, one level up from this
# file, since these scripts live in scripts/ and write into site/data.
ROOT = pathlib.Path(__file__).resolve().parent.parent
BOUNDARIES = ROOT / "site" / "data" / "precincts.geojson"
OUT_DIR = ROOT / "site" / "data" / "addresses"

EXPECTED_PRECINCTS = 202
EXPECTED_JURISDICTIONS = 30
MIN_ADDRESSES = 100_000        # ~150k expected; a big drop means upstream changed
NEAR_CAP_M = 60                # beyond this we only ever say "not near a line"


def fetch_parcels():
    """Every parcel in the county with an address, as (address_text, lng, lat).

    returnCentroid keeps polygons off the wire: we need a point, not a shape,
    and asking for geometry would move hundreds of megabytes for no reason.
    """
    rows, offset = [], 0
    while True:
        params = {
            "where": WHERE,
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
        if offset % 20000 == 0:
            print(f"  {len(rows):,} parcels", flush=True)
        if not data.get("exceededTransferLimit") or not features:
            print(f"  {len(rows):,} parcels", flush=True)
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

    Precincts are about a kilometre across in the cities and a few across in
    the townships, so a per-precinct equirectangular frame is accurate to well
    under a metre. This avoids a pyproj dependency for what is, at this scale,
    arithmetic. `boundary` rather than `exterior` so a precinct with a hole
    measures against the hole too.
    """
    lng0, lat0 = polygon.centroid.x, polygon.centroid.y
    xs = 111_320 * math.cos(math.radians(lat0))
    ys = 110_540

    def to_metres(lng, lat, _z=None):
        return (lng - lng0) * xs, (lat - lat0) * ys

    return to_metres, transform(to_metres, polygon.boundary)


def collapse(rows, code_index):
    """One row per house number, for one street in one jurisdiction.

    Condo buildings file a parcel per unit, so the same address arrives many
    times; those agree and collapse. A handful genuinely straddle a precinct
    line (a parcel either side of the same address), and those must not
    silently resolve to whichever we saw first. They carry the rival precincts
    so the page can say the address is ambiguous rather than answer with false
    confidence.
    """
    merged, ambiguous = {}, 0
    for number, code, edge_m in rows:
        if number in merged:
            merged[number][2] = min(merged[number][2], edge_m)
            merged[number][3].add(code)
        else:
            merged[number] = [number, code, edge_m, {code}]
    out = []
    for number, code, edge_m, seen in merged.values():
        if len(seen) > 1:
            ambiguous += 1
            out.append([number, code_index[code], edge_m,
                        sorted(code_index[c] for c in seen)])
        else:
            out.append([number, code_index[code], edge_m])
    out.sort()
    return out, ambiguous


def main():
    if not BOUNDARIES.exists():
        raise SystemExit(f"missing {BOUNDARIES}; run refresh_precincts.py first")
    features = json.loads(BOUNDARIES.read_text())["features"]
    if len(features) != EXPECTED_PRECINCTS:
        raise SystemExit(f"{BOUNDARIES} holds {len(features)} precincts, "
                         f"expected {EXPECTED_PRECINCTS}; re-run refresh_precincts.py")
    polygons = [shape(f["geometry"]) for f in features]
    props = [f["properties"] for f in features]
    tree = STRtree(polygons)

    # Each precinct's boundary in its own local metre frame, built once.
    frames = [metre_frame(p) for p in polygons]

    print("fetching parcels from Kent County...")
    parcels = fetch_parcels()
    print(f"fetched {len(parcels):,} parcels")

    # street rows per jurisdiction, keyed by MCD FIPS
    chunks = defaultdict(lambda: defaultdict(list))
    outside = unparsed = 0
    for text, lng, lat in parcels:
        parsed = split_address(text)
        if not parsed:
            unparsed += 1
            continue
        number, street = parsed
        point = Point(lng, lat)
        index = next((i for i in tree.query(point) if polygons[i].contains(point)), None)
        if index is None:
            outside += 1          # a parcel outside every precinct polygon
            continue
        to_metres, edge = frames[index]
        edge_m = min(int(round(edge.distance(Point(*to_metres(lng, lat))))), NEAR_CAP_M)
        chunks[props[index]["mcd"]][street].append(
            [number, props[index]["code"], edge_m])

    if len(chunks) != EXPECTED_JURISDICTIONS:
        raise SystemExit(f"REFUSING to write: {len(chunks)} jurisdictions got "
                         f"addresses, expected {EXPECTED_JURISDICTIONS}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    total = total_ambiguous = 0
    covered = set()
    table = []
    for mcd, streets in sorted(chunks.items()):
        here = [p for p in props if p["mcd"] == mcd]
        codes = sorted(p["code"] for p in here)
        code_index = {c: i for i, c in enumerate(codes)}

        placed = {}
        ambiguous = 0
        for street, rows in streets.items():
            placed[street], n = collapse(rows, code_index)
            ambiguous += n
        count = sum(len(v) for v in placed.values())
        covered |= {codes[row[1]] for rows in placed.values() for row in rows}
        total += count
        total_ambiguous += ambiguous

        name = here[0]["jurisdiction"]
        document = {
            "provenance": {
                "description": f"{name} parcel addresses, each matched to its "
                               "voting precinct. Generated, not edited by hand.",
                "source": "Kent County ParcelsWithCondos FeatureServer",
                "source_url": PARCELS.rsplit("/query", 1)[0],
                "matched_against": "site/data/precincts.geojson",
                "generated": datetime.date.today().isoformat(),
                "address_count": count,
                "ambiguous_count": ambiguous,
                "street_count": len(placed),
                "format": "street -> [[house number, index into `precincts`, "
                          f"metres from the precinct edge (capped at "
                          f"{NEAR_CAP_M})], ...]. A fourth element, when "
                          "present, lists every precinct the address touches: "
                          "it straddles a line and the answer is genuinely "
                          "ambiguous.",
                "licence": "Public record of Kent County, redistributed as published.",
                "how_to_update": "Run refresh_addresses.py. Re-run it after "
                                 "refresh_precincts.py, since the precinct a "
                                 "parcel falls in is baked in here.",
                "deliberately_omitted": "Owner names, parcel ids and valuations "
                                        "are read from the source and discarded. "
                                        "This file is served to browsers.",
            },
            "mcd": mcd,
            "jurisdiction": name,
            "precincts": codes,
            "streets": placed,
        }
        path = OUT_DIR / f"{mcd}.json"
        path.write_text(json.dumps(document, separators=(",", ":")) + "\n")
        table.append((name, count, len(placed), path.stat().st_size))

    missing = {p["code"] for p in props} - covered
    if missing:
        names = sorted(p["name"] for p in props if p["code"] in missing)
        raise SystemExit(f"REFUSING to write: no addresses landed in {names}")
    if total < MIN_ADDRESSES:
        raise SystemExit(f"REFUSING to write: only {total:,} addresses placed "
                         f"(expected at least {MIN_ADDRESSES:,})")

    print(f"\nplaced {total:,} addresses across {len(chunks)} jurisdictions")
    print(f"  outside every precinct  : {outside:,}")
    print(f"  unparsable address text : {unparsed:,}")
    print(f"  spanning two precincts  : {total_ambiguous:,}")
    print(f"\n{'jurisdiction':<26}{'addresses':>10}{'streets':>9}{'KB':>7}")
    for name, count, streets_n, size in sorted(table, key=lambda r: -r[1]):
        print(f"{name:<26}{count:>10,}{streets_n:>9,}{size/1024:>7.0f}")


if __name__ == "__main__":
    sys.exit(main())
