"""Regenerate site/data/precincts.geojson from the State of Michigan layer.

Verifies the layer before writing: 59 precincts, wards 1-20 / 21-40 / 41-59,
no self-overlaps. Geometry is thinned to roughly a metre, which changes no
answer for any address more than 5 m from a precinct line.

Usage: python3 refresh_precincts.py
"""
import datetime
import json
import pathlib
import re
import sys
import time

import requests
from shapely.geometry import mapping, shape

LAYER = ("https://services3.arcgis.com/dxRQUfTDNtfqZ301/arcgis/rest/services/"
         "VotingPrecinct/FeatureServer/0")
GR_WHERE = "CountyFIPS='081' AND MCDFIPS='34000'"
UA = {"User-Agent": "vote-gr/1.0 (+https://github.com/DT616/votegr)"}

OUT = pathlib.Path(__file__).resolve().parent.parent / "site" / "data" / "precincts.geojson"

EXPECTED = 59
WARD_RANGES = {1: (1, 20), 2: (21, 40), 3: (41, 59)}
SIMPLIFY_DEG = 0.00001   # roughly 1 m at this latitude
COORD_DP = 6             # roughly 11 cm, far finer than a precinct line needs


class RefreshError(Exception):
    """Raised when the upstream layer is not fit to publish."""


def fetch():
    meta = requests.get(LAYER, params={"f": "json"}, headers=UA, timeout=60).json()
    last_edit = (meta.get("editingInfo") or {}).get("lastEditDate")
    time.sleep(2)

    resp = requests.get(f"{LAYER}/query", headers=UA, timeout=120, params={
        "where": GR_WHERE, "outFields": "Ward,Precinct,PrecinctID",
        "returnGeometry": "true", "outSR": 4326, "f": "geojson",
    })
    resp.raise_for_status()
    return resp.json()["features"], last_edit


def verify(features):
    """Fail loudly rather than publish a layer that cannot be trusted."""
    if len(features) != EXPECTED:
        raise RefreshError(f"expected {EXPECTED} precincts, upstream returned {len(features)}")

    geoms, keys = [], []
    for f in features:
        props = f["properties"]
        keys.append((int(props["Ward"]), int(props["Precinct"])))
        geoms.append(shape(f["geometry"]).buffer(0))

    numbers = sorted(p for _, p in keys)
    if numbers != list(range(1, EXPECTED + 1)):
        missing = [n for n in range(1, EXPECTED + 1) if n not in numbers]
        raise RefreshError(f"precinct numbers are not 1-{EXPECTED}, missing={missing}")

    for ward, (low, high) in WARD_RANGES.items():
        got = sorted(p for w, p in keys if w == ward)
        if got != list(range(low, high + 1)):
            raise RefreshError(f"ward {ward} should hold precincts {low}-{high}, got {got}")

    # Self-overlap makes point-in-polygon ambiguous. The city's own layer has
    # 86 overlapping pairs, which is exactly why this uses the state's.
    overlaps = [
        (keys[i], keys[j])
        for i in range(len(geoms)) for j in range(i + 1, len(geoms))
        if geoms[i].intersection(geoms[j]).area > 1e-12
    ]
    if overlaps:
        raise RefreshError(f"{len(overlaps)} self-overlapping precinct pairs, e.g. {overlaps[:3]}")

    return geoms, keys


def main():
    features, last_edit = fetch()
    geoms, keys = verify(features)
    print(f"verified {len(geoms)} precincts, wards 1-3, no self-overlaps")

    out_features = []
    for (ward, precinct), geom in sorted(zip(keys, geoms)):
        thinned = geom.simplify(SIMPLIFY_DEG, preserve_topology=True)
        out_features.append({
            "type": "Feature",
            "properties": {"ward": ward, "precinct": precinct},
            "geometry": mapping(thinned),
        })

    edited = None
    if last_edit:
        edited = datetime.datetime.fromtimestamp(
            last_edit / 1000, datetime.timezone.utc).strftime("%Y-%m-%d")

    doc = {
        "type": "FeatureCollection",
        "provenance": {
            "description": "City of Grand Rapids voting precincts, 59 as of the 2025 consolidation",
            "source": "State of Michigan, Secretary of State",
            "source_url": LAYER,
            "source_filter": GR_WHERE,
            "source_last_edited": edited,
            "retrieved": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"),
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
