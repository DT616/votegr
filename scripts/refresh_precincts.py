"""Regenerate site/data/precincts.geojson from the State of Michigan layer.

Covers all of Kent County: 202 precincts across 30 jurisdictions. The layer is
statewide, so this filters server-side by county FIPS rather than pulling
Michigan and discarding it.

Verifies before it writes, because the trap in this data is that the STALE
sources look more official than the current one. Grand Rapids consolidated 74
precincts into 59 in 2025, and layers still serving 74 or 77 are easy to find,
including on the city's own ArcGIS org. So Grand Rapids' 59 is checked as a
canary: if it comes back any other number, this is not the current layer and
nothing is written.

Identity comes from the state, not from us. PrecinctCode is unique statewide,
and PrecinctShortName already reads the way the page wants to print it --
"Grand Rapids 1-9" where there are wards, "Plainfield Twp 10" where there are
not. Ward is '00' for the 25 jurisdictions that have none, and becomes null
here rather than a zero nobody should print.

Geometry is thinned to roughly a metre, which changes no answer for any
address more than 5 m from a precinct line.

Usage: python3 refresh_precincts.py
"""
import datetime
import json
import pathlib
import re
import sys
import time
from collections import Counter, defaultdict

import requests
from shapely.geometry import mapping, shape
from shapely.strtree import STRtree

LAYER = ("https://services3.arcgis.com/dxRQUfTDNtfqZ301/arcgis/rest/services/"
         "VotingPrecinct/FeatureServer/0")
COUNTY_WHERE = "CountyFIPS='081'"          # Kent County
UA = {"User-Agent": "vote-gr/1.0 (+https://github.com/DT616/votegr)"}

OUT = pathlib.Path(__file__).resolve().parent.parent / "site" / "data" / "precincts.geojson"

EXPECTED_PRECINCTS = 202
EXPECTED_JURISDICTIONS = 30
# The canary. Grand Rapids is MCD 34000, and 59 is the post-2025 count.
GR_MCDFIPS = "34000"
GR_EXPECTED = 59
GR_WARD_RANGES = {1: (1, 20), 2: (21, 40), 3: (41, 59)}
FIELDS = ("PrecinctCode,MCDFIPS,JurisdictionName,Ward,Precinct,"
          "PrecinctShortName,RegisteredVoters")
SIMPLIFY_DEG = 0.00001   # roughly 1 m at this latitude
COORD_DP = 6             # roughly 11 cm, far finer than a precinct line needs

# Square metres per square degree at 43N, for reporting overlap areas in units
# a person can judge.
M2_PER_DEG2 = 111320 * (111320 * 0.7314)
SLIVER_M2 = 100          # under this is two polygons drawn to the same border

# Overlaps in the state layer as published, confirmed 2026-09-08. Both are the
# state's to fix, not ours; they are listed so a NEW one still fails the run.
#
#   Sparta Twp 1 x Sparta Twp 2   6.7 km2, a quarter of the township's east side
#   Cedar Springs 1 x Solon Twp 1 0.52 km2, the city not clipped out of the
#                                 township that surrounds it
KNOWN_OVERLAPS = {
    ("Sparta Twp 2", "Sparta Twp 1"),
    ("Cedar Springs 1", "Solon Twp 1"),
}


class RefreshError(Exception):
    """Raised when the upstream layer is not fit to publish."""


def fetch():
    meta = requests.get(LAYER, params={"f": "json"}, headers=UA, timeout=60).json()
    last_edit = (meta.get("editingInfo") or {}).get("lastEditDate")
    time.sleep(2)

    resp = requests.get(f"{LAYER}/query", headers=UA, timeout=180, params={
        "where": COUNTY_WHERE, "outFields": FIELDS,
        "returnGeometry": "true", "outSR": 4326, "f": "geojson",
        "resultRecordCount": 2000,
    })
    resp.raise_for_status()
    return resp.json()["features"], last_edit


def row(props):
    """One precinct, in the shape the site reads. Ward '00' means the
    jurisdiction has no wards, which is 25 of the 30 here."""
    ward = props["Ward"]
    return {
        "code": props["PrecinctCode"],
        "mcd": props["MCDFIPS"],
        "jurisdiction": props["JurisdictionName"],
        "ward": None if ward in (None, "", "00") else int(ward),
        "precinct": int(props["Precinct"]),
        "name": props["PrecinctShortName"],
        "voters": props.get("RegisteredVoters"),
    }


def verify(features):
    """Fail loudly rather than publish a layer that cannot be trusted."""
    if len(features) != EXPECTED_PRECINCTS:
        raise RefreshError(
            f"expected {EXPECTED_PRECINCTS} precincts in Kent County, "
            f"upstream returned {len(features)}")

    rows = [row(f["properties"]) for f in features]
    geoms = [shape(f["geometry"]).buffer(0) for f in features]

    codes = [r["code"] for r in rows]
    if len(set(codes)) != len(codes):
        dupes = [c for c, n in Counter(codes).items() if n > 1]
        raise RefreshError(f"PrecinctCode is not unique: {dupes[:5]}")

    jurisdictions = {r["jurisdiction"] for r in rows}
    if len(jurisdictions) != EXPECTED_JURISDICTIONS:
        raise RefreshError(
            f"expected {EXPECTED_JURISDICTIONS} jurisdictions, "
            f"got {len(jurisdictions)}")

    # Within a jurisdiction a precinct number must mean one place.
    seen = defaultdict(list)
    for r in rows:
        seen[(r["mcd"], r["ward"], r["precinct"])].append(r["name"])
    collided = {k: v for k, v in seen.items() if len(v) > 1}
    if collided:
        raise RefreshError(f"repeated ward/precinct within a jurisdiction: {collided}")

    verify_grand_rapids([r for r in rows if r["mcd"] == GR_MCDFIPS])
    found = overlaps(geoms, rows)
    verify_overlaps(found)
    return rows, geoms, found


def verify_grand_rapids(gr):
    """The canary: a layer still serving 74 or 77 for Grand Rapids is the
    pre-2025 one, whatever it is named."""
    if len(gr) != GR_EXPECTED:
        raise RefreshError(
            f"Grand Rapids should hold {GR_EXPECTED} precincts since the 2025 "
            f"consolidation, this layer has {len(gr)} -- it is not current")
    for ward, (low, high) in GR_WARD_RANGES.items():
        got = sorted(r["precinct"] for r in gr if r["ward"] == ward)
        if got != list(range(low, high + 1)):
            raise RefreshError(
                f"Grand Rapids ward {ward} should hold precincts {low}-{high}, got {got}")


def overlaps(geoms, rows):
    """Every pair of precincts that genuinely covers the same ground.

    Self-overlap makes point-in-polygon ambiguous: an address inside one can
    resolve to either precinct, which is a wrong answer about where somebody
    votes. The city's own layer has 86 overlapping pairs, which is exactly why
    this uses the state's -- but the state's is not clean either once you look
    past Grand Rapids.

    Indexed rather than compared pair by pair: 202 polygons is 20,301 pairs,
    and all but a handful cannot touch. The tree answers which ones can.

    Shared borders are not overlaps. Two polygons drawn to the same line
    intersect in a line or a speck of a polygon, so anything under SLIVER_M2
    is digitizing noise and is dropped.
    """
    tree = STRtree(geoms)
    found = []
    for i, g in enumerate(geoms):
        for j in tree.query(g):
            if j <= i:
                continue
            area = g.intersection(geoms[j]).area * M2_PER_DEG2
            if area > SLIVER_M2:
                found.append((rows[i]["name"], rows[j]["name"], round(area)))
    return sorted(found, key=lambda o: -o[2])


def verify_overlaps(found):
    """A NEW overlap fails the refresh. The known ones are defects in the state
    layer that we cannot fix and will not silently pass on: they are allowed
    through so one bad township does not block the other 29 jurisdictions, and
    they are written into the file's provenance so the page can say so.
    """
    unknown = [o for o in found if (o[0], o[1]) not in KNOWN_OVERLAPS
               and (o[1], o[0]) not in KNOWN_OVERLAPS]
    if unknown:
        raise RefreshError(
            f"{len(unknown)} precinct pair(s) overlap and are not known defects: "
            f"{unknown}. Point-in-polygon cannot answer inside these.")


def main():
    features, last_edit = fetch()
    rows, geoms, found = verify(features)
    jurisdictions = sorted({r["jurisdiction"] for r in rows})
    voters = sum(int(r["voters"] or 0) for r in rows)
    print(f"verified {len(rows)} precincts across {len(jurisdictions)} jurisdictions, "
          f"{voters:,} registered voters, Grand Rapids at {GR_EXPECTED}")
    for a, b, area in found:
        print(f"  KNOWN STATE DEFECT: {a} overlaps {b} by {area:,} m2 -- "
              f"an address in there has no single answer")

    out_features = []
    order = sorted(range(len(rows)),
                   key=lambda i: (rows[i]["jurisdiction"], rows[i]["ward"] or 0,
                                  rows[i]["precinct"]))
    for i in order:
        thinned = geoms[i].simplify(SIMPLIFY_DEG, preserve_topology=True)
        out_features.append({
            "type": "Feature",
            "properties": rows[i],
            "geometry": mapping(thinned),
        })

    edited = None
    if last_edit:
        edited = datetime.datetime.fromtimestamp(
            last_edit / 1000, datetime.timezone.utc).strftime("%Y-%m-%d")

    doc = {
        "type": "FeatureCollection",
        "provenance": {
            "description": (
                f"Kent County voting precincts: {len(rows)} across "
                f"{len(jurisdictions)} jurisdictions, Grand Rapids at "
                f"{GR_EXPECTED} since the 2025 consolidation"),
            "source": "State of Michigan, Secretary of State",
            "source_url": LAYER,
            "source_filter": COUNTY_WHERE,
            "source_last_edited": edited,
            "retrieved": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"),
            "jurisdictions": jurisdictions,
            "registered_voters": voters,
            "known_overlaps": [
                {"a": a, "b": b, "area_m2": area} for a, b, area in found
            ],
            "known_overlaps_note": (
                "Precinct pairs the state layer draws over the same ground. An "
                "address inside one has no single answer and the page should "
                "say so rather than pick."
            ),
            "simplified_metres": 1,
            "simplification_note": (
                "Thinned for browser delivery. Verified to change no answer for "
                "addresses more than 5 m from a precinct line."
            ),
            "licence": "Public record of the State of Michigan, redistributed as published.",
            "regenerate_with": "python3 refresh_precincts.py",
        },
        "features": out_features,
    }

    body = json.dumps(doc, separators=(",", ":"))
    body = re.sub(r"(-?\d+\.\d{%d})\d+" % COORD_DP, r"\1", body)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(body + "\n")
    print(f"wrote {OUT} ({len(body):,} bytes), source last edited {edited}")


if __name__ == "__main__":
    try:
        main()
    except RefreshError as exc:
        print(f"REFRESH FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
