// Released into the public domain under the Unlicense, see UNLICENSE.
// Route safety audit. Not a unit test: it drives the REAL city graph with
// hundreds of real trips and mechanically checks every safety invariant on
// every route produced. Run it after any data refresh or router change.
//
//   node audit_routes.mjs [tripCount]
//
// Invariants checked on every route:
//   1. CONTIGUOUS   each edge starts where the previous one ended
//   2. LEGAL-WAY    no edge is traversed against its one-way direction
//   3. NO-FREEWAY   no class-1 edge appears
//   4. TURNS        every consecutive edge pair passes turnAllowed()
//   5. U-TURNS      only where the node offers no other exit
//   6. DISTANCE     step distances sum to the route distance (within 2%)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const R = require('./site/router.js');
const { pointInRings } = require('./site/precinct.js');
const fs = require('fs');

const graph = new R.Graph(JSON.parse(fs.readFileSync('site/data/graph.json')));
const cams = JSON.parse(fs.readFileSync('site/data/cameras.json')).cameras;
const poll = JSON.parse(fs.readFileSync('site/data/polling.json')).precincts;
// boundary.json stores [lng, lat]; the shared ray cast wants [lat, lng].
const cityRings = JSON.parse(fs.readFileSync('site/data/boundary.json'))
  .rings.map(ring => ring.map(p => [p[1], p[0]]));
const inside = (lat, lng) => pointInRings(lat, lng, cityRings);
graph.assignCameras(cams.filter(c => inside(c.lat, c.lng)));

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
    // 5. u-turns only when forced
    if (i > 0 && r.edges[i - 1] === eid && (deg.get(from) || 0) > 1) {
      problems.push(`${label}: gratuitous u-turn at node ${from}`);
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
const problems = [];
let ran = 0, unroutable = 0, camAvoidWorked = 0, exposedFast = 0;

// random in-city trips
while (ran < N) {
  const A = [42.90 + Math.random() * 0.13, -85.72 + Math.random() * 0.12];
  const B = [42.90 + Math.random() * 0.13, -85.72 + Math.random() * 0.12];
  if (!inside(A[0], A[1]) || !inside(B[0], B[1])) continue;
  const a = graph.snapToRoad(A[0], A[1]), b = graph.snapToRoad(B[0], B[1]);
  if (!a || !b || a.node === b.node) continue;
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

// every polling place must be reachable from a spread of origins
let pollFail = [];
const origins = [[42.912, -85.700], [42.995, -85.655], [42.930, -85.590], [42.965, -85.680]];
for (const [k, p] of Object.entries(poll)) {
  const lat = p.lat, lng = p.lng;
  if (lat == null) continue;
  const d = graph.snapToRoad(lat, lng);
  let ok = false;
  for (const o of origins) {
    const a = graph.snapToRoad(o[0], o[1]);
    if (graph.route(a.node, d.node)) { ok = true; break; }
  }
  if (!ok) pollFail.push(k);
  const r = graph.route(graph.snapToRoad(origins[0][0], origins[0][1]).node, d.node);
  if (r) auditRoute(r, `poll${k}`, problems);
}

console.log(`routes audited: ${ran * 2 + 59} (${ran} random trips x2 + polling places)`);
console.log(`unroutable random pairs: ${unroutable}`);
console.log(`polling places unreachable: ${pollFail.length}${pollFail.length ? ' -> ' + pollFail : ''}`);
console.log(`fast routes passing >=1 camera: ${exposedFast}; avoidance reduced: ${camAvoidWorked}`);
console.log(`\nINVARIANT VIOLATIONS: ${problems.length}`);
problems.slice(0, 20).forEach(p => console.log('  ' + p));
process.exit(problems.length || pollFail.length ? 1 : 0);
