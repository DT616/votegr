#!/usr/bin/env python3
# Released into the public domain under the Unlicense, see UNLICENSE.
"""Ask the Wayback Machine to keep a copy of a page we scraped, and hand back
the snapshot's address so it can be written into provenance.

Every page this project reads is rewritten each election: the county replaces
its polling lists, the city clerk replaces its early voting sites, and the
clerk's precinct directory changes its filename outright. So a `source_url` in
a data file points at what the page says TODAY, which is the one thing it
cannot be checked against later. A snapshot fixes that -- it is the difference
between "the county said this" and "the county says this now, and it is not
what we wrote down".

Best effort by design. Archiving is provenance, not data, so nothing here
raises: a failure returns None, the caller records that it has no snapshot,
and the build carries on. An archive being slow is not a reason to fail a
refresh.

It also declines to make work for the archive. If a capture already exists
within MAX_AGE_DAYS, that one is used instead of asking for another.

archive.today is deliberately not used: it fronts everything with a bot
challenge, so a script cannot submit to it honestly.
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

AVAILABILITY = "https://archive.org/wayback/available"
SAVE = "https://web.archive.org/save/"          # legacy, anonymous, rate limited
SAVE_API = "https://web.archive.org/save"       # SPN2, requires a key
STATUS = "https://web.archive.org/save/status/"
UA = {"User-Agent": "vote-gr/1.0 (+https://github.com/DT616/votegr)"}
MAX_AGE_DAYS = 7
TIMEOUT_LOOKUP = 45
TIMEOUT_SAVE = 120
POLL_SECONDS = 5
POLL_TRIES = 12


def credentials():
    """The archive.org S3 keys, from the environment, or None.

    Save Page Now's JSON API answers 401 without them -- "You need to be
    logged in to use Save Page Now" -- so unauthenticated runs fall back to
    the legacy endpoint, which takes a capture when it feels like it and
    silently declines the rest of the time. With keys, capture becomes
    something this project can rely on rather than hope for.

    Generate them while signed in at https://archive.org/account/s3.php and
    export ARCHIVE_S3_KEY and ARCHIVE_S3_SECRET. They are never read from a
    file in this repository and never written into one: the only thing that
    reaches a data file is the resulting snapshot URL.
    """
    key = os.environ.get("ARCHIVE_S3_KEY")
    secret = os.environ.get("ARCHIVE_S3_SECRET")
    return (key, secret) if key and secret else None


def _save_authenticated(url, keys):
    """SPN2: submit, then poll until the capture finishes. Returns a Wayback
    timestamp or None.

    `if_not_archived_within` lets the archive do the deduplicating, which is
    both cheaper and more correct than deciding here -- it knows about
    captures made by anyone, not just ours.
    """
    body = urllib.parse.urlencode({
        "url": url,
        "if_not_archived_within": f"{MAX_AGE_DAYS}d",
        "skip_first_archive": "1",
    }).encode()
    request = urllib.request.Request(SAVE_API, data=body, headers={
        **UA,
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": f"LOW {keys[0]}:{keys[1]}",
    })
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SAVE) as response:
            job = json.load(response)
    except Exception:
        return None
    job_id = job.get("job_id")
    if not job_id:
        return None

    for _ in range(POLL_TRIES):
        time.sleep(POLL_SECONDS)
        try:
            poll = urllib.request.Request(STATUS + job_id, headers={
                **UA, "Accept": "application/json",
                "Authorization": f"LOW {keys[0]}:{keys[1]}"})
            with urllib.request.urlopen(poll, timeout=TIMEOUT_LOOKUP) as response:
                state = json.load(response)
        except Exception:
            return None
        if state.get("status") == "success":
            return state.get("timestamp")
        if state.get("status") == "error":
            return None
    return None


def _get(url, timeout, headers=None):
    request = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response


def existing(url):
    """The most recent capture the Wayback Machine already holds, or None."""
    query = AVAILABILITY + "?" + urllib.parse.urlencode({"url": url})
    try:
        request = urllib.request.Request(query, headers=UA)
        with urllib.request.urlopen(request, timeout=TIMEOUT_LOOKUP) as response:
            payload = json.load(response)
    except Exception:
        return None
    closest = (payload.get("archived_snapshots") or {}).get("closest") or {}
    if not closest.get("available"):
        return None
    return {"url": closest.get("url", "").replace("http://web.archive.org",
                                                  "https://web.archive.org"),
            "timestamp": closest.get("timestamp")}


def _age_days(timestamp, today):
    """Days between a Wayback timestamp (YYYYMMDDhhmmss) and a date."""
    try:
        from datetime import date
        stamp = date(int(timestamp[0:4]), int(timestamp[4:6]), int(timestamp[6:8]))
    except Exception:
        return None
    return (today - stamp).days


def snapshot(url, today=None, force=False):
    """Make sure a recent capture of `url` exists, and return it.

    Returns {"url", "timestamp", "captured": bool} or None. `captured` says
    whether this call is what caused the capture, which is worth knowing when
    reading a log: a run that archived nothing is a run whose sources had all
    been captured this week already.
    """
    from datetime import date
    today = today or date.today()

    if not force:
        have = existing(url)
        if have and have.get("timestamp"):
            age = _age_days(have["timestamp"], today)
            if age is not None and age <= MAX_AGE_DAYS:
                return {**have, "captured": False}

    before = have["timestamp"] if (have := existing(url)) else None

    keys = credentials()
    if keys:
        stamp = _save_authenticated(url, keys)
        if stamp:
            return {"url": f"https://web.archive.org/web/{stamp}/{url}",
                    "timestamp": stamp, "captured": stamp != before}
        # Fall through: a failed SPN2 call still leaves whatever exists.
        fresh = existing(url)
        return {**fresh, "captured": fresh.get("timestamp") != before} if fresh else None

    try:
        _get(SAVE + url, TIMEOUT_SAVE)
    except urllib.error.HTTPError as err:
        # 429 and 5xx are the archive being busy, which is its business, not a
        # reason to fail a data refresh.
        if err.code not in (429, 500, 502, 503, 504):
            return None
    except Exception:
        return None

    fresh = existing(url)
    if not fresh:
        return None
    # `captured` means the timestamp actually MOVED. Save Page Now can accept a
    # request and decline to take a new copy -- of a page it captured recently,
    # or when it is rate limiting -- and the availability API then returns the
    # old snapshot. Reporting that as a fresh capture would write a false claim
    # into a provenance block, which is the one place a false claim does real
    # damage.
    return {**fresh, "captured": fresh.get("timestamp") != before}


def cite(url):
    """The capture the archive already has, without asking for a new one.

    For bulk sources. Thirty jurisdiction pages means thirty Save Page Now
    submissions per run, which is a lot to ask of a free archive for pages
    that change three times a year -- and a fast way to get rate limited into
    uselessness. So a bulk caller cites what exists and leaves the asking to
    the one-page sources.
    """
    from datetime import date
    # With keys, bulk stops being a reason to hold back: SPN2's own
    # if_not_archived_within does the deduplicating server-side, so thirty
    # pages cost thirty cheap no-ops on a run where nothing has changed.
    if credentials():
        return snapshot_or_note(url)
    have = existing(url)
    if not have:
        return {"archived": None,
                "archive_note": "The Wayback Machine holds no capture of this "
                                "page. Nothing was submitted: this is one of "
                                "thirty pages read per run."}
    block = {"archived": have["url"], "archived_timestamp": have["timestamp"]}
    age = _age_days(have["timestamp"] or "", date.today())
    if age is not None and age > MAX_AGE_DAYS:
        block["archive_note"] = (
            f"An existing capture, {age} days old, cited rather than made. It "
            f"may show an earlier version of the page than the one read here.")
    return block


def snapshot_or_note(url, **kwargs):
    """What goes into a provenance block, whether or not archiving worked.

    An OLD capture is reported as old. Save Page Now can decline to take a new
    copy, and the archive then hands back whatever it already had -- which for
    the city clerk's page was a snapshot from three months before the November
    content was posted. Citing that as "archived" would suggest the archive
    shows what we read, when it shows a different version of the page. The
    timestamp is always written down, and a stale one says so.
    """
    from datetime import date
    result = snapshot(url, **kwargs)
    if not result:
        return {"archived": None,
                "archive_note": "No Wayback capture was available or could be "
                                "made when this file was generated."}
    block = {"archived": result["url"], "archived_timestamp": result["timestamp"]}
    age = _age_days(result["timestamp"] or "", date.today())
    if not result.get("captured") and age is not None and age > MAX_AGE_DAYS:
        block["archive_note"] = (
            f"This capture is {age} days old and predates the read that made "
            f"this file. The Wayback Machine declined a new one, so the "
            f"snapshot may show an earlier version of the page.")
    return block


if __name__ == "__main__":
    import sys
    for target in sys.argv[1:]:
        print(target, "->", json.dumps(snapshot(target)))
