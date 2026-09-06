// Every external link in the docs, the two pages and the data provenance
// blocks, checked live. Run: node check_links.mjs [--list]
//
// The rest of the suite runs on every pull request and never touches the
// network. This one is different: it exists to notice when someone ELSE's
// page moves, which happens on their schedule rather than ours. So it runs
// weekly from .github/workflows/link-check.yml, and on demand, and never on
// a pull request. A clerk's site being down should not turn a routing change
// red, and a check that cries wolf on unrelated work is a check people learn
// to ignore.
//
// The link most likely to rot is the precinct directory PDF in polling.json.
// The clerk publishes each election's directory under a new generated
// filename; BUILD.md says what to do when it 404s, and this is what says it
// has.
//
// --list prints the URLs it would check and exits, so the set can be
// inspected without making a request.
import { readFile } from 'fs/promises';
import { fileURLToPath, pathToFileURL } from 'url';
import { join } from 'path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

// Text files scanned for anything that looks like a URL. The Python scripts
// are left out on purpose: they assemble their endpoint URLs from fragments
// across several lines, and the data files' provenance blocks carry the
// same endpoints whole.
const TEXT_FILES = [
  'README.md', 'BUILD.md', 'UNLICENSE',
  'site/index.html', 'site/simple/index.html',
  'site/app.js', 'site/simple/lookup.js', 'compare_osrm.mjs',
];

// Data files whose provenance block names where the data came from. Only
// that block is read; the rest is coordinates and house numbers.
const DATA_FILES = [
  'addresses', 'boundary', 'cameras', 'elections', 'graph',
  'landcover', 'neighbors', 'polling', 'precincts',
].map(n => `site/data/${n}.json`).concat(['site/data/precincts.geojson']);

// URLs that are not links in the sense that matters here.
const SKIP = [
  // Overpass answers a bare GET with 400 by design. The refresh scripts are
  // its real test, and they run daily.
  /\/api\/interpreter$/,
  // A URL template in compare_osrm.mjs; the host serves no page at its root.
  /router\.project-osrm\.org/,
  // The page tests' own throwaway server.
  /^https?:\/\/(127\.0\.0\.1|localhost)/,
  // An XML namespace name in lookup.js, not a page anyone links to.
  /www\.w3\.org\/2000\/svg/,
];

// An honest user agent, with the project named so a server log can tell who
// was asking. Some government hosts sit behind bot management that refuses
// anything that is not a browser, and they refuse this. That is fine, and
// classify() below says so: the alternative is claiming to be Chrome, which
// is both a lie to someone else's server and, measured against these exact
// hosts, does not work anyway, because they fingerprint the TLS handshake.
const UA = 'votegr-link-check/1.0 (+https://github.com/DT616/votegr)';
const TIMEOUT_MS = 20000;
const RETRY_WAIT_MS = 4000;
const SPACING_MS = 300;

// What a response means. This is the whole judgement of the checker, and the
// only part with tests (test_check_links.mjs), because it is the part that
// decides whether a run is red.
//
// Three buckets, and the rule names no host. An earlier version kept a list
// of hosts whose firewall answers with 403 and counted those as reachable,
// which does not scale: the list grows every time another agency turns on
// bot management, each entry is a link that quietly stopped being checked,
// and the growing is done by a person editing this file to clear a red run.
//
// The line that does scale is between "this page is gone" and "we could not
// find out". Only the first is worth failing on, and only three answers mean
// it: 404, 410, and a host that no longer resolves. Everything else is a
// server declining to answer us, which is not evidence about the page.
export function classify({ status, error }) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 404 || status === 410) return 'rotted';
  // A domain that stopped resolving is a dead link in the way that matters,
  // and the retry above has already ruled out a runner's momentary DNS blip.
  if (status === 0 && /ENOTFOUND/.test(error || '')) return 'rotted';
  return 'unverifiable';
}

// Stops at whitespace, quotes, brackets, backticks and `$`; the punctuation
// a sentence or a markdown link leaves stuck to the end is trimmed after.
const URL_RE = /https?:\/\/[^\s"'<>()[\]`$\\]+/g;

function urlsIn(text) {
  const out = [];
  for (const m of text.matchAll(URL_RE)) {
    // A URL cut short by `${` is a template, and its static prefix is not a
    // page: openstreetmap.org/directions?from=${...} in lookup.js.
    if (text[m.index + m[0].length] === '$') continue;
    out.push(m[0].replace(/[.,;:!?)]+$/, ''));
  }
  return out;
}

// Every string value under a JSON value, at any depth.
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => strings(x, out));
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const noSlash = u => u.replace(/\/$/, '');

async function probe(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': UA,
               accept: 'text/html,application/pdf,application/json;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // The status is the answer. Do not download a multi-megabyte PDF to learn
  // that it exists.
  if (res.body) await res.body.cancel().catch(() => {});
  return { status: res.status, finalUrl: res.url };
}

// A server having a moment (5xx, 429, a dropped connection) gets one more
// try after a pause. A 404 is an answer and is not retried; neither is a
// 403, which is a firewall's settled decision and not something a second
// request to someone else's server is going to change.
async function check(url) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      last = await probe(url);
      if (last.status < 500 && last.status !== 429) return last;
    } catch (e) {
      // fetch wraps network failures in a bare TypeError; the reason worth
      // printing (ENOTFOUND, ECONNREFUSED, a certificate error) is on cause.
      const why = e.cause?.code || e.cause?.message || e.name || String(e);
      last = { status: 0, error: String(why).split('\n')[0].slice(0, 80) };
    }
    if (attempt === 0) await sleep(RETRY_WAIT_MS);
  }
  return last;
}

// ---- collect ----------------------------------------------------------
async function collect() {
  const foundIn = new Map();   // url -> the first file it was seen in
  const note = (list, file) => { for (const u of list) if (!foundIn.has(u)) foundIn.set(u, file); };
  for (const f of TEXT_FILES) note(urlsIn(await readFile(join(ROOT, f), 'utf8')), f);
  for (const f of DATA_FILES) {
    const doc = JSON.parse(await readFile(join(ROOT, f), 'utf8'));
    note(urlsIn(strings(doc.provenance || {}).join('\n')), f);
  }
  for (const u of [...foundIn.keys()]) if (SKIP.some(re => re.test(u))) foundIn.delete(u);
  return foundIn;
}

// ---- run --------------------------------------------------------------
async function main() {
  const foundIn = await collect();
  const urls = [...foundIn.keys()].sort();

  if (process.argv.includes('--list')) {
    for (const u of urls) console.log(`${u}  (${foundIn.get(u)})`);
    console.log(`\n${urls.length} links`);
    return 0;
  }

  // One request at a time, spaced out: these are other people's servers, and
  // a couple of dozen links do not need to arrive all at once. A redirect is
  // not a failure, but the destination is printed, because a page that now
  // bounces to a generic front door has rotted just as surely as a 404, and
  // that is a judgement for a person reading the run.
  const counts = { ok: 0, unverifiable: 0, rotted: 0 };
  for (const u of urls) {
    const r = await check(u);
    const bucket = classify(r);
    counts[bucket]++;
    const what = r.status || r.error;
    if (bucket === 'ok') {
      const moved = r.finalUrl && noSlash(r.finalUrl) !== noSlash(u) ? `  -> ${r.finalUrl}` : '';
      console.log(`  ok   ${what}  ${u}${moved}`);
    } else if (bucket === 'unverifiable') {
      console.log(`  ??   ${what}  ${u}  (answered, page not verifiable)`);
    } else {
      console.log(`  GONE ${what}  ${u}  (${foundIn.get(u)})`);
    }
    await sleep(SPACING_MS);
  }

  console.log(`\n${urls.length} links: ${counts.ok} ok, ` +
              `${counts.unverifiable} unverifiable, ${counts.rotted} gone`);
  if (counts.unverifiable && !counts.rotted) {
    console.log('Unverifiable is not a failure. Those servers declined to answer a ' +
                'non-browser client; the pages are worth an eye, not a red run.');
  }
  return counts.rotted ? 1 : 0;
}

// Only when run, not when imported: test_check_links.mjs imports classify
// and must not make a single request to do it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
