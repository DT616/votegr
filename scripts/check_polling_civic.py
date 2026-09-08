#!/usr/bin/env python3
"""Check the committed polling places against Google Civic, and report
disagreements. Never stores what Google returns.

votegr's polling places are transcribed by hand from the City Clerk's precinct
directory, which is the authoritative source and also a PDF that changes under
a new filename every election. The failure that matters is a voter sent to a
building that stopped being a polling place. This script catches it: in the
weeks when the Voting Information Project has published an election, it asks
Google Civic where ONE representative address per precinct votes, compares that
to site/data/polling.json, and reports only the differences.

Three properties this deliberately keeps:

* No visitor ever touches Google. It runs on a runner, at build time, against
  synthetic addresses that belong to no one. The page stays offline-only.
* It is a checker, never a source. Google's developer terms cap caching of
  voting locations at 24 hours, so nothing it returns is written to disk. The
  script holds the answer in memory, compares, and exits. The committed files
  remain the record.
* It fails loudly. A disagreement exits non-zero so a workflow goes red rather
  than logging into the void.

Representative addresses come from site/data/addresses.json, choosing the
address FURTHEST from a precinct edge (the file already carries that distance),
because a third-party geocoder rounding a boundary address into the neighbouring
precinct would be a false alarm about our data.

Usage:
    export GOOGLE_CIVIC_API_KEY=...
    python3 check_polling_civic.py elections        # what VIP has published
    python3 check_polling_civic.py check            # compare GR against Civic
    python3 check_polling_civic.py proof --state DE # prove the logic elsewhere
    python3 check_polling_civic.py selftest         # no key, no network
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://www.googleapis.com/civicinfo/v2"
UA = "vote-gr/1.0 (+https://github.com/DT616/votegr)"
DATA = Path(__file__).resolve().parent.parent / "site" / "data"
CITY = "Grand Rapids"
STATE = "MI"

# Addresses used only to prove the parse-and-compare path against a live feed
# in some other state when Michigan has nothing published. Public buildings,
# chosen because they are stable and belong to no one.
PROOF_ADDRESSES = {
    "DE": [
        "43 South State Street, Dover, DE 19901",
        "10 East Memorial Drive, Newark, DE 19711",
        "100 North Market Street, Wilmington, DE 19801",
    ],
    "RI": [
        "150 Empire Street, Providence, RI 02903",
        "100 Boyd Avenue, East Providence, RI 02914",
    ],
}

# Street-word spellings differ between the clerk's directory and VIP's feed
# ("Avenue" vs "AVE", "Southeast" vs "SE"). Compare a canonical form of each
# rather than the raw strings, or every row reads as a difference.
ABBREV = {
    "STREET": "ST", "AVENUE": "AVE", "BOULEVARD": "BLVD", "DRIVE": "DR",
    "ROAD": "RD", "LANE": "LN", "COURT": "CT", "PLACE": "PL", "TERRACE": "TER",
    "PARKWAY": "PKWY", "CIRCLE": "CIR", "SQUARE": "SQ", "HIGHWAY": "HWY",
    "NORTHWEST": "NW", "NORTHEAST": "NE", "SOUTHWEST": "SW", "SOUTHEAST": "SE",
    "NORTH": "N", "SOUTH": "S", "EAST": "E", "WEST": "W",
}
SUITE = re.compile(r"\b(SUITE|STE|APT|UNIT|RM|ROOM|#)\b.*$")


def canon_address(value):
    """Reduce a street address to what two sources can be expected to agree on:
    the house number and the street, with no city, state, ZIP, or suite."""
    if not value:
        return ""
    text = value.upper().split(",")[0]
    text = SUITE.sub("", text)
    text = re.sub(r"[^A-Z0-9 ]", " ", text)
    words = [ABBREV.get(w, w) for w in text.split()]
    return " ".join(words).strip()


def canon_name(value):
    """Venue names differ more freely than addresses, so this is looser and its
    result is reported, never failed on."""
    if not value:
        return ""
    text = value.upper()
    text = re.sub(r"[^A-Z0-9 ]", " ", text)
    drop = {"THE", "OF", "AT"}
    return " ".join(w for w in text.split() if w not in drop)


def get(path, params):
    key = os.environ.get("GOOGLE_CIVIC_API_KEY")
    if not key:
        sys.exit("GOOGLE_CIVIC_API_KEY is not set. This script needs a key and "
                 "writes it nowhere; in CI it belongs in a repository secret.")
    query = dict(params)
    query["key"] = key
    url = f"{API}/{path}?" + urllib.parse.urlencode(query)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp), None
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace")
        try:
            message = json.loads(body)["error"]["message"]
        except Exception:
            message = body[:200]
        return None, f"HTTP {err.code}: {message}"


def elections():
    payload, error = get("elections", {})
    if error:
        sys.exit(error)
    return payload.get("elections", [])


def pick_election(state):
    """VIP scopes an election to an OCD division. Take the one for this state,
    and never the permanent test election, whose id is 2000."""
    want = f"ocd-division/country:us/state:{state.lower()}"
    for item in elections():
        if item.get("id") == "2000":
            continue
        if item.get("ocdDivisionId", "").startswith(want):
            return item
    return None


def voter_info(address, election_id):
    """One address, one election. Returns the election day polling places, or a
    reason there are none. Nothing here is written to disk."""
    payload, error = get("voterinfoquery",
                         {"address": address, "electionId": election_id})
    if error:
        return None, error
    places = payload.get("pollingLocations") or []
    return [{"name": (p.get("address") or {}).get("locationName", ""),
             "address": " ".join(filter(None, [
                 (p.get("address") or {}).get("line1", ""),
                 (p.get("address") or {}).get("city", ""),
             ]))} for p in places], None


def representative_addresses():
    """One address per precinct, the one furthest from a precinct edge.

    addresses.json rows are [house number, precinct, metres to nearest edge],
    with an optional fourth element listing rival precincts when the address is
    genuinely ambiguous. Those are skipped: an address our own data cannot place
    confidently would produce a disagreement about nothing.
    """
    data = json.loads((DATA / "addresses.json").read_text())
    best = {}
    for street, rows in data["streets"].items():
        for row in rows:
            number, precinct, edge = row[0], row[1], row[2]
            if len(row) > 3 and row[3]:
                continue
            current = best.get(precinct)
            if current is None or edge > current[0]:
                best[precinct] = (edge, f"{number} {street}, {CITY}, {STATE}")
    return {p: addr for p, (_edge, addr) in sorted(best.items(), key=lambda kv: int(kv[0]))}


def expected_place(polling, precinct):
    """Where a precinct actually votes, honouring `consolidated_with` the way
    site/precinct.js does: for one election a precinct can vote at another's
    location, which the clerk records only in the directory's footnotes."""
    place = polling.get(precinct)
    if not place:
        return None, None
    host_id = place.get("consolidated_with")
    host = polling.get(str(host_id)) if host_id is not None else None
    if host:
        return host, str(host_id)
    return place, None


def compare(expected, observed):
    """expected: {'name','address'} from our file. observed: list from Civic.

    Returns a verdict string. Address disagreement is a failure; a name that
    differs while the address matches is worth printing and nothing more,
    because the two sources name buildings differently on purpose.
    """
    if not observed:
        return "NO LOCATION RETURNED"
    ours = canon_address(expected["address"])
    for place in observed:
        if canon_address(place["address"]) == ours:
            if canon_name(place["name"]) != canon_name(expected["name"]):
                return f"name differs: ours {expected['name']!r}, theirs {place['name']!r}"
            return "OK"
    theirs = "; ".join(p["address"] for p in observed)
    return f"ADDRESS DIFFERS: ours {expected['address']!r}, theirs {theirs!r}"


def cmd_elections(_args):
    found = elections()
    if not found:
        print("VIP has published no elections.")
        return 0
    for item in found:
        print(f"{item.get('id'):>6}  {item.get('electionDay')}  "
              f"{item.get('ocdDivisionId','')}  {item.get('name','')}")
    return 0


def cmd_check(args):
    election = pick_election(args.state)
    if not election:
        print(f"No live {args.state} election in VIP today, so there is nothing "
              f"to check against. This is the normal state outside the two to "
              f"four weeks before an election.")
        return 0
    print(f"Checking against {election['name']} ({election['electionDay']}), "
          f"election id {election['id']}.\n")

    polling = json.loads((DATA / "polling.json").read_text())["precincts"]
    addresses = representative_addresses()
    failures = 0
    for precinct, address in addresses.items():
        expected, host = expected_place(polling, precinct)
        if not expected:
            print(f"precinct {precinct:>3}  no polling place in polling.json")
            failures += 1
            continue
        observed, error = voter_info(address, election["id"])
        verdict = error if error else compare(expected, observed)
        if verdict != "OK":
            failures += 1
        note = f"  (consolidated with {host})" if host else ""
        print(f"precinct {precinct:>3}  {verdict}{note}")

    print(f"\n{len(addresses)} precincts checked, {failures} to look at.")
    return 1 if failures else 0


def cmd_proof(args):
    """Michigan is dark most of the year. This runs the same request, parse and
    compare path against whatever state VIP does have live, so the logic is
    proven on real payloads rather than on a fixture we wrote ourselves."""
    election = pick_election(args.state)
    if not election:
        print(f"No live {args.state} election to prove against. Try one of "
              f"{', '.join(PROOF_ADDRESSES)} or check `elections`.")
        return 1
    print(f"Proving against {election['name']} ({election['electionDay']}).\n")

    seen = []
    for address in PROOF_ADDRESSES.get(args.state.upper(), []):
        observed, error = voter_info(address, election["id"])
        if error:
            print(f"{address}\n  {error}")
            continue
        for place in observed:
            print(f"{address}\n  -> {place['name']} | {place['address']}")
        if observed:
            seen.append(observed[0])

    if not seen:
        print("\nNo polling locations came back, so the compare path was not "
              "exercised. That is a real answer about the feed, not a bug here.")
        return 1

    truth = {"name": seen[0]["name"], "address": seen[0]["address"]}
    same = compare(truth, [seen[0]])
    moved = compare({"name": truth["name"], "address": "1 Nowhere St"}, [seen[0]])
    print(f"\ncompare(identical)      -> {same}")
    print(f"compare(moved building) -> {moved}")
    ok = same == "OK" and moved.startswith("ADDRESS DIFFERS")
    print("\nCompare path proven on live data." if ok else "\nCompare path is wrong.")
    return 0 if ok else 1


def cmd_selftest(_args):
    """No key, no network: the normaliser and the differ, which is where the
    bugs live. The API shape is proven by `proof` against a live feed."""
    cases = [
        ("977 WEALTHY ST SW, 49504", "977 Wealthy Street Southwest, Grand Rapids", True),
        ("107 LA GRAVE AVE SE, 49503", "107 La Grave Ave SE, Grand Rapids", True),
        ("2505 MADISON AVE SE, 49507", "2505 Madison Avenue SE Suite 3, Grand Rapids", True),
        ("947 SIBLEY ST NW, 49504", "949 Sibley St NW, Grand Rapids", False),
    ]
    failures = 0
    for ours, theirs, should_match in cases:
        matched = canon_address(ours) == canon_address(theirs)
        if matched != should_match:
            failures += 1
            print(f"FAIL {ours!r} vs {theirs!r}: matched={matched}, "
                  f"expected {should_match}")
        else:
            print(f"ok   {ours!r} vs {theirs!r} -> {'same' if matched else 'different'}")

    expected = {"name": "LaGrave Christian Reformed Church",
                "address": "107 LA GRAVE AVE SE, 49503"}
    checks = [
        ("identical", [{"name": "LaGrave Christian Reformed Church",
                        "address": "107 La Grave Ave SE, Grand Rapids"}], "OK"),
        ("renamed", [{"name": "LaGrave CRC",
                      "address": "107 La Grave Ave SE, Grand Rapids"}], "name differs"),
        ("moved", [{"name": "LaGrave Christian Reformed Church",
                    "address": "50 Monroe Ave NW, Grand Rapids"}], "ADDRESS DIFFERS"),
        ("nothing", [], "NO LOCATION RETURNED"),
    ]
    for label, observed, want in checks:
        verdict = compare(expected, observed)
        if not verdict.startswith(want):
            failures += 1
            print(f"FAIL {label}: {verdict!r} does not start with {want!r}")
        else:
            print(f"ok   {label} -> {verdict}")

    print(f"\n{failures} failure(s).")
    return 1 if failures else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("elections").set_defaults(func=cmd_elections)
    check = sub.add_parser("check")
    check.add_argument("--state", default=STATE)
    check.set_defaults(func=cmd_check)
    proof = sub.add_parser("proof")
    proof.add_argument("--state", default="DE")
    proof.set_defaults(func=cmd_proof)
    sub.add_parser("selftest").set_defaults(func=cmd_selftest)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
