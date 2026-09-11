// Released into the public domain under the Unlicense, see UNLICENSE.
// Plain-assert tests for the page itself. Run: node test_page.mjs
//
// test_router.mjs checks the answer. This checks that a reader can actually
// get at it: that the masthead fits, that nothing scrolls sideways on a
// phone, that the About sheet opens above the header rather than under it,
// that the theme switch is where the footer puts it, and that a real address
// still comes back with its ward and precinct and a map.
//
// It serves site/ itself on an ephemeral port and drives Chromium, so there
// is nothing to start first. Set PLAYWRIGHT_BROWSERS_PATH if the browsers
// live somewhere other than the default cache.
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname, normalize } from 'path';
import { fileURLToPath } from 'url';
import { chromium, devices } from 'playwright';

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)), 'site');

let pass = 0, fail = 0;
function ok(name, cond) { cond ? (pass++, console.log('  ok  ' + name)) : (fail++, console.log('  FAIL ' + name)); }

// --- static server ----------------------------------------------------
// Enough of one to load the page. Anything outside site/ is refused rather
// than resolved, so a stray ../ in the page would fail loudly here.
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
const URL_ = ORIGIN + '/index.html';

// --- the widths that matter -------------------------------------------
// 1280 is a desktop, 390 is the phone the masthead used to wrap on, and 320
// is the narrowest screen still in use. The header and footer both restack
// between them, so a rule that only works at one width shows up here.
const WIDTHS = [1280, 390, 320];
const browser = await chromium.launch();

for (const w of WIDTHS) {
  console.log('\n' + w + 'px');
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
  const page = await ctx.newPage();
  // The favicon 404 is the page not having one; everything else is a bug.
  const errors = [];
  // Every URL the page asks for, so the claim the About sheet now makes in
  // absolute terms can be checked rather than trusted. A Cache/OSM toggle used
  // to fetch Overpass behind a confirm dialog; it is gone, and the page may
  // only talk to the host it was served from.
  const offsite = [];
  page.on('request', r => { if (new URL(r.url()).origin !== ORIGIN) offsite.push(r.method() + ' ' + r.url()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) errors.push(r.status() + ' ' + r.url()); });
  await page.goto(URL_, { waitUntil: 'networkidle' });

  // --- masthead and footer geometry ---
  const m = await page.evaluate(() => {
    const head = document.getElementById('siteHeader');
    const foot = document.getElementById('siteFooter');
    const sw = document.getElementById('themeSwitch');
    const mark = document.querySelector('.brand-text');
    const swr = sw.getBoundingClientRect();
    return {
      headerH: head.getBoundingClientRect().height,
      declaredH: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')),
      markTruncated: mark.scrollWidth > mark.clientWidth + 0.5,
      markSize: parseFloat(getComputedStyle(mark).fontSize),
      switchInFooter: foot.contains(sw),
      switchInHeader: head.contains(sw),
      switchLeftGap: swr.left,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      footOverflow: foot.scrollWidth - foot.clientWidth,
    };
  });
  ok('header is as tall as --header-h says', Math.abs(m.headerH - m.declaredH) < 1);
  // The wordmark used to ellipsis down to a single letter to make room for
  // the controls. It has the bar to itself now, so it must never clip.
  ok('wordmark is never truncated (' + m.markSize + 'px)', !m.markTruncated);
  ok('theme switch lives in the footer, not the header', m.switchInFooter && !m.switchInHeader);
  // Not a fixed offset -- just that it is still in the corner rather than
  // centred with everything else, which is what the phone layout regressed to.
  ok('theme switch sits in the bottom-left corner', m.switchLeftGap > 4 && m.switchLeftGap < 40);
  ok('page does not scroll sideways', m.pageOverflow <= 0);
  ok('footer does not scroll sideways', m.footOverflow <= 0);

  // --- the About sheet ---
  // A stray token above the .modal-wrap rule once left the wrap static, so
  // the header painted over the sheet's own title bar and close button on a
  // phone. elementFromPoint is the only check that would have caught it.
  await page.click('#aboutBtnFoot');
  await page.waitForTimeout(250);
  const modal = await page.evaluate(() => {
    const wrap = document.getElementById('aboutModal');
    const cs = getComputedStyle(wrap);
    const head = wrap.querySelector('.modal-head');
    const hr = head.getBoundingClientRect();
    const x = wrap.querySelector('.modal-x');
    const xr = x.getBoundingClientRect();
    const body = wrap.querySelector('.modal-body');
    const at = (el, r) => { const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return el === t || el.contains(t); };
    return {
      open: !wrap.hidden, position: cs.position, z: cs.zIndex,
      headOnTop: hr.height > 0 && hr.top >= 0 && at(head, hr),
      closeReachable: at(x, xr),
      bodyScrolls: ['auto', 'scroll'].includes(getComputedStyle(body).overflowY),
    };
  });
  ok('About opens', modal.open);
  ok('the sheet is pinned to the viewport', modal.position === 'fixed');
  ok('the sheet outranks the header', modal.z === '1000');
  ok('the sheet\'s title bar is on top, not under the masthead', modal.headOnTop);
  ok('the close button is reachable', modal.closeReachable);
  ok('the sheet scrolls', modal.bodyScrolls);
  await page.click('#aboutModal .modal-x');
  await page.waitForTimeout(200);
  ok('the close button closes it', await page.evaluate(() => document.getElementById('aboutModal').hidden));

  // --- the theme switch ---
  // System is the absence of the attribute, not a third value for it.
  for (const [choice, attr] of [['light', 'light'], ['dark', 'dark'], ['system', null]]) {
    await page.click(`#themeSwitch button[data-theme-choice="${choice}"]`);
    await page.waitForTimeout(100);
    const set = await page.evaluate(c => ({
      attr: document.documentElement.getAttribute('data-theme'),
      on: document.querySelector(`#themeSwitch button[data-theme-choice="${c}"]`).classList.contains('on'),
    }), choice);
    ok(`${choice} applies and marks its button`, set.attr === attr && set.on);
    await page.reload({ waitUntil: 'networkidle' });
    const kept = await page.evaluate(c => ({
      attr: document.documentElement.getAttribute('data-theme'),
      on: document.querySelector(`#themeSwitch button[data-theme-choice="${c}"]`).classList.contains('on'),
    }), choice);
    ok(`${choice} survives a reload`, kept.attr === attr && kept.on);
  }

  // --- the disclaimer is gated on there being something to disclaim ---
  // It lives inside the answer now rather than in a box under the tool, so
  // "hidden" is the empty #advisory inside a hidden #resultBlock.
  const before = await page.evaluate(() => {
    const d = document.getElementById('advisory');
    const cs = getComputedStyle(d);
    return { flagged: document.getElementById('col').classList.contains('has-result'),
             shown: d.getBoundingClientRect().height > 0 && cs.display !== 'none' && parseFloat(cs.opacity) > 0 };
  });
  ok('the disclaimer is hidden until there is a result', !before.flagged && !before.shown);

  // --- the countdown to election day ---
  // Its failure modes are all quiet ones: a row that reflows every second, a
  // screen reader read a new number every second, four zeroes where a date used
  // to be, or a card title that has drifted under the line beneath it. None of
  // them throw, so they are checked rather than watched for.
  const cd1 = await page.evaluate(() => {
    const box = document.getElementById('countdown');
    const clock = document.getElementById('cdClock');
    const px = el => parseFloat(getComputedStyle(el).fontSize);
    const units = Array.from(clock.querySelectorAll('.cd-unit'));
    const said = document.getElementById('cdSaid');
    return {
      shown: !box.hidden && getComputedStyle(box).display !== 'none',
      labels: units.map(u => u.querySelector('.cd-lab').textContent),
      seconds: units.length ? units[units.length - 1].querySelector('.cd-num').textContent : null,
      clockWidth: clock.getBoundingClientRect().width,
      digitsHidden: clock.getAttribute('aria-hidden') === 'true',
      said: said.textContent,
      saidInvisible: said.getBoundingClientRect().width <= 2,
      note: document.getElementById('cdNote').textContent,
      labelSize: px(document.getElementById('cdLabel')),
      forSize: px(document.querySelector('.cd-for')),
      whenSize: px(document.querySelector('.cd-when')),
      numSize: px(document.querySelector('.cd-num')),
      forColor: getComputedStyle(document.querySelector('.cd-for')).color,
      whenColor: getComputedStyle(document.querySelector('.cd-when')).color,
      footBand: !!document.getElementById('electionFoot'),
      overflow: box.scrollWidth - box.clientWidth,
    };
  });
  ok('the countdown is on the page', cd1.shown);
  ok('it counts in days, hours, minutes and seconds',
     cd1.labels.join(',') === 'Days,Hours,Minutes,Seconds');
  // A colon, not a comma: the election is the label and the day is the value.
  ok('it names the election it is counting to', /^[^:]+: .+\d{4}$/.test(cd1.note));
  // The footer used to print the same date in a shorter voice and this
  // asserted the two could not disagree. The band is gone: the countdown
  // above says it once, in full, and a second copy of one date in the
  // chrome at the bottom of every screen was not worth the row.
  ok('and the footer no longer prints a second copy of it', cd1.footBand === false);
  ok('the election and its date are told apart by colour',
     cd1.whenColor !== cd1.forColor);
  // The card title heads the whole card, so it outranks the line two rows
  // below it. It was sized off the footer's --label-size chrome once, which
  // put it under the election name.
  ok('the card title outranks the line beneath it',
     cd1.labelSize >= cd1.forSize && cd1.labelSize >= cd1.whenSize);
  ok('the clock still outranks them all', cd1.numSize > cd1.labelSize);
  ok('the countdown does not scroll sideways', cd1.overflow <= 0);
  // A screen reader would be read a new figure every second otherwise.
  ok('the digits are hidden from a screen reader', cd1.digitsHidden);
  ok('a sentence stands in for the digits', /\bday(s)? until\b/.test(cd1.said));
  ok('that sentence is not on screen', cd1.saidInvisible);

  await page.waitForTimeout(1300);
  const cd2 = await page.evaluate(() => {
    const clock = document.getElementById('cdClock');
    const units = Array.from(clock.querySelectorAll('.cd-unit'));
    return {
      seconds: units[units.length - 1].querySelector('.cd-num').textContent,
      clockWidth: clock.getBoundingClientRect().width,
    };
  });
  ok('the seconds actually run', cd2.seconds !== cd1.seconds);
  // Tabular figures and a padded seconds field, so the row is the same width
  // at :09 as at :10 and nothing beside it twitches.
  ok('running seconds do not move the row',
     Math.abs(cd2.clockWidth - cd1.clockWidth) < 0.5);

  // --- a real lookup ---
  await page.fill('#addr', '');
  await page.type('#addr', '300 Monroe Ave NW', { delay: 25 });
  await page.waitForSelector('#ac-addr .ac-item', { timeout: 10000 });
  await page.locator('#ac-addr .ac-item').first().click();
  await page.waitForTimeout(2500);
  const result = await page.evaluate(() => {
    const d = document.getElementById('advisory');
    const cs = getComputedStyle(d);
    const map = document.getElementById('map');
    return {
      flagged: document.getElementById('col').classList.contains('has-result'),
      countdownGone: getComputedStyle(document.getElementById('countdown')).display === 'none',
      precinct: (document.getElementById('precinctInfo').innerText || '').replace(/\s+/g, ' ').trim(),
      mapShown: !document.getElementById('mapBlock').hidden,
      mapDrawn: map.querySelectorAll('canvas, svg').length > 0 && map.getBoundingClientRect().height > 50,
      shown: d.getBoundingClientRect().height > 0 && cs.display !== 'none' && parseFloat(cs.opacity) > 0,
      blocks: d.querySelectorAll('.advisory').length,
      text: d.innerText.replace(/\s+/g, ' ').trim(),
      // Counted over the whole page, not the note: the duplicate this
      // replaces was a separate element further down the column.
      flagsOnPage: (document.body.innerText.match(/Not an official government tool/g) || []).length,
      links: Array.from(d.querySelectorAll('a')).map(a => a.href),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      footOverflow: document.getElementById('siteFooter').scrollWidth - document.getElementById('siteFooter').clientWidth,
    };
  });
  ok('300 Monroe Ave NW resolves', result.flagged);
  // innerText carries the CSS uppercasing, so compare case-insensitively.
  ok('300 Monroe Ave NW is Ward 2, Precinct 40',
     /ward\s*2\b/i.test(result.precinct) && /precinct\s*40\b/i.test(result.precinct));
  ok('and says it is in Grand Rapids', /Grand Rapids/.test(result.precinct));

  // Outside the city. The Kentwood Activities Center is a polling place,
  // so its address is a fixture that names nobody's house. Kentwood has
  // wards; a township would show none, and neither may show a blank one.
  await page.fill('#addr', '355 48th St SE');
  await page.press('#addr', 'Enter');
  await page.waitForFunction(() =>
    /Kentwood/.test(document.getElementById('precinctInfo').innerText), null,
    { timeout: 15000 });
  const kw = await page.evaluate(() => ({
    info: document.getElementById('precinctInfo').innerText.replace(/\s+/g, ' '),
    steps: document.getElementById('steps').innerText.trim().length,
    routes: document.getElementById('routes').innerText,
  }));
  ok('a Kentwood address resolves, and says Kentwood', /Kentwood/.test(kw.info));
  ok('with a precinct number', /Precinct\s*\d+/i.test(kw.info));
  ok('and a polling place with a name', /Election day polling place/i.test(kw.info) &&
     !/No polling place on file/i.test(kw.info));
  ok('and directions to it', kw.steps > 0 || /already here/i.test(kw.routes));
  ok('never a blank ward', !/Ward\s*(Precinct|$)/i.test(kw.info));

  // A township with no published drop box. Ada Township is one of the 24;
  // the fixture is a polling place there. The answer has to name the
  // clerk's office as where an absentee ballot goes -- never a neighbouring
  // jurisdiction's box, which by law cannot take it -- and must not describe
  // an office as open 24/7 or as monitored.
  await page.fill('#addr', '6330 Ada Dr SE');
  await page.press('#addr', 'Enter');
  await page.waitForFunction(() =>
    /Ada Township/.test(document.getElementById('precinctInfo').innerText), null,
    { timeout: 15000 });
  const ada = await page.evaluate(() => ({
    info: document.getElementById('precinctInfo').innerText.replace(/\s+/g, ' '),
    box: (document.querySelector('.vi-dropbox') || {}).textContent || '',
    // textContent, not innerText: on a phone the note sits behind a closed
    // <details>, which innerText leaves out and textContent does not. The
    // card, not the dates cell: the note folds away with the place.
    note: (document.querySelector('.vi-card-dropbox') || document.querySelector('.vi-when-dropbox') || {}).textContent || '',
    ward: !!document.querySelector('.vi-rail .vi-num + .vi-lbl'),
  }));
  ok('a township with no drop box names its clerk\'s office instead',
     /Clerk.s Office/i.test(ada.box));
  ok('and labels it as where to return a ballot, not as a box',
     /return an absentee ballot/i.test(ada.box));
  ok('and says plainly that no box is published',
     /No ballot drop box is published for Ada Township/.test(ada.note));
  ok('and never claims 24\/7 or monitoring for an office',
     !/24\/7/.test(ada.box) && !/monitor/i.test(ada.note));
  ok('a township shows no Ward at all', !/\bWard\b/.test(ada.info));
  // The state's 13-digit precinct code is an identity, not a label: it had
  // been reaching the polling-place marker and the consolidation note as
  // one. A township has no ward, so its marker names bare numbers.
  const adaPop = await page.evaluate(async () => {
    const a = document.querySelector('.site-polling.active');
    if (!a) return '(no active marker)';
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    await new Promise(r => setTimeout(r, 400));
    const p = document.querySelector('.leaflet-popup-content'), d = document.getElementById('mapDetailBody');
    return ((p && p.innerText) || (d && d.innerText) || '(empty)').replace(/\s+/g, ' ');
  });
  ok('the voter\'s own polling place is the marker drawn large', !/no active marker/.test(adaPop));
  ok('and it names precincts, not 13-digit codes',
     /Precinct/i.test(adaPop) && !/\b08\d{11}\b/.test(adaPop));
  ok('the map is drawn', result.mapShown && result.mapDrawn);
  // The answer carries its own Election day row; the column belongs to it.
  ok('the countdown stands down for the answer', result.countdownGone);
  ok('the disclaimer appears with the result', result.shown);
  // One notice, not two. The page used to carry a second copy in a box under
  // the tool, gated on the same condition and making the same claims.
  ok('the disclaimer is stated once', result.blocks === 1 && result.flagsOnPage === 1);
  ok('the disclaimer leads with what it is not', /^Not an official government tool\./.test(result.text));
  // The route is not permission to ignore a sign, and that line has nowhere
  // else to live now.
  ok('the disclaimer still says to obey traffic signs', /Obey all traffic signs and laws\./.test(result.text));
  // Both official sources stay reachable no matter how the copy is reworded.
  ok('the Voter Information Center is linked', result.links.some(h => h.includes('mvic.sos.state.mi.us')));
  ok('the City Clerk is linked', result.links.some(h => h.includes('grandrapidsmi.gov')));
  ok('a result does not make the page scroll sideways', result.pageOverflow <= 0);
  ok('a result does not make the footer scroll sideways', result.footOverflow <= 0);

  // A consolidated Grand Rapids precinct: the note names the host precinct
  // by its number, and a ward city's marker says which ward.
  await page.fill('#addr', '995 36th St SE');
  await page.press('#addr', 'Enter');
  await page.waitForFunction(() => /Precinct 51/.test(document.getElementById('precinctInfo').innerText),
    null, { timeout: 15000 });
  const cons = await page.evaluate(async () => {
    const note = [...document.querySelectorAll('.pp-note')]
      .map(n => n.innerText.replace(/\s+/g, ' ')).filter(t => /votes with/.test(t))[0] || '';
    const a = document.querySelector('.site-polling.active');
    if (a) a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    await new Promise(r => setTimeout(r, 400));
    const p = document.querySelector('.leaflet-popup-content');
    return { note, pop: p ? p.innerText.replace(/\s+/g, ' ') : '', body: document.body.innerText };
  });
  ok('a consolidated precinct names its host by number',
     /Precinct 51 votes with precinct 45\b/.test(cons.note));
  ok('a ward city\'s marker names the ward with the precinct', /Precincts 3-45, 3-51/i.test(cons.pop));
  ok('no 13-digit precinct code is ever shown', !/\b08\d{11}\b/.test(cons.body));

  // Three ways to vote, three marks on the map, and a legend that draws the
  // same three. Told apart by shape as well as colour.
  const marks = await page.evaluate(() => ({
    polling: document.querySelectorAll('.site-polling').length,
    early: document.querySelectorAll('.site-early').length,
    dropbox: document.querySelectorAll('.site-dropbox').length,
    legend: [...document.querySelectorAll('.map-legend .sitek')].map(i => i.dataset.kind),
    legendDrawn: [...document.querySelectorAll('.map-legend .sitek svg')].length,
    shapes: ['polling', 'early', 'dropbox'].map(k => {
      const el = document.querySelector('.map-legend .sitek[data-kind="' + k + '"] svg');
      return el ? el.innerHTML.length : 0;
    })
  }));
  ok('the polling places are on the map', marks.polling > 100);
  ok('so are the drop boxes and the early voting sites', marks.dropbox > 0 && marks.early > 0);
  ok('the legend names all three', marks.legend.join() === 'polling,early,dropbox');
  ok('and draws each of them', marks.legendDrawn === 3);
  ok('the three marks are three different drawings',
     new Set(marks.shapes).size === 3 && marks.shapes.every(n => n > 0));

  // No link anywhere is left to the browser's own blue, or to the purple it
  // turns once followed: both are illegible on a dark panel, and neither is
  // a state any link on this page has.
  await page.evaluate(() => document.querySelector('.about-btn').click());
  await page.waitForTimeout(200);
  const linkColours = await page.evaluate(() => {
    const DEFAULTS = ['rgb(0, 0, 238)', 'rgb(85, 26, 139)', 'rgb(0, 0, 255)'];
    const bad = [];
    document.querySelectorAll('a').forEach(a => {
      if (!a.offsetParent && !a.closest('#aboutModal')) return;
      const c = getComputedStyle(a).color;
      if (DEFAULTS.includes(c)) bad.push(a.textContent.trim().slice(0, 30) + ' ' + c);
    });
    return { bad, about: [...document.querySelectorAll('#aboutModal a')].length };
  });
  ok('the About panel is full of links', linkColours.about > 4);
  ok('and no link is left the browser default blue or purple', linkColours.bad.length === 0);
  if (linkColours.bad.length) linkColours.bad.forEach(b => console.log('       ' + b));
  ok('the About panel says what the tool is and what it is for',
     await page.evaluate(() => {
       const t = document.getElementById('aboutModal').innerText;
       return /What this is/i.test(t) && /maximizes your anonymity/i.test(t) &&
              /proof of concept/i.test(t);
     }));
  await page.evaluate(() => document.querySelector('#aboutModal .modal-x').click());

  ok('nothing failed to load and nothing threw', errors.length === 0);
  // Asserted after a full lookup and a drawn route, so it covers the paths a
  // reader actually walks, not just the load.
  ok('the page never talks to anyone but its own host', offsite.length === 0);
  if (offsite.length) offsite.forEach(u => console.log('       ' + u));
  if (errors.length) errors.forEach(e => console.log('       ' + e));

  await ctx.close();
}

// --- the ?debug panel ---
// Loaded only when the URL asks for it, and then it drives the same
// resolve-and-route path the answer does, so one run with both ends
// filled has to end in a JSON dump carrying a routed distance and a pair
// drawn on the map. Without the parameter the panel must not exist at all.
{
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL_ + '?debug&from=602%20Alexander%20St%20SE&to=355%2048th%20St%20SE', { waitUntil: 'networkidle' });
  let report = null;
  try {
    await page.waitForFunction(() => {
      const o = document.getElementById('dbgOut');
      return o && /"meters"/.test(o.textContent);
    }, null, { timeout: 60000 });
    report = JSON.parse(await page.evaluate(() => document.getElementById('dbgOut').textContent));
  } catch (e) { errors.push('debug panel never produced a report: ' + e.message); }
  ok('?debug mounts the panel', await page.$('#debugPanel') !== null);
  ok('both ends resolve to a precinct', !!(report && report.from.precinct && report.to.precinct
     && report.from.precinct.jurisdiction === 'Grand Rapids' && report.to.precinct.jurisdiction === 'Kentwood'));
  ok('the report carries routed metres for both routes', !!(report && report.route
     && report.route.fastest.meters > 1000 && report.route.avoiding.meters > 1000));
  ok('the report lists the turn steps', !!(report && report.route.avoiding.steps.length > 3));
  ok('the pair is drawn through the page renderer', await page.evaluate(() =>
     document.body.classList.contains('has-result') && document.getElementById('steps').innerText.trim().length > 0));
  ok('the address of a debug run is shareable', (await page.url()).includes('debug&from='));
  ok('the debug run threw nothing', errors.length === 0);
  if (errors.length) errors.forEach(e => console.log('       ' + e));
  await ctx.close();
}

// --- one expander per card on a phone ---
// The dates are the button: a card that is shut says that way of voting is
// not open yet, and tapping the head opens it on the place and the detail.
// It used to take two links under the dates -- "More" and "Show the nearest
// drop box" -- neither of which said the section itself was shut.
{
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.getElementById('addr').disabled, null, { timeout: 60000 });
  await page.fill('#addr', '602 Alexander St SE');
  await page.press('#addr', 'Enter');
  await page.waitForFunction(() => document.querySelector('.vi-fold'), null, { timeout: 30000 });
  const cards = await page.evaluate(() => [...document.querySelectorAll('.vi-card')].map(c => ({
    kind: (c.className.match(/vi-card-(\w+)/) || [])[1],
    folds: c.querySelectorAll('details').length,
    open: !!(c.querySelector('.vi-fold') || {}).open,
    place: !!c.querySelector('[data-kind]')
  })));
  ok('every card carries exactly one fold', cards.length === 3 && cards.every(c => c.folds === 1));
  ok('a window that has not opened yet is shut',
     cards.filter(c => c.kind !== 'polling').every(c => !c.open));
  ok('election day is open', (cards.filter(c => c.kind === 'polling')[0] || {}).open === true);
  ok('and the old pair of links is gone', await page.evaluate(() =>
     !document.querySelector('.vi-more, .vi-place')));
  // Tapping the head opens that card and nothing else.
  await page.tap('.vi-card-dropbox summary');
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => ({
    box: document.querySelector('.vi-card-dropbox .vi-fold').open,
    early: document.querySelector('.vi-card-early .vi-fold').open,
    shows: !!document.querySelector('.vi-card-dropbox [data-kind="dropbox"]')
  }));
  ok('tapping a shut card opens it', after.box && after.shows);
  ok('and leaves the others alone', !after.early);
  // Open is a selected state, and has to look different from shut.
  const lit = await page.evaluate(() => {
    const paint = (sel) => {
      const el = document.querySelector(sel);
      const s = getComputedStyle(el);
      return s.backgroundColor + ' ' + s.boxShadow;
    };
    return { open: paint('.vi-card-dropbox .vi-fold'), shut: paint('.vi-card-early .vi-fold') };
  });
  ok('an open card is lit differently from a shut one', lit.open !== lit.shut);
  ok('and a shut card carries no highlight of its own',
     /rgba\(0, 0, 0, 0\)/.test(lit.shut));
  // The section pills say where you are: the one you press lights, and
  // scrolling hands the light on, including to the last section, whose top
  // never reaches the bar because the page ends first.
  const litPill = () => page.evaluate(() => {
    const b = document.querySelector('#sectionNav button.is-current');
    return b ? b.textContent.trim() : null;
  });
  ok('the first section is lit as soon as the answer lands', await litPill() === 'Voting info');
  // Two pills, not three. The Map pill was removed: the map is already in
  // view on the way to the directions, so the pill spent its third of the bar
  // on a jump nobody needed, and it was the only reason the two handlers
  // below carried a mapBlock special case.
  const pills = await page.evaluate(() => [...document.querySelectorAll('#sectionNav button')]
     .map(b => ({ text: b.textContent.trim(), goto: b.dataset.goto })));
  ok('the bar carries two pills', pills.length === 2);
  ok('and neither of them jumps to the map',
     pills.every(p => p.goto !== 'mapBlock') &&
     pills.map(p => p.text).join('|') === 'Voting info|Directions');
  // The page's navigation on the device with the worst pointer, so it carries
  // the 44px floor rather than the height its padding happens to make.
  ok('a pill is big enough to hit', await page.evaluate(() =>
     [...document.querySelectorAll('#sectionNav button')]
       .every(b => b.getBoundingClientRect().height >= 44)));
  await page.tap('#sectionNav button[data-goto="routeBlock"]');
  await page.waitForTimeout(800);
  ok('pressing a pill lights it', await litPill() === 'Directions');
  ok('and only it', await page.evaluate(() =>
     document.querySelectorAll('#sectionNav button.is-current').length === 1));
  ok('a lit pill is drawn in the accent', await page.evaluate(() => {
    const b = document.querySelector('#sectionNav button.is-current');
    const other = document.querySelector('#sectionNav button:not(.is-current)');
    const c = getComputedStyle(b);
    return c.color !== getComputedStyle(other).color &&
           b.getAttribute('aria-current') === 'true';
  }));
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight }));
  await page.waitForTimeout(500);
  ok('the bottom of the page lights the last pill', await litPill() === 'Directions');
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await page.waitForTimeout(500);
  ok('and the top lights the first', await litPill() === 'Voting info');

  // Tapping a place takes you to the directions for it. This used to assert
  // the opposite, and the opposite was right while the route section had no
  // heading: there was nowhere to land except the middle of it, so every
  // anchor tried put the reader somewhere they had not asked to be. #dirHead
  // is that anchor now. The tap is dispatched rather than driven, because the
  // driver scrolls the target into view before it taps and that scroll would
  // be the harness's, not the page's.
  //
  // Checked as a POSITION, not as "scrollY changed": the heading has to come
  // to rest just under the sticky bar. A page that scrolled to the wrong
  // place would pass a movement check.
  // Waits for the smooth scroll to come to REST rather than for a fixed
  // number of milliseconds. A 950px glide takes Chrome about 1.2s and a
  // shorter one a fraction of that, so any constant here is either flaky or
  // slow, and a constant that happened to fit this page would rot the first
  // time a card above it changed height.
  const landing = async () => {
    await page.waitForFunction(() => {
      const y = Math.round(window.scrollY);
      const settled = window.__lastY === y ? (window.__still || 0) + 1 : 0;
      window.__lastY = y; window.__still = settled;
      return settled >= 3;
    }, null, { timeout: 8000, polling: 100 });
    return page.evaluate(() => {
      const h = document.getElementById('dirHead');
      const bar = document.getElementById('searchBar');
      if (!h || !bar) return Number.NaN;      // reported, not thrown
      return Math.round(h.getBoundingClientRect().top - bar.getBoundingClientRect().bottom);
    });
  };
  ok('the route section has a heading to land on',
     await page.evaluate(() => !!document.getElementById('dirHead')));
  const beforeTap = await page.evaluate(() => Math.round(window.scrollY));
  await page.evaluate(() => document.querySelector('[data-kind="polling"]').click());
  const gapAfterTap = await landing();
  ok('tapping a place scrolls down to the directions', 
     await page.evaluate(() => Math.round(window.scrollY)) > beforeTap);
  // Under the bar, not behind it, and near the top rather than merely moved:
  // measured at 25px, which is the route block's own top padding. Nothing
  // scrolled would read as several hundred; overscrolled would read negative.
  ok('and leaves the heading clear of the sticky bar',
     gapAfterTap >= 0 && gapAfterTap <= 48);

  // The Directions pill has to land where tapping a place lands: at the
  // heading, under the bar. It used to aim at #steps, which is the turn list
  // BELOW the map, and #steps plus the advisory under it are shorter than a
  // screen -- so the scroll the pill asked for was past the end of the
  // document and the browser clamped it. The reader was left a third of a
  // screen short with the map still filling the top half, which reads as a
  // button that does not work rather than as a page that cannot scroll
  // further. Aiming at the section instead of at its tail is what makes the
  // landing reachable.
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await page.waitForTimeout(400);
  await page.evaluate(() =>
    document.querySelector('#sectionNav button[data-goto="routeBlock"]').click());
  const gapAfterPill = await landing();
  ok('the Directions pill lands on the heading too',
     gapAfterPill >= 0 && gapAfterPill <= 48);
  ok('and not at the bottom of the page, short of its target',
     await page.evaluate(() => {
       const doc = document.documentElement;
       return window.innerHeight + window.scrollY < doc.scrollHeight - 4;
     }));

  // The other way a place gets chosen: out of the full list, by name. Picking
  // "Main Library" there is the same intent as tapping the card that names
  // it, so it has to land in the same place. The two were wired separately,
  // which is exactly how they would drift apart.
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await page.waitForTimeout(400);
  ok('there is a full drop box list to pick from',
     await page.evaluate(() => !!document.getElementById('boxListBtn')));
  await page.evaluate(() => {
    const b = document.getElementById('boxListBtn');
    if (b) b.click();
  });
  await page.waitForSelector('#placeModal:not([hidden]) li[data-pick]', { timeout: 10000 });
  const picked = await page.evaluate(() => {
    // Not the first row: that is the one already chosen, and choosing it
    // again would prove nothing about a change of destination.
    const li = [...document.querySelectorAll('#placeModal li[data-pick]')][1]
            || document.querySelector('#placeModal li[data-pick]');
    if (!li) return '';
    const name = li.textContent.trim().slice(0, 40);
    li.click();
    return name;
  });
  const gapAfterPick = await landing();
  ok('picking a place out of the list lands on the same heading',
     gapAfterPick >= 0 && gapAfterPick <= 48);
  ok('and it really was a named place that was picked', picked.length > 3);

  // The heading itself: centred, and in the accent.
  const head = await page.evaluate(() => {
    const h = document.getElementById('dirHead');
    if (!h) return {};
    const hex = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ');
    const cs = getComputedStyle(h);
    return { text: h.textContent.trim(), align: cs.textAlign,
             accent: cs.color.includes(rgb), caps: cs.textTransform,
             aboveButtons: !!(h.compareDocumentPosition(document.getElementById('destPick'))
                              & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  ok('the route section is headed Directions', head.text === 'Directions' && head.caps === 'uppercase');
  ok('centred and in the accent', head.align === 'center' && head.accent);
  ok('and above the destination buttons', head.aboveButtons);

  // Every place card offers Directions as a labelled button, under its
  // address and beside the button that opens the other options where there
  // are any. It replaced a chevron in the card's corner, which was the only
  // sign the card could be tapped at all. Same shape as the list button it
  // sits with, because they are the same kind of control.
  const acts = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.vi-where[data-kind]')];
    const shape = (el) => { const s = getComputedStyle(el);
      return s.borderRadius + '|' + s.fontSize + '|' + s.padding + '|' + s.borderWidth; };
    return {
      cards: cards.length,
      everyCardHasOne: cards.every(c => c.querySelector('.vi-actions .dir-btn')),
      labelled: cards.every(c => c.querySelector('.dir-btn').textContent.trim() === 'Directions'),
      chevronGone: !document.querySelector('.dir-cue'),
      // Below the address, never beside it.
      belowAddress: cards.every(c => {
        const a = c.querySelector('.pp-addr'), b = c.querySelector('.dir-btn');
        return !a || b.getBoundingClientRect().top >= a.getBoundingClientRect().bottom - 0.5;
      }),
      // Where a card has a list button too, the two share a row and a shape,
      // and the list button leads. They share a LINE only where there is
      // room: on a phone "Show all my early voting site options" plus a
      // button is wider than the screen, and wrapping is what should happen.
      pairedRow: [...document.querySelectorAll('.vi-actions')].filter(r =>
        r.children.length === 2).every(r => {
          const [a, b] = r.children;
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          const sameLine = Math.abs(ra.top - rb.top) < 1;
          return shape(a) === shape(b) && b.classList.contains('dir-btn')
                 && (sameLine ? rb.left > ra.left : rb.top > ra.top);
        }),
      pairs: [...document.querySelectorAll('.vi-actions')].filter(r => r.children.length === 2).length,
      // Wide enough and they really are side by side.
      sideBySideWhenRoom: innerWidth < 700 || [...document.querySelectorAll('.vi-actions')]
        .filter(r => r.children.length === 2)
        .every(r => Math.abs(r.children[0].getBoundingClientRect().top
                           - r.children[1].getBoundingClientRect().top) < 1),
    };
  });
  ok('every place card offers Directions', acts.cards >= 2 && acts.everyCardHasOne && acts.labelled);
  ok('and the old chevron cue is gone', acts.chevronGone);
  ok('the button sits below the address', acts.belowAddress);
  ok('and in the same row as the list button, in the same shape',
     acts.pairs >= 1 && acts.pairedRow);
  ok('side by side wherever there is room for both', acts.sideBySideWhenRoom);

  // Selection is a state on a phone, not something the page animates into.
  // Duration, not property: with no transition set at all, transition-property
  // computes to "all", so reading it cannot tell "everything animates" from
  // "nothing does". The wide block asserts the other half, that a pointer
  // still gets the fade.
  ok('a selected place is not animated into being', await page.evaluate(() =>
     getComputedStyle(document.querySelector('.vi-dest')).transitionDuration === '0s'));

  // The absentee summary says when a ballot can go back, and stops there.
  const note = await page.evaluate(() => {
    const n = document.querySelector('.vi-card-dropbox .pp-note');
    return n ? n.textContent : '';
  });
  ok('the absentee summary has a note to check', note.length > 20);
  ok('and it drops the monitoring sentence', !/monitor/i.test(note));
  ok('and the drop box hours', !/24\/7|hours are on the list/i.test(note));
  ok('and does not trail a space where those sentences were', note === note.trim());
  // Ward and precinct read as a row of labelled numbers, each centred.
  ok('the rail centres each value under its label', await page.evaluate(() =>
     [...document.querySelectorAll('.vi-rail > div')]
       .every(d => getComputedStyle(d).textAlign === 'center')));

  // The head of a card has always been the tap target. The chevron is the
  // mark that says so, and it was 6px by 24px: a hairline at arm's length,
  // sized to the glyph rather than to the target under it.
  const chev = await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.vi-fold > summary'), '::after');
    return { w: parseFloat(s.width), h: parseFloat(s.height) };
  });
  ok('the expander mark is drawn at the size of its target',
     chev.w >= 44 && chev.h >= 44);

  // Open is a lift, not a wash of the accent. The accent is spoken for on
  // this screen -- the labels, the cue chevron, the ring on the chosen place
  // -- and a fourth use of it read as four selections at once. Checked by
  // colour rather than by rule, so any route back to a blue card fails here.
  const noBlue = await page.evaluate(() => {
    const hex = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ');
    const open = document.querySelector('.vi-card-dropbox .vi-fold');
    const s = getComputedStyle(open);
    return { rgb, paint: s.backgroundColor + ' ' + s.boxShadow };
  });
  ok('an open card is not painted in the accent', !noBlue.paint.includes(noBlue.rgb));
  await ctx.close();
}

// --- a lookup lands on the voting info, at every width ---
// The bar is sticky so the second address is typed from wherever the reader
// had got to. The phone used to be left exactly where it stood, which is
// right for the first lookup and wrong for every one after it: search again
// from the directions and the new answer arrived with the map filling the
// screen and the ward and precinct several hundred pixels above it.
//
// The second lookup is the one that matters, so it is the one asserted, and
// the first is checked too so a fix that only moves the page on a cold load
// cannot pass.
{
  for (const [tag, opt] of [['phone', { ...devices['Pixel 7'] }],
                            ['desktop', { viewport: { width: 1280, height: 900 } }]]) {
    const ctx = await browser.newContext(opt);
    const page = await ctx.newPage();
    await page.goto(URL_, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.getElementById('addr').disabled, null, { timeout: 60000 });
    const settle = () => page.waitForFunction(() => {
      const y = Math.round(window.scrollY);
      const n = window.__ly === y ? (window.__ln || 0) + 1 : 0;
      window.__ly = y; window.__ln = n;
      return n >= 4;
    }, null, { timeout: 15000, polling: 120 });
    // Landed on the answer means: the top of the voting info is on screen and
    // clear of the sticky bar, and the map is not what you are looking at.
    const landed = () => page.evaluate(() => {
      const top = (id) => document.getElementById(id).getBoundingClientRect().top;
      const barBottom = document.getElementById('searchBar').getBoundingClientRect().bottom;
      return { gap: Math.round(top('resultBlock') - barBottom),
               mapBelow: top('mapBlock') > barBottom };
    });
    const look = async (addr) => {
      await page.fill('#addr', addr);
      await page.press('#addr', 'Enter');
      await page.waitForFunction(() => !document.getElementById('mapBlock').hidden, null, { timeout: 30000 });
      await page.waitForTimeout(600);
      await settle();
      return landed();
    };
    const first = await look('300 Monroe Ave NW');
    ok(tag + ': the first lookup shows the voting info',
       first.gap >= -1 && first.gap <= 48 && first.mapBelow);
    // Read the directions, as a reader does, then search a different address
    // from the bar that followed them down.
    await page.evaluate(() => {
      const d = document.getElementById('dirHead');
      window.scrollTo({ top: window.scrollY + d.getBoundingClientRect().top - 120 });
    });
    await page.waitForTimeout(500);
    ok(tag + ': and the reader can get down to the directions',
       (await landed()).gap < -100);
    const second = await look('602 Alexander St SE');
    ok(tag + ': a second lookup comes back to the voting info',
       second.gap >= -1 && second.gap <= 48);
    ok(tag + ': and not to the map', second.mapBelow);
    await ctx.close();
  }
}

// --- the pills and the two-pane layout may not both apply ---
// The pills exist because the answer is one long column with the directions
// at the bottom of it. At 640px it stops being one: the grid puts the
// directions beside the map, at the top. Those two bounds were 700 and 640,
// so between them a landscape phone got the two-pane layout AND a 126px phone
// bar on a viewport that may only be 400px tall, and the map went behind that
// bar 54px sooner at the end of the page.
//
// The last check is the one that would have caught it: the sticky map's top
// is a constant in the stylesheet and the bar's height is content, so they
// can drift apart silently. They were 6px apart before the pills ever grew,
// and 60px apart after.
{
  const widths = [639, 640, 660, 701, 1280];
  const seen = [];
  for (const w of widths) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(URL_, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.getElementById('addr').disabled, null, { timeout: 60000 });
    await page.fill('#addr', '300 Monroe Ave NW');
    await page.press('#addr', 'Enter');
    await page.waitForFunction(() => !document.getElementById('mapBlock').hidden, null, { timeout: 30000 });
    seen.push(await page.evaluate(() => {
      const nav = document.getElementById('sectionNav');
      const ms = document.querySelector('#routeBlock > .map-section');
      return {
        pills: getComputedStyle(nav).display !== 'none',
        grid: getComputedStyle(document.getElementById('routeBlock')).display === 'grid',
        barH: Math.round(document.getElementById('searchBar').getBoundingClientRect().height),
        stickyTop: parseFloat(getComputedStyle(ms).top),
      };
    }));
    await ctx.close();
  }
  const at = (w) => seen[widths.indexOf(w)];
  ok('under 640 the answer is one column and the pills are up',
     at(639).pills === true && at(639).grid === false);
  ok('at 640 it is two panes and the pills are gone',
     at(640).pills === false && at(640).grid === true);
  ok('and nowhere do both apply at once',
     seen.every(v => !(v.pills && v.grid)));
  // In the two-pane layout the bar is one height, so the sticky top can be
  // one number. If a future change makes the bar taller in some of these and
  // not others, this is what says so.
  ok('the bar is the same height everywhere the two panes apply',
     new Set(seen.filter(v => v.grid).map(v => v.barH)).size === 1);
  ok('and the sticky map clears exactly that much',
     seen.filter(v => v.grid).every(v => v.stickyTop === v.barH));
}

// --- the map may not paint over the sticky bar on a phone ---
// Leaflet numbers its own panes 200 to 700 and its controls 1000, against the
// map. Those numbers only stay inside the map if its container is a stacking
// context, and the position: relative Leaflet sets for itself is not one. On a
// phone, where the map sits in the normal flow, they escaped and beat the
// search bar's z-index 5: scrolling the map up under the bar painted canvas
// over the address field and the pills, and took their taps with it, because
// the hit test follows the same order.
//
// Checked by hit test rather than by eye, since a screenshot cannot say which
// element would receive the touch. The overlap is asserted FIRST: if the map
// never reaches the bar the rest of this proves nothing, and a check that
// cannot fail is worse than no check.
{
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.getElementById('addr').disabled, null, { timeout: 60000 });
  await page.fill('#addr', '300 Monroe Ave NW');
  await page.press('#addr', 'Enter');
  await page.waitForFunction(() => !document.getElementById('mapBlock').hidden, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  const probe = await page.evaluate(() => {
    const mb = document.getElementById('mapBlock');
    window.scrollTo({ top: window.scrollY + mb.getBoundingClientRect().top - 10 });
    return new Promise(res => setTimeout(() => {
      const bar = document.getElementById('searchBar');
      // What a touch in the middle of each control would actually land on.
      const lands = (el) => {
        const r = el.getBoundingClientRect();
        const t = document.elementFromPoint(Math.round(r.left + r.width / 2),
                                            Math.round(r.top + r.height / 2));
        return !!(t && bar.contains(t));
      };
      res({
        overlap: document.getElementById('map').getBoundingClientRect().top
                 < bar.getBoundingClientRect().bottom,
        field: lands(document.getElementById('addr')),
        pill: lands(document.querySelector('#sectionNav button')),
      });
    }, 250));
  });
  ok('the map really does scroll up under the bar', probe.overlap);
  ok('and a touch on the address field still lands on the field', probe.field);
  ok('and a touch on a pill still lands on the pill', probe.pill);
  await ctx.close();
}

// --- the rail on a wide screen ---
// Ward and Precinct are a label with a number under it, and the number belongs
// under the label rather than at the left edge of a column the jurisdiction
// name sets the width of. The trap is that centring alone does not do it: the
// block is as wide as the rail, so "3" would centre under the middle of
// "Grand Rapids". Each block has to shrink to its own label first, which is
// what these two assertions are really checking -- the second is the one that
// fails if the align-self goes.
{
  console.log('\nthe rail, wide');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.getElementById('addr').disabled, null, { timeout: 60000 });
  await page.fill('#addr', '602 Alexander St SE');
  await page.press('#addr', 'Enter');
  await page.waitForSelector('#resultBlock:not([hidden])', { timeout: 30000 });
  const rail = await page.evaluate(() => {
    const mid = el => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
    const rows = [...document.querySelectorAll('.vi-rail > div')].map(d => ({
      idn: d.classList.contains('vi-idn'),
      align: getComputedStyle(d).textAlign,
      width: d.getBoundingClientRect().width,
      block: mid(d),
      lbl: mid(d.querySelector('.vi-lbl')),
      val: mid(d.querySelector('.vi-num, .vi-name')),
    }));
    return { rows, railWidth: document.querySelector('.vi-rail').getBoundingClientRect().width };
  });
  // .every on an empty list is true, so each of these says how many it found
  // as well as what it found. Without that, dropping the class the rows are
  // selected by would turn both green rather than red.
  const idn = rail.rows.filter(r => r.idn);
  ok('the rail has both numbers', idn.length === 2);
  ok('each number is centred on its own label',
     idn.length === 2 && idn.every(r => Math.abs(r.lbl - r.val) < 0.6));
  ok('and its block is narrower than the rail, so that centring means something',
     idn.length === 2 && idn.every(r => r.width < rail.railWidth - 1));
  // And the column as a whole reads as centred: three rows of different
  // widths sharing one axis, rather than three blocks flush to a left edge.
  // Jurisdiction included -- it is the widest, so it is the row that sets
  // where that axis falls.
  // The width clause is load bearing, not belt and braces: with align-items
  // gone the rows stretch to the full rail and TRIVIALLY share a centre, so
  // an axis check on its own goes green on the layout it is meant to catch.
  // The other half of the touch rule above: gating the fade on a real pointer
  // has to leave the pointer's fade alone, or it is just a deletion.
  ok('a pointer still gets the fade a touch does not', await page.evaluate(() =>
     getComputedStyle(document.querySelector('.vi-dest')).transitionDuration !== '0s'));
  ok('the rail is three rows on one centre axis',
     rail.rows.length === 3 &&
     rail.rows.every(r => Math.abs(r.block - rail.rows[0].block) < 0.6) &&
     rail.rows.filter(r => r.width < rail.railWidth - 1).length === 2);
  await ctx.close();
}

// --- a phone tap on a suggestion must not scroll the page ---
// A touch is replayed as mousedown then click. The list chooses on the
// mousedown, so by the time the click arrives the answer has been drawn
// under the finger, and on a phone the card that had appeared there took
// the click as "directions here" and scrolled the reader down to the map.
// The click that belongs to the choosing tap has to be eaten, and only
// that one: the next tap on a card is real and must still work. Where
// the trailing click lands is the browser's call and differs by screen,
// so the swallow is exercised directly: choose on mousedown, then fire the
// click at a card ourselves.
{
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.getElementById('addr').disabled, null, { timeout: 60000 });
  await page.evaluate(() => {
    window.__cardClicks = 0;
    document.getElementById('precinctInfo').addEventListener('click', () => { window.__cardClicks++; });
  });
  // A street on its own is not an address: no rows until a house number
  // leads, and Enter on a bare street says what is missing.
  await page.tap('#addr');
  await page.type('#addr', 'Division');
  await page.waitForTimeout(400);
  ok('a bare street name gets no suggestions', await page.evaluate(() => !document.querySelector('.ac-item')));
  await page.press('#addr', 'Enter');
  await page.waitForTimeout(200);
  ok('and Enter on it asks for the house number', await page.evaluate(() =>
     /start with the house number/i.test(document.getElementById('precinctInfo').innerText)));
  await page.fill('#addr', '');
  await page.type('#addr', '602 Alexander St SE');
  await page.waitForSelector('.ac-item', { timeout: 10000 });
  // The row says which jurisdiction, as a name: no "in", and "City" spelled
  // out because Grand Rapids Township is next door.
  const label = await page.evaluate(() => document.querySelector('.ac-item .ac-where').textContent.trim());
  ok('a suggestion names its jurisdiction as "Grand Rapids City"', label === 'Grand Rapids City');
  ok('no row is coloured for being outside the city', await page.evaluate(() =>
     !document.querySelector('.ac-item.is-outside')));
  const r = await page.evaluate(() => {
    const item = document.querySelector('.ac-item');
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    // The answer is drawn synchronously by the choose; the click the touch
    // still owes arrives next, on whatever is under the finger now.
    const card = document.querySelector('#precinctInfo [data-kind]');
    if (!card) return { drawn: false };
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { drawn: true, clicks: window.__cardClicks };
  });
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => {
    const top = (id) => document.getElementById(id).getBoundingClientRect().top;
    const barBottom = document.getElementById('searchBar').getBoundingClientRect().bottom;
    return { clicks: window.__cardClicks,
             gap: Math.round(top('resultBlock') - barBottom),
             mapBelow: top('mapBlock') > barBottom };
  });
  ok('choosing a suggestion on mousedown draws the answer', r.drawn);
  ok('the tap\'s trailing click never reaches the answer', r.drawn && r.clicks === 0 && after.clicks === 0);
  // This asserted the page had not moved at all, as a proxy for "the
  // trailing click did not reach a card and drive us to the map". A lookup
  // now lands on the voting info deliberately, so the proxy would report
  // that as the failure it was watching for. Assert the destination instead,
  // which is what was actually meant and tells the two apart: the answer is
  // under the bar, and the map is not.
  ok('a phone lookup lands on the voting info, not the map',
     after.gap >= -1 && after.gap <= 48 && after.mapBelow);
  // The swallow is one click wide: the next click on a card still lands.
  const later = await page.evaluate(() => {
    document.querySelector('#precinctInfo [data-kind]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return window.__cardClicks;
  });
  ok('the next tap on a card is still a tap', later === 1);
  ok('the phone lookup threw nothing', errors.length === 0);
  if (errors.length) errors.forEach(e => console.log('       ' + e));
  await ctx.close();
}

// --- a pinch takes the streets with it ---
// Leaflet runs a pinch by calling _move on every frame with a fractional
// zoom. Layers that position themselves from the pixel origin -- the markers,
// the route -- follow the fingers; nothing transforms the pane. The basemap is
// a canvas we draw ourselves, so it did neither, and a pinch slid every pin
// off the streets it belonged to. Measured before the fix: a marker travelled
// 8,500px while the canvas transform never changed once.
//
// The check needs no map object and no zoom reading. Two markers a fixed
// distance apart on the ground are a ruler: how much further apart they get is
// the scale the PINS are drawn at, and the canvas's own CSS scale is the scale
// the STREETS are drawn at. On one map those are the same number.
{
  console.log('\na pinch');
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.getElementById('addr').disabled, null, { timeout: 60000 });
  await page.fill('#addr', '602 Alexander St SE');
  await page.press('#addr', 'Enter');
  await page.waitForSelector('#resultBlock:not([hidden])', { timeout: 30000 });
  await page.waitForSelector('.basemap-canvas', { timeout: 30000 });
  await page.locator('#map').scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);

  const sample = () => page.evaluate(() => {
    const at = el => { const m = new DOMMatrixReadOnly(getComputedStyle(el).transform); return m; };
    const pins = [...document.querySelectorAll('.leaflet-marker-pane > *')].slice(0, 2).map(at);
    const cv = at(document.querySelector('.basemap-canvas'));
    return {
      pins: pins.length,
      spread: pins.length === 2 ? Math.hypot(pins[0].m41 - pins[1].m41, pins[0].m42 - pins[1].m42) : 0,
      canvasScale: cv.a,
    };
  });

  const box = await page.locator('#map').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: i })),
  });

  const start = await sample();
  ok('two pins to measure between', start.pins === 2 && start.spread > 20);
  await touch('touchStart', [[cx - 60, cy], [cx + 60, cy]]);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [[cx - 60 - i * 12, cy], [cx + 60 + i * 12, cy]]);
  const mid = await sample();                       // still mid gesture: no touchEnd yet
  await touch('touchEnd', []);

  const pinScale = mid.spread / start.spread;
  ok('the pinch spread the pins', pinScale > 1.2);
  // The one that fails if the basemap stops following: the streets sat at
  // scale 1 through the whole gesture while this ratio climbed.
  ok('and the streets grew with them',
     Math.abs(mid.canvasScale / start.canvasScale - pinScale) / pinScale < 0.03);
  await ctx.close();
}

// Plain load, no panel.
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.getElementById('addr').disabled, null, { timeout: 60000 });
  ok('without ?debug no panel and no debug.js', await page.evaluate(() =>
     !document.getElementById('debugPanel') && ![...document.scripts].some(s => /debug\.js/.test(s.src))));
  await ctx.close();
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
