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
// Reads [{mcd, key, number, street}, ...] on stdin.
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

const out = {};
for (const [mcd, items] of byJurisdiction) {
  const path = `${CHUNKS}/${mcd}.json`;
  if (!existsSync(path)) continue;
  const graph = new R.Graph(JSON.parse(readFileSync(path, 'utf8')));
  for (const item of items) {
    const hit = graph.geocode(item.number, item.street);
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
