#!/usr/bin/env python3
"""Stamp coordinates onto every polling place, drop box and early voting site.

Grand Rapids has always placed its destinations by interpolating along the
street centreline in the routing graph. That works, but it puts a marker on
the road outside the building rather than on the building, and outside the
city there was nothing at all: all 202 county polling places and all 23 drop
boxes arrive from the county as a name and an address string, with no
coordinate anywhere. No coordinate means no marker, no distance and no route.

The county's own parcel layer already has the answer, and this project already
reads it. refresh_addresses.py pulls the centroid of every addressed parcel in
Kent County -- about 232,000 of them -- uses it to decide which precinct the
address is in, and then throws the coordinate away. That discard is right for
the published address files, which are served to browsers and must not become
an address-to-owner index. It is wrong for 263 buildings that are public
polling places. So this reads the same layer and keeps the centroid for those.

A parcel centroid beats an interpolated centreline point: it is the building's
own parcel rather than a guess at where along the block it sits.

WHAT THIS DOES NOT DO: invent a coordinate. An address that does not match a
parcel is left without one and reported, because a marker in the wrong place
is worse than no marker -- somebody drives to it. The misses are listed at the
end so they can be looked at rather than averaged away.

Usage: python3 geocode_places.py [--parcels CACHE.json]
"""
import argparse
import json
import pathlib
import re
import time
from collections import defaultdict

import requests

ROOT = pathlib.Path(__file__).resolve().parent.parent
POLLING_DIR = ROOT / "site" / "data" / "polling"
EARLY_VOTING = ROOT / "site" / "data" / "early-voting.json"
PRECINCTS = ROOT / "site" / "data" / "precincts.json"

# A matched address must land in the jurisdiction that published it. This is
# the check that makes an inferred quadrant safe to accept: "8350 Byron Center
# Avenue" with no quadrant could be SW or NE, and the two are twelve miles
# apart. Byron Township's own bounding box settles it, and rejects the match
# outright if neither fits rather than picking one.
#
# The margin is generous on purpose. A jurisdiction's polling place is
# occasionally just outside its line -- Plainfield Township votes at two
# buildings the county addresses as Grand Rapids -- and this is a sanity
# check against a match in the wrong END OF THE COUNTY, not a boundary test.
BBOX_MARGIN_DEG = 0.02   # ~2.2km

# Street suffixes and directionals, as the county's parcel layer writes them.
# The clerks write them long ("Avenue", "Drive"), abbreviated ("Ave.", "Dr."),
# or not at all; the parcel layer is consistent, so everything is folded to
# the parcel layer's spelling rather than to some third normal form.
SUFFIX = {
    "AVENUE": "AVE", "AV": "AVE",
    "STREET": "ST", "STR": "ST",
    "DRIVE": "DR",
    "ROAD": "RD",
    "BOULEVARD": "BLVD", "BLVD": "BLVD",
    "COURT": "CT",
    "PLACE": "PL",
    "LANE": "LN",
    "TERRACE": "TER", "TERR": "TER",
    "PARKWAY": "PKWY",
    "CIRCLE": "CIR",
    "HIGHWAY": "HWY",
    "SQUARE": "SQ",
    "TRAIL": "TRL",
    "EXPRESSWAY": "EXPY",
}
QUADRANT = {"NE", "NW", "SE", "SW", "N", "S", "E", "W"}
# Type words as the parcel layer writes them, for stripping. The clerks and
# the county DISAGREE about these: the parcel layer calls it BRETON AVE SE
# where Kentwood's clerk writes "4950 Breton Road SE", and writes ALDEN NASH
# AVE SE where Bowne Township writes "8240 Alden Nash SE". Matching on the
# full street therefore misses; matching on the name with the type removed,
# but the QUADRANT kept, does not. The quadrant is never dropped -- that is
# the half that decides which side of the county you are on.
TYPE_WORDS = {"AVE", "ST", "DR", "RD", "BLVD", "CT", "PL", "LN", "TER",
              "PKWY", "CIR", "HWY", "SQ", "TRL", "EXPY", "WAY", "RUN"}
# "East Main Street" is "E MAIN ST" in the parcel layer.
LEADING = {"EAST": "E", "WEST": "W", "NORTH": "N", "SOUTH": "S"}
# "88 Eighth Street" is "88 8TH ST".
ORDINALS = {"FIRST": "1ST", "SECOND": "2ND", "THIRD": "3RD", "FOURTH": "4TH",
            "FIFTH": "5TH", "SIXTH": "6TH", "SEVENTH": "7TH", "EIGHTH": "8TH",
            "NINTH": "9TH", "TENTH": "10TH", "ELEVENTH": "11TH",
            "TWELFTH": "12TH"}
# A part like "Room 105" or "Suite 200" is inside the building, not a street,
# and is written after the address rather than before it.
INTERIOR = {"ROOM", "RM", "SUITE", "STE", "UNIT", "APT", "APARTMENT",
            "FLOOR", "FL", "BLDG", "BUILDING", "LOWER", "UPPER"}


def norm_street(text):
    """'Grand River Dr. NE' -> 'GRAND RIVER DR NE'.

    Periods and double spaces go, the suffix is folded to the parcel layer's
    abbreviation, and the quadrant is preserved -- losing NE/SE puts a voter
    on the wrong side of the county, which is the one error this whole tool
    exists to prevent.
    """
    words = re.sub(r"[.,]", " ", text.upper()).split()
    return " ".join(ORDINALS.get(w, SUFFIX.get(w, w)) for w in words)


def street_core(street):
    """'BRETON RD SE' -> ('BRETON', 'SE'). The name, and the quadrant.

    The type word comes off because the two sources disagree about it; the
    quadrant stays on because they never disagree about that and it is what
    separates 1201 Madison SE from 1201 Madison NE.
    """
    words = street.split()
    quadrant = words.pop() if words and words[-1] in QUADRANT else None
    if words and words[-1] in TYPE_WORDS:
        words.pop()
    if words and words[0] in LEADING:
        words[0] = LEADING[words[0]]
    return " ".join(words), quadrant


def split_address(text):
    """A clerk's location string -> (house number, normalised street), or None.

    Handles the three shapes that actually occur in the sources:

      '655 Spaulding Avenue SE'                        -> (655, 'SPAULDING AVE SE')
      'KDL-Amy Van Andel Library, 7215 Headley St. SE' -> (7215, 'HEADLEY ST SE')
      'EGR Community Center, 750 Lakeside Dr. SE, Room 105'
                                                       -> (750, 'LAKESIDE DR SE')
      'North Complex'                                  -> None

    The county writes early voting sites as a building name, then the address,
    and sometimes then a room. So the comma parts are scanned rather than the
    last one taken: the address is the first part that begins with a number
    and is not an interior reference. Taking the last part put a voter in
    'Room 105'; taking the first put them at the building's name.
    """
    text = " ".join(str(text or "").split())
    if not text:
        return None
    for part in [p.strip() for p in text.split(",")] or [text]:
        match = re.match(r"^(\d+)\s+(.+)$", part)
        if not match:
            continue
        street = norm_street(match.group(2))
        if not street or street.split()[0] in INTERIOR:
            continue
        return int(match.group(1)), street
    return None


PARCELS = ("https://gis.kentcountymi.gov/agisprod/rest/services/"
           "ParcelsWithCondos/FeatureServer/0/query")
UA = {"User-Agent": "vote-gr/1.0 (+https://github.com/DT616/votegr)"}
PAGE = 1000            # the layer's own maxRecordCount; asking for more is clamped
DELAY_SECONDS = 1.0    # be a polite guest on someone else's server


def fetch_parcels():
    """Every addressed parcel in the county, as (address, lng, lat).

    The same query refresh_addresses.py makes, repeated here rather than
    imported: that module needs shapely to do its precinct work, and this one
    needs nothing but the centroid. A geocoder that cannot run without a
    geometry library it never calls is a geocoder people stop running.
    """
    rows, offset = [], 0
    while True:
        params = {
            "where": "PROPERTYADDRESS IS NOT NULL",
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
        if offset % 25000 == 0:
            print(f"  {len(rows):,} parcels", flush=True)
        if not data.get("exceededTransferLimit") or not features:
            print(f"  {len(rows):,} parcels", flush=True)
            return rows
        offset += len(features)
        time.sleep(DELAY_SECONDS)


def load_parcels(cache):
    """(address, lng, lat) rows, from the cache or straight from the county."""
    if cache and cache.exists():
        rows = json.loads(cache.read_text())
        print(f"read {len(rows):,} parcels from {cache}")
        return rows
    rows = fetch_parcels()
    if cache:
        cache.write_text(json.dumps(rows, separators=(",", ":")))
    return rows


def build_index(parcels):
    """(number, street) -> (lng, lat), averaged over the parcels that share it.

    A condo building files one parcel per unit at the same street address.
    Their centroids are metres apart and all of them are the building, so the
    mean is the building. Where an address somehow spans a wider spread that
    is reported rather than averaged, because it means the two are not the
    same place.
    """
    exact, loose = defaultdict(list), defaultdict(list)
    for text, lng, lat in parcels:
        key = split_address(text)
        if not key:
            continue
        number, street = key
        exact[key].append((lng, lat))
        core, quadrant = street_core(street)
        loose[(number, core, quadrant)].append((lng, lat))
    print(f"indexed {len(exact):,} addresses "
          f"({len(loose):,} type-insensitive keys)")
    return exact, loose


def one_place(points):
    """The mean of these parcels, or None if they are not one building.

    A condo building files a parcel per unit at the same address; their
    centroids are metres apart and averaging them gives the building. Two
    genuinely different places that share a number must NOT be averaged into
    a point between them, which is a coordinate in neither of them.
    """
    if not points:
        return None
    lngs = [p[0] for p in points]
    lats = [p[1] for p in points]
    # ~250m at this latitude: wider than any condo block, narrower than two
    # different buildings.
    if max(lngs) - min(lngs) > 0.003 or max(lats) - min(lats) > 0.0023:
        return None
    return (round(sum(lngs) / len(lngs), 6), round(sum(lats) / len(lats), 6))


def geocode(index, text):
    """(lat, lng, how) for a location string, or None. Three tries, narrowing."""
    exact, loose = index
    key = split_address(text)
    if not key:
        return None
    number, street = key

    point = one_place(exact.get(key))
    if point:
        return point[1], point[0], "exact"

    core, quadrant = street_core(street)
    point = one_place(loose.get((number, core, quadrant)))
    if point:
        return point[1], point[0], "street type ignored"

    # The clerk wrote no quadrant at all. Accept one only when exactly one
    # quadrant of that street carries the number: 10515 Grange with a single
    # Grange Ave NE is unambiguous, and choosing between two would not be.
    if quadrant is None:
        rivals = [(k, v) for k, v in loose.items()
                  if k[0] == number and k[1] == core]
        if len(rivals) == 1:
            point = one_place(rivals[0][1])
            if point:
                return point[1], point[0], f"quadrant inferred {rivals[0][0][2]}"
    return None


def load_bboxes():
    """MCD code -> (south, west, north, east), from the precinct index."""
    index = json.loads(PRECINCTS.read_text())
    return {j["mcd"]: j["bbox"] for j in index["jurisdictions"] if j.get("bbox")}


def inside(bbox, lat, lng):
    if not bbox:
        return True
    south, west, north, east = bbox
    return (south - BBOX_MARGIN_DEG <= lat <= north + BBOX_MARGIN_DEG
            and west - BBOX_MARGIN_DEG <= lng <= east + BBOX_MARGIN_DEG)


def stamp(record, address_text, index, stats, misses, label, bbox=None):
    """Add lat/lng to one record. Returns True when it landed."""
    found = geocode(index, address_text)
    if found and not inside(bbox, found[0], found[1]):
        stats["outside"] += 1
        misses.append((label, f"{address_text} [matched outside the jurisdiction]"))
        return False
    if not found:
        stats["miss"] += 1
        misses.append((label, address_text))
        return False
    lat, lng, how = found
    record["lat"], record["lng"] = lat, lng
    record["geocode"] = how
    stats["hit"] += 1
    stats[how.split(" ")[0] if how.startswith("quadrant") else how] += 1
    stats["quadrant inferred"] += how.startswith("quadrant")
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--parcels", type=pathlib.Path, default=None,
                        help="cache file of (address, lng, lat) rows")
    parser.add_argument("--dry-run", action="store_true",
                        help="report the hit rate and write nothing")
    args = parser.parse_args()

    index = build_index(load_parcels(args.parcels))
    bboxes = load_bboxes()
    # Grand Rapids keeps its own polling places, hand-transcribed WITH
    # coordinates in polling.json, and that file is better than anything
    # derivable here. The county's scrape of the same 59 precincts is the
    # cross-check, not the source, so it is not geocoded.
    skip_mcd = {"34000"}
    stats, misses, pending = defaultdict(int), [], []

    for path in sorted(POLLING_DIR.glob("*.json")):
        document = json.loads(path.read_text())
        where = document["jurisdiction"]
        if document["mcd"] in skip_mcd:
            continue
        bbox = bboxes.get(document["mcd"])
        for code, place in (document.get("precincts") or {}).items():
            stamp(place, place.get("address"), index, stats, misses,
                  f"{where} polling {place.get('name', code)}", bbox)
        # The county's drop box rows put the ADDRESS in `name` and the
        # location note in `address` -- the opposite of the city clerk's file.
        # Read as written rather than renaming the fields here: the scrape is
        # the record of what the page said.
        for box in (document.get("drop_boxes") or []):
            stamp(box, box.get("name"), index, stats, misses,
                  f"{where} drop box {box.get('name')}", bbox)
        pending.append((path, document))

    early = json.loads(EARLY_VOTING.read_text())
    for mcd, site in early["sites"].items():
        placed = []
        for location in site["locations"]:
            record = {"text": location}
            stamp(record, location, index, stats, misses,
                  f"{site['jurisdiction']} early voting", bboxes.get(mcd))
            placed.append(record)
        site["located"] = placed
    pending.append((EARLY_VOTING, early))

    total = stats["hit"] + stats["miss"] + stats["outside"]
    print(f"\n{stats['hit']}/{total} located "
          f"({100 * stats['hit'] / total:.1f}%)")
    for how in ("exact", "street type ignored", "quadrant inferred"):
        if stats[how]:
            print(f"  {how:<24}{stats[how]}")
    if stats["outside"]:
        print(f"  rejected, wrong area   {stats['outside']}")
    if misses:
        print(f"\n{len(misses)} without a coordinate:")
        for label, text in misses:
            print(f"  {label:<52} {text!r}")

    if args.dry_run:
        print("\n--dry-run: nothing written")
        return
    for path, document in pending:
        path.write_text(json.dumps(document, separators=(",", ":")) + "\n")
    print(f"\nwrote {len(pending)} files")


if __name__ == "__main__":
    main()
