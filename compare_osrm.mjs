// Differential test: our fastest route vs OSRM (the OSM reference router)
// over the same origin/destination pairs.
//
//   node compare_osrm.mjs [tripCount]
//
// OSRM knows nothing about cameras, so only the FASTEST route is compared.
// The demo profile cannot exclude motorways, so trips where OSRM chose a
// freeway are classified separately: we refuse freeways by design, and that
// divergence is a product decision, not a defect.
//
// The interesting output is the DIVERGENT list. OSRM carries the complete
// OSM turn-restriction set; every place it detours where we do not is a
// candidate restriction our 45 are missing.
//
// Etiquette: this queries the public OSRM demo server. Small samples, one
// request at a time, 2.5s apart, identified user agent. Keep N modest.
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
const require = createRequire(import.meta.url);
const R = require('./site/router.js');
const fs = require('fs');

const graph = new R.Graph(JSON.parse(fs.readFileSync('site/data/graph.json')));
graph.assignCameras([]);
const bnd = JSON.parse(fs.readFileSync('site/data/boundary.json'));
const UA = 'vote-gr/1.0 (+https://github.com/DT616/votegr)';

function inside(lat, lng) {
  let ins = false;
  for (const ring of bnd.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) ins = !ins;
    }
  }
  return ins;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function osrm(a, b) {
  const url = `https://router.project-osrm.org/route/v1/driving/` +
    `${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson&steps=true`;
  try {
    const out = execFileSync('curl', ['-s', '--max-time', '30', '-A', UA, url],
                             { encoding: 'utf8' });
    const d = JSON.parse(out);
    if (d.code !== 'Ok' || !d.routes || !d.routes.length) return null;
    const r = d.routes[0];
    return {
      meters: r.distance, seconds: r.duration,
      pts: r.geometry.coordinates.map(c => [c[1], c[0]]),
      streets: [...new Set(r.legs.flatMap(l => l.steps.map(s => s.name)).filter(Boolean))],
    };
  } catch { return null; }
}

// metres between points, equirectangular (fine at city scale)
function dm(a, b) {
  const kx = 111320 * Math.cos(a[0] * Math.PI / 180), ky = 110574;
  return Math.hypot((a[1] - b[1]) * kx, (a[0] - b[0]) * ky);
}
// fraction of pts within tol metres of the other polyline (point sampling)
function overlap(pts, other, tol) {
  if (!pts.length || !other.length) return 0;
  let hit = 0;
  for (const p of pts) {
    let best = Infinity;
    for (const q of other) { const d = dm(p, q); if (d < best) best = d; if (d < tol) break; }
    if (best < tol) hit++;
  }
  return hit / pts.length;
}
// does the OSRM geometry ride one of OUR freeway edges?
const fwyPts = [];
graph.edges.forEach(e => { if (e.c === 1) e.p.forEach(p => fwyPts.push(p)); });
function usedFreeway(pts) {
  let run = 0;
  for (const p of pts) {
    let near = false;
    for (const q of fwyPts) { if (dm(p, q) < 40) { near = true; break; } }
    run = near ? run + 1 : 0;
    if (run >= 3) return true;      // a sustained stretch, not a crossing
  }
  return false;
}

const N = Number(process.argv[2] || 30);
const results = [];
console.log(`comparing ${N} trips against OSRM, one request per 2.5s...`);
const trips = [];
while (trips.length < N) {
  const A = [42.90 + Math.random() * 0.13, -85.72 + Math.random() * 0.12];
  const B = [42.90 + Math.random() * 0.13, -85.72 + Math.random() * 0.12];
  if (!inside(A[0], A[1]) || !inside(B[0], B[1])) continue;
  if (dm(A, B) < 1500) continue;
  trips.push([A, B]);
}

for (let i = 0; i < trips.length; i++) {
  const [A, B] = trips[i];
  const a = graph.snapToRoad(A[0], A[1]), b = graph.snapToRoad(B[0], B[1]);
  const ours = graph.route(a.node, b.node);
  if (!ours) continue;
  const ourPts = [];
  ours.edges.forEach((id, k) => {
    let p = graph.edges[id].p;
    if (ours.nodes[k] !== graph.edges[id].a) p = p.slice().reverse();
    p.forEach(pt => ourPts.push(pt));
  });
  const theirs = osrm([graph.nodes[a.node][0], graph.nodes[a.node][1]],
                      [graph.nodes[b.node][0], graph.nodes[b.node][1]]);
  await sleep(2500);
  if (!theirs) continue;
  const ovOurs = overlap(ourPts, theirs.pts, 60);
  const ovTheirs = overlap(theirs.pts, ourPts, 60);
  results.push({
    i, ourMi: ours.meters / 1609.34, osrmMi: theirs.meters / 1609.34,
    ourMin: ours.seconds / 60, osrmMin: theirs.seconds / 60,
    ov: Math.min(ovOurs, ovTheirs), fwy: usedFreeway(theirs.pts),
    ourStreets: [...new Set(graph.steps(ours).map(s => s.street).filter(Boolean))],
    osrmStreets: theirs.streets,
  });
  process.stdout.write('.');
}
console.log(`\n\n${results.length} comparable trips`);
const nonFwy = results.filter(r => !r.fwy), fwy = results.filter(r => r.fwy);
console.log(`OSRM chose a freeway on ${fwy.length} (excluded by our design; not compared further)`);
const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
console.log(`\nsurface-street trips (${nonFwy.length}):`);
console.log(`  avg corridor overlap: ${(100 * avg(nonFwy.map(r => r.ov))).toFixed(0)}%`);
console.log(`  avg distance: ours ${avg(nonFwy.map(r => r.ourMi)).toFixed(2)} mi, OSRM ${avg(nonFwy.map(r => r.osrmMi)).toFixed(2)} mi`);
const close = nonFwy.filter(r => r.ov >= 0.7);
const div = nonFwy.filter(r => r.ov < 0.5);
console.log(`  agree (overlap >=70%): ${close.length}   partially: ${nonFwy.length - close.length - div.length}   divergent (<50%): ${div.length}`);
for (const d of div.slice(0, 6)) {
  console.log(`\n  DIVERGENT trip ${d.i}: ours ${d.ourMi.toFixed(2)}mi/${d.ourMin.toFixed(0)}min vs OSRM ${d.osrmMi.toFixed(2)}mi/${d.osrmMin.toFixed(0)}min (overlap ${(100 * d.ov).toFixed(0)}%)`);
  console.log(`    ours: ${d.ourStreets.slice(0, 7).join(' > ')}`);
  console.log(`    OSRM: ${d.osrmStreets.slice(0, 7).join(' > ')}`);
}
fs.writeFileSync('build/osrm_comparison.json', JSON.stringify(results, null, 1));
console.log('\nfull results -> build/osrm_comparison.json');
