# Rebuilding the data files

Everything under `site/data/` is committed, so nothing here is needed in order
to serve the site. Copy `site/` to any host and it works. These are
regenerators, to run when an upstream source changes.

The point of committing the data and shipping the scripts that produced it is
that the numbers are reproducible rather than asserted: anyone can rerun these
and get the same files.

## Setup

Most scripts use only the Python standard library. A few need `requests` or
`shapely`:

```
pip install -r requirements.txt
```

`scripts/refresh_addresses.py` and `scripts/refresh_precincts.py` need both;
`scripts/build_precincts.py` and `scripts/build_graph_chunks.py` need `shapely`
alone. Everything else runs on a bare interpreter.

## What generates what

| File | Made by | From |
|---|---|---|
| `graph/<mcd>.json` | `build_graph.py`, `build_restrictions.py`, then `build_graph_chunks.py` | REGIS/Kent centerlines, OpenStreetMap restrictions |
| `graph/index.json` | `build_graph_chunks.py` | sizes of every chunk, so the browser allocates once and streams them |
| `addresses/<mcd>.json` | `refresh_addresses.py` | Kent County parcels, matched to precincts, one file per jurisdiction |
| `polling/<mcd>.json` | `refresh_polling.py`, then `geocode_places.py` | Kent County's polling place and drop box pages, then parcel centroids and street centrelines for coordinates |
| `early-voting.json` | `refresh_early_voting.py`, then `geocode_places.py` | Kent County's early voting page |
| `cameras.json` | `refresh_cameras.py` — **automated, see below** | OpenStreetMap |
| `addresses.json` | `refresh_addresses.py` | Kent County parcels, matched to precincts |
| `precincts.geojson` | `refresh_precincts.py` | Michigan Secretary of State |
| `precincts.json` | `build_precincts.py` | slimmed from `precincts.geojson`, plus each jurisdiction's outline |
| `boundary.json` | `refresh_boundary.py` | Michigan Geographic Framework |
| `landcover.json` | `refresh_landcover.py` | OpenStreetMap |
| `neighbors.json` | `refresh_neighbors.py` | Michigan Geographic Framework |
| `polling.json` | **hand-edited, no script** | City Clerk precinct directory PDF |
| `elections.json` | **hand-edited, no script** | Secretary of State and City Clerk |

`build/` holds intermediate pulls that are not committed. It is gitignored, and
the scripts create it as needed.

### Cameras refresh themselves

`.github/workflows/refresh-cameras.yml` runs `scripts/refresh_cameras.py` daily
at 06:17 UTC, commits `cameras.json` if it changed, and asks the Pages workflow
to publish. Running it by hand is only for when you want the list updated
sooner. The job refuses to write a truncated Overpass result, and separately
refuses any pull that drops more than a fifth of the committed set, on the
grounds that cameras come off the map in ones and twos rather than in droves.

## Where each file came from

Every file under `site/data/` carries a `provenance` block: source, the URL
actually fetched, licence, the script that writes it, and `generated`, the
date the source was last read.

`generated` is null on files written before the block existed. That is
deliberate. It was not back-filled from the git log, because git records when
a result was COMMITTED rather than when the source was READ, and those differ
every time a pull returns nothing new. Null means nobody has stamped it yet;
the next run of the owning script replaces it with a real date.

The block sits beside `meta` rather than inside it. `meta` carries counts and
bounding boxes that the browser reads at runtime, so it should not grow
fields only a maintainer cares about. `scripts/provenance.py` builds the block
so the eight writers cannot drift apart on field names, which is how four
files ended up recording the same fact as `generated`, `retrieved`,
`source_last_edited` and `transcribed`.

## Full rebuild

Order matters in two places, both because a later step writes into an earlier
step's output.

```
# Routing graph
python3 scripts/refresh_centerlines.py   # REGIS/Kent centerlines  -> build/
python3 scripts/build_graph.py           # compile the county graph -> build/graph.json
python3 scripts/refresh_osm_roads.py     # OSM ways + restrictions -> build/
python3 scripts/refresh_osm_via_nodes.py # the relations' via nodes -> build/
python3 scripts/build_restrictions.py    # attach restrictions     -> build/graph.json
python3 scripts/build_graph_chunks.py    # cut per jurisdiction    -> site/data/graph/ (+ index.json)

# Precincts, addresses, boundaries
python3 scripts/refresh_precincts.py     # SOS precinct polygons   -> site/data/precincts.geojson
python3 scripts/build_precincts.py       # slim them + outline each jurisdiction -> site/data/precincts.json
python3 scripts/refresh_addresses.py     # parcels -> precincts    -> site/data/addresses.json
python3 scripts/refresh_boundary.py      # city limits             -> site/data/boundary.json
python3 scripts/refresh_neighbors.py     # neighbouring street names -> site/data/neighbors.json

# Places to vote, county-wide
python3 scripts/refresh_polling.py       # county polling places + drop boxes -> site/data/polling/
python3 scripts/refresh_early_voting.py  # county early voting sites -> site/data/early-voting.json
python3 scripts/geocode_places.py        # coordinates for all of the above, in place

# Map furniture and cameras
python3 scripts/refresh_landcover.py     # water, parks, rail      -> site/data/landcover.json
python3 scripts/refresh_cameras.py       # plate readers           -> site/data/cameras.json
```

**`geocode_places.py` runs last and needs `node`.** It places every polling
place, drop box and early voting site from the county parcel layer first and
the street centrelines second, and the centreline pass runs `site/router.js`
itself -- the same file the page loads -- so a coordinate computed at build
time cannot drift from one the browser would compute. Pass `--parcels FILE` to
cache the parcel pull (232,000 rows, a few minutes) between runs, and
`--dry-run` to see the hit rate without writing. Anything it cannot place is
listed by name at the end rather than guessed.

**How the browser loads the graph.** It reads `graph/index.json`, allocates
typed arrays once from the totals, then streams the thirty chunks through one
at a time, a few fetches ahead, dropping each parsed document as it is folded
in. Every jurisdiction ends up resident, so a route can cross a city line with
no second fetch, and the peak while loading stays near the 13 MiB steady state
rather than the 102 MiB that parsing all thirty at once would cost.

**`build_restrictions.py` must follow `build_graph.py`.** A graph rebuild
discards restrictions, so they have to be re-attached afterwards or the router
silently permits banned turns.

**`build_precincts.py` must follow `refresh_precincts.py`.** It reads the
geojson that script writes, and refuses to run if it does not hold exactly 59
precincts.

Both steps guard, at different points. `refresh_precincts.py` checks the count
and that each ward's precinct numbers fall in its expected range before writing
the geojson; `build_precincts.py` re-checks the count before slimming it. A bad
upstream pull stops at one of them rather than reaching the browser.

`scripts/build_graph_osm.py` is not part of this sequence. It builds the same
graph from OpenStreetMap instead of the city centerlines, for comparison. The
shipped `graph.json` is the centerline build.

## The two files with no script

These are transcribed by hand, and they are the ones most likely to be wrong,
because nothing recomputes them.

**`polling.json`** comes from the City Clerk's precinct directory PDF. Each
election the clerk publishes a new one under a new generated filename, so the
URL in the file's `provenance` block goes stale; when it 404s (the weekly link
check, `scripts/check_links.mjs`, is what will say so), find the current directory from
the elections page rather than assuming it is gone. After
transcribing: check there are 59 precincts and the numbering runs 1 to 59,
cross-check against the Kent County listing, and read the footnotes for
consolidations, where one precinct votes at another's location for that
election only.

The directory is not carefully proofed. It has misspelled Madison, Kalamazoo,
Garfield and Orthodox across editions. Those are corrected in `polling.json`,
and two venue names there are deliberately fuller than the PDF prints them.
Do not "fix" them back.

**`elections.json`** holds election dates, the early voting window, its hours,
and the early voting sites. Add the next election when it is announced. The
page shows the first date that has not passed and ignores the rest, so a stale
entry is harmless and no date at all is better than a wrong one. Early voting
sites belong to the election they sit in: check them against the clerk's
posting for that election rather than carrying the previous one's forward.

## Verifying a rebuild

The suites live in `tests/` and the two network tools in `scripts/`; all of
them find the repository root from their own location, so they run from any
directory.

```
node tests/test_display_case.mjs         # display casing invariants over the real corpus
node tests/test_router.mjs               # routing, chunks, restrictions, addresses, the county index, the polls clock
node tests/audit_routes.mjs              # drives hundreds of real trips, checks every route
npm ci && node tests/test_page.mjs       # the page itself, in a browser
node tests/test_simple_page.mjs          # /simple, in a browser
node tests/test_early_voting_states.mjs  # the early voting states and election day, from a dated fixture
node tests/test_check_links.mjs          # what the link checker makes of a response
node scripts/compare_osrm.mjs 30         # differential check against OSRM
node scripts/check_links.mjs             # every external link, the provenance URLs included
```

All but the last two also run on every pull request, so a rebuild that breaks
the routing or the page is caught before it can be merged and deployed. Those
two reach other people's servers and gate nothing; the link check runs weekly
on its own schedule, and after a rebuild changes a provenance URL it is worth
running by hand.

`audit_routes.mjs` is the one that matters. It routes across the real city and
mechanically checks every result: edges join end to end, no edge is driven
against its one-way, no freeway is used, every turn passes the restriction
gate, no gratuitous U-turns, and the step distances add up. It exits non-zero
on any violation.

`compare_osrm.mjs` sends origin and destination pairs to a public OSRM
instance as a measuring stick. It is a development tool and is never used at
run time: sending your trip to a routing server is the thing this project
exists to avoid.

## Upstream etiquette

These scripts query government endpoints and a volunteer-run Overpass. Be a
good guest. Filter server-side rather than pulling everything and discarding
it locally. Do not run a full rebuild repeatedly while debugging one script.
If an endpoint returns 429, back off rather than retrying immediately.

## Sources

| Data | Endpoint |
|---|---|
| Street centerlines, one-ways, speeds | `services2.arcgis.com/L81TiOwAPO1ZvU9b/…/Transport_Street_Centerlines/FeatureServer/6` |
| Voting precincts | `services3.arcgis.com/dxRQUfTDNtfqZ301/…/VotingPrecinct/FeatureServer/0` |
| Parcel addresses | `gis.kentcountymi.gov/agisprod/…/ParcelsWithCondos/FeatureServer/0` |
| City limits, neighbouring streets | `gisagocss.state.mi.us/…/michigan_geographic_framework/MapServer` |
| Cameras, turn restrictions, water, parks | Overpass API, OpenStreetMap |
| Polling places | City Clerk precinct directory (PDF) |

The precinct layer is statewide, so `refresh_precincts.py` filters it
server-side with `CountyFIPS='081' AND MCDFIPS='34000'` and receives 59
features rather than every precinct in Michigan.

## Archiving the pages we scrape

Every page this project reads is rewritten each election, so a `source_url` in
a data file points at what the page says today and cannot be checked against
what it said when we read it. Each scraped file therefore carries a Wayback
capture in its provenance: `archived`, `archived_timestamp`, and an
`archive_note` when the capture is older than the read.

**Without keys this is mostly citation, not capture.** Save Page Now's JSON
API answers `401 You need to be logged in to use Save Page Now`, so anonymous
runs fall back to the legacy endpoint, which takes a capture when it feels
like it. Measured on 2026-09-08: the county index was captured; the city
clerk's page was refused and the newest existing capture was 84 days old; of
the thirty jurisdiction pages, 27 had a capture to cite with a median age of
306 days and three had none at all. A year-old capture of a polling place page
is a capture of the wrong election -- it proves the page existed, not that it
said what we wrote down.

**With keys it becomes reliable.** Sign in at archive.org, generate an S3 key
pair at <https://archive.org/account/s3.php>, and export them:

```bash
export ARCHIVE_S3_KEY=...
export ARCHIVE_S3_SECRET=...
```

`scripts/archive.py` picks them up from the environment on its own; nothing
else changes and no script needs an argument. The keys are never read from a
file in this repository and never written into one -- the only thing that
reaches a data file is the resulting snapshot URL. In CI they belong in a
repository secret, like the Civic key.

With keys present the bulk path changes too: the thirty jurisdiction pages
stop citing and start capturing, because SPN2's own `if_not_archived_within`
does the deduplicating server-side, so a run where nothing has changed costs
thirty cheap no-ops rather than thirty submissions.

Archiving never fails a build. It is provenance, not data: a refusal, a
timeout or a missing key leaves a note in the file and the refresh carries on.

archive.today is deliberately not used. It fronts everything with a bot
challenge, so a script cannot submit to it honestly.

## The per-election step, which is not automatic

Streets, parcels and precinct polygons change on a yearly cadence and their
scripts can run unattended. **Election data cannot.** Polling places, early
voting sites and their hours are published as prose on pages maintained by
hand, under URLs that change, describing whichever election someone last
edited them for. There is no feed. This is the part a person has to do, and
pretending otherwise is how a voter ends up at a building that closed.

Timing: MCL 168.662 bars moving a polling place or early voting site inside
**60 days** of an election, so nothing before that date is final. Run this
after it, and again in the last fortnight if anything looked unsettled.

```bash
python3 scripts/refresh_polling.py        # county pages -> site/data/polling/
python3 scripts/refresh_early_voting.py   # county + city cross-check
python3 scripts/refresh_gr_clerk.py       # the city's own dates and sites
```

Then **read what they wrote**. Each script checks shape, never sense: that
every precinct came back with somewhere to vote, that a window ends before its
election, that the page still names the jurisdiction asked for. None of that
catches a page that is simply describing the wrong election, which is the most
common failure and the one that has actually happened here.

What a person has to do by hand, every election:

1. **Read the three sources against each other.** `refresh_polling.py` prints
   the city clerk's directory against the county's page for all 59 Grand
   Rapids precincts; `refresh_early_voting.py` prints the county against the
   city. Disagreement is the point of running them: in September 2026 the
   county was still describing the August primary while the city had published
   November, and it listed three early voting sites where the city had opened
   four.
2. **Check the election each file names.** `gr-clerk.json` carries `election`,
   `early-voting.json` carries `election`; if either is not the election you
   are publishing for, that source is stale and its contents must not ship.
3. **Re-transcribe `polling.json` from the clerk's PDF.** The directory moves
   to a new generated filename every election, so the URL in the file's
   provenance will 404 -- find the current one from the clerk's elections page
   rather than assuming it is gone. This is the only source carrying entrance
   notes and the consolidation footnotes, where one precinct votes at
   another's location for a single election.
4. **Update `elections.json` by hand** with the election date, and with the
   early voting window and hours read from `gr-clerk.json`. Never derive the
   window from statute: the minimum is nine days ending the Sunday before, and
   Grand Rapids opened on the thirteenth day for November 2026.
5. **Check the archive stamps.** Each scraped file's provenance carries a
   Wayback URL for the page it read. If it says the capture predates the read,
   the archive is showing an older version of the page and the citation is
   weaker than it looks -- submit one by hand at `web.archive.org/save/`.

None of this is automatable and none of it should be pretended away. The
durable fix is upstream: a Bureau of Elections records request returns the
statewide polling list as a spreadsheet, one row per precinct, once per
election. Until that is a standing arrangement, this checklist is the process.

## Turn restrictions come from OpenStreetMap alone

`scripts/build_restrictions.py` attaches declared OSM relations (this way, via
this node, to that way) and nothing else. The centerlines carry no turn
restrictions at all, which is the only reason a second source is involved.

Matching is geometric, since the two datasets share no keys: for each OSM
restriction the script finds the centerline node nearest the via point, then
picks the incident edges whose bearings best match the OSM from- and to-ways.
Anything that cannot be tied to a junction unambiguously is dropped rather
than guessed, because a wrong restriction silently forbids a legal turn.
240 attach across Kent County.

The City of Grand Rapids sign inventory was the second source until the county
widening and is no longer used. It covered one jurisdiction of thirty, had been
frozen upstream since 2024-03-29, and inferring a ban from a sign's DIRECTION
column was inference on top of inference. Dropping it cost 45 restrictions in
Grand Rapids and bought one source, one licence, and the same treatment in
every jurisdiction. `refresh_signs.py` is deleted; nothing reads
`build/signs.json`.

## Licensing

Code is public domain under the Unlicense. Road geometry, address ranges and
posted speeds come from the REGIS/Kent County centerlines. **Turn restrictions
and camera locations come from
OpenStreetMap and are ODbL**, so `graph.json` and `cameras.json` carry an
ODbL obligation: keep the attribution and share derivatives alike.
