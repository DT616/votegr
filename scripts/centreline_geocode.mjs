// Released into the public domain under the Unlicense, see UNLICENSE.
// Geocode addresses the parcel layer does not carry, by interpolating along
// the street centreline -- exactly what the browser does for Grand Rapids.
//
// Called by geocode_places.py for its leftovers. It shells out to node rather
// than reimplementing the interpolation in Python on purpose: this loads
// site/router.js, the same file the page loads, so a coordinate computed here
// and a coordinate computed in the browser cannot drift apart. A second
// implementation of "where on this block is number 8350" would eventually
// disagree with the first, and the failure would be a marker in the wrong
// place, which is the one outcome this whole exercise is trying to avoid.
//
// Reads [{mcd, key, number, street, neighbours}, ...] on stdin.
// Writes {key: {lat, lng, street}} on stdout, omitting anything it cannot place.
import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const R = require(process.cwd() + '/site/router.js');
const CHUNKS = process.cwd() + '/site/data/graph';

const wanted = JSON.parse(readFileSync(0, 'utf8'));

// One Graph per jurisdiction, built once: constructing it indexes every edge
// by street name, which is most of the cost and is wasted if repeated.
const byJurisdiction = new Map();
for (const item of wanted) {
  if (!byJurisdiction.has(item.mcd)) byJurisdiction.set(item.mcd, []);
  byJurisdiction.get(item.mcd).push(item);
}

const QUADRANTS = ['NE', 'NW', 'SE', 'SW'];

// Every way the same street might be written, cheapest first.
//
// The quadrant is the big one. A clerk writes "8350 Byron Center Avenue" and
// the road file says BYRON CENTER AVE SW; the street is right there, carrying
// numbers 5910 to 10799, and the lookup missed it over two letters nobody in
// Byron Township writes down. A quadrant is only ACCEPTED when exactly one of
// the four resolves -- if two do, the address is genuinely ambiguous and
// picking one would put a voter on the wrong side of the county.
//
// Spacing is the small one: "DeHoop Avenue SW" against DE HOOP AVE SW.
const LEADING = ['N', 'S', 'E', 'W'];

function variants(street) {
  // "West Lake Street" is "W LAKE ST" in the road file.
  let base = street.replace(/^(NORTH|SOUTH|EAST|WEST)\b/,
                            (w) => w[0]);
  const forms = [base];
  if (base !== street) forms.push(street);
  // "DEHOOP" -> "DE HOOP": a leading Dutch particle, which is what most of
  // these are in this county.
  const dutch = base.replace(/^(DE|VAN|TEN|TER)([A-Z])/, '$1 $2');
  if (dutch !== base) forms.push(dutch);
  return forms;
}

// Try one missing piece at a time, and take the answer ONLY when it is not a
// choice between equals. Guessing between two real candidates is how a voter
// ends up on the wrong side of the county -- N Maple and S Maple are
// different streets.
//
// One EXACT hit does settle it, though. The router will happily extrapolate a
// number past the end of a block, so asking for 250 on N Maple (which runs
// 100-199) returns a point up the road beyond the last house, while S Maple
// (100-400) returns the house itself. An address the road file actually
// carries beats one it had to invent; two exact hits, or none, is still a
// refusal.
function onlyOne(graph, number, form, affixes, place) {
  const hits = [];
  for (const affix of affixes) {
    const hit = graph.geocode(number, place(form, affix));
    if (hit) hits.push(hit);
  }
  if (hits.length === 1) return hits[0];
  const exact = hits.filter((h) => h.exact);
  return exact.length === 1 ? exact[0] : null;
}

function look(graph, number, street) {
  for (const form of variants(street)) {
    const direct = graph.geocode(number, form);
    if (direct) return direct;

    // The county-wide quadrant, which clerks outside Grand Rapids leave off:
    // "8350 Byron Center Avenue" against BYRON CENTER AVE SW.
    if (!QUADRANTS.some((q) => form.endsWith(' ' + q))) {
      const byQuadrant = onlyOne(graph, number, form, QUADRANTS,
                                 (f, q) => f + ' ' + q);
      if (byQuadrant) return byQuadrant;
    }

    // The village's OWN directional, which is part of the street's name and a
    // different thing entirely: Caledonia writes "250 Maple Street SE" where
    // the road file has N MAPLE ST SE (100-199) and S MAPLE ST SE (100-400).
    // Only the south one carries 250, so only the south one is offered.
    if (!LEADING.includes(form.split(' ')[0])) {
      const byLeading = onlyOne(graph, number, form, LEADING,
                                (f, d) => d + ' ' + f);
      if (byLeading) return byLeading;
      // Both missing at once.
      for (const d of LEADING) {
        const both = onlyOne(graph, number, d + ' ' + form, QUADRANTS,
                             (f, q) => f + ' ' + q);
        if (both) return both;
      }
    }
  }
  return null;
}

const out = {};
for (const [mcd, items] of byJurisdiction) {
  const path = `${CHUNKS}/${mcd}.json`;
  if (!existsSync(path)) continue;
  // A polling place can sit on a street that runs just outside the
  // jurisdiction's own chunk -- Whitneyville Avenue is not in Caledonia
  // Township's file at all, because the 150m ring does not reach it. Merging
  // the named neighbours is exactly what the chunk format is for, and it
  // costs nothing here: this runs once, at build time.
  const docs = [JSON.parse(readFileSync(path, 'utf8'))];
  for (const other of (items[0].neighbours || [])) {
    const p = `${CHUNKS}/${other}.json`;
    if (existsSync(p)) docs.push(JSON.parse(readFileSync(p, 'utf8')));
  }
  const graph = new R.Graph(docs.length > 1 ? docs : docs[0]);
  for (const item of items) {
    const hit = look(graph, item.number, item.street);
    if (!hit) continue;
    out[item.key] = {
      lat: Number(hit.lat.toFixed(6)),
      lng: Number(hit.lng.toFixed(6)),
      street: hit.street,
      // An exact hit sits on a house number the centreline file carries; the
      // rest is interpolated between the two nearest numbers on that side of
      // the block. Both are honest, and they are not equally good.
      exact: !!hit.exact,
    };
  }
}
process.stdout.write(JSON.stringify(out));
