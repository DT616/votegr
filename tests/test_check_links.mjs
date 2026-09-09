// Released into the public domain under the Unlicense, see UNLICENSE.
// Plain-assert tests for the link checker's one judgement call: what a
// response means. Run: node test_check_links.mjs
//
// This runs in checks.yml with the rest of the suite, unlike check_links.mjs
// itself, because classify() is a pure function over a status code and makes
// no request. That split is the point of the file. The live check depends on
// a dozen other organisations' servers and cannot be deterministic; the rule
// it applies to what those servers say can be, and is the part that decides
// whether a run is red.
//
// The rule exists because of a real failure. The first live run was refused
// by deflock.me, mvic.sos.state.mi.us and two pages on www.michigan.gov, all
// 403 from bot-management firewalls, and the first fix was to name those
// three hosts in the script. Naming hosts does not scale: the list grows by
// one every time another agency turns on bot management, and each entry
// silently stops checking a link. So the answer is a rule about statuses,
// with no host in it, and these tests are what hold that line.
import { readFile } from 'fs/promises';
import { classify } from '../scripts/check_links.mjs';

let fails = 0;
const ok = (n, c, d = '') => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  ' + d)); if (!c) fails++; };
const is = (n, got, want) => ok(n, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

const res = (status, error) => ({ status, ok: status >= 200 && status < 300, error });

// --- ok: the server served the page ---------------------------------
is('200 is ok', classify(res(200)), 'ok');
is('204 is ok', classify(res(204)), 'ok');
// A 3xx never reaches classify: fetch follows redirects, so what arrives is
// the destination's status. Where a redirect landed is printed by the run,
// for a person to read, and is not a pass or fail judgement.

// --- rotted: the page is gone, and only these mean that -------------
is('404 is rotted', classify(res(404)), 'rotted');
is('410 is rotted', classify(res(410)), 'rotted');
is('unresolvable host is rotted', classify(res(0, 'ENOTFOUND')), 'rotted');

// --- unverifiable: a server answered, but not with the page ---------
// The four that failed the first live run. None of them is named anywhere
// in the checker, and adding a fifth such host must stay a no-op.
is('403 is unverifiable', classify(res(403)), 'unverifiable');
is('401 is unverifiable', classify(res(401)), 'unverifiable');
is('429 is unverifiable', classify(res(429)), 'unverifiable');
is('500 is unverifiable', classify(res(500)), 'unverifiable');
is('502 is unverifiable', classify(res(502)), 'unverifiable');
is('503 is unverifiable', classify(res(503)), 'unverifiable');
// A 4xx that is not 404 or 410 is the server declining, not the page being
// gone. Erring toward unverifiable keeps a red run meaning one thing.
is('400 is unverifiable', classify(res(400)), 'unverifiable');
is('405 is unverifiable', classify(res(405)), 'unverifiable');
is('451 is unverifiable', classify(res(451)), 'unverifiable');

// --- unverifiable: nothing answered at all --------------------------
is('timeout is unverifiable', classify(res(0, 'TimeoutError')), 'unverifiable');
is('connection refused is unverifiable', classify(res(0, 'ECONNREFUSED')), 'unverifiable');
is('connection reset is unverifiable', classify(res(0, 'ECONNRESET')), 'unverifiable');
is('expired certificate is unverifiable', classify(res(0, 'CERT_HAS_EXPIRED')), 'unverifiable');
is('unknown network error is unverifiable', classify(res(0, 'something new')), 'unverifiable');

// --- totality: every status lands in exactly one bucket -------------
const BUCKETS = new Set(['ok', 'unverifiable', 'rotted']);
let stray = null;
for (let s = 100; s < 600; s++) if (!BUCKETS.has(classify(res(s)))) { stray = s; break; }
ok('every status 100-599 classifies', stray === null, `status ${stray} did not`);

// --- the invariants the whole change exists to hold -----------------
// Not style checks. Each one is the exact thing that was wrong before, and
// each would pass silently if it came back, since the live run only reports
// what it found today.
const src = await readFile(new URL('../scripts/check_links.mjs', import.meta.url), 'utf8');
ok('no per-host exemption list',
   !/\b(FIREWALLED|ALLOWED?_HOSTS|EXEMPT(ED)?_HOSTS|HOST_ALLOWLIST)\b/.test(src),
   'a named host means a link stopped being checked');
ok('no browser-spoofing user agent', !/Mozilla\/|AppleWebKit|Chrome\/\d/.test(src),
   'the checker identifies itself honestly; it does not evade bot management');
ok('the checker names itself and the project', /votegr-link-check/.test(src) &&
   /github\.com\/DT616\/votegr/.test(src), 'a server log should be able to tell who asked');

console.log(`\n${fails === 0 ? 'check_links: all passed' : fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
