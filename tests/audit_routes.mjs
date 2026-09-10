// Released into the public domain under the Unlicense, see UNLICENSE.
// Route safety audit. Not a unit test: it drives the REAL county graph with
// hundreds of real trips and mechanically checks every safety invariant on
// every route produced. Run it after any data refresh or router change.
//
//   node audit_routes.mjs [tripCount] [seed]
//
// It used to drive the city: site/data/graph.json, Grand Rapids' 59 polling
// places, and cameras clipped to the city rings. The site ships a county
// network four times that size and sends people to 202 polling places, so
// three quarters of the roads and 143 of the destinations were never driven
// by anything. Widening it found no router defect, which is worth saying,
// but it did find that invariant 5 was wrong.
//
// Invariants checked on every route:
//   1. CONTIGUOUS   each edge starts where the previous one ended
//   2. LEGAL-WAY    no edge is traversed against its one-way direction
//   3. NO-FREEWAY   no class-1 edge appears
//   4. TURNS        every consecutive edge pair passes turnAllowed()
//   5. U-TURNS      only where they buy something a legal turn could not
//   6. DISTANCE     step distances sum to the route distance (within 2%)
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
process.chdir(fileURLToPath(new URL('..', import.meta.url)));   // paths below are from the repo root
const R = require('../site/router.js');
const fs = require('fs');

// The county network the page actually loads, built the way the page builds
// it: the index, then every chunk, then finish. Not site/data/graph.json,
// which is the city only. The two are not close -- 44,508 edges against
// 10,521 -- so auditing the small one left three quarters of the roads this
// site will route somebody over never driven by any test, and every polling
// place outside Grand Rapids unvisited.
const index = JSON.parse(fs.readFileSync('site/data/graph/index.json'));
const graph = R.Graph.streaming(index);
for (const chunk of index.chunks) {
  graph.addChunk(JSON.parse(fs.readFileSync(`site/data/graph/${chunk.mcd}.json`)));
}
graph.finish();

// Every camera in the county. This used to clip to the Grand Rapids city
// rings, which made the avoidance figures below a statement about the city
// while the routes ran countywide.
const cams = JSON.parse(fs.readFileSync('site/data/cameras.json')).cameras;
graph.assignCameras(cams);

// Every polling place in the county: 59 in Grand Rapids from polling.json,
// which is the hand-transcribed source of record for the city, and the rest
// from the per-jurisdiction files. Grand Rapids' own polling/34000.json
// carries no coordinates by design, so taking it here would silently drop
// the city.
const poll = {};
for (const [code, v] of Object.entries(
       JSON.parse(fs.readFileSync('site/data/polling.json')).precincts)) {
  poll[`GR ${code}`] = v;
}
for (const f of fs.readdirSync('site/data/polling').filter(f => f.endsWith('.json'))) {
  const d = JSON.parse(fs.readFileSync(`site/data/polling/${f}`));
  if (d.mcd === '34000') continue;
  for (const [code, v] of Object.entries(d.precincts || {})) poll[code] = v;
}

// The county, from the chunk bounding boxes rather than a number typed here.
const bbox = index.chunks.reduce((b, c) => [
  Math.min(b[0], c.bbox[0]), Math.min(b[1], c.bbox[1]),
  Math.max(b[2], c.bbox[2]), Math.max(b[3], c.bbox[3])], [90, 180, -90, -180]);

// A sampled point is in play when it lands near a road. That replaces a
// point-in-polygon against the city outline, and it is the better test for
// what this audit is for: the question is whether the ROUTER can carry
// somebody between two places, and a point in the middle of a lake or over
// the county line is not such a place. snapToRoad already reports the
// distance, so this costs nothing extra.
const SNAP_M = 400;

// degree map for the u-turn check
const deg = new Map();
for (let n = 0; n < graph.nodeCount(); n++) deg.set(n, graph.linksFrom(n).length);

function auditRoute(r, label, problems) {
  if (!r) return;
  for (let i = 0; i < r.edges.length; i++) {
    const eid = r.edges[i];
    const from = r.nodes[i], to = r.nodes[i + 1];
    const ea = graph.edgeA(eid), eb = graph.edgeB(eid);
    const ed = graph.edgeDir(eid), name = graph.edgeName(eid) || eid;
    // 1. contiguity + 2. legality (direction actually permitted)
    const fwd = ea === from && eb === to;
    const rev = eb === from && ea === to;
    if (!fwd && !rev) problems.push(`${label}: edge ${eid} not contiguous`);
    else if (fwd && ed === 2) problems.push(`${label}: ${name} traversed against one-way`);
    else if (rev && ed === 1) problems.push(`${label}: ${name} traversed against one-way`);
    // 3. freeway
    if (graph.edgeClass(eid) === 1) problems.push(`${label}: freeway edge ${name} used`);
    // 4. turn legality
    if (i > 0 && !graph.turnAllowed(r.edges[i - 1], from, eid)) {
      problems.push(`${label}: illegal turn onto ${name}`);
    }
    // 5. u-turns only when they buy something
    //
    // "The node has another exit" is NOT the test, though it was until the
    // audit started driving the county. Turn restrictions make a u-turn a
    // legal tool: at 60th St SE and Thornapple River Dr SE, an OSM
    // restriction forbids the turn from Thornapple onto 60th westbound, so
    // the only lawful way onto it is to approach from the east. The router
    // runs 68 m up 60th, turns around and comes back, which is exactly right
    // and looked like a defect to a check that counted exits.
    //
    // So ask what the u-turn was FOR: could the route have made the move it
    // makes afterwards without it? Arrived at P on W, bounced off U, and
    // left P on X -- if W to X at P was allowed all along, the detour bought
    // nothing and is a real finding.
    if (i > 0 && r.edges[i - 1] === eid) {
      const P = r.nodes[i + 1], W = r.edges[i - 2], X = r.edges[i + 1];
      const pointless = (W === undefined || X === undefined)
        ? (deg.get(from) || 0) > 1          // at either end, fall back to exits
        : graph.turnAllowed(W, P, X);
      if (pointless) problems.push(`${label}: gratuitous u-turn at node ${from}`);
    }
  }
  // 6. distance accounting
  const steps = graph.steps(r);
  const sum = steps.reduce((s, st) => s + st.meters, 0);
  if (Math.abs(sum - r.meters) > Math.max(20, r.meters * 0.02)) {
    problems.push(`${label}: step distances ${Math.round(sum)}m != route ${Math.round(r.meters)}m`);
  }
}

const N = Number(process.argv[2] || 400);

// Seeded, so a failure can be reproduced and looked at instead of being
// re-rolled away on the next run. Unseeded this drove a different four
// hundred trips every time, which on the city graph never failed and so
// never mattered; over the county it means CI can go red on a trip nobody
// can get back. Pass a seed as the second argument to explore other ones.
const SEED = Number(process.argv[3] || 20260910);
let _s = SEED >>> 0;
const random = () => {                                   // mulberry32
  _s = (_s + 0x6D2B79F5) >>> 0;
  let t = _s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const problems = [];
let ran = 0, unroutable = 0, camAvoidWorked = 0, exposedFast = 0;

// Random trips: the origin anywhere in the county, the destination within
// TRIP_KM of it.
//
// Not two independent county-wide points. A trip to a polling place is a
// neighbourhood trip -- it is why freeways are excluded from the graph at
// all -- so Sparta to Lowell on surface streets is not a route this site
// will ever produce, and asking A* for four hundred of them took minutes
// instead of seconds while testing nothing the app does. Sampling the origin
// uniformly over the county still walks every jurisdiction's roads; it just
// walks them at the length a voter actually drives.
const TRIP_KM = 10;
const pick = () => [bbox[0] + random() * (bbox[2] - bbox[0]),
                    bbox[1] + random() * (bbox[3] - bbox[1])];
const near = ([lat, lng]) => {
  const t = random() * 2 * Math.PI, r = Math.sqrt(random()) * TRIP_KM;
  return [lat + (r / 111.32) * Math.sin(t),
          lng + (r / (111.32 * Math.cos(lat * Math.PI / 180))) * Math.cos(t)];
};
let sampled = 0;
while (ran < N) {
  if (++sampled > N * 200) break;          // never spin forever on a bad bbox
  const A = pick(), B = near(A);
  const a = graph.snapToRoad(A[0], A[1]), b = graph.snapToRoad(B[0], B[1]);
  if (!a || !b || a.node === b.node) continue;
  if (a.meters > SNAP_M || b.meters > SNAP_M) continue;
  ran++;
  const saved = graph._edgeCams; graph._edgeCams = null;
  const fast = graph.route(a.node, b.node);
  graph._edgeCams = saved;
  const avoid = graph.route(a.node, b.node);
  if (!fast || !avoid) { unroutable++; continue; }
  auditRoute(fast, `trip${ran}-fast`, problems);
  auditRoute(avoid, `trip${ran}-avoid`, problems);
  const exp = new Set();
  fast.edges.forEach(id => (graph._edgeCams[id] || []).forEach(c => exp.add(c)));
  if (exp.size > 0) { exposedFast++; if (avoid.cameraCount < exp.size) camAvoidWorked++; }
}

// Every polling place must be reachable from a spread of origins. The
// origins were four points inside Grand Rapids, which could not say anything
// about whether somebody in Sparta can reach their own polling place. They
// are now spread over the county, snapped once rather than per destination.
let pollFail = [], noCoord = [];
const origins = [
  [42.912, -85.700],   // Wyoming, south west
  [42.995, -85.655],   // Grand Rapids, north
  [42.930, -85.590],   // Kentwood, south east
  [43.196, -85.551],   // Cedar Springs, far north
  [42.940, -85.345],   // Lowell, far east
  [43.160, -85.760],   // Sparta, north west
].map(o => graph.snapToRoad(o[0], o[1]));
for (const [k, p] of Object.entries(poll)) {
  const lat = p.lat, lng = p.lng;
  // A polling place with no coordinate cannot be routed to at all, which is
  // a worse failure than an unreachable one and used to pass silently.
  if (lat == null) { noCoord.push(k); continue; }
  const d = graph.snapToRoad(lat, lng);
  // Nearest origin first. Every origin proves the same thing about
  // reachability, and the nearest one proves it over the shortest route,
  // which on a county graph with no freeways is the difference between a
  // couple of kilometres and a fifty kilometre crawl across four townships.
  let reached = null;
  const byNear = origins.slice().sort((x, y) =>
    Math.hypot(graph.nodeLat(x.node) - lat, graph.nodeLng(x.node) - lng) -
    Math.hypot(graph.nodeLat(y.node) - lat, graph.nodeLng(y.node) - lng));
  for (const o of byNear) {
    const r = graph.route(o.node, d.node);
    if (r) { reached = r; break; }
  }
  if (!reached) pollFail.push(k);
  else auditRoute(reached, `poll${k}`, problems);
}

const places = Object.keys(poll).length;
console.log(`county graph: ${graph.nodeCount().toLocaleString()} nodes, ` +
            `${graph.edgeCount().toLocaleString()} edges, ${index.chunks.length} jurisdictions`);
console.log(`routes audited: ${ran * 2 + places - noCoord.length} ` +
            `(${ran} random trips x2 + ${places - noCoord.length} polling places)`);
console.log(`unroutable random pairs: ${unroutable}`);
console.log(`polling places without a coordinate: ${noCoord.length}` +
            `${noCoord.length ? ' -> ' + noCoord.slice(0, 8) : ''}`);
console.log(`polling places unreachable: ${pollFail.length}` +
            `${pollFail.length ? ' -> ' + pollFail.slice(0, 8) : ''}`);
console.log(`fast routes passing >=1 camera: ${exposedFast}; avoidance reduced: ${camAvoidWorked}`);
console.log(`\nINVARIANT VIOLATIONS: ${problems.length}`);
problems.slice(0, 20).forEach(p => console.log('  ' + p));
process.exit(problems.length || pollFail.length || noCoord.length ? 1 : 0);
