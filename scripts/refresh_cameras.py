#!/usr/bin/env python3
# Released into the public domain under the Unlicense, see UNLICENSE.
"""Pull known ALPR camera positions across Kent County from OpenStreetMap via
Overpass, and write the cached camera floor (site/data/cameras.json).

This is the ONLY camera source. The browser used to be able to re-query
Overpass live, adding to this set but never showing fewer; that control is
gone, so the page shows exactly what this script last wrote and nothing
corrects it at read time. So this file must be complete: the pull walks an endpoint fallback chain and REFUSES to write a
truncated result (Overpass signals truncation with a 'remark' at HTTP 200, and
its main front 504s under load). A busy mirror is retried, with a growing
wait; a truncated answer is not, because asking again returns the same one.

Every ALPR node counts, all operators and zones: police, Flock, retail, HOA.
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from provenance import provenance

# Kent County with ~2km margin (S, W, N, E) for Overpass. The county's own
# precinct polygons span 42.768..43.294 N, -85.791..-85.310 W.
#
# This was the Grand Rapids city bbox (42.87, -85.78, 43.05, -85.55) until the
# lookup went county-wide. That bbox is 373 km2 of a 2,280 km2 county: outside
# it there were no cameras ON FILE, which is not the same fact as no cameras,
# and the page would have told a Rockford voter their trip passed none. A
# camera set that stops at a line the reader cannot see is worse than no
# avoidance at all, because it reads as a clean bill of health.
BBOX = (42.75, -85.81, 43.31, -85.29)

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
UA = "vote-gr/1.0 (+https://github.com/DT616/votegr)"

# Overpass answers 504 when it is busy, and the three public mirrors get busy
# at the same times of day, so one pass over them all can come back empty for
# a reason that is gone a minute later. Two of six scheduled runs failed that
# way in a week, on 2026-09-06 and 2026-09-08, every endpoint 504 or timed
# out within the same three minutes.
#
# So the walk is tried more than once, and the wait between tries grows. It
# grows because the failure being retried is "this server is overloaded":
# coming straight back is what an overloaded server least needs, and is how a
# polite client turns an outage into its own contribution to one. Three
# rounds and a minute then four is about eight minutes of patience, which a
# daily job has and a busy mirror usually needs less of.
ROUNDS = 3
ROUND_BACKOFF_S = (60, 240)      # between rounds, not before the first
ENDPOINT_PAUSE_S = 2             # between endpoints inside one round
# 429 is the server saying how long to wait, which beats guessing, but a
# header can say an hour and this job will not hold a runner that long.
RETRY_AFTER_CAP_S = 300
OUT = Path(__file__).resolve().parent.parent / "site" / "data" / "cameras.json"
MIN_CAMERAS = 20   # GR metro has hundreds; a handful back = truncated/broken
# Widening the box must not LOSE cameras. Overpass returning a clean but
# short result is indistinguishable from a real decline unless we say what
# we already had, and a silent drop here quietly re-opens the exact hole
# this widening closes.
FLOOR_IS_PREVIOUS = True

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


def _retry_after(error):
    """The wait a 429 asked for, in seconds, or None if it did not ask."""
    if not isinstance(error, urllib.error.HTTPError) or error.code != 429:
        return None
    raw = (error.headers or {}).get("Retry-After")
    try:
        return min(max(int(str(raw).strip()), 1), RETRY_AFTER_CAP_S)
    except (TypeError, ValueError):
        return RETRY_AFTER_CAP_S      # asked to wait, would not say how long


def fetch_result():
    """A complete Overpass answer, or None once the patience runs out.

    Truncation is NOT retried against the same endpoint. A 'remark' saying
    the query timed out server-side means this bounding box is more than that
    mirror will do right now, and asking again is how you get the same
    truncated answer twice; the next endpoint is the useful move.
    """
    asked = 0
    for attempt in range(ROUNDS):
        if attempt:
            wait = ROUND_BACKOFF_S[min(attempt - 1, len(ROUND_BACKOFF_S) - 1)]
            print(f"every endpoint declined; waiting {wait}s before round "
                  f"{attempt + 1} of {ROUNDS}")
            time.sleep(wait)
        for ep in ENDPOINTS:
            try:
                print(f"trying {ep} ...")
                asked += 1
                j = _query(ep)
            except Exception as e:  # noqa: BLE001 - fall through to next endpoint
                print(f"  failed: {e}")
                told = _retry_after(e)
                if told:
                    print(f"  429: waiting the {told}s it asked for")
                time.sleep(told if told else ENDPOINT_PAUSE_S)
                continue
            if "remark" in j and ("timed out" in j["remark"].lower()
                                  or "truncated" in j["remark"].lower()):
                print(f"  REMARK signals truncation: {j['remark']!r}; next endpoint")
                time.sleep(ENDPOINT_PAUSE_S)
                continue
            if attempt:
                print(f"  succeeded on round {attempt + 1} after {asked} request(s)")
            return j
    return None


def main():
    result = fetch_result()

    if result is None:
        sys.exit(f"REFUSE: no complete Overpass result from any endpoint, "
                 f"after {ROUNDS} rounds over {len(ENDPOINTS)} endpoints")

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

    # Every camera we already published must still be here. A strictly larger
    # bbox cannot honestly return fewer, so a drop means a truncated answer
    # dressed up as a complete one -- which is the one failure this file's
    # whole design is against.
    if FLOOR_IS_PREVIOUS and OUT.exists():
        try:
            had = {c["id"] for c in json.loads(OUT.read_text()).get("cameras", [])}
        except (ValueError, KeyError):
            had = set()
        lost = had - {c["id"] for c in cams}
        if lost:
            sys.exit(f"REFUSE: {len(lost)} camera(s) in the committed file are "
                     f"missing from this result, e.g. {sorted(lost)[:5]}. A wider "
                     "bbox cannot return fewer; treat this as a truncated query.")

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
