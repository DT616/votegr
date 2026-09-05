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
import { chromium } from 'playwright';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'site');

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
const URL_ = 'http://127.0.0.1:' + server.address().port + '/index.html';

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
  const before = await page.evaluate(() => {
    const d = document.querySelector('.page-disclaimer');
    const cs = getComputedStyle(d);
    return { flagged: document.getElementById('col').classList.contains('has-result'),
             shown: d.getBoundingClientRect().height > 0 && cs.display !== 'none' && parseFloat(cs.opacity) > 0 };
  });
  ok('the disclaimer is hidden until there is a result', !before.flagged && !before.shown);

  // --- a real lookup ---
  await page.fill('#addr', '');
  await page.type('#addr', '300 Monroe Ave NW', { delay: 25 });
  await page.waitForSelector('#ac .ac-item', { timeout: 10000 });
  await page.locator('#ac .ac-item').first().click();
  await page.waitForTimeout(2500);
  const result = await page.evaluate(() => {
    const d = document.querySelector('.page-disclaimer');
    const cs = getComputedStyle(d);
    const map = document.getElementById('map');
    return {
      flagged: document.getElementById('col').classList.contains('has-result'),
      precinct: (document.getElementById('precinctInfo').innerText || '').replace(/\s+/g, ' ').trim(),
      mapShown: !document.getElementById('mapBlock').hidden,
      mapDrawn: map.querySelectorAll('canvas, svg').length > 0 && map.getBoundingClientRect().height > 50,
      shown: d.getBoundingClientRect().height > 0 && cs.display !== 'none' && parseFloat(cs.opacity) > 0,
      paragraphs: d.querySelectorAll('p').length,
      text: d.innerText.replace(/\s+/g, ' ').trim(),
      links: Array.from(d.querySelectorAll('a')).map(a => a.href),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      footOverflow: document.getElementById('siteFooter').scrollWidth - document.getElementById('siteFooter').clientWidth,
    };
  });
  ok('300 Monroe Ave NW resolves', result.flagged);
  // innerText carries the CSS uppercasing, so compare case-insensitively.
  ok('300 Monroe Ave NW is Ward 2, Precinct 40',
     /ward\s*2\b/i.test(result.precinct) && /precinct\s*40\b/i.test(result.precinct));
  ok('the map is drawn', result.mapShown && result.mapDrawn);
  ok('the disclaimer appears with the result', result.shown);
  ok('the disclaimer is one paragraph', result.paragraphs === 1);
  ok('the disclaimer leads with what it is not', /^Not an official government tool\./.test(result.text));
  // Both official sources stay reachable no matter how the copy is reworded.
  ok('the Voter Information Center is linked', result.links.some(h => h.includes('mvic.sos.state.mi.us')));
  ok('the City Clerk is linked', result.links.some(h => h.includes('grandrapidsmi.gov')));
  ok('a result does not make the page scroll sideways', result.pageOverflow <= 0);
  ok('a result does not make the footer scroll sideways', result.footOverflow <= 0);

  ok('nothing failed to load and nothing threw', errors.length === 0);
  if (errors.length) errors.forEach(e => console.log('       ' + e));

  await ctx.close();
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
