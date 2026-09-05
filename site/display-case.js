/* Title-case a display string without expanding or rewriting it.

   Every street name in the routing graph, every polling place address and
   every early voting address arrives ALL CAPS, because that is how the city
   centerline file, the clerk's directory and the state layers publish them.
   Shouting an address at a reader is not a decision this project made; it is
   one it inherited and never undid.

   THE INVARIANT, and the reason this is not a one-line regex: case is the
   only thing that changes. displayCase(x).toUpperCase() === x.toUpperCase()
   for every input. No character, digit or space is inserted, removed or
   substituted, and running it twice changes nothing. That is what makes it
   safe to apply at DISPLAY time over data that is still matched, geocoded and
   compared in its original form.

   Ported from the same function in a sibling project, where it has a fuller
   vocabulary for police agency names. Trimmed here to what this corpus
   actually contains, counted rather than guessed: US appears 181 times and
   NB/SB/EB/WB 253 times between them across the graph and the polling data,
   so the freeway shorthand is real and stays. The agency acronyms and the
   block-anonymization mask rule appear zero times, because this project
   publishes exact addresses and redacts nothing, so they are left out.

   The hard cases are all real streets here: 10TH ST NW must not become
   "10Th", MCREYNOLDS must not become "Mcreynolds", O'BRIEN must not become
   "O'brien", and NW must never become "Nw". */
(function (root) {
  'use strict';

  // Abbreviated directionals stay UPPER as standalone tokens. The full words
  // (NORTH, EAST) deliberately are not here: "North Park Street" is a name.
  var DIR = { N: 1, S: 1, E: 1, W: 1, NE: 1, NW: 1, SE: 1, SW: 1 };

  // Freeway-bound and ramp-locator shorthand. Title-casing these produces
  // gibberish ("Nb So"), and they read as codes rather than words.
  var ACRONYMS = { US: 1, NB: 1, SB: 1, EB: 1, WB: 1,
                   SO: 1, NO: 1, EO: 1, WO: 1 };

  // UPPER when immediately followed by a number: US 131, M 6, I 196.
  var HWY = { US: 1, M: 1, I: 1 };

  // Lowercase unless they open the string.
  var MINOR = { OF: 1, AND: 1, THE: 1, AT: 1, IN: 1, ON: 1, FOR: 1 };

  var ORDINAL = /^(\d+)(ST|ND|RD|TH)$/;
  // Alternating word and non-word runs, both preserved exactly.
  var RUN = /[A-Za-z0-9]+|[^A-Za-z0-9]+/g;

  function isWordRun(run) {
    return !!run && /^[A-Za-z0-9]/.test(run.charAt(0));
  }

  function caseWord(w, isFirst, prevDelim, nextWord) {
    var up = w.toUpperCase(), m;
    if (/^\d+$/.test(w)) return w;
    m = ORDINAL.exec(up);
    if (m) return m[1] + m[2].toLowerCase();
    // A name continuing after an apostrophe: O'BRIEN, SHERIFF'S.
    if (prevDelim && prevDelim.charAt(prevDelim.length - 1) === "'") {
      return w.length === 1 ? w.toLowerCase()
                            : up.charAt(0) + w.slice(1).toLowerCase();
    }
    if (DIR[up] === 1) return up;
    if (ACRONYMS[up] === 1) return up;
    if (HWY[up] === 1 && nextWord !== null && /^\d+$/.test(nextWord)) return up;
    if (MINOR[up] === 1 && !isFirst) return w.toLowerCase();
    if (up.slice(0, 2) === 'MC' && up.length > 2 && /^[A-Z]+$/.test(up.slice(2))) {
      return 'Mc' + up.charAt(2) + up.slice(3).toLowerCase();
    }
    return up.charAt(0) + w.slice(1).toLowerCase();
  }

  function displayCase(s) {
    if (typeof s !== 'string' || !s) return s;
    var runs = s.match(RUN) || [];
    var seenWord = false, out = [], i, j, prevDelim, nextWord;
    for (i = 0; i < runs.length; i++) {
      if (!isWordRun(runs[i])) { out.push(runs[i]); continue; }
      prevDelim = (i > 0 && !isWordRun(runs[i - 1])) ? runs[i - 1] : '';
      nextWord = null;
      for (j = i + 1; j < runs.length; j++) {
        if (isWordRun(runs[j])) { nextWord = runs[j]; break; }
      }
      out.push(caseWord(runs[i], !seenWord, prevDelim, nextWord));
      seenWord = true;
    }
    return out.join('');
  }

  root.displayCase = displayCase;
  if (typeof module !== 'undefined' && module.exports) module.exports = displayCase;
})(typeof self !== 'undefined' ? self : this);
