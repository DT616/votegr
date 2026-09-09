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
   /REAL ST/.test(g.edgeName(snap.edge)));

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
const beforeNodes = g.nodeCount(), beforeEdges = g.edgeCount();
let sp = g.splitAt(42.960, -85.670);          // exact midpoint
ok('splitAt: creates a new node', sp && sp.node === beforeNodes);
ok('splitAt: node sits at the requested point', sp && Math.abs(sp.lng + 85.670) < 1e-6);
ok('splitAt: adds two half-edges', g.edgeCount() === beforeEdges + 2);
ok('splitAt: halves sum to the original length',
   Math.abs((g.edgeLen(beforeEdges) + g.edgeLen(beforeEdges+1)) - 1600) < 5);
ok('splitAt: can route from the split point', g.route(sp.node, 1) !== null);
const half = g.route(sp.node, 1);
ok('splitAt: route from midpoint is about half', half && Math.abs(half.meters - 800) < 5);
sp.release();
ok('splitAt: release restores node count', g.nodeCount() === beforeNodes);
ok('splitAt: release restores edge count', g.edgeCount() === beforeEdges);
ok('splitAt: release restores adjacency',
   g.linksFrom(0).length + g.linksFrom(1).length === 2);
ok('splitAt: original edge usable again after release', g.route(0,1) !== null);

// A point near an end reuses the real node rather than making a sliver.
g = street(); g.assignCameras([]);
sp = g.splitAt(42.960, -85.68001);
ok('splitAt: near an end, reuses the existing node', sp && sp.node === 0);
ok('splitAt: no sliver edge created', g.edgeCount() === 1);

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
const degrees = (gr) => {
  const out = [];
  for (let n = 0; n < gr.nodeCount(); n++) out.push(gr.linksFrom(n).length);
  return out.join(',');
};
const base = { n: g.nodeCount(), e: g.edgeCount(),
               c: g._edgeCams.length, deg: degrees(g) };
for (let i = 0; i < 50; i++) {
  const s1 = g.splitAt(42.960, -85.6755 + (i % 7) * 0.0004);
  const s2 = g.splitAt(42.960, -85.6645 - (i % 5) * 0.0003);
  try { g.route(s1 ? s1.node : 0, s2 ? s2.node : 2); }
  finally { if (s2) s2.release(); if (s1) s1.release(); }
}
ok('splitAt: no node leak over 50 cycles', g.nodeCount() === base.n);
ok('splitAt: no edge leak over 50 cycles', g.edgeCount() === base.e);
ok('splitAt: no adjacency leak over 50 cycles', degrees(g).split(',').length === base.n);
ok('splitAt: no camera-array leak over 50 cycles', g._edgeCams.length === base.c);
ok('splitAt: adjacency degrees unchanged', degrees(g) === base.deg);
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
ok('freeway: snap avoids it', /SURFACE|A ST|B ST/.test(g.edgeName(g.snapToRoad(42.9601,-85.670).edge)));

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

// --- the county index --------------------------------------------------
// Precincts.county() holds all thirty jurisdictions at once, identified by
// the state's 13-digit code, because a bare number is no identity when there
// is a Precinct 1 in twenty-nine places. Grand Rapids must come out exactly
// as it did from the city files, and a township must come out with no ward
// rather than a blank one.
{
  const index = JSON.parse(fs.readFileSync('./site/data/precincts.json', 'utf8'));
  const mcds = index.jurisdictions.map((j) => j.mcd);
  const C = Precincts.county({
    index,
    addresses: mcds.map((m) => JSON.parse(fs.readFileSync(`./site/data/addresses/${m}.json`, 'utf8'))),
    polling: mcds.map((m) => JSON.parse(fs.readFileSync(`./site/data/polling/${m}.json`, 'utf8'))),
    cityPolling: JSON.parse(fs.readFileSync('./site/data/polling.json', 'utf8')),
    cityMcd: '34000',
  });
  ok('county: every jurisdiction contributes streets', C.streetNames.length > 8000);

  const gr = C.lookup('300 Monroe Ave NW');
  ok('county: a city address still resolves', !gr.error);
  ok('county: to the same ward and precinct as the city files',
     gr.ward === 2 && String(gr.precinct) === '40');
  ok('county: carrying the state code and the jurisdiction',
     gr.code === '0813400002040' && gr.jurisdiction === 'Grand Rapids' && gr.mcd === '34000');
  ok('county: the city keeps polling.json, with its entrance notes',
     Object.values(C.polling).filter((r) => r.entrance_note).length >= 15);

  // The Kentwood Activities Center is a polling place, so its own address
  // is a fair fixture. Kentwood has wards; Ada Township does not.
  const kw = C.lookup('355 48th St SE');
  ok('county: a Kentwood address resolves', !kw.error && kw.jurisdiction === 'Kentwood');
  ok('county: with a ward, because Kentwood has them', kw.ward === 1 || kw.ward === 2);
  ok('county: to a polling place with coordinates',
     kw.place && kw.place.lat && kw.place.name);

  const ada = C.lookup('6330 Ada Dr SE');   // as the type-ahead writes it
  ok('county: a township address resolves', !ada.error && ada.jurisdiction === 'Ada Township');
  ok('county: with NO ward, not a blank one', ada.ward === null);

  // 28th St SE runs through Grand Rapids, Kentwood and Wyoming. The street
  // is one list; the house number picks the jurisdiction.
  const where = C.whereIs('28TH ST SE');
  ok('county: a street through three cities lists all three',
     where.length >= 3 && where.includes('Kentwood'));
  ok('county: suggestions say where each street is',
     C.suggest('28th St', 8).every((o) => o.where && o.where.length));

  ok('county: drop boxes come per jurisdiction',
     C.dropBoxes('42820').length === 3 && C.dropBoxes('34000').length === 10);
  // Twenty-four jurisdictions publish no box. Their clerk's office is the
  // place an absentee ballot goes instead, and it has to be somewhere the
  // page can drive to.
  const noBox = index.jurisdictions.filter((j) => C.dropBoxes(j.mcd).length === 0);
  ok(`county: ${noBox.length} jurisdictions publish no drop box`, noBox.length >= 20);
  ok('county: every one of them has a clerk\'s office with a coordinate',
     noBox.every((j) => { const c = C.clerkOf(j.mcd); return c && c.lat && c.lng && c.phone; }));
}

// --- the polls clock ------------------------------------------------------
// On election day the banner stops counting to the day and counts the polls:
// to 7 AM, then to 8 PM, then says they have closed. The phase is decided
// from a fixed instant here so it can be checked at times that are not now.
{
  const E = require('./site/elections.js');
  const hours = { open: '7:00 AM', close: '8:00 PM' };
  const el = { date: '2026-11-03', name: 'General Election' };
  const at = (h, m) => new Date(2026, 10, 3, h, m || 0);   // local time
  ok('polls: 7:00 AM parses to 07:00 local', E.atTime('2026-11-03', '7:00 AM').getHours() === 7);
  ok('polls: 8:00 PM parses to 20:00 local', E.atTime('2026-11-03', '8:00 PM').getHours() === 20);
  ok('polls: 12:00 AM is midnight, not noon', E.atTime('2026-11-03', '12:00 AM').getHours() === 0);
  ok('polls: unreadable hours give null, not a guess', E.atTime('2026-11-03', 'dawn') === null);
  ok('polls: the day before is not a phase', E.pollsPhase(el, hours, new Date(2026, 10, 2, 23, 59)) === null);
  ok('polls: 6:59 AM is before', E.pollsPhase(el, hours, at(6, 59)) === 'before');
  ok('polls: 7:00 AM is open', E.pollsPhase(el, hours, at(7)) === 'open');
  ok('polls: 7:59 PM is still open', E.pollsPhase(el, hours, at(19, 59)) === 'open');
  ok('polls: 8:00 PM is closed', E.pollsPhase(el, hours, at(20)) === 'closed');
  ok('polls: 11:59 PM is still closed, not the next election', E.pollsPhase(el, hours, at(23, 59)) === 'closed');
  ok('polls: no hours means no phase', E.pollsPhase(el, null, at(12)) === null);
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

// ---- per-jurisdiction chunks ------------------------------------------
// The county graph ships as thirty chunks so a phone parses one jurisdiction
// rather than all of it. They keep county-wide node and edge ids and store
// maps rather than arrays, and Graph compacts that to its dense arrays once
// at construction. What is worth testing is not the compaction but the thing
// it exists for: two adjacent chunks overlap in a 150m ring, and a merged
// pair has to be ONE connected graph, not two graphs in one object.
{
  const fs = await import('fs');
  const chunk = (mcd) =>
    JSON.parse(fs.readFileSync(`./site/data/graph/${mcd}.json`, 'utf8'));

  const GR = '34000', KENTWOOD = '42820';
  const gr = new R.Graph(chunk(GR));
  ok('a chunk loads at all', gr.nodeCount() > 5000 && gr.edgeCount() > 5000);
  ok('a chunk geocodes', !!gr.geocode(602, 'ALEXANDER ST SE'));

  // The wire format is maps keyed by global id; everything downstream indexes
  // dense arrays. Both maps have to survive, because an id from the wire has
  // no other way back to a local index.
  ok('global ids are kept', !!gr.nodeId && !!gr.edgeId);
  const someId = Object.keys(chunk(GR).nodes)[0];
  ok('a global node id resolves to its own point',
     gr.node(gr.nodeId[someId]).every((v, i) =>
       Math.abs(v - chunk(GR).nodes[someId][i]) < 1e-6));

  const kw = new R.Graph(chunk(KENTWOOD));
  const both = new R.Graph([chunk(GR), chunk(KENTWOOD)]);

  // A union, not a concatenation: the ring means hundreds of nodes are in
  // both chunks, and each is ONE node in the merge. If they were duplicated
  // the border would be two parallel road networks that never touch.
  const sharedNodes = gr.nodeCount() + kw.nodeCount() - both.nodeCount();
  const sharedEdges = gr.edgeCount() + kw.edgeCount() - both.edgeCount();
  ok(`the ring is shared, not duplicated (${sharedNodes} nodes, ${sharedEdges} edges)`,
     sharedNodes > 100 && sharedEdges > 100);
  ok('no restriction is lost in the merge',
     both.restrictionCount === gr.restrictionCount + kw.restrictionCount);

  // The point of the whole thing. A Grand Rapids origin and a Kentwood
  // destination: on the GR chunk alone the router still answers, but it stops
  // at the edge of the chunk, most of a kilometre short of where the voter is
  // going. That is worse than an error, because it looks like a route.
  const origin = { lat: 42.9276, lng: -85.6353 };     // 602 Alexander St SE
  const kentwood = Object.values(
    JSON.parse(fs.readFileSync('./site/data/polling/42820.json', 'utf8')).precincts
  ).find((p) => p.lat);
  const missBy = (g) => {
    const d = g.snapToRoad(kentwood.lat, kentwood.lng);
    return R.haversine(kentwood.lat, kentwood.lng, g.nodeLat(d.node), g.nodeLng(d.node));
  };
  const alone = missBy(gr), together = missBy(both);
  ok(`merging reaches the destination (${Math.round(alone)}m -> ${Math.round(together)}m)`,
     together < alone / 2);
  const crossed = both.route(both.snapToRoad(origin.lat, origin.lng).node,
                             both.snapToRoad(kentwood.lat, kentwood.lng).node);
  ok('a route crosses the jurisdiction line', !!crossed && crossed.edges.length > 0);

  // Ids are positions in ONE build. Chunks from different builds share
  // numbers that mean different roads, and merging them would splice
  // unrelated streets together with no visible error -- a route down a road
  // that does not exist. It has to refuse.
  const stale = chunk(KENTWOOD);
  stale.meta = Object.assign({}, stale.meta, { build: 'deadbeef0000' });
  let refused = false;
  try { new R.Graph([chunk(GR), stale]); } catch (e) { refused = /build/.test(e.message); }
  ok('chunks from different builds are refused', refused);

  // Streaming: the same graph, built without ever holding two chunks.
  //
  // Handing Graph all thirty parsed chunks costs 102 MiB at the moment it
  // happens, against a 13 MiB steady state, and that transient is what
  // decides whether the page survives on an older phone. Streaming from the
  // index drops it to 40 MiB. The result has to be indistinguishable, or the
  // saving is bought with a different graph.
  const index = JSON.parse(fs.readFileSync('./site/data/graph/index.json', 'utf8'));
  ok('the chunk index lists every chunk', index.chunks.length === 30);
  ok('the index carries sizes to allocate from',
     index.chunks.every((c) => c.nodes > 0 && c.edges > 0 && c.points > 0));

  const twoChunks = { build: index.build,
                      chunks: index.chunks.filter((c) => c.mcd === GR || c.mcd === KENTWOOD) };
  const streamed = R.Graph.streaming(twoChunks);
  streamed.addChunk(chunk(GR));
  streamed.addChunk(chunk(KENTWOOD));
  streamed.finish();

  ok('streamed and merged agree on size',
     streamed.nodeCount() === both.nodeCount() &&
     streamed.edgeCount() === both.edgeCount() &&
     streamed.restrictionCount === both.restrictionCount);

  let coordsDiffer = 0;
  for (let i = 0; i < both.nodeCount(); i++) {
    if (both.nodeLat(i) !== streamed.nodeLat(i) ||
        both.nodeLng(i) !== streamed.nodeLng(i)) coordsDiffer++;
  }
  ok('streamed and merged agree on every coordinate', coordsDiffer === 0);

  let adjDiffer = 0;
  for (let n = 0; n < both.nodeCount(); n++) {
    if (JSON.stringify(both.linksFrom(n)) !== JSON.stringify(streamed.linksFrom(n))) {
      adjDiffer++;
    }
  }
  ok('streamed and merged agree on every adjacency list', adjDiffer === 0);

  const src = both.snapToRoad(origin.lat, origin.lng).node;
  const dst = both.snapToRoad(kentwood.lat, kentwood.lng).node;
  ok('streamed and merged route identically',
     JSON.stringify(both.route(src, dst).edges) ===
     JSON.stringify(streamed.route(src, dst).edges));

  // A restriction can name an edge that only arrives in a LATER chunk, so
  // they are held and resolved at finish(). Feeding the same two chunks in
  // the other order must not lose any.
  const reversed = R.Graph.streaming(twoChunks);
  reversed.addChunk(chunk(KENTWOOD));
  reversed.addChunk(chunk(GR));
  reversed.finish();
  ok('chunk order does not change the graph',
     reversed.nodeCount() === streamed.nodeCount() &&
     reversed.edgeCount() === streamed.edgeCount() &&
     reversed.restrictionCount === streamed.restrictionCount);

  // The index reserves an upper bound. Understating it must fail loudly
  // rather than silently truncate the county at the end of the array.
  let overflowed = false;
  try {
    const tooSmall = R.Graph.streaming({ build: index.build,
      chunks: [{ nodes: 10, edges: 10, points: 10 }] });
    tooSmall.addChunk(chunk(GR));
  } catch (e) { overflowed = /reserved/.test(e.message); }
  ok('an index that understates the sizes is refused', overflowed);

  // The snap grid. snapToRoad used to walk every edge in the graph, which
  // at county size is 14ms per call and happens twice per lookup; it now
  // consults a cell index. An index that ever returned a DIFFERENT edge
  // than the full scan would put the start of a route on the wrong street,
  // so the two are compared directly, on random points spread over both
  // jurisdictions and a few deliberately out in the middle of nowhere.
  const brute = (g, lat, lng) => {
    let bestEdge = -1, bestD = Infinity;
    for (let i = 0; i < g.edgeCount(); i++) {
      if (g.edgeClass(i) === 1) continue;
      let d = g._distToEdge(lat, lng, i);
      if (/\bALY\b|\bALLEY\b/.test(g.edgeName(i))) d += 120;
      if (d < bestD) { bestD = d; bestEdge = i; }
    }
    return { edge: bestEdge, meters: bestD };
  };
  let snapAgree = 0, snapWorse = 0;
  const TRIALS = 120;
  for (let t = 0; t < TRIALS; t++) {
    const lat = 42.84 + Math.random() * 0.17, lng = -85.75 + Math.random() * 0.2;
    const a = both.snapToRoad(lat, lng), b = brute(both, lat, lng);
    if (a.edge === b.edge) snapAgree++;
    else if (a.meters > b.meters + 0.01) snapWorse++;   // a tie is not a miss
  }
  ok(`snap grid agrees with a full scan (${snapAgree}/${TRIALS} identical)`,
     snapWorse === 0 && snapAgree > TRIALS * 0.95);
  // A point far outside every cell still resolves to SOMETHING: the grid
  // widens a few rings, then hands off to the nearest-node scan, which is
  // what routing needs -- a node -- even when there is no edge close by.
  const far = both.snapToRoad(43.4, -85.2);
  ok('a point far off the network still resolves to a node',
     far && far.node >= 0 && far.meters > 10000);

  // A chunk document must survive being used twice: once alone, once merged.
  // Rewriting its endpoints in place would corrupt the second use.
  const doc = chunk(KENTWOOD);
  const first = new R.Graph(doc).edgeCount();
  new R.Graph([chunk(GR), doc]);
  ok('a chunk document is not consumed by use',
     new R.Graph(doc).edgeCount() === first);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
