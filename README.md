# Vote Grand Rapids

Live at [votegr.org](https://votegr.org).

Type a Grand Rapids address, or drop a pin, and get your ward, your precinct,
where you vote, and a driving route there that avoids the license plate
readers we know about.

**Nothing you type leaves your browser.** Everything is rendered on your device.

This project is independent and unofficial, offered with no guarantee of
accuracy. It is not affiliated with the City of Grand Rapids, Kent County, or
the State of Michigan. The Michigan Voter Information Center is the official
source of record; always verify there, or with the Clerk.

## Why

Two reasons:

1. **Finding out where you vote should not require identifying yourself.** The
state's Michigan Voter Information Center is accurate and it is the official
source, but it asks for your name, your birth month and year, and your
registration ZIP before it will tell your ward and precint number.  To find where to vote, you either have to give them your address or the personal info.
THeir privacy notice you have to agree to states information such as a name or address may be released under a Freedom of
Information Act request. The records of your searches or the fact you loooked them up could be subject to FOIA, and that didn't sit right with me.

3. **Driving to perform a constitutoinally protected activity shouldn't be surveilled.**
Grand Rapids has automated license plate readers on traffic signals and utility poles. They photograph
every passing vehicle, perform OCR, and store it with the time and place, whether or not anyone suspects
you of anything, and can alert officers in realtime of a flagged vehicle. The records are also searchable
later, and many systems let agencies search across each other's networks. 

## Inventory

Copy the `site` folder to any web host and it works.

```
site/index.html            the page
site/router.js             routing, geocoding, turn restrictions
site/basemap.js            draws the map on a canvas, no tiles
site/precinct.js           address -> ward, precinct, polling place
site/app.js                the interface
site/data/graph.json       street network, one-ways, speeds, turn restrictions
site/data/cameras.json     known plate readers
site/data/precincts.json   the 59 precinct boundaries
site/data/landcover.json   water, parks and rail, so the map reads as a map
site/data/boundary.json    the city limits
site/data/neighbors.json   street names in surrounding jurisdictions
site/data/addresses.json   every city address and its precinct
site/data/polling.json     the 59 polling places
site/data/elections.json   election days and early voting
site/data/precincts.geojson  full precinct polygons, the source scripts/build_precincts.py slims
site/simple/               the light version, no map, at /simple/
```

Included are the scripts that generated those files. `BUILD.md` has the order:

```
scripts/
  refresh_centerlines.py  city street centerlines
  refresh_osm_roads.py    OpenStreetMap ways and turn restrictions
  refresh_signs.py        city turn-sign inventory
  refresh_cameras.py      plate readers from OpenStreetMap
  refresh_landcover.py    water, parks, rail
  refresh_boundary.py     city limits
  refresh_neighbors.py    street names in neighboring jurisdictions
  refresh_addresses.py    city addresses and their precincts
  refresh_precincts.py    precinct polygons from the State of Michigan
  build_graph.py          compiles the routing graph, from the city centerlines
  build_graph_osm.py      the same graph from OpenStreetMap instead, for comparison
  build_restrictions.py   merges turn restrictions into it
  build_precincts.py      slims the precinct polygons for in-browser use
```

The shipped `graph.json` is the centerline build. `scripts/build_graph_osm.py` exists
to check it against OpenStreetMap, not to replace it.

## How the routing works

Streets, one-way directions and posted speed limits come from the **City of
Grand Rapids street centerlines**, which is the authoritative local record and
is more complete than OpenStreetMap. 99.8% of segments are named and
every one carries address ranges.

**Freeways are excluded outright:** A trip to a polling place is a
neighborhood trip, the highway saves a minute at best, and surface streets
are where the camera data actually applies.

**Turn restrictions come from two places:** OpenStreetMap contributes declared
relations. The city's sign inventory contributes the posted MUTCD no-turn
signs, which is the larger source and uniquely records which signs have been
**retired**, so a restriction that no longer exists is not enforced forever.

A sign is a point with a bearing rather than a declared relation, so turning
one into a restriction is inference. `build_restrictions.py` decides how to
read the sign's `DIRECTION` column by measuring both possible interpretations
against the OpenStreetMap set and keeping whichever agrees and does not
contradict; it prints that comparison on every run. Anything that cannot be
tied to a junction unambiguously is dropped rather than guessed, which is why
roughly half the signs are not used.

**Cameras are a routing cost, not a filter.** A camera-free route always beats
a faster route that passes one, and where no clean route exists the same
search returns the one passing the fewest cameras, with each unavoidable camera named.

## Checking the data

```bash
node test_router.mjs      # 76 assertions: routing, restrictions, addresses
node audit_routes.mjs     # drives hundreds of real trips, checks every route
npm ci && node test_page.mjs   # 93 assertions: the page itself, in a browser
node compare_osrm.mjs 30  # differential test against OSRM, the OSM reference
```

The first three checks run on every pull request, and on any push to `main`. The
`package.json` exists only so `test_page.mjs` has a browser to drive; the site
has no build step and no dependencies.

`audit_routes.mjs` is the one that matters. It routes across the real city and
mechanically checks every result: edges join end to end, no edge is driven
against its one-way, no freeway is used, every turn passes the restriction
gate, no gratuitous U-turns, and the step distances add up. It exits non-zero
on any violation.

`compare_osrm.mjs` compares our fastest route against OSRM over the same
origin and destination. OSRM is used as a measuring stick, never at run time:
sending your trip to a routing server is the thing this tool exists to avoid.
Turn costs were added to the router because that comparison showed our routes
zigzagging between fast streets in ways OSRM would not.

## Limits and Disclaimer:

This tool is an estimate, and these are the ways it is wrong.

**Your precinct is legally set by the state voter file, not by a line on a
map.** Addresses near a precinct boundary are genuinely ambiguous and the page
says so, as it does for a number it had to infer from its neighbors.

**Coverage is parcel addresses**, Meaning a brand new build may be missing
entirely. More than half of all Grand Rapids mailing addresses are outside the
city limits, in Wyoming, Kentwood, Walker, East Grand Rapids or one of the
townships; the page detects those and says which jurisdiction you are in, but
it cannot route there.

**Polling places change every election**, and consolidations appear only in
the footnotes of the clerk's directory.

## Privacy

The page downloads its data once and does everything in the browser.  

We deliberately do not publish the OpenStreetMap usernames of the people who
mapped these cameras, though the data contains them. They are real people
doing something that carries risk.

## License

Code is public domain under the [Unlicense](UNLICENSE). Copy, host, revise, and
change it without asking, with or without credit.

The data is not ours to license. Streets, signs and address ranges are public
records of the City of Grand Rapids and Kent County; precinct boundaries are a
public record of the State of Michigan; polling places come from the Grand
Rapids City Clerk. **Camera locations, turn restrictions, water and parks come
from OpenStreetMap and are ODbL**, so `graph.json`, `cameras.json` and
`landcover.json` carry that obligation: keep the attribution and share
derivatives alike. Much of the camera mapping is the work of the
[DeFlock](https://deflock.me/) community, where you can also contribute to the
plate reader database and read more about the project.

The light version is still here, at
[votegr.org/simple/](https://votegr.org/simple/): the same lookup with no map
and no directions, so it stays the better choice on an old phone, a slow
connection, or a screen reader. It is deliberately unlisted, carrying a
noindex and linked from nowhere on the site. Both pages read the same address,
polling place and election data from `site/data`.
