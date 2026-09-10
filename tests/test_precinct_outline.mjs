// Released into the public domain under the Unlicense, see UNLICENSE.
// The jurisdiction outline: the solid line the map draws to say "this is the
// city or township your address is in".
//
// build_precincts.py precomputes it as the union of the jurisdiction's
// precincts. The page used to work it out for itself instead, by counting
// every precinct edge and keeping the ones seen exactly once, which assumes
// two neighbouring precincts describe their shared border with the same
// vertices. They do not, because each polygon is thinned on its own upstream,
// so both sides of an interior border were counted once and both were drawn.
// That put 263 km of line through the insides of jurisdictions, 71 km of it
// within Grand Rapids, where a third of the yellow on the screen was wrong.
//
// So the test that matters is not "an outline exists and is closed": the
// broken version passed that too, and it is the trap this file exists to
// avoid. It is that the outline is a BORDER, meaning the jurisdiction is on
// one side of it and not the other. Step off each segment to either side and
// exactly one of those points may belong to the jurisdiction. The old
// derivation fails this on 643 segments; the union passes on all 3,062.
import { readFile } from 'fs/promises';

let fails = 0;
const ok = (n, c, d = '') => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  ' + d)); if (!c) fails++; };

const D = JSON.parse(await readFile(new URL('../site/data/precincts.json', import.meta.url), 'utf8'));

// Metres per degree at 43N, the county's latitude. Every threshold below is
// in metres so it can be argued about as ground rather than as coordinates.
const MLAT = 111320, MLNG = 111320 * Math.cos(43 * Math.PI / 180);
const m = (a, b) => Math.hypot((a[0] - b[0]) * MLAT, (a[1] - b[1]) * MLNG);

// How far to step off the line, and the shortest segment worth stepping off.
// Corners are where this technique is weakest: near one, a step meant for the
// outside can land back inside, or miss the jurisdiction entirely. Segments
// under MIN_M are mostly corner, and skipping them costs nothing -- 643 of
// the old derivation's failures are longer than that.
const STEP_M = 5, MIN_M = 40;

function inside(p, rings) {          // even-odd, as the page's own test does it
  let n = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const yi = r[i][0], xi = r[i][1], yj = r[j][0], xj = r[j][1];
      if ((yi > p[0]) !== (yj > p[0]) &&
          p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) n = !n;
    }
  }
  return n;
}
const inJurisdiction = (p, own) => own.some(pr => inside(p, pr.rings));

const byMcd = new Map();
for (const p of D.precincts) {
  if (!byMcd.has(p.mcd)) byMcd.set(p.mcd, []);
  byMcd.get(p.mcd).push(p);
}

ok(`every jurisdiction carries an outline (${D.jurisdictions.length})`,
   D.jurisdictions.every(j => Array.isArray(j.outline) && j.outline.length));

// --- shape ---
let badShape = null, dots = 0;
for (const j of D.jurisdictions) {
  for (const r of j.outline || []) {
    if (r.length < 4) badShape = `${j.name}: ring of ${r.length} points`;
    else if (String(r[0]) !== String(r[r.length - 1])) badShape = `${j.name}: ring not closed`;
    for (let i = 0; i < r.length - 1; i++) if (m(r[i], r[i + 1]) === 0) dots++;
  }
}
ok('outline rings are closed and have real extent', badShape === null, badShape || '');
// The map draws this line with a round cap, under which a zero-length segment
// paints a filled circle. It is a visible speck, not a no-op.
ok('no zero-length outline segments', dots === 0, `${dots} would paint as dots`);

// --- the invariant the bug broke: a border has the place on ONE side ---
// Three samples per segment rather than one, so a defect that starts partway
// along a long segment is still caught.
let strayCount = 0, strayKm = 0, checked = 0;
const per = [];
for (const j of D.jurisdictions) {
  const own = byMcd.get(j.mcd) || [];
  let bad = 0;
  for (const r of j.outline) {
    for (let i = 0; i < r.length - 1; i++) {
      const a = r[i], b = r[i + 1], len = m(a, b);
      if (len < MIN_M) continue;
      checked++;
      const dx = (b[1] - a[1]) * MLNG, dy = (b[0] - a[0]) * MLAT, L = Math.hypot(dx, dy);
      const nx = -dy / L, ny = dx / L, step = Math.min(STEP_M, len / 4);
      let stray = false;
      for (const t of [0.25, 0.5, 0.75]) {
        const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const left = [q[0] + ny * step / MLAT, q[1] + nx * step / MLNG];
        const right = [q[0] - ny * step / MLAT, q[1] - nx * step / MLNG];
        if (inJurisdiction(left, own) && inJurisdiction(right, own)) stray = true;
      }
      if (stray) { bad++; strayKm += len / 1000; }
    }
  }
  strayCount += bad;
  if (bad) per.push(`${j.name} ${bad}`);
}
ok(`no outline segment has its own jurisdiction on both sides (${checked} checked)`,
   strayCount === 0, `${strayCount} do, ${strayKm.toFixed(2)} km: ${per.join(', ')}`);

// --- the outline really bounds its own precincts ---
let stray = null;
for (const j of D.jurisdictions) {
  for (const p of byMcd.get(j.mcd) || []) {
    if (!inside(p.label, j.outline)) { stray = `${p.name} sits outside ${j.name}`; break; }
  }
  if (stray) break;
}
ok('every precinct sits inside its own jurisdiction outline', stray === null, stray || '');

// --- length, so a silently truncated outline cannot pass ---
const gr = D.jurisdictions.find(j => j.mcd === '34000');
let km = 0;
for (const r of gr.outline) for (let i = 0; i < r.length - 1; i++) km += m(r[i], r[i + 1]) / 1000;
ok(`Grand Rapids outline is 90.8 km give or take 3% (${km.toFixed(1)} km)`,
   Math.abs(km - 90.8) / 90.8 < 0.03);
ok('the corpus is not vacuously small', checked > 2500, `only ${checked} segments`);

console.log(`\n${fails === 0 ? 'precinct outline: all passed' : fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
