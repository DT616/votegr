// displayCase: the vectors, then the two invariants over the REAL corpus.
//
// Vectors are ported from the sibling project this function came from, minus
// the ones covering vocabulary this project does not carry (agency acronyms,
// the block-anonymization mask). Keeping them aligned is deliberate: two
// copies of a function in two languages drift silently, and a shared vector
// list is the cheapest thing that makes drift visible.
//
// The invariants are what actually protect the site. displayCase runs at
// DISPLAY time over strings that are still matched, geocoded and compared in
// their original ALL CAPS form, so it may change case and nothing else. They
// run here over every street name in the graph and every polling and early
// voting address, several thousand real strings, rather than a handful.
import { createRequire } from 'module';
import { readFile } from 'fs/promises';
const require = createRequire(import.meta.url);
const D = require('./site/display-case.js');

let fails = 0;
const ok = (n, c, d = '') => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  ' + d)); if (!c) fails++; };
const eq = (n, got, want) => ok(n, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

// --- core rules ---
eq('directional stays upper', D('50 RANSOM AVE NE'), '50 Ransom Ave NE');
eq('ordinal th', D('10TH ST NW'), '10th St NW');
eq('ordinal nd', D('42ND ST'), '42nd St');
eq('ordinal rd', D('3RD ST SE'), '3rd St SE');
eq('mc name', D('MCREYNOLDS AVE NW'), 'McReynolds Ave NW');
eq('mac is not mc', D('MACOMB'), 'Macomb');
eq('apostrophe name', D("O'BRIEN ST"), "O'Brien St");
eq('possessive lowercases', D("SHERIFF'S OFFICE"), "Sheriff's Office");
eq('minor word of', D('CITY OF WALKER'), 'City of Walker');
eq('minor word first stays', D('OF MICE'), 'Of Mice');
eq('hwy US', D('US-131'), 'US-131');
eq('hwy M', D('M-6'), 'M-6');
eq('hwy I', D('I-196'), 'I-196');
eq('freeway bound', D('US-131 NB SO 76TH'), 'US-131 NB SO 76th');
eq('freeway bound wo', D('I-196 EB WO FULLER'), 'I-196 EB WO Fuller');
eq('slash intersection', D('MICHIGAN AVE / GREENFIELD RD'), 'Michigan Ave / Greenfield Rd');
eq('x-ending word is a word', D('PHOENIX DR'), 'Phoenix Dr');
eq('already cased is unchanged', D('Ransom Tower Apartments'), 'Ransom Tower Apartments');

// --- passthrough ---
eq('empty', D(''), '');
eq('null', D(null), null);
eq('undefined', D(undefined), undefined);
ok('number passes through', D(5) === 5);

// --- invariants over the real corpus ---
const read = async (p) => JSON.parse(await readFile(new URL(p, import.meta.url), 'utf8'));
const corpus = [];
const polling = await read('./site/data/polling.json');
for (const v of Object.values(polling.precincts)) {
  corpus.push(v.name, v.address, v.entrance_note || '');
}
const elections = await read('./site/data/elections.json');
for (const el of elections.elections) {
  for (const s of el.early_voting_sites || []) corpus.push(s.name, s.address);
}
const graph = await read('./site/data/graph.json');
for (const e of graph.edges) if (typeof e.n === 'string' && e.n) corpus.push(e.n);

const strings = [...new Set(corpus.filter(Boolean))];
let badUpper = null, badIdem = null;
for (const s of strings) {
  const d = D(s);
  if (d.toUpperCase() !== s.toUpperCase()) { badUpper = [s, d]; break; }
  if (D(d) !== d) { badIdem = [s, d, D(d)]; break; }
}
ok(`UPPER-invariant across ${strings.length} real strings`, badUpper === null,
   badUpper ? `${JSON.stringify(badUpper[0])} -> ${JSON.stringify(badUpper[1])}` : '');
ok(`idempotent across ${strings.length} real strings`, badIdem === null,
   badIdem ? JSON.stringify(badIdem) : '');
ok('corpus is not vacuously small', strings.length > 1000, `only ${strings.length}`);

console.log(`\n${fails === 0 ? 'display case: all passed' : fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
