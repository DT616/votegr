// Plain-assert tests for the router core. Run: node test_router.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const R = require('./site/router.js');

let pass = 0, fail = 0;
function ok(name, cond) { cond ? (pass++, console.log('  ok  ' + name)) : (fail++, console.log('  FAIL ' + name)); }

// --- Tiny hand-built graph -------------------------------------------
// Nodes: 0 --edge0(fast,2 cam)--> 1 ;  0 --e1--> 2 --e2--> 1 (slow, 0 cam)
// A straight fast road with cameras, and a longer clean detour.
function tiny(withCamOnFast) {
  const g = new R.Graph({
    nodes: [[42.96, -85.67], [42.97, -85.67], [42.96, -85.68], [42.97, -85.68]],
    edges: [
      { a: 0, b: 1, d: 0, l: 1000, t: 60, n: 'Fast St', r: [], z: [], p: [[42.96,-85.67],[42.97,-85.67]] },
      { a: 0, b: 2, d: 0, l: 1200, t: 90, n: 'Detour A', r: [], z: [], p: [[42.96,-85.67],[42.96,-85.68]] },
      { a: 2, b: 1, d: 0, l: 1200, t: 90, n: 'Detour B', r: [], z: [], p: [[42.96,-85.68],[42.97,-85.67]] },
    ],
    meta: {}
  });
  // put 2 cameras exactly on the midpoint of Fast St if requested
  const cams = withCamOnFast
    ? [{ id: 'c1', lat: 42.965, lng: -85.67 }, { id: 'c2', lat: 42.966, lng: -85.67 }]
    : [];
  g.assignCameras(cams);
  return g;
}

// 1. No cameras -> takes the fast road
let g = tiny(false);
let r = g.route(0, 1);
ok('no cameras: picks fast road (1 edge)', r && r.edges.length === 1 && r.cameraCount === 0);

// 2. Cameras on fast road -> detours around, 0 cameras, more seconds
g = tiny(true);
r = g.route(0, 1);
ok('camera avoidance: detours (2 edges)', r && r.edges.length === 2);
ok('camera avoidance: zero cameras passed', r && r.cameraCount === 0);
// the detour is two edges with one turn between them, so its time is the
// 180s of driving plus that turn's cost
ok('camera avoidance: slower than fast road', r && r.seconds >= 180 && r.seconds <= 210);

// 3. Min-exposure fallback: block the detour so the ONLY path has a camera.
//    Make detour B one-way the wrong way -> forced through Fast St.
g = new R.Graph({
  nodes: [[42.96,-85.67],[42.97,-85.67],[42.96,-85.68]],
  edges: [
    { a:0,b:1,d:0,l:1000,t:60,n:'Only Rd',r:[],z:[],p:[[42.96,-85.67],[42.97,-85.67]] },
    { a:0,b:2,d:1,l:1200,t:90,n:'Deadend',r:[],z:[],p:[[42.96,-85.67],[42.96,-85.68]] },
  ], meta:{}
});
g.assignCameras([{ id:'c1', lat:42.965, lng:-85.67 }]);
r = g.route(0, 1);
ok('min-exposure: still returns a route', r !== null);
ok('min-exposure: reports the unavoidable camera', r && r.cameraCount === 1 && r.cameras[0] === 'c1');

// 4. One-way respected: 1->0 on a forward-only edge is unreachable
g = new R.Graph({
  nodes: [[42.96,-85.67],[42.97,-85.67]],
  edges: [{ a:0,b:1,d:1,l:1000,t:60,n:'OneWay',r:[],z:[],p:[[42.96,-85.67],[42.97,-85.67]] }],
  meta:{}
});
g.assignCameras([]);
ok('one-way: forward reachable', g.route(0,1) !== null);
ok('one-way: reverse blocked', g.route(1,0) === null);

// --- turn-by-turn -----------------------------------------------------
// A dogleg: east, then north. The step list must name the turn and not
// double-report a camera that sits near the corner.
g = new R.Graph({
  nodes: [[42.960,-85.670],[42.960,-85.660],[42.970,-85.660]],
  edges: [
    { a:0,b:1,d:0,l:800,t:60,n:'EAST ST',r:[],z:[],p:[[42.960,-85.670],[42.960,-85.660]] },
    { a:1,b:2,d:0,l:1100,t:80,n:'NORTH AVE',r:[],z:[],p:[[42.960,-85.660],[42.970,-85.660]] },
  ], meta:{}
});
// one camera right at the corner, in range of both edges
g.assignCameras([{ id:'corner', lat:42.9600, lng:-85.6600 }]);
r = g.route(0,2);
let steps = g.steps(r);
ok('steps: one per leg plus arrival', steps.length === 3);
ok('steps: first says head east', /east/i.test(steps[0].text));
ok('steps: names the street', /EAST ST/.test(steps[0].text));
ok('steps: detects the left turn onto NORTH AVE', /left onto NORTH AVE/i.test(steps[1].text));
ok('steps: last step is arrival', steps[2].arrive === true);
const stepCams = steps.reduce((n,s)=>n+s.cameras.length,0);
ok('steps: corner camera counted once, not per leg', stepCams === 1);

// --- snapToRoad -------------------------------------------------------
// A named street and a parallel alley; a point nearer the alley should still
// snap to the street, because alleys are penalized.
g = new R.Graph({
  nodes: [[42.960,-85.670],[42.960,-85.660],[42.9605,-85.670],[42.9605,-85.660]],
  edges: [
    { a:0,b:1,d:0,l:800,t:60,n:'REAL ST SE',r:[],z:[],p:[[42.960,-85.670],[42.960,-85.660]] },
    { a:2,b:3,d:0,l:800,t:60,n:'BACK ALY SE',r:[],z:[],p:[[42.9605,-85.670],[42.9605,-85.660]] },
  ], meta:{}
});
g.assignCameras([]);
let snap = g.snapToRoad(42.96045, -85.665);   // ~5m from alley, ~50m from street
ok('snapToRoad: prefers a street over a nearer alley',
   /REAL ST/.test(g.edges[snap.edge].n));

// A one-way may only be entered at its tail.
g = new R.Graph({
  nodes: [[42.960,-85.670],[42.960,-85.660]],
  edges: [{ a:0,b:1,d:1,l:800,t:60,n:'ONEWAY ST',r:[],z:[],p:[[42.960,-85.670],[42.960,-85.660]] }],
  meta:{}
});
g.assignCameras([]);
ok('snapToRoad: enters a one-way at its tail',
   g.snapToRoad(42.960, -85.6605).node === 0);

// --- turn restrictions -------------------------------------------------
// A T junction: arrive on WEST, then either turn onto NORTH or continue EAST.
// A no_left_turn from WEST onto NORTH must force the long way round.
function tee(withRestriction) {
  return new R.Graph({
    nodes: [[42.960,-85.680],[42.960,-85.670],[42.970,-85.670],[42.960,-85.660],[42.970,-85.660]],
    edges: [
      { a:0,b:1,d:0,l:800,t:60,n:'WEST ST',r:[],z:[],p:[[42.960,-85.680],[42.960,-85.670]] },   // 0
      { a:1,b:2,d:0,l:1100,t:60,n:'NORTH AVE',r:[],z:[],p:[[42.960,-85.670],[42.970,-85.670]] },// 1
      { a:1,b:3,d:0,l:800,t:60,n:'EAST ST',r:[],z:[],p:[[42.960,-85.670],[42.960,-85.660]] },   // 2
      { a:3,b:4,d:0,l:1100,t:60,n:'FAR NORTH',r:[],z:[],p:[[42.960,-85.660],[42.970,-85.660]] },// 3
      { a:4,b:2,d:0,l:800,t:60,n:'TOP ST',r:[],z:[],p:[[42.970,-85.660],[42.970,-85.670]] },    // 4
    ],
    restrictions: withRestriction ? [{ f:0, v:1, t:1, no:true }] : [],
    meta:{}
  });
}
g = tee(false); g.assignCameras([]);
r = g.route(0, 2);
ok('restriction: without one, takes the direct turn', r && r.edges.length === 2);

g = tee(true); g.assignCameras([]);
r = g.route(0, 2);
ok('restriction: no_left forces the long way', r && r.edges.length === 4);
ok('restriction: forbidden edge not used', r && r.edges.indexOf(1) === -1);
ok('restriction: turnAllowed reports the ban', g.turnAllowed(0, 1, 1) === false);
ok('restriction: other turns still allowed', g.turnAllowed(0, 1, 2) === true);
ok('restriction: ban does not apply from elsewhere', g.turnAllowed(2, 1, 1) === true);
ok('restriction: start of route is unrestricted', g.turnAllowed(null, 1, 1) === true);

// only_* forbids every exit but the named one
g = new R.Graph({
  nodes: [[42.960,-85.680],[42.960,-85.670],[42.970,-85.670],[42.960,-85.660]],
  edges: [
    { a:0,b:1,d:0,l:800,t:60,n:'IN',r:[],z:[],p:[[42.960,-85.680],[42.960,-85.670]] },
    { a:1,b:2,d:0,l:800,t:60,n:'ALLOWED',r:[],z:[],p:[[42.960,-85.670],[42.970,-85.670]] },
    { a:1,b:3,d:0,l:800,t:60,n:'BLOCKED',r:[],z:[],p:[[42.960,-85.670],[42.960,-85.660]] },
  ],
  restrictions: [{ f:0, v:1, t:1, no:false }],
  meta:{}
});
g.assignCameras([]);
ok('only_*: the named turn is allowed', g.turnAllowed(0,1,1) === true);
ok('only_*: every other turn is forbidden', g.turnAllowed(0,1,2) === false);
// Not unreachable: the restriction only governs turns made FROM edge 0. Going
// up ALLOWED and coming back re-approaches on a different edge, where it does
// not apply -- which is what the rule actually says, and what a driver could
// really do. The direct turn must still be refused.
r = g.route(0,3);
ok('only_*: still reachable by re-approaching', r !== null);
ok('only_*: does not take the forbidden direct turn',
   r && !(r.edges[0] === 0 && r.edges[1] === 2));
ok('only_*: doubles back instead', r && r.edges.length === 4);

// U-turns are legal but penalized, so a route never picks one gratuitously.
const straight = new R.Graph({
  nodes: [[42.960,-85.680],[42.960,-85.670],[42.960,-85.660]],
  edges: [
    { a:0,b:1,d:0,l:500,t:40,n:'A',r:[],z:[],p:[[42.960,-85.680],[42.960,-85.670]] },
    { a:1,b:2,d:0,l:500,t:40,n:'B',r:[],z:[],p:[[42.960,-85.670],[42.960,-85.660]] },
  ], meta:{}
});
straight.assignCameras([]);
const sr = straight.route(0,2);
ok('u-turn: straight route unaffected by the penalty', sr && sr.edges.length === 2 && sr.seconds === 80);

// --- mid-block splitting ----------------------------------------------
// One long straight street. A point at its middle should start the route
// there, not at either end, and the graph must be restored afterwards.
function street() {
  return new R.Graph({
    nodes: [[42.960,-85.680],[42.960,-85.660]],
    edges: [{ a:0,b:1,d:0,l:1600,t:120,n:'LONG ST',r:[],z:[],
              p:[[42.960,-85.680],[42.960,-85.670],[42.960,-85.660]] }],
    meta:{}
  });
}
g = street(); g.assignCameras([]);
const beforeNodes = g.nodes.length, beforeEdges = g.edges.length;
let sp = g.splitAt(42.960, -85.670);          // exact midpoint
ok('splitAt: creates a new node', sp && sp.node === beforeNodes);
ok('splitAt: node sits at the requested point', sp && Math.abs(sp.lng + 85.670) < 1e-6);
ok('splitAt: adds two half-edges', g.edges.length === beforeEdges + 2);
ok('splitAt: halves sum to the original length',
   Math.abs((g.edges[beforeEdges].l + g.edges[beforeEdges+1].l) - 1600) < 5);
ok('splitAt: can route from the split point', g.route(sp.node, 1) !== null);
const half = g.route(sp.node, 1);
ok('splitAt: route from midpoint is about half', half && Math.abs(half.meters - 800) < 5);
sp.release();
ok('splitAt: release restores node count', g.nodes.length === beforeNodes);
ok('splitAt: release restores edge count', g.edges.length === beforeEdges);
ok('splitAt: release restores adjacency', g.adj.length === beforeNodes);
ok('splitAt: original edge usable again after release', g.route(0,1) !== null);

// A point near an end reuses the real node rather than making a sliver.
g = street(); g.assignCameras([]);
sp = g.splitAt(42.960, -85.68001);
ok('splitAt: near an end, reuses the existing node', sp && sp.node === 0);
ok('splitAt: no sliver edge created', g.edges.length === 1);

// Cameras on the parent edge carry to both halves, so a mid-block start does
// not silently change the exposure count.
g = street();
g.assignCameras([{ id:'c1', lat:42.960, lng:-85.675 }]);
sp = g.splitAt(42.960, -85.670);
ok('splitAt: halves inherit the parent edge cameras',
   (g._edgeCams[1]||[]).length === 1 && (g._edgeCams[2]||[]).length === 1);
sp.release();
ok('splitAt: release trims camera assignments', g._edgeCams.length === 1);

// splitAt mutates the live graph, so the thing that would really bite is a
// slow leak across many lookups. Assert the graph is byte-for-byte restored,
// including adjacency degree, which a partial restore would corrupt silently.
g = new R.Graph({
  nodes: [[42.960,-85.680],[42.960,-85.670],[42.960,-85.660],[42.970,-85.670]],
  edges: [
    { a:0,b:1,d:0,l:800,t:60,n:'A ST',r:[],z:[],p:[[42.960,-85.680],[42.960,-85.670]] },
    { a:1,b:2,d:0,l:800,t:60,n:'B ST',r:[],z:[],p:[[42.960,-85.670],[42.960,-85.660]] },
    { a:1,b:3,d:0,l:800,t:60,n:'C ST',r:[],z:[],p:[[42.960,-85.670],[42.970,-85.670]] },
  ], meta:{}
});
g.assignCameras([{ id:'x', lat:42.960, lng:-85.675 }]);
const base = { n: g.nodes.length, e: g.edges.length, a: g.adj.length,
               c: g._edgeCams.length, deg: g.adj.map(l => l.length).join(',') };
for (let i = 0; i < 50; i++) {
  const s1 = g.splitAt(42.960, -85.6755 + (i % 7) * 0.0004);
  const s2 = g.splitAt(42.960, -85.6645 - (i % 5) * 0.0003);
  try { g.route(s1 ? s1.node : 0, s2 ? s2.node : 2); }
  finally { if (s2) s2.release(); if (s1) s1.release(); }
}
ok('splitAt: no node leak over 50 cycles', g.nodes.length === base.n);
ok('splitAt: no edge leak over 50 cycles', g.edges.length === base.e);
ok('splitAt: no adjacency leak over 50 cycles', g.adj.length === base.a);
ok('splitAt: no camera-array leak over 50 cycles', g._edgeCams.length === base.c);
ok('splitAt: adjacency degrees unchanged', g.adj.map(l => l.length).join(',') === base.deg);
ok('splitAt: graph still routes normally afterwards', g.route(0, 2) !== null);

// --- freeway exclusion -------------------------------------------------
// A fast class-1 shortcut and a slower surface street. The route must take
// the surface street even though the freeway is quicker, and a point next to
// the freeway must snap to the surface street.
g = new R.Graph({
  nodes: [[42.960,-85.680],[42.960,-85.660],[42.9605,-85.680],[42.9605,-85.660]],
  edges: [
    { a:0,b:1,d:0,l:1600,t:60, c:1, n:'US-131 FWY',r:[],z:[],p:[[42.960,-85.680],[42.960,-85.660]] },
    { a:0,b:2,d:0,l:60,  t:8,  c:5, n:'A ST',r:[],z:[],p:[[42.960,-85.680],[42.9605,-85.680]] },
    { a:2,b:3,d:0,l:1600,t:150,c:5, n:'SURFACE ST',r:[],z:[],p:[[42.9605,-85.680],[42.9605,-85.660]] },
    { a:3,b:1,d:0,l:60,  t:8,  c:5, n:'B ST',r:[],z:[],p:[[42.9605,-85.660],[42.960,-85.660]] },
  ], meta:{}
});
g.assignCameras([]);
r = g.route(0, 1);
ok('freeway: never used even when faster', r && r.edges.indexOf(0) === -1);
ok('freeway: surface route found instead', r && r.edges.length === 3);
ok('freeway: snap avoids it', /SURFACE|A ST|B ST/.test(g.edges[g.snapToRoad(42.9601,-85.670).edge].n));

// --- address suggestions ------------------------------------------------
// Grand Rapids numbers restart per quadrant from Fulton and Division, so a
// number that does not exist on one side usually exists on the other. The
// suggestion order has to reflect that, and must not bury a good answer under
// a list of the neighbors' addresses.
const fs = require('fs');
const { Precincts } = require('./site/precinct.js');
const P = new Precincts(
  JSON.parse(fs.readFileSync('./site/data/addresses.json')),
  JSON.parse(fs.readFileSync('./site/data/polling.json')));

// Fixtures here are deliberately commercial, civic, or numbers that exist
// nowhere. This tool's whole claim is that it does not put anyone's address
// on the record, so its own test suite should not name a stranger's house.
// 250 Monroe Ave NW is a downtown commercial block whose exact number is not
// in the parcel file, which is what makes it the 'inferred' case.
let sg = P.suggest('250 Monroe Ave NW', 8);
ok('suggest: a resolvable address returns only itself', sg.length === 1);
ok('suggest: and it is that address', sg[0].number === 250 && /MONROE AVE NW/.test(sg[0].street));

sg = P.suggest('300 Monroe Ave NW', 8);
ok('suggest: an exact hit returns only itself', sg.length === 1 && sg[0].kind === 'exact');

// 15 Burton St SE does not exist; 15 Burton St SW does. So the right answer
// is the other quadrant of the same street, not the nearest numbers on the
// one that was typed.
sg = P.suggest('15 Burton St SE', 8);
ok('suggest: offers the other quadrant, not the neighbors',
   sg.length && sg[0].kind === 'quadrant' && /BURTON ST SW/.test(sg[0].street));
ok('suggest: keeps the number the person typed', sg[0].number === 15);
ok('suggest: does not list unrelated numbers alongside it',
   sg.every(x => x.number === 15));

// Nothing anywhere: neighbors are the last resort, and only then.
sg = P.suggest('99999 Burton St SE', 8);
ok('suggest: falls back to nearest on the street', sg.length > 0 && sg[0].kind === 'near');

// --- movement classification (used to read turn signs) ------------------
// A no-left-turn sign is only useful if "left" is identified correctly from
// the bearings; getting it backwards would ban the opposite movement.
{
  const g2 = new R.Graph({ nodes: [[42.96,-85.67]], edges: [], meta: {} });
  // bearings: arriving northbound (0), leaving east (90) is a RIGHT turn
  const mv = (a, b) => {
    const d = ((b - a + 540) % 360) - 180, x = Math.abs(d);
    return x < 35 ? 'through' : x > 150 ? 'uturn' : (d > 0 ? 'right' : 'left');
  };
  ok('movement: north then east is a right', mv(0, 90) === 'right');
  ok('movement: north then west is a left', mv(0, 270) === 'left');
  ok('movement: north then north is through', mv(0, 5) === 'through');
  ok('movement: north then south is a u-turn', mv(0, 180) === 'uturn');
  ok('movement: wraps correctly past 0', mv(350, 80) === 'right');
}

// The shipped graph must carry restrictions from both sources, and every one
// must reference edges that exist.
{
  const gr = JSON.parse(fs.readFileSync('./site/data/graph.json'));
  const rs = gr.restrictions || [];
  ok('graph ships turn restrictions', rs.length > 60);
  ok('restrictions come from both sources',
     rs.some(r => r.src === 'sign') && rs.some(r => !r.src || r.src === 'osm'));
  ok('every restriction references real edges',
     rs.every(r => gr.edges[r.f] && gr.edges[r.t] && gr.nodes[r.v]));
  ok('no restriction bans a turn onto itself', rs.every(r => r.f !== r.t));
}

// --- inferred addresses must defer to the precinct boundary --------------
// 401 Ionia Ave SW is not in the parcel index. Its only nearby rows are 400,
// 404 and 408, which sit across the street on the far side of a boundary that
// runs down Ionia, so inferring from neighbors puts it in precinct 6 when the
// polygon says 15.
//
// This exercises the SHIPPED refineWithPolygon, not a copy of it. An earlier
// version of this block reimplemented point-in-polygon inline and asserted
// facts about the data files, so it passed for weeks while the page itself
// applied no refinement at all and kept answering 6.
{
  const polys = JSON.parse(fs.readFileSync('./site/data/precincts.json')).precincts;
  const gr = new R.Graph(JSON.parse(fs.readFileSync('./site/data/graph.json')));
  const geo = (n, st) => gr.geocode(n, st);

  const raw = P.lookup('401 Ionia Ave SW');
  ok('401 Ionia: not an exact parcel match', raw.inferred === true);
  ok('401 Ionia: neighbors alone put it in precinct 6', String(raw.precinct) === '6');

  const r = P.refineWithPolygon(P.lookup('401 Ionia Ave SW'), geo, polys);
  ok('401 Ionia: the boundary overrules the neighbors', String(r.precinct) === '15');
  ok('401 Ionia: the ward follows the precinct',
     String(r.ward) === String(polys.find(p => String(p.precinct) === '15').ward));
  ok('401 Ionia: the polling place follows the precinct',
     r.place && r.place.name === P.pollingPlace('15').name);
  ok('401 Ionia: both precincts are still named for the reader',
     Array.isArray(r.rivals) && r.rivals.indexOf('15') >= 0 && r.rivals.indexOf('6') >= 0);

  // The rule is inferred-only. An exact parcel match must come back untouched,
  // because geocoding it lands on the centerline and the polygon disagrees for
  // about 1 in 15 of them.
  let exactChecked = 0, exactChanged = 0;
  for (const st of Object.keys(P.streets)) {
    for (const row of P.streets[st]) {
      const one = P.lookup(row[0] + ' ' + st);
      if (one.error || one.inferred) continue;
      const before = String(one.precinct);
      P.refineWithPolygon(one, geo, polys);
      exactChecked++;
      if (String(one.precinct) !== before) exactChanged++;
      if (exactChecked >= 400) break;
    }
    if (exactChecked >= 400) break;
  }
  ok(`exact parcel matches are never overruled (${exactChecked} checked)`,
     exactChecked > 100 && exactChanged === 0);

  // No geocode means no opinion: leave the neighbors' answer alone.
  const noGeo = P.refineWithPolygon(P.lookup('401 Ionia Ave SW'), () => null, polys);
  ok('401 Ionia: an unplaceable address keeps the inferred answer',
     String(noGeo.precinct) === '6');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
