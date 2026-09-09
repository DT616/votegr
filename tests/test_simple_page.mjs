// Released into the public domain under the Unlicense, see UNLICENSE.
// Plain-assert tests for /simple, the light version. Run: node test_simple_page.mjs
//
// This page had no browser test at all, which is how it drifted from the map
// page in the first place: the two answer the same question from the same
// files, and only one of them was being checked. It is also the version that
// matters most on an old phone, a slow connection or a screen reader, so a
// break here is a break for the people least able to work around it.
//
// What it checks is what would fail silently: that a real address still comes
// back with its ward, precinct and polling place; that a street outside the
// city is offered and ANSWERED rather than refused; that early voting and the
// drop boxes come from the clerk's file when it is about this election; and
// that the page still talks to nobody but its own host.
//
// Expectations are read from the shipped data rather than written here, so a
// refresh that changes the numbers cannot leave this file asserting last
// month's.
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname, normalize } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)), 'site');

let pass = 0, fail = 0;
function ok(name, cond) { cond ? (pass++, console.log('  ok  ' + name)) : (fail++, console.log('  FAIL ' + name)); }

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.geojson': 'application/json', '.png': 'image/png',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
};
const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = 'http://127.0.0.1:' + server.address().port;
const URL_ = ORIGIN + '/simple/index.html';

// What ships, so the assertions below describe the data rather than a memory
// of it.
const read = async (p) => JSON.parse(await readFile(join(ROOT, 'data', p), 'utf8'));
const clerk = await read('gr-clerk.json');
const calendar = await read('elections.json');
const neighbours = await read('neighbors.json');
const polling = await read('polling.json');

const today = new Date().toISOString().slice(0, 10);
const nextElection = (calendar.elections || [])
  .filter(e => e.date >= today).sort((a, b) => a.date < b.date ? -1 : 1)[0];
const clerkIsCurrent = !!(nextElection && clerk.election === nextElection.date);

// A street the city does not have, taken from the shipped neighbour index so
// this cannot name one that has since been annexed or renamed.
const outsideStreet = Object.keys(neighbours.streets)
  .filter(s => (neighbours.streets[s] || []).length)
  .sort()[0];

// --- the address used throughout ---------------------------------------
const ADDRESS = '602 ALEXANDER ST SE';
const EXPECT_PRECINCT = '52';

const browser = await chromium.launch();

async function open(width) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  const errors = [], offsite = [];
  page.on('request', r => { if (new URL(r.url()).origin !== ORIGIN) offsite.push(r.method() + ' ' + r.url()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) errors.push(r.status() + ' ' + r.url()); });
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('input').disabled, null, { timeout: 15000 });
  return { ctx, page, errors, offsite };
}

// What the rows said about where they are, as of the last pick.
let lastWhere = [], lastOutsideRows = 0;

// Type, then pick the option at `index` the way a mouse does.
async function pick(page, text, index = 0) {
  await page.fill('#addr, input[type="text"]', '');
  await page.type('#addr, input[type="text"]', text, { delay: 5 });
  await page.waitForSelector('#opts li', { timeout: 5000 });
  const options = await page.$$eval('#opts li', els => els.map(e => e.innerText.trim()));
  lastWhere = await page.$$eval('#opts li .opt-where', els => els.map(e => e.textContent.trim()));
  lastOutsideRows = await page.$$eval('#opts li .opt-outside', els => els.length);
  await page.$$eval('#opts li', (els, i) => {
    els[i].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  }, index);
  await page.waitForTimeout(400);
  return options;
}

for (const width of [1280, 390, 320]) {
  console.log('\n' + width + 'px');
  const { ctx, page, errors, offsite } = await open(width);

  // --- a real address ---------------------------------------------------
  await pick(page, ADDRESS);
  const answer = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  ok('a real address answers with its ward and precinct',
     /Ward:\s*3\s*Precinct:\s*52/.test(answer));
  ok('and names the polling place from polling.json',
     answer.includes(polling.precincts[EXPECT_PRECINCT].name));

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('nothing scrolls sideways with an answer on screen', overflow <= 0);

  // --- early voting, from the clerk when it is about this election -------
  if (clerkIsCurrent) {
    const from = clerk.early_voting.from, to = clerk.early_voting.to;
    const monthDay = iso => {
      const [y, m, d] = iso.split('-').map(Number);
      return ['January','February','March','April','May','June','July','August',
              'September','October','November','December'][m - 1] + ' ' + d;
    };
    ok('early voting shows the window the clerk published, not the calendar',
       answer.includes(monthDay(from)) && answer.includes(monthDay(to)));
    ok('and names a site from the clerk file',
       clerk.early_voting_sites.some(s => answer.includes(s.name)));

    // --- drop boxes ------------------------------------------------------
    // By name, not by position. The blocks were reordered to match the map
    // page and "the last one" stopped meaning the drop boxes.
    const rows = await page.$$eval('.ev-boxes', blocks =>
      blocks[0] ? blocks[0].querySelectorAll('.loc').length : 0);
    ok(`every drop box is listed (${clerk.drop_boxes.length})`,
       rows === clerk.drop_boxes.length);
    ok('with the dates that make a drop box usable',
       /Ballots are mailed from|Return it by the time the polls close/.test(answer));
  }

  // The same order as the map page, which is the point of having one.
  const order = await page.$$eval('.card-body > *', els => els.map(e => e.className));
  const at = (cls) => order.findIndex(c => c.includes(cls));
  ok('drop boxes come before early voting, which comes before the polling place',
     at('ev-boxes') > -1 && at('ev-early') > at('ev-boxes') &&
     order.findIndex(c => c === 'loc') > at('ev-early'));

  // --- a street outside the city ----------------------------------------
  const options = await pick(page, '100 ' + outsideStreet);
  ok('a street outside the city is offered, not refused',
     options.some(o => o.includes(outsideStreet)));
  ok('and the option says which jurisdiction it is in',
     options.some(o => neighbours.streets[outsideStreet].some(j => o.includes(j))));
  // A name, not a phrase: "Kentwood City" or "Ada Township", never "in …",
  // and the same grey whether or not the street is in the city.
  ok('every row names its place as a City or a Township, with no "in"',
     lastWhere.length > 0 && lastWhere.every(w => /(City|Township)$/.test(w) && !/^in /.test(w)));
  ok('no row is coloured for being outside the city', lastOutsideRows === 0);

  const outside = await page.evaluate(() => ({
    text: document.body.innerText.replace(/\s+/g, ' '),
    box: document.querySelector('#addr, input[type="text"]').value,
  }));
  ok('picking it explains where the address actually is',
     /not the City of Grand Rapids/.test(outside.text));
  ok('names the jurisdiction in the answer',
     neighbours.streets[outsideStreet].some(j => outside.text.includes(j)));
  ok('keeps the address in the box, because the address is right',
     outside.box.toUpperCase().includes(outsideStreet));
  ok('and does not pretend to know a precinct for it',
     !/Ward:\s*\d/.test(outside.text));

  // --- the privacy property ---------------------------------------------
  ok('the page never talks to anyone but its own host', offsite.length === 0);
  ok('nothing failed to load and nothing threw', errors.length === 0);
  if (offsite.length) offsite.forEach(u => console.log('       ' + u));
  if (errors.length) errors.forEach(e => console.log('       ' + e));

  await ctx.close();
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
