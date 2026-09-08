#!/usr/bin/env python3
"""Scrape Kent County's early voting sites and hours into
site/data/early-voting.json.

The county lists early voting for every jurisdiction on one page, which is the
only place it exists in one piece: the state publishes none, and thirty clerks
publish thirty formats. Grand Rapids is on it too, with two sites, which makes
this a second opinion on the city's own elections.json rather than only a
filler for the other twenty-nine.

This is a page written for people, not an interface, and it should be treated
that way. It carries no election id, no ISO dates and no schema, so everything
below is inferred from prose: the election from a heading like "August 4, 2026
Primary Election", the window from a sentence like "Early Voting will take
place Saturday, July 25 - Sunday, August 2", whose year is taken from the
election because the sentence does not carry one.

So the value here is as a CROSS-CHECK, not as a source of record. It is a
second opinion on what the clerks publish and on what Google Civic returns
during the weeks it has Michigan data, and disagreement between the three is
the signal worth having.

Staleness is not this script's judgement to make. The window it scraped is
written down as ISO dates and the page decides, with the same windowState()
that governs every other early voting date in this project -- so a window that
has already closed reads as closed rather than as an invitation. What this
script refuses to do is publish a window it could not parse, or one that ends
after the election it belongs to.

Usage: python3 refresh_early_voting.py
"""
import datetime
import json
import pathlib
import re
import sys
import urllib.request
import html as html_module

from archive import snapshot_or_note

URL = "https://www.kentcountymi.gov/250/Drop-Box-Polling-Locations"
CITY_URL = ("https://www.grandrapidsmi.gov/departments/clerks-office/"
            "elections/early-voting/")
UA = {"User-Agent": "vote-gr/1.0 (+https://github.com/DT616/votegr)"}

ROOT = pathlib.Path(__file__).resolve().parent.parent
PRECINCTS = ROOT / "site" / "data" / "precincts.json"
OUT = ROOT / "site" / "data" / "early-voting.json"

MIN_SITES = 20            # 29 jurisdictions list one; well under this is a broken parse
MIN_CITY_SITES = 2        # the city has run three or four; one means a broken parse

CITY_SITES_HEADING = "Early Voting Sites"
CITY_HOURS_HEADING = "Early Voting Dates and Times"
CITY_SITE = re.compile(r"^(.+?)\s+[-\u2013]\s+(\d+\s+.+)$")

MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]
ELECTION = re.compile(
    r"^(%s)\s+(\d{1,2}),\s*(\d{4})\s+(.+?Election)$" % "|".join(MONTHS), re.I)
WINDOW = re.compile(
    r"Early Voting will take place\s+\w+day,\s*(%s)\s+(\d{1,2})\s*[-–]\s*"
    r"\w+day,\s*(%s)\s+(\d{1,2})" % ("|".join(MONTHS), "|".join(MONTHS)), re.I)
# Any month-and-day in the city's hours text, which is what reveals which
# election that page is describing -- it never names one.
DATE_HINT = re.compile(r"\b(%s)\s+(\d{1,2})\b" % "|".join(MONTHS), re.I)


def lines_of(page):
    text = re.sub(r"<script.*?</script>|<style.*?</style>", "", page, flags=re.S)
    text = re.sub(r"<[^>]+>", "\n", text)
    text = html_module.unescape(text).replace("\xa0", " ")
    return [line.strip() for line in text.split("\n") if line.strip()]


def iso(month_name, day, year):
    month = MONTHS.index(month_name.title()) + 1
    return f"{year:04d}-{month:02d}-{int(day):02d}"


def fetch_lines(url):
    request = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(request, timeout=60) as response:
        return lines_of(response.read().decode("utf-8", "replace"))


def parse_city(lines):
    """Grand Rapids' own early voting page, as a second opinion on the county's.

    The city is the one jurisdiction with a source of its own worth reading:
    the county page describes whichever election it was last updated for, and
    in September 2026 that was still the August primary, while the city had
    already published November -- including a fourth site the county does not
    list.

    No window is inferred. Michigan's minimum is nine days ending the Sunday
    before the election, but a city may open earlier, so a range invented here
    could be wrong in the direction that matters. What the page states is
    recorded: the sites, the hours as written, and any month-and-day mentioned
    in them, which is what reveals WHICH election is being described.
    """
    try:
        start = lines.index(CITY_SITES_HEADING)
        stop = lines.index(CITY_HOURS_HEADING)
    except ValueError:
        return None

    sites = []
    for line in lines[start + 1:stop]:
        match = CITY_SITE.match(line)
        if match:
            sites.append({"name": match.group(1).strip(),
                          "address": match.group(2).strip()})

    # The hours are broken across lines by the footnote marker: "Saturdays",
    # "*", ", Sundays, Monday, ... - 9:00 a.m. - 5:00 p.m." are three lines of
    # one sentence. A line that is only a marker, or that opens with a comma,
    # belongs to the line above it.
    hours, hints = [], []
    for line in lines[stop + 1:stop + 12]:
        if line.lower().startswith("please click") or line == "Current Election Information":
            break
        if line in ("*", "**") or line.startswith(","):
            if hours:
                hours[-1] = (hours[-1] + line).replace(" ,", ",")
            continue
        hours.append(line)
    for line in hours:
        for found in DATE_HINT.finditer(line):
            hints.append(f"{found.group(1).title()} {int(found.group(2))}")
    return {"sites": sites, "hours": hours, "dates_mentioned": sorted(set(hints))}


def compare_city(county, city):
    """What the two say about Grand Rapids, side by side. Neither is corrected
    from the other."""
    def key(text):
        text = re.sub(r"[^a-z0-9 ]", " ", text.lower())
        return " ".join(w for w in text.split()
                        if w not in {"st", "sts", "saint", "the", "school", "church"})

    county_sites = county["locations"] if county else []
    print(f"\nGrand Rapids: county lists {len(county_sites)}, "
          f"the city clerk lists {len(city['sites'])}")
    theirs = [key(s) for s in county_sites]
    for site in city["sites"]:
        k = key(site["name"])
        if not any(k in t or t in k for t in theirs):
            print(f"  ONLY ON THE CITY PAGE: {site['name']} - {site['address']}")
    ours = [key(s["name"]) for s in city["sites"]]
    for line in county_sites:
        k = key(line.split(",")[0])
        if not any(k in o or o in k for o in ours):
            print(f"  only on the county page: {line}")
    if city["dates_mentioned"]:
        print(f"  the city's hours mention: {', '.join(city['dates_mentioned'])}")


def main():
    request = urllib.request.Request(URL, headers=UA)
    with urllib.request.urlopen(request, timeout=60) as response:
        lines = lines_of(response.read().decode("utf-8", "replace"))

    election = window = None
    for i, line in enumerate(lines):
        match = ELECTION.match(line)
        if match and not election:
            election = {"name": match.group(4).strip(),
                        "date": iso(match.group(1), match.group(2), int(match.group(3)))}
            continue
        found = WINDOW.search(line)
        if found and election and not window:
            year = int(election["date"][:4])
            window = {"from": iso(found.group(1), found.group(2), year),
                      "to": iso(found.group(3), found.group(4), year),
                      "as_written": line}
    if not election:
        sys.exit("REFUSE: no election heading found; the page has been rewritten")
    if not window:
        sys.exit(f"REFUSE: found the {election['name']} but no early voting "
                 f"window sentence to go with it")
    if window["to"] > election["date"]:
        sys.exit(f"REFUSE: early voting window ends {window['to']}, after the "
                 f"election on {election['date']}; the year was inferred and "
                 f"the inference is wrong")

    # The jurisdiction names the county prints, so a site can be tied to the
    # precincts we already hold rather than to a string.
    index = {j["name"]: j["mcd"]
             for j in json.loads(PRECINCTS.read_text())["jurisdictions"]}
    # The county writes a few names its own way.
    aliases = {"Grand Rapids Charter Township": "Grand Rapids Township",
               "Grand Rapids City": "Grand Rapids",
               "Lowell City": "Lowell"}

    # A block is: the jurisdiction, "Dates/Times:", ONE OR MORE hours lines,
    # "Location:" (or "Locations:"), then one or more places. The counts vary
    # per jurisdiction -- East Grand Rapids publishes four different weekday
    # patterns, Grand Rapids runs two sites -- so this reads until the next
    # thing rather than assuming a fixed shape. An earlier version walked back
    # a fixed three lines from "Location:" and silently lost the six
    # jurisdictions whose hours run to more than one line.
    known = set(index)
    sites, unknown = {}, []
    i = 0
    while i < len(lines):
        if lines[i] != "Dates/Times:" or i == 0:
            i += 1
            continue
        raw = lines[i - 1]
        name = aliases.get(raw, raw)
        if name not in known:
            unknown.append(raw)
            i += 1
            continue
        hours, j = [], i + 1
        while j < len(lines) and not lines[j].startswith("Location"):
            hours.append(lines[j])
            j += 1
        places, j = [], j + 1
        while j < len(lines) and lines[j] not in known \
                and aliases.get(lines[j], lines[j]) not in known \
                and lines[j] != "Dates/Times:":
            places.append(lines[j])
            j += 1
        if hours and places:
            sites[index[name]] = {"jurisdiction": name, "hours": hours,
                                  "locations": places}
        i = j

    if len(sites) < MIN_SITES:
        sys.exit(f"REFUSE: only {len(sites)} early voting sites parsed "
                 f"(expected at least {MIN_SITES}); unmatched: {unknown[:5]}")

    city = parse_city(fetch_lines(CITY_URL))
    if not city or len(city["sites"]) < MIN_CITY_SITES:
        sys.exit(f"REFUSE: parsed {len(city['sites']) if city else 0} early "
                 f"voting sites from {CITY_URL}; the page has been rewritten")

    document = {
        "provenance": {
            "description": "Kent County early voting sites and hours, one per "
                           "jurisdiction. Grand Rapids is not on this page and "
                           "keeps its own sites in elections.json.",
            "source": "Kent County Clerk / Register of Deeds",
            "source_url": URL,
            "generated": datetime.date.today().isoformat(),
            "licence": "Public record of Kent County, redistributed as published.",
            **snapshot_or_note(URL),
            "how_to_update": "Run refresh_early_voting.py after each election "
                             "is settled. MCL 168.662 fixes early voting sites "
                             "60 days out, so before that the page may still "
                             "describe the previous election.",
            "read_this_as": "A CROSS-CHECK, not a source of record. The page is "
                            "prose written for people: no election id, no ISO "
                            "dates, no schema. The election, the window and its "
                            "year are all inferred here, and the value is in "
                            "disagreeing with the clerks and with Google Civic, "
                            "not in being believed over them.",
            "staleness": "Not decided here. The window is written down and the "
                         "page applies the same windowState() it applies to "
                         "every other early voting date, so a window that has "
                         "closed reads as closed.",
        },
        "election": election,
        "early_voting": window,
        "sites": sites,
        # Grand Rapids' own page, read as a second opinion on the county's.
        # Deliberately NOT merged: where the two disagree, both readings are
        # kept so the disagreement is visible instead of resolved by whichever
        # script ran last.
        "grand_rapids_clerk": dict(city, source_url=CITY_URL,
                                   **snapshot_or_note(CITY_URL)),
    }
    OUT.write_text(json.dumps(document, separators=(",", ":"), indent=1) + "\n")

    today = datetime.date.today().isoformat()
    state = ("closed" if today > window["to"] else
             "open" if today >= window["from"] else "upcoming")
    print(f"{election['name']} on {election['date']}")
    print(f"early voting {window['from']} to {window['to']} -- {state} as of {today}")
    if state == "closed":
        print("  NOTE: this page still describes an election that has passed. "
              "It is captured as a cross-check; nothing should render it as "
              "current, and windowState() will not.")
    total = sum(len(s["locations"]) for s in sites.values())
    print(f"{len(sites)} of {len(index)} jurisdictions listed, {total} sites")
    if unknown:
        print(f"unmatched jurisdiction names: {unknown}")
    compare_city(sites.get("34000"), city)
    print(f"wrote {OUT} ({OUT.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
