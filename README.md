# Vote Grand Rapids

Live at [votegr.org](https://votegr.org).

Type any address in Kent County Michigan (which includes the City of Grand Rapids), or drop a pin, and get your precinct, your ward
(if applicable), where you vote, where to return an absentee ballot, and a driving route there that avoids the license plate readers we know about.

It covers every city and township in the county: 30 jurisdictions, 202 precincts, and 234 known plate readers, all loaded once and held in the
browser, so a lookup or a route anywhere in the county needs nothing further from the network.

**Nothing you type leaves your browser.** Everything is rendered on your device.

This project is independent and unofficial, offered with no guarantee of accuracy. It is not affiliated with the City of Grand Rapids, Kent County, or
the State of Michigan. The Michigan Voter Information Center is still the official source of record; always verify there, or with the Clerk.

## Why

Two reasons:

1. **Finding out where you vote should not require identifying yourself.** The
state's Michigan Voter Information Center is accurate and it is the official
source, but it asks for your name, your birth month and year, and your
registration ZIP before it will tell you your ward and precinct, and every
lookup runs on its servers. The notice you agree to on that form says, in
full:

   > The information collected on this form is only what is needed to complete your transaction as authorized by MCL 168.509ii, MCL 168.759, MCL 168.759a, and MCL 168.764c. As a public body, MDOS is subject to the Michigan Freedom of Information Act (FOIA), MCL 15.231 et seq., and information such as a name or address may be disclosed in response to a FOIA request.

   **This site is a proof of concept that none of that information needs to
   be collected to show you where you vote.** Every answer comes from public
   records already on your device. There is no form, no transaction, and
   nothing for a FOIA request to disclose, because nothing was ever collected.

2. **Driving to perform a constitutionally protected activity shouldn't be surveilled.**
Kent County has automated license plate readers on traffic signals and utility poles, in Grand Rapids and well beyond it. They photograph
every passing vehicle, perform OCR, and store it with the time and place, whether or not anyone suspects you of anything, and can alert officers in realtime of a flagged vehicle. The records are also searchable later, and many systems let agencies search across each other's networks. 

## Inventory

Copy the `site` folder to any web host and it works.

```
site/index.html              the page
site/router.css              its styles
site/router.js               routing, geocoding, turn restrictions
site/basemap.js              draws the map on a canvas, no tiles
site/precinct.js             address -> jurisdiction, ward, precinct, polling place
site/display-case.js         title-cases the ALL CAPS street and place names for display
site/app.js                  the interface
site/data/graph/index.json   which road-network chunks exist and how big each is
site/data/graph/<mcd>.json   the street network, one file per jurisdiction, with a
                             150 m overlap so routes cross the line
site/data/addresses/<mcd>.json  every parcel address in that jurisdiction and its precinct
site/data/polling/<mcd>.json    its polling places, drop boxes and clerk's office
site/data/precincts.json     the 202 precinct boundaries and the 30 jurisdictions
site/data/polling.json       Grand Rapids' 59 polling places, hand-transcribed from
                             the City Clerk's directory: the source of record for the city
site/data/gr-clerk.json      the City Clerk's early voting sites and drop boxes
site/data/early-voting.json  the County Clerk's early voting sites (see Limits)
site/data/cameras.json       known plate readers, county-wide
site/data/sources.json       every upstream this site reads, by id, with licence and archive
site/data/landcover.json     water, parks and rail, so the map reads as a map
site/data/boundary.json      the Grand Rapids city limits, which decide only whether
                             the City Clerk's own data applies
site/data/neighbors.json     street names just outside the city, kept for /simple
site/data/addresses.json     every city address and its precinct, kept for /simple
site/data/graph.json         the city-only road network, kept for the router tests
site/data/elections.json     election days and early voting
site/data/precincts.geojson  full precinct polygons, the source scripts/build_precincts.py slims
site/simple/                 the light version, no map, at /simple/ (Grand Rapids only, for now)
tests/                       the test suites and the route audit
scripts/                     the data refresh and build scripts, the link checker, the OSRM comparison
```

The `<mcd>` in a filename is the state's five-digit code for the city or
township -- `34000` is Grand Rapids, `42820` Kentwood -- and every precinct is
identified by the state's 13-digit code, of which that is the middle. A bare
precinct number is no identity in a county with a Precinct 1 in twenty-nine
places.

Included are the scripts that generated those files. `BUILD.md` has the order:

```
scripts/
  refresh_centerlines.py   county street centerlines
  refresh_osm_roads.py     OpenStreetMap ways and turn restrictions
  refresh_osm_via_nodes.py the via nodes those restrictions turn at
  refresh_cameras.py       plate readers from OpenStreetMap, county-wide
  refresh_landcover.py     water, parks, rail
  refresh_boundary.py      the Grand Rapids city limits
  refresh_neighbors.py     street names in neighboring jurisdictions
  refresh_addresses.py     every parcel address in the county and its precinct, per jurisdiction
  refresh_precincts.py     precinct polygons from the State of Michigan, county-wide
  refresh_polling.py       polling places and drop boxes from the County Clerk, per jurisdiction
  refresh_early_voting.py  early voting sites from the County Clerk
  refresh_gr_clerk.py      early voting and drop boxes from the Grand Rapids City Clerk
  geocode_places.py        coordinates for every polling place, drop box and clerk's office
  centreline_geocode.mjs   its second pass, run by node against the same router the page uses
  build_graph.py           compiles the county routing graph, from the centerlines
  build_graph_osm.py       the same graph from OpenStreetMap instead, for comparison
  build_restrictions.py    merges turn restrictions into it
  build_graph_chunks.py    cuts it into one file per jurisdiction, plus the index
  build_precincts.py       slims the precinct polygons for in-browser use
  archive.py, sources.py   Wayback captures and the master registry of sources
```

The shipped graph is the centerline build, cut into thirty chunks.
`scripts/build_graph_osm.py` exists to check it against OpenStreetMap, not to
replace it.

## How the routing works

Streets, one-way directions and posted speed limits come from the **Kent
County (REGIS) street centerlines**, the authoritative local record and more
complete than OpenStreetMap. Nearly every segment is named and carries address
ranges, which is what lets the road network double as the geocoder.

**The whole county is resident at once.** The page reads a small index, then
streams the thirty chunks in one at a time, packing each into flat typed
arrays before fetching the next: every coordinate in the county is one
`Int32Array` of microdegrees. Held as ordinary objects the same network costs
about 70 MiB; packed it is about 13, less than the city alone used to cost,
and a route from a Wyoming address to a polling place two blocks inside
Kentwood needs no second fetch, because the chunks overlap by 150 m at every
border and are merged into one connected graph.

**Freeways are excluded outright:** A trip to a polling place is a
neighborhood trip, the highway saves a minute at best, and surface streets
are where the camera data actually applies.

**Turn restrictions come from OpenStreetMap, and only from there.** The
centerlines carry none, so declared OSM relations (this way, via this node, to
that way) are the whole source: 240 across Kent County. Matching is geometric,
since the two datasets share no keys, and a restriction whose geometry does not
match cleanly is dropped rather than guessed, because a wrong restriction
silently forbids a legal turn.


## Checking the data

Each finds the repository root from its own location, so run them from anywhere.

```bash
node tests/test_display_case.mjs         # display casing: vectors, then two invariants over the real corpus
node tests/test_router.mjs               # 122 assertions: routing, chunks, restrictions, addresses, the county index, the polls clock
node tests/audit_routes.mjs              # drives hundreds of real trips, checks every route
npm ci && node tests/test_page.mjs       # 174 assertions: the page itself, in a browser, city and county
node tests/test_simple_page.mjs          # 48 assertions: /simple in a browser
node tests/test_early_voting_states.mjs  # the early voting states and election day, from a dated fixture, both pages
node tests/test_check_links.mjs          # what the link checker makes of a response
node scripts/compare_osrm.mjs 30         # differential test against OSRM, the OSM reference
node scripts/check_links.mjs             # every external link in the docs, the pages and the data provenance
```

All but the last two run on every pull request, and on any push to `main`.
Those two reach other people's servers, so neither gates a merge: run them by
hand. The link check also runs weekly on a schedule, which is when a page
someone else moved gets noticed. It fails only on a page that is actually
gone, never on a server that declined to answer it. The `package.json` exists
only so the two browser tests have a browser to drive; the site has no build
step and no dependencies.

`tests/audit_routes.mjs` is the one that matters. It routes across the real city and
mechanically checks every result: edges join end to end, no edge is driven
against its one-way, no freeway is used, every turn passes the restriction
gate, no gratuitous U-turns, and the step distances add up. It exits non-zero
on any violation.

`scripts/compare_osrm.mjs` compares our fastest route against OSRM over the same
origin and destination. OSRM is used as a measuring stick, never at run time:
sending your trip to a routing server is the thing this tool exists to avoid.
Turn costs were added to the router because that comparison showed our routes
zigzagging between fast streets in ways OSRM would not.

## Limits and disclaimer

This tool is an estimate, and these are the ways it is wrong.

**Your precinct is legally set by the state voter file, not by a line on a
map.** Addresses near a precinct boundary are genuinely ambiguous and the page
says so, as it does for a number it had to infer from its neighbors.

**Coverage is Kent County, and it is parcel addresses**, so a brand new build
may be missing entirely, and an address across the county line in Ottawa,
Allegan, Barry, Ionia, Montcalm or Newaygo County is not in the index. The
page says so rather than guessing.

**Polling places change every election**, and consolidations appear only in
the footnotes of the clerk's directory. Outside Grand Rapids the polling
places come from the County Clerk's pages and were placed on the map from
the county parcel layer, or where a church or township hall is missing from
that layer, from the street centreline, so a marker may sit on the road
outside the building rather than on it. One, given by the county only as
"North Complex", could not be placed at all.

**Drop boxes are published by six jurisdictions**, and the page shows those
23. The other 24 publish none, and it does not send you to a neighbour's box,
because under MCL 168.764a an absentee ballot is returned only to the clerk of
the city or township where you are registered: there, it names your own
clerk's office as the place to return it, with the phone number.

**Early voting sites outside Grand Rapids are not shown yet.** The City Clerk
has published the city's four for November; the County Clerk's page still
describes the August primary, and a site for the wrong election is worse than
none. The dates are shown; the row says no site is published.

## Privacy

The page downloads its data once and does everything in the browser. It makes
no third-party request at all.  You can watch that in the network
panel, and `tests/test_page.mjs` asserts it, over a full session from load to drawn
route.

A **Cache / OSM** control under *Camera data* in the map's gear menu used to be
the one exception, checking OpenStreetMap for readers mapped since the last
publish. It asked first and named who got contacted, but it meant this section
needed a caveat, and a privacy claim with a caveat is worth less to a reader
than the occasional handful of cameras it added. Camera freshness is the
build's job now: `scripts/refresh_cameras.py`, run daily by a workflow.

We deliberately do not publish the OpenStreetMap usernames of the people who
mapped these cameras, though the data contains them. They are real people
doing something that carries risk.

## License

Code is public domain under the [Unlicense](UNLICENSE). Copy, host, revise, and
change it without asking, with or without credit.

Two third-party pieces ship with the site and keep their own licences:
[Leaflet](https://leafletjs.com) 1.9.4, BSD 2-Clause, in `site/vendor/leaflet/`
with its `LICENSE`; and the Hanken Grotesk typeface, SIL Open Font License 1.1,
in `site/fonts/` with its `OFL.txt`. The address-matching logic in
`site/precinct.js` is carried over from the earlier vote-gr project and says so
at the top of the file.

The data is not ours to license. Streets and address ranges are public
records of Kent County and the City of Grand Rapids; precinct boundaries are a
public record of the State of Michigan; polling places, drop boxes and clerks'
offices come from the Kent County Clerk and, for the city, the Grand Rapids
City Clerk. Every file says where it came from, and `sources.json` is the
registry those pointers resolve through. **Camera locations, turn
restrictions, water and parks come from OpenStreetMap and are ODbL**, so the
graph chunks, `cameras.json` and `landcover.json` carry that obligation: keep
the attribution and share derivatives alike. Much of the camera mapping is the work of the
[DeFlock](https://deflock.org/) community, where you can also contribute to the
plate reader database and read more about the project.

The light version is still here, at
[votegr.org/simple/](https://votegr.org/simple/): the same lookup with no map
and no directions, so it stays the better choice on an old phone, a slow
connection, or a screen reader. It is deliberately unlisted, carrying a
noindex and linked from nowhere on the site. It still reads the Grand Rapids
files and answers for the city only; widening it to the county is the next
piece of work.
