#!/usr/bin/env python3
"""One shape for the provenance block every generated data file carries.

Four of the ten files under site/data/ recorded where they came from and six
recorded nothing, and the four that did each invented their own key names:
`generated`, `retrieved`, `source_last_edited`, `transcribed`, `rechecked`.
So there was no way to ask "when did we last poll this" without reading each
file by hand and knowing which word that file happened to use.

The one field that earns the module is `generated`. Without it, a file that
was polled last week and a file nobody has touched since July look identical,
and the only way to tell them apart is the git log, which records when a
result was COMMITTED rather than when the source was READ. Those differ
whenever a pull returns nothing new.

`generated` is nullable on purpose. A file written before this module existed
cannot know its own fetch date, and inventing one would be worse than leaving
the gap visible: null means "nobody has stamped this yet", and the next run
of the owning script replaces it with a real date.

This sits alongside `meta` rather than inside it. `meta` carries counts and
bounding boxes that client code reads (router.js reads data.meta, app.js
prints graph.meta.edges), so it is load-bearing at runtime and should not
grow fields that only a maintainer cares about.
"""
from datetime import date, timezone, datetime


def provenance(source, source_url, licence, made_by, how_to_update, **extra):
    """Build the block. Every argument is required because every one of them
    is a question someone has actually had to answer by reading a script.

    source        human-readable name of the publishing body
    source_url    the endpoint or page actually fetched, not the org's homepage
    licence       what we are allowed to do with it, in a sentence
    made_by       the script that writes this file, so the reader knows what
                  to re-run rather than hand-editing a generated file
    how_to_update what to do, including anything that must run first or after
    """
    return {
        "source": source,
        "source_url": source_url,
        "licence": licence,
        "made_by": made_by,
        "generated": date.today().isoformat(),
        "generated_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "how_to_update": how_to_update,
        **extra,
    }
