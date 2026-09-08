#!/usr/bin/env python3
"""Read the Grand Rapids City Clerk's current election page into
site/data/gr-clerk.json: early voting dates, sites and drop boxes for the city.

This page is the SOURCE for Grand Rapids early voting, not a cross-check. It is
the only one that publishes the actual dates rather than a weekday pattern, and
those dates matter: for November 3 2026 the city opens on October 20, four days
before Michigan's statutory minimum of nine days ending the Sunday before. A
window derived from the statute would have told voters the sites were shut on
four days they are open, which is the wrong direction to be wrong in.

It also carries what the other sources drop -- which door to use (gymnasium,
old cafeteria) and where each drop box actually stands (curbside, bike rack,
east parking lot).

It is still prose, and it is not clean. Under the November heading the page
currently says "Deadline to register by mail or online and be eligible to vote
in the AUGUST Election": the clerk copied the block from the primary and did
not change the name. The date is right and the label is wrong. So this script
verifies what it can -- the election date, the site count, that every early
voting day falls before the election -- and leaves the rest for the human step
that BUILD.md describes. Nothing here should run unattended.

Usage: python3 refresh_gr_clerk.py
"""
import datetime
import html as html_module
import json
import pathlib
import re
import sys
import urllib.request

from archive import snapshot_or_note
from sources import register

URL = ("https://www.grandrapidsmi.gov/departments/clerks-office/elections/"
       "current-election-information/")
SOURCE_ID = "gr-clerk-current-election"
UA = {"User-Agent": "vote-gr/1.0 (+https://github.com/DT616/votegr)"}
OUT = pathlib.Path(__file__).resolve().parent.parent / "site" / "data" / "gr-clerk.json"

MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]
MONTH_DAY = re.compile(r"^\w+day,\s*(%s)\s+(\d{1,2})$" % "|".join(MONTHS), re.I)
ELECTION_DATE = re.compile(r"^(%s)\s+(\d{1,2}),\s*(\d{4})$" % "|".join(MONTHS), re.I)
SITE = re.compile(r"^(.+?)\s+-\s+(\d+\s+[^(]+?)(?:\s*\((.+)\))?$")
BOX = re.compile(r"^(.+?),\s*(\d+\s+[^(]+?)(?:\s*\((.+)\))?$")

MIN_SITES = 2
MIN_BOXES = 5


def lines_of(page):
    text = re.sub(r"<script.*?</script>|<style.*?</style>", "", page, flags=re.S)
    text = re.sub(r"<[^>]+>", "\n", text)
    text = html_module.unescape(text).replace("\xa0", " ")
    return [line.strip() for line in text.split("\n") if line.strip()]


def section(lines, start_text, *stop_texts):
    """The lines between one heading and the next thing, by exact heading."""
    try:
        start = lines.index(start_text)
    except ValueError:
        return []
    stop = len(lines)
    for text in stop_texts:
        for i in range(start + 1, len(lines)):
            if lines[i] == text:
                stop = min(stop, i)
                break
    return lines[start + 1:stop]


def iso(month_name, day, year):
    return f"{year:04d}-{MONTHS.index(month_name.title()) + 1:02d}-{int(day):02d}"


def main():
    request = urllib.request.Request(URL, headers=UA)
    with urllib.request.urlopen(request, timeout=60) as response:
        lines = lines_of(response.read().decode("utf-8", "replace"))

    # "Next Election in the City of Grand Rapids" then the date on its own line.
    election = None
    for i, line in enumerate(lines):
        if line.startswith("Next Election in the City of Grand Rapids") and i + 1 < len(lines):
            match = ELECTION_DATE.match(lines[i + 1])
            if match:
                election = iso(match.group(1), match.group(2), int(match.group(3)))
            break
    if not election:
        sys.exit("REFUSE: could not read the next election date; the page has "
                 "been rewritten")
    year = int(election[:4])

    sites = []
    for line in section(lines, "Early Voting Sites", "Early Voting Dates and Times"):
        match = SITE.match(line)
        if match:
            sites.append({"name": match.group(1).strip(),
                          "address": match.group(2).strip(),
                          "entrance_note": (match.group(3) or "").strip() or None,
                          "src": SOURCE_ID})

    # Dated, one day per pair of lines: "Tuesday, October 20" / "11 am - 7 pm".
    # Dated days, taken only while they run CONSECUTIVELY from the first. The
    # page keeps listing dates after early voting ends -- election night
    # closing, the deadlines table -- and a scan that takes every date it sees
    # reported a 21-day window ending November 2 for a schedule that actually
    # runs the 20th to the 1st. Early voting is a continuous stretch of days,
    # so the first gap is the end of it.
    days, block = [], section(lines, "Early Voting Dates and Times")
    expected = None
    for i, line in enumerate(block):
        match = MONTH_DAY.match(line)
        if not match or i + 1 >= len(block):
            continue
        when = iso(match.group(1), match.group(2), year)
        if expected and when != expected:
            break
        days.append({"date": when, "hours": block[i + 1]})
        expected = (datetime.date.fromisoformat(when)
                    + datetime.timedelta(days=1)).isoformat()
    if not days:
        sys.exit("REFUSE: no dated early voting days found")

    dates = sorted(d["date"] for d in days)
    if dates[-1] >= election:
        sys.exit(f"REFUSE: early voting runs to {dates[-1]}, on or after the "
                 f"election on {election}")

    boxes = []
    for line in section(lines, "Drop Box Locations", "Important Election Dates and Deadlines"):
        if line.lower().startswith("election drop boxes"):
            # The trailing sentence about City Hall is a location too, just
            # written as prose and with hours instead of an address.
            if "City Hall" in line:
                boxes.append({"name": "City Hall", "address": None,
                              "note": line, "hours": "City Hall open hours",
                              "src": SOURCE_ID})
            continue
        match = BOX.match(line)
        if match:
            boxes.append({"name": match.group(1).strip(),
                          "address": match.group(2).strip(),
                          "note": (match.group(3) or "").strip() or None,
                          "hours": "24/7", "src": SOURCE_ID})
        elif re.match(r"^\d+\s", line):
            boxes.append({"name": None, "address": line, "note": None,
                          "hours": "24/7", "src": SOURCE_ID})
        elif boxes and boxes[-1].get("note") is None and boxes[-1]["name"] is None:
            boxes[-1]["note"] = line          # the description on its own line

    if len(sites) < MIN_SITES or len(boxes) < MIN_BOXES:
        sys.exit(f"REFUSE: parsed {len(sites)} sites and {len(boxes)} drop "
                 f"boxes; the page has been rewritten")

    # The source goes in the registry; the file keeps what is true of the file.
    snapshot = snapshot_or_note(URL)
    src = register(
        SOURCE_ID,
        publisher="City of Grand Rapids, City Clerk's Office",
        url=URL,
        licence="Public record of the City of Grand Rapids.",
        archived=snapshot,
        covers="Grand Rapids early voting dates, sites and absentee drop boxes",
        note="The source of record for the city. The county's pages are the "
             "cross-check, not the other way round.")

    document = {
        "src": src,
        "provenance": {
            "description": "Grand Rapids early voting dates, sites and absentee "
                           "drop boxes, from the City Clerk.",
            "source_registry": "sources.json",
            "generated": datetime.date.today().isoformat(),
            "how_to_update": "Run refresh_gr_clerk.py AND READ WHAT IT WROTE. "
                             "This is a prose page maintained by hand and it "
                             "carries copy errors: under the November heading "
                             "it currently names the August election in a "
                             "registration deadline. The script checks the "
                             "shape, not the sense.",
            "why_not_derived": "Michigan's minimum early voting window is nine "
                               "days ending the Sunday before an election. "
                               "Grand Rapids opens earlier than that, so the "
                               "window is read from this page and never "
                               "computed from the statute.",
        },
        "election": election,
        "early_voting": {"from": dates[0], "to": dates[-1], "days": days},
        "early_voting_sites": sites,
        "drop_boxes": boxes,
    }
    OUT.write_text(json.dumps(document, separators=(",", ":"), indent=1) + "\n")
    print(f"next election {election}")
    print(f"early voting {dates[0]} to {dates[-1]} ({len(days)} days, "
          f"{len(sites)} sites)")
    for site in sites:
        print(f"  {site['name']} - {site['address']}"
              f"{'  (' + site['entrance_note'] + ')' if site['entrance_note'] else ''}")
    print(f"{len(boxes)} drop boxes")
    print(f"wrote {OUT} ({OUT.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
