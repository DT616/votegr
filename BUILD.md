# Rebuilding the data files

Everything under `site/data/` is committed, so nothing here is needed in order
to serve the site. Copy `site/` to any host and it works. These are
regenerators, to run when an upstream source changes.

The point of committing the data and shipping the scripts that produced it is
that the numbers are reproducible rather than asserted: anyone can rerun these
and get the same files.

## Setup

Most scripts use only the Python standard library. Two need `requests` and
`shapely`:

```
pip install -r requirements.txt
```

`scripts/refresh_addresses.py` and `scripts/refresh_precincts.py` are the
exceptions. Everything else runs on a bare interpreter.

## What generates what

| File | Made by | From |
|---|---|---|
| `graph.json` | `build_graph.py`, then `build_restrictions.py` | city centerlines, sign inventory, OpenStreetMap |
| `cameras.json` | `refresh_cameras.py` — **automated, see below** | OpenStreetMap |
| `addresses.json` | `refresh_addresses.py` | Kent County parcels, matched to precincts |
| `precincts.geojson` | `refresh_precincts.py` | Michigan Secretary of State |
| `precincts.json` | `build_precincts.py` | slimmed from `precincts.geojson` |
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

## Full rebuild

Order matters in two places, both because a later step writes into an earlier
step's output.

```
# Routing graph
python3 scripts/refresh_centerlines.py   # city centerlines        -> build/
python3 scripts/build_graph.py           # compile the graph       -> site/data/graph.json
python3 scripts/refresh_osm_roads.py     # OSM ways + restrictions -> build/
python3 scripts/refresh_signs.py         # city sign inventory     -> build/
python3 scripts/build_restrictions.py    # attach restrictions     -> site/data/graph.json

# Precincts, addresses, boundaries
python3 scripts/refresh_precincts.py     # SOS precinct polygons   -> site/data/precincts.geojson
python3 scripts/build_precincts.py       # slim them for the browser -> site/data/precincts.json
python3 scripts/refresh_addresses.py     # parcels -> precincts    -> site/data/addresses.json
python3 scripts/refresh_boundary.py      # city limits             -> site/data/boundary.json
python3 scripts/refresh_neighbors.py     # neighbouring street names -> site/data/neighbors.json

# Map furniture and cameras
python3 scripts/refresh_landcover.py     # water, parks, rail      -> site/data/landcover.json
python3 scripts/refresh_cameras.py       # plate readers           -> site/data/cameras.json
```

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
URL in the file's `provenance` block goes stale; when it 404s, find the current
directory from the elections page rather than assuming it is gone. After
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

```
node test_router.mjs      # 76 assertions: routing, restrictions, addresses
node audit_routes.mjs     # drives hundreds of real trips, checks every route
npm ci && node test_page.mjs   # 93 assertions: the page itself, in a browser
node compare_osrm.mjs 30  # differential check against OSRM
```

The first three also run on every pull request, so a rebuild that breaks the
routing or the page is caught before it can be merged and deployed.

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
| Turn signs | `services2.arcgis.com/L81TiOwAPO1ZvU9b/…/signs/FeatureServer/0` |
| Voting precincts | `services3.arcgis.com/dxRQUfTDNtfqZ301/…/VotingPrecinct/FeatureServer/0` |
| Parcel addresses | `gis.kentcountymi.gov/agisprod/…/ParcelsWithCondos/FeatureServer/0` |
| City limits, neighbouring streets | `gisagocss.state.mi.us/…/michigan_geographic_framework/MapServer` |
| Cameras, turn restrictions, water, parks | Overpass API, OpenStreetMap |
| Polling places | City Clerk precinct directory (PDF) |

The precinct layer is statewide, so `refresh_precincts.py` filters it
server-side with `CountyFIPS='081' AND MCDFIPS='34000'` and receives 59
features rather than every precinct in Michigan.

## Turn restrictions come from two sources

`scripts/build_restrictions.py` merges them. OpenStreetMap contributes declared
relations (this way, via this node, to that way). The City of Grand Rapids
sign inventory contributes the MUTCD no-turn family, which is larger and
uniquely records which signs have been RETIRED, so a restriction that no
longer exists is not enforced forever.

A sign is a point with a bearing rather than a declared relation, so turning
one into a restriction is inference. The script decides how to read the
DIRECTION column by MEASURING both interpretations against the OSM set and
keeping whichever agrees and does not contradict; it reports the comparison
on every run. Anything that cannot be tied to a junction unambiguously is
dropped rather than guessed.

## Licensing

Code is public domain under the Unlicense. Road geometry, address ranges and posted speeds come from the
City of Grand Rapids. **Turn restrictions and camera locations come from
OpenStreetMap and are ODbL**, so `graph.json` and `cameras.json` carry an
ODbL obligation: keep the attribution and share derivatives alike.
