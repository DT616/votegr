#!/usr/bin/env python3
"""The master list of where our data comes from: site/data/sources.json.

Every data file used to carry its own provenance block, which meant the same
publisher, URL and licence were written out ten times in ten shapes -- and
elections.json, whose dates, sites and hours genuinely come from three
different places, had to invent key names (`early_voting_sites_source`,
`early_voting_hours_source`) to say so.

So sources are registered once, by id, and everything else POINTS at one:

    "src": "gr-clerk-current-election"

A record can carry its own `src` where records differ in origin, and a file
can carry one for everything in it where they do not. That is the whole
mechanism. It means a reader -- or the page, or a script -- can ask "where did
this line come from" and get an answer, rather than "which file am I in".

What lives in the registry is what belongs to the SOURCE: who publishes it,
the URL actually read, the licence, when it was last read, and the archive
copy if one exists. What stays in a data file is what belongs to that FILE:
how to regenerate it, what it counts, and any caveat about its own contents.

Usage from a refresh script:

    from sources import register
    register("gr-clerk-current-election",
             publisher="City of Grand Rapids, City Clerk's Office",
             url=URL, licence="Public record of the City of Grand Rapids.",
             archived=snapshot)
"""
import json
import pathlib
from datetime import date

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "data" / "sources.json"

NOTE = ("Every source this site reads, by id. Data files and individual "
        "records point at these with a `src` key rather than repeating the "
        "publisher, the URL and the licence. Written by the refresh scripts; "
        "do not edit by hand.")


def load():
    if not OUT.exists():
        return {"note": NOTE, "sources": {}}
    doc = json.loads(OUT.read_text())
    doc.setdefault("sources", {})
    doc["note"] = NOTE
    return doc


def register(source_id, publisher, url, licence, retrieved=None,
             archived=None, covers=None, note=None):
    """Record one source and return its id, so a caller can write it straight
    into the data it just built.

    Merging rather than replacing: a run that fails to reach the archive
    should not erase the capture a previous run recorded.
    """
    doc = load()
    entry = doc["sources"].get(source_id, {})
    entry.update({
        "publisher": publisher,
        "url": url,
        "licence": licence,
        "retrieved": retrieved or date.today().isoformat(),
    })
    if covers:
        entry["covers"] = covers
    if note:
        entry["note"] = note
    if archived:
        # snapshot_or_note() shapes: {"archived": url, "archived_timestamp": ...}
        # or {"archived": None, "archive_note": ...}. Keep a real capture over
        # a failed attempt.
        if archived.get("archived"):
            entry["archived"] = archived["archived"]
            entry["archived_timestamp"] = archived.get("archived_timestamp")
            entry.pop("archive_note", None)
        elif "archived" not in entry:
            entry["archive_note"] = archived.get("archive_note")
    doc["sources"][source_id] = entry

    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc["sources"] = dict(sorted(doc["sources"].items()))
    OUT.write_text(json.dumps(doc, indent=1, sort_keys=False) + "\n")
    return source_id


if __name__ == "__main__":
    doc = load()
    print(f"{len(doc['sources'])} sources in {OUT}")
    for key, entry in doc["sources"].items():
        stamp = entry.get("archived_timestamp", "")
        print(f"  {key:<34} {entry['publisher'][:38]:<40} "
              f"read {entry.get('retrieved','?')}" + (f"  archived {stamp[:8]}" if stamp else ""))
