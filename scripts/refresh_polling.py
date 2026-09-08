#!/usr/bin/env python3
"""Scrape Kent County's polling places and drop boxes into
site/data/polling/<mcd>.json, one file per jurisdiction.

The county publishes a page per jurisdiction with the same three sections --
clerk contact, absentee drop boxes with hours, and Election Day polling
locations listed by precinct. So this is one scraper against thirty pages of
identical shape, rather than thirty clerks' websites. That consistency is what
made covering the county tractable at all; it is not the pattern statewide, and
the other 82 counties do not follow it.

Grand Rapids is on the county pages too, so it is scraped like everywhere else
AND compared against site/data/polling.json, the hand transcription from the
City Clerk's precinct directory. The directory stays authoritative for the
city: it carries entrance notes and the consolidation footnotes (one precinct
voting at another's location for a single election) that the county page does
not print. Anything the two disagree about is reported, never silently
resolved -- a polling place the two levels of government describe differently
is exactly the thing a voter needs told.

Nothing here is geocoded. The browser already geocodes the address a voter
types, against the same street chunk it loaded to route them, so it can
geocode the polling place the same way and there is no coordinate to go stale.

Verifies before writing: every precinct in the county must gain a polling
place, and every page's own heading must name the jurisdiction we asked for,
so a renumbered county page fails loudly instead of quietly scraping the wrong
town.

Usage: python3 refresh_polling.py
"""
import html
import json
import pathlib
import re
import sys
import time
import urllib.request
from collections import defaultdict

BASE = "https://www.kentcountymi.gov"
UA = {"User-Agent": "vote-gr/1.0 (+https://github.com/DT616/votegr)"}
DELAY_SECONDS = 2.0            # be a polite guest: 30 pages, one at a time

ROOT = pathlib.Path(__file__).resolve().parent.parent
PRECINCTS = ROOT / "site" / "data" / "precincts.json"
CITY_POLLING = ROOT / "site" / "data" / "polling.json"
OUT_DIR = ROOT / "site" / "data" / "polling"

# MCD FIPS -> the county's page for that jurisdiction. Hardcoded rather than
# scraped from the site navigation so a run is deterministic, and checked
# against each page's own heading so a renumbered id cannot pass silently.
# Note 34260: the state calls it Grand Rapids Township, the county calls it
# Grand Rapids Charter Township, and they are the same place.
PAGES = {
    "00240": "324/Ada-Township",   # Ada Township
    "01160": "383/Algoma-Township",   # Algoma Township
    "01840": "387/Alpine-Township",   # Alpine Township
    "09780": "392/Bowne-Township",   # Bowne Township
    "12240": "393/Byron-Township",   # Byron Township
    "12500": "394/Caledonia-Township",   # Caledonia Township
    "13080": "396/Cannon-Township",   # Cannon Township
    "13660": "397/Cascade-Township",   # Cascade Township
    "14200": "398/Cedar-Springs",   # Cedar Springs
    "18500": "399/Courtland-Township",   # Courtland Township
    "23980": "400/East-Grand-Rapids",   # East Grand Rapids
    "31240": "401/Gaines-Township",   # Gaines Township
    "34000": "418/Grand-Rapids",   # Grand Rapids
    "34020": "404/Grand-Rapids-Charter-Township",   # Grand Rapids Township
    "34160": "422/Grandville",   # Grandville
    "34560": "424/Grattan-Township",   # Grattan Township
    "42820": "425/Kentwood",   # Kentwood
    "49540": "426/Lowell",   # Lowell
    "49560": "427/Lowell-Township",   # Lowell Township
    "56920": "428/Nelson-Township",   # Nelson Township
    "59580": "1194/Oakfield-Township",   # Oakfield Township
    "64660": "1195/Plainfield-Township",   # Plainfield Township
    "69080": "1196/Rockford",   # Rockford
    "74460": "1197/Solon-Township",   # Solon Township
    "75440": "1198/Sparta-Township",   # Sparta Township
    "75560": "1199/Spencer-Township",   # Spencer Township
    "81140": "1200/Tyrone-Township",   # Tyrone Township
    "81920": "1201/Vergennes-Township",   # Vergennes Township
    "82960": "1202/Walker",   # Walker
    "88940": "1203/Wyoming",   # Wyoming
}

POLLING_HEADING = "Election Day Polling Location"   # some pages drop the plural
DROPBOX_HEADING = "Absentee Voter Drop Box Locations"
# The trailing colon is not decoration: about a third of the county's pages
# write "Precinct 1:" and the rest write "Precinct 1". Both are the same
# label, and an anchored pattern without the colon silently reads twelve
# jurisdictions as having no polling places at all.
# Thirty pages, five ways of writing the same label: "Precinct 1", "Precinct
# 1:" with a colon, "Precincts 1 and 2" and "Precincts 1, 2 & 3" where several
# share a venue, and Bowne -- with its single precinct -- dropping the plural
# from the heading itself. A pattern matching any one of these reads the others
# as having no polling places at all, SILENTLY, which is how the first run of
# this script "found" twelve empty jurisdictions. Hence the count check at the
# end: every precinct the state knows about must come back with somewhere to
# vote, or this refuses to write.
PRECINCT_LABEL = re.compile(
    r"^(?:Ward\s+(\d+)\s*,\s*)?Precincts?\s+((?:\d|,|&|\s|and\b)+?)\s*:?$", re.I)
HOURS = re.compile(r"^Hours:\s*(.+)$", re.I)


def lines_of(page):
    """The page as visible text, one line per element, which is all the
    structure this needs: every record here is a label followed by its name
    and address on the next two lines."""
    text = re.sub(r"<script.*?</script>|<style.*?</style>", "", page, flags=re.S)
    text = re.sub(r"<[^>]+>", "\n", text)
    text = html.unescape(text).replace("\xa0", " ")
    return [line.strip() for line in text.split("\n") if line.strip()]


def fetch(slug):
    request = urllib.request.Request(f"{BASE}/{slug}", headers=UA)
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode("utf-8", "replace")


def parse_polling(lines):
    """[{ward, precinct, name, address}] from the Election Day section.

    A ward jurisdiction prints "Ward 1, Precinct 2"; a township prints
    "Precinct 2". Both are followed by the venue name and its street address.
    """
    try:
        start = next(i for i, line in enumerate(lines)
                     if line.startswith(POLLING_HEADING))
    except StopIteration:
        return []
    rows = []
    for i in range(start + 1, len(lines)):
        match = PRECINCT_LABEL.match(lines[i])
        if not match or i + 2 >= len(lines):
            continue
        ward = int(match.group(1)) if match.group(1) else None
        numbers = [int(n) for n in re.findall(r"\d+", match.group(2))]
        name = lines[i + 1].rstrip(":").strip()
        address = lines[i + 2].rstrip(":").strip()
        # "Precincts 1 and 2" is two precincts voting in one building, which is
        # ordinary in the rural townships. Each gets its own row.
        for precinct in numbers:
            rows.append({"ward": ward, "precinct": precinct,
                         "name": name, "address": address})
    return rows


def parse_dropboxes(lines):
    """[{name, address, hours}] from the absentee section. Stops at the polling
    heading so a venue never gets read as a drop box."""
    try:
        start = next(i for i, line in enumerate(lines) if line == DROPBOX_HEADING)
    except StopIteration:
        return []
    end = next((i for i, line in enumerate(lines)
                if i > start and line.startswith(POLLING_HEADING)), len(lines))
    boxes, i = [], start + 1
    while i + 2 < end:
        hours = HOURS.match(lines[i + 2])
        if hours:
            boxes.append({"name": lines[i].rstrip(":").strip(),
                          "address": lines[i + 1].rstrip(":").strip(),
                          "hours": hours.group(1)})
            i += 3
        else:
            i += 1
    return boxes


def main():
    index = json.loads(PRECINCTS.read_text())
    wanted = defaultdict(dict)          # mcd -> (ward, precinct) -> code
    names = {}
    for p in index["precincts"]:
        wanted[p["mcd"]][(p["ward"], p["precinct"])] = p["code"]
        names[p["mcd"]] = p["jurisdiction"]

    missing_pages = set(wanted) - set(PAGES)
    if missing_pages:
        sys.exit(f"REFUSE: no county page mapped for "
                 f"{sorted(names[m] for m in missing_pages)}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    unmatched, table, pending = [], [], []
    for mcd, slug in sorted(PAGES.items(), key=lambda kv: names[kv[0]]):
        lines = lines_of(fetch(slug))
        # The page names itself; if it does not name who we asked for, the id
        # has been reused and everything below would be the wrong town.
        expected = names[mcd].replace(" Township", "")
        if not any(expected in line for line in lines[:60]):
            sys.exit(f"REFUSE: {BASE}/{slug} does not mention {expected!r}; "
                     f"the county page id has probably changed")

        rows = parse_polling(lines)
        boxes = parse_dropboxes(lines)
        places = {}
        for row in rows:
            key = (row["ward"], row["precinct"])
            code = wanted[mcd].get(key)
            if code is None:
                unmatched.append((names[mcd], key, row["name"]))
                continue
            places[code] = {"name": row["name"], "address": row["address"]}

        document = {
            "provenance": {
                "description": f"{names[mcd]} Election Day polling places and "
                               "absentee drop boxes, by precinct.",
                "source": "Kent County Clerk / Register of Deeds, "
                          "Drop Box & Polling Locations",
                "source_url": f"{BASE}/{slug}",
                "matched_against": "site/data/precincts.json",
                "generated": time.strftime("%Y-%m-%d"),
                "licence": "Public record of Kent County, redistributed as published.",
                "how_to_update": "Run refresh_polling.py. Polling places change "
                                 "every election, and MCL 168.662 settles them "
                                 "60 days out, so re-run after that date for "
                                 "each election.",
                "not_geocoded": "The browser geocodes these against the street "
                                "chunk it already loaded, so no coordinate here "
                                "can go stale.",
            },
            "mcd": mcd,
            "jurisdiction": names[mcd],
            "precincts": places,
            "drop_boxes": boxes,
        }
        pending.append((OUT_DIR / f"{mcd}.json", document))
        table.append((names[mcd], len(places), len(wanted[mcd]), len(boxes)))
        time.sleep(DELAY_SECONDS)

    short = [(name, got, want) for name, got, want, _ in table if got != want]
    print(f"\n{'jurisdiction':<26}{'polling':>8}{'precincts':>11}{'drop boxes':>12}")
    for name, got, want, boxes in table:
        flag = "" if got == want else "  <-- SHORT"
        print(f"{name:<26}{got:>8}{want:>11}{boxes:>12}{flag}")
    if unmatched:
        print(f"\n{len(unmatched)} rows matched no precinct in the state layer:")
        for name, key, venue in unmatched[:10]:
            print(f"  {name}: ward/precinct {key} -> {venue}")
    if short:
        sys.exit(f"\nREFUSE: {len(short)} jurisdiction(s) did not cover every "
                 f"precinct: {short}")

    # Written only once every jurisdiction has checked out, so a page whose
    # shape has changed leaves the previous scrape intact rather than half
    # replacing it with blanks.
    for path, document in pending:
        path.write_text(json.dumps(document, separators=(",", ":")) + "\n")
    print(f"\nwrote {len(pending)} files to {OUT_DIR}")

    compare_grand_rapids()


def compare_grand_rapids():
    """The city clerk's directory against the county's page for the same 59
    precincts. Neither is corrected from the other; a disagreement is printed
    because two levels of government describing a polling place differently is
    the thing a voter most needs to know about."""
    city = json.loads(CITY_POLLING.read_text())["precincts"]
    scraped = json.loads((OUT_DIR / "34000.json").read_text())["precincts"]
    index = {p["code"]: p for p in json.loads(PRECINCTS.read_text())["precincts"]}

    # The two sources write addresses differently on purpose: the clerk prints
    # "645 LOGAN ST SE, 49503", the county prints "645 Logan SE". Comparing
    # them raw reports every one of the 59 as a difference and buries the ones
    # that matter. So both sides reduce to house number, street stem and
    # quadrant -- street TYPE and ZIP are dropped, since neither source is
    # wrong about those and neither sends anyone to the wrong building.
    TYPES = {"st", "street", "ave", "avenue", "rd", "road", "dr", "drive",
             "blvd", "boulevard", "pkwy", "parkway", "ln", "lane", "ct",
             "court", "pl", "place", "ter", "terrace", "way", "cir", "circle"}

    def norm(text):
        text = re.sub(r"[^a-z0-9 ]", " ", (text or "").lower())
        words = [w for w in text.split() if w not in TYPES]
        words = [w for w in words if not (len(w) == 5 and w.isdigit())]
        return " ".join(words)

    differ = 0
    for code, place in sorted(scraped.items()):
        number = str(index[code]["precinct"])
        mine = city.get(number)
        if not mine:
            continue
        a, b = norm(mine["name"]), norm(place["name"])
        if a not in b and b not in a:
            differ += 1
            print(f"  precinct {number:>3} name: clerk {mine['name']!r} vs "
                  f"county {place['name']!r}")
        a, b = norm(mine["address"]), norm(place["address"])
        if a != b:
            differ += 1
            print(f"  precinct {number:>3} addr: clerk {mine['address']!r} vs "
                  f"county {place['address']!r}")
    print(f"\nGrand Rapids: {len(scraped)} scraped, compared against the city "
          f"clerk's directory, {differ} difference(s) to look at")


if __name__ == "__main__":
    main()
