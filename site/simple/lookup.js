// Grand Rapids Precinct Lookup
// https://github.com/DT616/votegr
// Released into the public domain under the Unlicense, see UNLICENSE.

(function () {
  "use strict";

  const NEAR_M = 10;              // how close to a precinct line counts as "too close to be certain"
  const MAX_SUGGESTIONS = 6;

  const $ = (id) => document.getElementById(id);
  const input = $("addr"), optionList = $("opts"), statusLine = $("status"), resultBox = $("result");

  // The whole lookup is a dictionary hit against a file the page already
  // downloaded. There is no geocoder and no request: the address you type is
  // never sent anywhere, and a city or county server going down cannot stop
  // this working. See refresh_addresses.py for how the index is built.
  let streets = {};     // { "MONROE AVE NW": [[number, precinct, metresFromEdge, [rivals]?] ] }
  let streetNames = []; // the keys, for matching what someone types
  let wards = {};       // { "32": 2 }
  let polling = {};     // { "43": { name, address, lat, lng, ... } }
  let election = null;  // the next election, or null once every date has passed
  let suggestions = [];
  let active = -1;      // highlighted suggestion, -1 for none

  // Build an element. Extra arguments become children; strings become text.
  const el = (tag, cls, ...children) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    for (const child of children) if (child != null) node.append(child);
    return node;
  };

  const say = (message, isError) => {
    statusLine.className = isError ? "status err" : "status";
    statusLine.textContent = message || "";
  };

  const clearResult = () => { resultBox.textContent = ""; };

  const getJSON = async (url) => {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };

  let neighbours = null;    // street -> the jurisdictions it is in
  let clerk = null;         // gr-clerk.json: early voting and drop boxes

  // Set by render(); the Directions links start the route here.
  let typedAddress = null;

  // "977 WEALTHY ST SW, 49504" -> "977 WEALTHY ST SW, Grand Rapids, MI 49504"
  const fullAddress = (addr) => {
    const m = addr.match(/^(.*),\s*(\d{5})$/);
    return m ? `${m[1]}, Grand Rapids, MI ${m[2]}` : `${addr}, Grand Rapids, MI`;
  };

  // Both ends are addresses, not coordinates, so OSM's From and To boxes
  // read like the page the person just left. OSM geocodes them when its
  // page opens; nothing loads until the click, and only the click shares
  // the typed address. A place without an address links by coordinates.
  const osmLink = (place) => {
    const to = place.address
      ? `to=${encodeURIComponent(fullAddress(place.address))}`
      : `to=${place.lat},${place.lng}`;
    if (!typedAddress) return `https://www.openstreetmap.org/directions?${to}`;
    const from = encodeURIComponent(`${typedAddress}, Grand Rapids, MI`);
    return `https://www.openstreetmap.org/directions?from=${from}&${to}`;
  };

  // ---- matching what someone types against the index --------------------

  // "250 Monroe Ave. NW" -> { number: 250, rest: "MONROE AVE NW" }
  // The street index is ALL CAPS because the parcel file is; that is not how
  // anyone writes an address. parseTyped uppercases whatever it is handed, so
  // the box can show the readable form without anything downstream noticing.
  const cased = (s) => (typeof displayCase === "function" ? displayCase(s) : s);

  function parseTyped(text) {
    const clean = text.toUpperCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
    const match = clean.match(/^(\d+)\s*(.*)$/);
    return match ? { number: Number(match[1]), rest: match[2] }
                 : { number: null, rest: clean };
  }

  // Every typed word must begin a word of the street name, in order. So
  // "monroe nw" finds "MONROE AVE NW" without the typist having to know
  // we spell it AVE, while "se lafayette" does not match SEWARD.
  function streetMatches(street, tokens) {
    const words = street.split(" ");
    let at = 0;
    for (const token of tokens) {
      while (at < words.length && !words[at].startsWith(token)) at++;
      if (at >= words.length) return false;
      at++;
    }
    return true;
  }

  function matchingStreets(rest) {
    const tokens = rest.split(" ").filter(Boolean);
    if (!tokens.length) return [];
    const hits = streetNames.filter((s) => streetMatches(s, tokens));
    // A street whose first word is what they started typing comes first;
    // after that, shorter names, which are the less surprising answer.
    return hits.sort((a, b) => {
      const lead = (s) => (s.startsWith(tokens[0]) ? 0 : 1);
      return lead(a) - lead(b) || a.length - b.length || a.localeCompare(b);
    });
  }

  // ---- resolving a house number on a street -----------------------------

  // Addresses come from parcels, so a number can be missing: a new build, or
  // something that never had its own parcel. Rather than guess, we answer
  // only when the neighbours on the same side of the street agree, and say so
  // when they do not. Same side matters because a precinct line often runs
  // down the middle of a street, putting odd and even in different precincts.
  function resolve(street, number) {
    const rows = streets[street];
    if (!rows) return null;

    const exact = rows.find((r) => r[0] === number);
    if (exact) {
      return { precinct: exact[1], edgeMetres: exact[2], rivals: exact[3] || null,
               inferred: false };
    }

    const sameSide = rows.filter((r) => r[0] % 2 === number % 2);
    let below = null, above = null;
    for (const row of sameSide) {
      if (row[0] < number) below = row;
      else if (row[0] > number) { above = row; break; }
    }
    if (!below || !above) return null;          // outside the known range: do not extrapolate
    if (below[1] !== above[1]) {
      return { precinct: below[1], rivals: [below[1], above[1]], inferred: true,
               edgeMetres: Infinity };
    }
    return { precinct: below[1], edgeMetres: Math.min(below[2], above[2]),
             rivals: null, inferred: true };
  }

  // ---- rendering --------------------------------------------------------

  const advisory = (kind, text) => {
    const node = el("div", "advisory", text);
    node.dataset.kind = kind;
    return node;
  };

  // Drawn inline rather than loaded, so it costs no request and there is no
  // icon font to go missing. createElementNS matters here: createElement would
  // make an unknown HTML element that silently never paints.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const directionsIcon = () => {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");     // the link carries the label
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M12 2 4.5 20.29l.71.71L12 18l6.79 3 .71-.71z");
    svg.append(path);
    return svg;
  };

  // An icon on its own says nothing to a screen reader, so the link is named
  // for the place it points at rather than left as "link".
  const mapLink = (place) => {
    const link = el("a", "dir-btn");
    link.rel = "noopener";
    link.target = "_blank";
    link.href = osmLink(place);
    link.title = `Directions to ${place.name}`;
    // The visible word is inside the accessible name, which is what keeps the
    // announced label and the printed label from disagreeing.
    link.setAttribute("aria-label", `Directions to ${place.name}`);
    link.append(directionsIcon(), el("span", "dir-label", "Directions"));
    return link;
  };

  // One location: the text on the left, directions on the right. Shared by the
  // voting day location and the early voting sites so they cannot drift apart.
  function locationRow(place, extraClass) {
    const row = el("div", extraClass ? `loc ${extraClass}` : "loc",
      el("div", "loc-text",
        el("div", "place", place.name),
        el("div", "addr", place.address),
        place.entrance_note ? el("div", "note", place.entrance_note) : null));
    if (place.address || (place.lat != null && place.lng != null)) {
      row.append(mapLink(place));
    }
    return row;
  }

  function pollingPlace(precinct, place) {
    if (!place) {
      return [el("div", "advisory",
        `We do not have a polling place listed for precinct ${precinct}. ` +
        "Please check the Michigan Voter Information Center.")];
    }
    const parts = [
      // No date here: the banner above already names the election and its day,
      // and saying it twice on one screen reads as two different facts.
      el("div", "lead-2", "Your voting day location"),
      locationRow(place),
    ];
    if (place.consolidated_with) {
      parts.push(advisory("consolidated",
        `For this election, precinct ${precinct} votes at precinct ` +
        `${place.consolidated_with}'s location${place.note ? `. ${place.note}.` : "."}`));
    }
    return parts;
  }

  function render(found, resolvedAddress) {
    typedAddress = resolvedAddress;   // Directions links start from here
    const { precinct, edgeMetres, rivals, inferred } = found;
    // True when any of the three uncertainty advisories below will fire.
    const uncertain = Boolean(rivals || inferred || edgeMetres <= NEAR_M);
    const body = el("div", "card-body",
      el("div", "lead", "Address: ", el("span", "addr-quote", resolvedAddress)),
      el("div", "ward",
        el("span", "wp-label", "Ward:"), el("span", "wp-value", String(wards[precinct])),
        el("span", "wp-label", "Precinct:"), el("span", "wp-value", String(precinct))),
      ...pollingPlace(precinct, polling[String(precinct)]),

      // Said plainly rather than buried: an address that straddles a line, or
      // that we only inferred from its neighbours, is a guess and should be
      // checked. This is the whole reason the page exists, so it would be
      // perverse to hide it.
      rivals ? advisory("ambiguous",
        `This address sits where precincts ${rivals.join(" and ")} meet, so we ` +
        "cannot tell which one it votes in. Please check with the city clerk or " +
        "the Michigan Voter Information Center.") : null,
      !rivals && inferred ? advisory("inferred",
        "We do not have this exact address, so this is taken from the addresses " +
        "either side of it on the same side of the street. They agree, but it is " +
        "worth confirming.") : null,
      !rivals && edgeMetres <= NEAR_M ? advisory("boundary",
        `This address sits about ${Math.round(edgeMetres)} m from the edge of the ` +
        "precinct, which is too close to be certain. Please check with the city " +
        "clerk or the Michigan Voter Information Center.") : null,

      // Last, so the advisories stay next to the precinct answer they qualify.
      ...earlyVoting(uncertain),
      ...dropBoxes());

    clearResult();
    resultBox.append(el("div", "card", body));
  }

  const failed = (message) => {
    clearResult();
    say(`${message} You can read the city's precinct directory directly, or check the ` +
        "Michigan Voter Information Center.", true);
  };

  // ---- suggestions ------------------------------------------------------

  function closeList() {
    optionList.textContent = "";
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }

  function renderList() {
    optionList.textContent = "";
    suggestions.forEach((suggestion, i) => {
      // A street outside the city names where it is, because that is the
      // whole answer for it and the reader should see it before choosing.
      const option = suggestion.outside
        ? el("li", null, suggestion.text,
             el("span", "opt-where", ` in ${placeList(suggestion.outside)}`))
        : el("li", null, suggestion.text);
      option.id = `opt-${i}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", i === active ? "true" : "false");
      option.addEventListener("mousedown", (event) => { event.preventDefault(); choose(i); });
      optionList.append(option);
    });
    input.setAttribute("aria-expanded", suggestions.length ? "true" : "false");
    // The ids exist for exactly this: tell assistive tech which option is lit.
    if (active >= 0) input.setAttribute("aria-activedescendant", `opt-${active}`);
    else input.removeAttribute("aria-activedescendant");
  }

  function suggest(text) {
    const { number, rest } = parseTyped(text);
    const matches = matchingStreets(rest);

    // With a number, offer the full address, but only where we can actually
    // answer it. Without one, offer street names to finish first.
    suggestions = number === null
      ? matches.slice(0, MAX_SUGGESTIONS).map((street) => ({ text: street, street }))
      : matches.filter((street) => resolve(street, number))
               .slice(0, MAX_SUGGESTIONS)
               .map((street) => ({ text: `${number} ${street}`, street, number }));
    suggestions = suggestions.concat(outsideMatches(rest, number, suggestions))
                             .slice(0, MAX_SUGGESTIONS);

    active = -1;
    renderList();
    say(suggestions.length ? "" : notFoundHint(number, matches.length));
  }

  // More than half of all Grand Rapids mailing addresses are outside the city
  // limits. Refusing to list those streets meant a person who typed their own
  // address correctly got "no address found", which reads as a broken tool
  // rather than an honest limit. They are offered last, filling only what the
  // city's own matches leave, and labelled with where they actually are.
  const outsideMatches = (rest, number, already) => {
    if (!neighbours || !rest || rest.length < 2) return [];
    const have = new Set(already.map((s) => s.street));
    return Object.keys(neighbours)
      .filter((name) => !have.has(name) && name.startsWith(rest))
      .sort()
      .slice(0, MAX_SUGGESTIONS)
      .map((street) => ({
        text: number === null ? street : `${number} ${street}`,
        street, number, outside: neighbours[street] || [],
      }));
  };

  const placeList = (where) =>
    where.length === 1 ? where[0]
      : `${where.slice(0, -1).join(", ")} or ${where[where.length - 1]}`;

  // Picking one is an answer, not a rejection: which jurisdiction it is in,
  // and where to go instead. The address stays in the box, because it is
  // right.
  function renderOutside(picked) {
    const where = placeList(picked.outside);
    clearResult();
    resultBox.append(el("div", "card", el("div", "card-body",
      el("div", "lead", "Address: ", el("span", "addr-quote", picked.text)),
      advisory("outside",
        `This address is in ${where}, not the City of Grand Rapids, so this ` +
        "page cannot say where you vote. A Grand Rapids mailing address does " +
        `not always mean you live in the city. Your clerk is the one for ${where}.`),
      el("div", "ev-note", "The Michigan Voter Information Center at " +
        "mvic.sos.state.mi.us has the polling place for any Michigan address."))));
  }

  const notFoundHint = (number, streetHits) => {
    if (number === null) return "No street found. Try the street name, like Monroe Ave NW.";
    if (streetHits) return `We have no number ${number} on that street. Check the number, ` +
                           "or look it up at the Michigan Voter Information Center.";
    return "No address found. Try the number and the direction, like 300 Monroe Ave NW. " +
           "Addresses outside the city are not listed here.";
  };

  function choose(index) {
    const picked = suggestions[index];
    if (!picked) return;
    if (picked.outside) {
      input.value = cased(picked.text);
      closeList();
      renderOutside(picked);
      return;
    }

    // A street on its own is half an address: put it in the box and wait.
    if (picked.number == null) {
      input.value = `${cased(picked.street)} `;
      closeList();
      say("Now add the house number.");
      input.focus();
      return;
    }

    input.value = cased(picked.text);
    closeList();
    clearResult();
    const found = resolve(picked.street, picked.number);
    if (!found) return failed("We do not have that address.");
    say("");
    // The answer is what matters now, not the box. Dismiss the soft keyboard
    // so the result is not hidden behind it. The street-only branch above
    // keeps focus on purpose, since a house number still has to be typed.
    input.blur();
    render(found, picked.text);
  }

  // No debounce: the index is already in memory, so this is a dictionary
  // lookup rather than a request, and waiting would only add lag.
  input.addEventListener("input", () => {
    const text = input.value.trim();
    clearResult();
    say("");
    if (text.length < 3) return closeList();
    suggest(text);
  });

  input.addEventListener("keydown", (event) => {
    if (!suggestions.length) return;
    const move = (step) => {
      event.preventDefault();
      const count = suggestions.length;
      // Nothing highlighted yet: down goes to the first, up to the last.
      active = active < 0 ? (step > 0 ? 0 : count - 1)
                          : (active + step + count) % count;
      renderList();
    };
    if (event.key === "ArrowDown") move(1);
    else if (event.key === "ArrowUp") move(-1);
    else if (event.key === "Enter") { event.preventDefault(); choose(active >= 0 ? active : 0); }
    else if (event.key === "Escape") closeList();
  });

  // ---- next election ----------------------------------------------------
  // Shows the first date that has not passed and hides the rest, so a stale
  // entry is harmless while a missing one simply shows nothing.

  // The calendar itself -- today, the next election, the state of the early
  // voting window, the date formats -- comes from ../elections.js, which the
  // map page reads too. Both pages once carried their own copy, and this page
  // went on offering an early voting site for a day after the other had
  // stopped. Only the wording below is this page's own.

  function showNextElection(next) {
    const banner = $("election");
    if (!banner || !next) return;

    banner.append("Next election: ", el("strong", null, `${next.name}, ${Elections.withWeekday(next.date)}`));

    const state = Elections.windowState(next);
    const { early_voting_from: from, early_voting_to: to } = next;
    if (state !== "none") {
      // The count, not the addresses. Addresses appear once an address has been
      // looked up, not to everyone who loads the page.
      const count = (next.early_voting_sites || []).length;
      const where = count ? `, at ${count} site${count === 1 ? "" : "s"} across the city` : "";
      // Three states, not two. This used to stop at today <= to and say nothing
      // once the window closed, which reads the same as an election with no
      // early voting at all -- and the days it covered are the ones just before
      // an election, when the most people are looking. The site count is left
      // off the closed sentence: those doors are shut, and counting them would
      // be offering somewhere to go.
      banner.append(el("span", "ev",
        state === "closed" ? `Early voting ended ${Elections.withWeekday(to)}.`
        : state === "open" ? `Early voting is open now, through ${Elections.withWeekday(to)}${where}.`
        : `Early voting runs from ${Elections.withWeekday(from)} through ${Elections.withWeekday(to)}${where}.`));
    }
    banner.hidden = false;
  }

  // Early voting, shown while the next election carries sites and the window
  // has not closed. Returns an empty array otherwise, so render can spread it
  // without a conditional. Once the window passes this goes quiet on its own,
  // with no edit to make and nothing to remember.
  // The clerk's own dates and sites when the file is about THIS election, the
  // calendar's otherwise. gr-clerk.json names the election it describes, and
  // that is checked rather than assumed: a file about a finished election
  // must not supply dates for the next one.
  const clerkWindow = () => {
    if (!clerk || !clerk.early_voting || !election ||
        clerk.election !== election.date) return null;
    return {
      early_voting_from: clerk.early_voting.from,
      early_voting_to: clerk.early_voting.to,
      early_voting_sites: clerk.early_voting_sites || [],
      early_voting_hours: null,
    };
  };

  function earlyVoting(uncertain) {
    if (!election) return [];
    const source = clerkWindow() || election;
    const { early_voting_from: from, early_voting_to: to,
            early_voting_sites: sites, early_voting_hours: hours } = source;
    if (!(sites || []).length) return [];

    const state = Elections.windowState(source);
    if (state === "none" || state === "closed") return [];
    const open = state === "open";

    const parts = [];

    // Said first, because for an address we could not place with certainty this
    // is the answer: every site holds the voter's registration, so which
    // precinct wins stops mattering.
    if (uncertain) {
      parts.push(advisory("early-voting",
        "Vote early and verify there. All early voting locations have your information."));
    }

    // The date carries the weight here, so it is the part set in bold.
    parts.push(open
      ? el("div", "lead-2", "Vote early, through ", el("strong", "when", Elections.withWeekday(to)))
      : el("div", "lead-2", "Vote early, ", el("strong", "when", Elections.withWeekday(from)),
           " through ", el("strong", "when", Elections.withWeekday(to))));
    parts.push(el("div", "ev-note",
      "Any Grand Rapids voter may use any of these, whatever precinct they are in."));

    // The same row the voting day location gets, so a site reads the same
    // wherever it appears on the card.
    for (const site of sites) parts.push(locationRow(site, "ev-site"));

    // Hours last, as aligned rows with today's picked out: where to go is
    // the answer, when it is open is the detail that follows it.
    if ((hours || []).length) {
      const todayAbbr = open ? Elections.todayAbbr() : null;
      const table = el("div", "ev-hours");
      for (const rule of hours) {
        const isToday = todayAbbr !== null && (rule.days || []).includes(todayAbbr);
        const mark = isToday ? " is-today" : "";
        table.append(
          el("span", `ev-day${mark}`, rule.days.join(", ") + (isToday ? " (today)" : "")),
          el("span", `ev-time${mark}`, `${rule.open} to ${rule.close}`));
      }
      parts.push(table);
    }

    return [el("div", "ev-block", ...parts)];
  }

  // Every drop box, with a directions link each. No "nearest": this page does
  // no geocoding and cannot honestly rank them by distance, so it lists them
  // and lets the reader pick the one they know.
  function dropBoxes() {
    const boxes = (clerk && clerk.drop_boxes) || [];
    if (!boxes.length || !election || clerk.election !== election.date) return [];

    const parts = [el("div", "lead-2", "Drop off an absentee ballot")];
    // A box is only useful once there is a ballot to put in it. Michigan
    // sends absentee ballots 40 days before an election, and a returned
    // ballot has to be in hand when the polls close.
    const start = Elections.dayStart(election.date);
    start.setDate(start.getDate() - 40);
    const from = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}` +
                 `-${String(start.getDate()).padStart(2, "0")}`;
    parts.push(el("div", "ev-note",
      Elections.todayISO() < from
        ? `Ballots are mailed from ${Elections.monthDay(from)}. Boxes accept ` +
          `them from then until the polls close on ${Elections.monthDay(election.date)}.`
        : `Return it by the time the polls close on ${Elections.monthDay(election.date)}.`));

    for (const box of boxes) {
      parts.push(locationRow({
        name: box.name || box.address || "Drop box",
        address: box.address || "Inside City Hall",
        entrance_note: [box.note, box.hours
          ? (/^24\/7$/.test(box.hours) ? "Accessible 24/7"
             : `Accessible during ${box.hours}`)
          : null]
          .filter(Boolean).join(" \u00b7 "),
      }, "ev-site"));
    }
    return [el("div", "ev-block", ...parts)];
  }

  // ---- clicks outside the suggestion list close it ------------------------

  document.addEventListener("click", (event) => {
    if (!optionList.contains(event.target) && event.target !== input) closeList();
  });

  // ---- boot -------------------------------------------------------------

  (async () => {
    input.disabled = true;
    say("Loading...");
    try {
      const optional = (url) => getJSON(url).catch(() => null);
      const [addresses, places, calendar, neighbourData, clerkData] = await Promise.all([
        getJSON("../data/addresses.json"),
        getJSON("../data/polling.json"),
        getJSON("../data/elections.json"),
        // Both optional. A copy of this page hosted without them still
        // answers the question it exists to answer; it just answers less.
        optional("../data/neighbors.json"),
        optional("../data/gr-clerk.json"),
      ]);
      neighbours = (neighbourData && neighbourData.streets) || null;
      clerk = clerkData || null;

      streets = addresses.streets;
      streetNames = Object.keys(streets);
      wards = addresses.wards;
      polling = places.precincts;
      election = Elections.next(calendar.elections);
      showNextElection(election);

      input.disabled = false;
      say("");
    } catch {
      say("Could not load the precinct data files. If you are hosting this yourself, " +
          "check that the data folder sits next to this page.", true);
    }
  })();
})();
