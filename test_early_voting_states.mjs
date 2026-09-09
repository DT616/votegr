// The early voting group in the answer block has four states, and only one
// of them can be reached from the committed data on any given day. So the
// states are driven here by serving a synthetic elections.json, with every
// date relative to TODAY so the fixture cannot rot into a fixed calendar.
//
// The state worth the whole file is "closed": after the window ends but
// before election day, the block must stop naming an early voting site. A
// reader who saw one listed last week and drives to it finds a locked door,
// and nothing else in the suite would catch that regression.
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname, normalize } from 'path';

const ROOT = join(process.cwd(), 'site');
// LOCAL date, the way Elections.todayISO() reckons it. toISOString() is UTC,
// and after 8pm Eastern that is already tomorrow: the "election day" case,
// which needs today exactly, then served a fixture dated a day ahead of the
// page and failed every evening. The other cases have days of slack and
// never noticed.
const iso = d => {
  const x = new Date(); x.setDate(x.getDate() + d);
  const pad = n => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
};

const SITES = JSON.parse(await readFile(join(ROOT, 'data/elections.json'), 'utf8'))
  .elections[0].early_voting_sites;
const HOURS = JSON.parse(await readFile(join(ROOT, 'data/elections.json'), 'utf8'))
  .elections[0].early_voting_hours;

// Read the statewide hours from the real file rather than restating them, so
// this fixture cannot drift from what ships if the SOS ever changes them.
const POLL_HOURS = JSON.parse(await readFile(join(ROOT, 'data/elections.json'), 'utf8'))
  .election_day_hours;

// Mirrors shortTime() in app.js on purpose: the page drops :00 on the hour
// but keeps a half hour's minutes, and a fixed '7:00 AM to 8:00 PM' string
// here would pass while the page rendered something else entirely.
const short = t => String(t).replace(/:00(?=\s*[AP]M\b)/i, '');

const base = extra => ({
  election_day_hours: POLL_HOURS,
  elections: [Object.assign({ date: iso(30), name: 'Test Election' }, extra)],
});

const CASES = [
  ['open',     base({ early_voting_from: iso(-2), early_voting_to: iso(2),
                      early_voting_sites: SITES, early_voting_hours: HOURS }),
   { label: /early voting open/i, site: true }],
  ['closed',   base({ early_voting_from: iso(-10), early_voting_to: iso(-2),
                      early_voting_sites: SITES, early_voting_hours: HOURS }),
   { label: /early voting closed/i, site: false }],
  ['upcoming', base({ early_voting_from: iso(5), early_voting_to: iso(10),
                      early_voting_sites: SITES, early_voting_hours: HOURS }),
   { label: /early voting upcoming/i, site: false }],
  ['none',     base({ early_voting_sites: SITES }),
   { label: null, site: false }],
];

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.geojson': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml' };

let current = null;
const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/data/elections.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(current)); return;
  }
  const file = join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_ = 'http://127.0.0.1:' + server.address().port + '/index.html';

const browser = await chromium.launch();
let fails = 0;
const ok = (n, c) => { console.log((c ? '  ok  ' : '  FAIL') + '  ' + n); if (!c) fails++; };

for (const [name, data, want] of CASES) {
  current = data;
  const page = await browser.newPage();
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.fill('#addr', '300 Monroe Ave NW');
  await page.press('#addr', 'Enter');
  await page.waitForSelector('#precinctInfo .vi-lbl', { timeout: 10000 });

  const hours = await page.evaluate(() =>
    (document.querySelector('#precinctInfo .vi-hours') || {}).textContent || null);

  const got = await page.evaluate(() => {
    // The row, by name. Three rows now share one shape -- drop box, early
    // voting, election day -- so "the cell with the live accent" no longer
    // identifies this one: the drop box carries it too while it is accepting
    // ballots.
    const cell = document.querySelector('#precinctInfo .vi-when-early');
    if (!cell) return { label: null, site: false, status: null };
    // Both where-cells hold a .pp-name; .vi-ev-site is what separates the
    // early voting site from the polling place.
    return { label: (cell.querySelector('.vi-lbl') || {}).textContent.trim(),
             status: (cell.querySelector('.vi-val') || {}).textContent || null,
             site: !!document.querySelector('.vi-ev-site .pp-name') };
  });

  console.log(`\n[${name}] label=${JSON.stringify(got.label)} status=${JSON.stringify(got.status)} site=${got.site} pollHours=${JSON.stringify(hours)}`);
  // Statewide and statutory, so it shows in every state including the ones
  // where no early voting group renders at all.
  // Pins the "Hours:" label as well as the value: the label is the point of
  // the field, and an unlabelled time is what this replaced.
  ok(`${name}: election day hours shown, labelled`,
     hours === `Hours: ${short(POLL_HOURS.open)} to ${short(POLL_HOURS.close)}`);
  ok(`${name}: label`, want.label === null ? got.label === null
                                           : !!(got.label && want.label.test(got.label)));
  ok(`${name}: site ${want.site ? 'shown' : 'withheld'}`, got.site === want.site);
  await page.close();
}
// ---- election day itself ------------------------------------------------
// On the day, the answer stops being a menu: early voting has closed and a
// drop box is a race against the same 8pm the polls close at, so the polling
// place leads the card and the directions point at it before anything is
// clicked. Only reachable one day a year from real data, hence the fixture.
//
// The routed default is a SEPARATE question and only checked on the day: away
// from it the polls already lead the picker, because "where do I vote" is
// answered by election day until early voting actually opens. The card order
// is the thing that differs, and it is what these two cases contrast.
const ORDER_CASES = [
  ['election day', base({ date: iso(0),
                          early_voting_from: iso(-10), early_voting_to: iso(-2),
                          early_voting_sites: SITES, early_voting_hours: HOURS }),
   ['polling', 'dropbox'], /election day/i],
  ['a month out', base({ date: iso(30),
                         early_voting_from: iso(5), early_voting_to: iso(10),
                         early_voting_sites: SITES, early_voting_hours: HOURS }),
   ['dropbox', 'polling'], null],
];

for (const [name, data, want, routedWant] of ORDER_CASES) {
  current = data;
  const page = await browser.newPage();
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.fill('#addr', '300 Monroe Ave NW');
  await page.press('#addr', 'Enter');
  await page.waitForSelector('#precinctInfo .vi-lbl', { timeout: 10000 });

  const order = await page.evaluate(() =>
    [...document.querySelectorAll('#precinctInfo .vi-where[data-kind]')]
      .map(el => el.dataset.kind));
  // Which destination the directions are already pointed at, read off the
  // picker rather than the card: that is the one a reader gets by doing
  // nothing, and it is the half of this that actually saves a wrong trip.
  const routed = await page.evaluate(() => {
    const on = document.querySelector('#destPick button.on, #destPick button[aria-pressed="true"]');
    return on ? on.textContent.trim() : null;
  });

  console.log(`\n[${name}] order=${JSON.stringify(order)} routed=${JSON.stringify(routed)}`);
  ok(`${name}: card order`, JSON.stringify(order) === JSON.stringify(want));
  if (routedWant) {
    ok(`${name}: directions already point at the polls`,
       !!routed && routedWant.test(routed));
  }
  await page.close();
}

await browser.close(); server.close();
console.log(`\n${fails === 0 ? 'all state checks passed' : fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
