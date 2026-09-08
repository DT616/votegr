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

URL = "https://www.kentcountymi.gov/250/Drop-Box-Polling-Locations"
UA = {"User-Agent": "vote-gr/1.0 (+https://github.com/DT616/votegr)"}

ROOT = pathlib.Path(__file__).resolve().parent.parent
PRECINCTS = ROOT / "site" / "data" / "precincts.json"
OUT = ROOT / "site" / "data" / "early-voting.json"

MIN_SITES = 20            # 29 jurisdictions list one; well under this is a broken parse

MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]
ELECTION = re.compile(
    r"^(%s)\s+(\d{1,2}),\s*(\d{4})\s+(.+?Election)$" % "|".join(MONTHS), re.I)
WINDOW = re.compile(
    r"Early Voting will take place\s+\w+day,\s*(%s)\s+(\d{1,2})\s*[-–]\s*"
    r"\w+day,\s*(%s)\s+(\d{1,2})" % ("|".join(MONTHS), "|".join(MONTHS)), re.I)


def lines_of(page):
    text = re.sub(r"<script.*?</script>|<style.*?</style>", "", page, flags=re.S)
    text = re.sub(r"<[^>]+>", "\n", text)
    text = html_module.unescape(text).replace("\xa0", " ")
    return [line.strip() for line in text.split("\n") if line.strip()]


def iso(month_name, day, year):
    month = MONTHS.index(month_name.title()) + 1
    return f"{year:04d}-{month:02d}-{int(day):02d}"


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

    document = {
        "provenance": {
            "description": "Kent County early voting sites and hours, one per "
                           "jurisdiction. Grand Rapids is not on this page and "
                           "keeps its own sites in elections.json.",
            "source": "Kent County Clerk / Register of Deeds",
            "source_url": URL,
            "generated": datetime.date.today().isoformat(),
            "licence": "Public record of Kent County, redistributed as published.",
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
    print(f"wrote {OUT} ({OUT.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
