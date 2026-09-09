/* Get to your polling place — Grand Rapids
 * Released into the public domain under the Unlicense, see UNLICENSE.
 *
 * One address in. The destination is never asked for: it is derived
 * (address -> precinct -> polling place), which is the point of the tool.
 */
(function () {
  'use strict';

  var map, graph, P, cameras;
  var boundaryLayer, pollLayer, camLayer, routeLayer, pinLayer;
  var cachedCameras = null, current = null;
  var activeEl = null, destChoice = null, electionDayHours = null;
  // Kept beside activeEl because the countdown re-asks the calendar when the
  // day rolls over under a page nobody has reloaded.
  var electionList = null;
  var cityRings = null, ownBase = null;      // cityRings: [lat, lng] pairs
  var neighbors = null, precincts = null;
  var pinArmed = false;
  var ac = null;            // the suggestion list, from autocomplete.js
  var clerk = null;         // gr-clerk.json: early voting sites and drop boxes
  var sources = {};         // sources.json: every upstream this site reads, by id
  // Which place, within a kind, the reader picked from its list. The nearest
  // is only the default: someone drops a ballot on the way to somewhere else,
  // and the box outside the library they were visiting beats the one four
  // streets closer to home. Reset whenever a new address is looked up, since
  // "the third nearest" means something different from a different doorstep.
  var chosen = { dropbox: 0, early: 0 };
  var routes = null, selected = 'avoid';
  var originArrow = null;   // the blue you-are-here arrow; steps advance it
  var GR = [42.9634, -85.6681];

  // There is deliberately no tile layer. Tiles would be fetched from a third
  // party on every pan, which is the one thing that stopped this page being
  // able to say nothing leaves your browser. The basemap is drawn from files
  // the page already holds; see basemap.js.
  // Kept to one line: the map is now a card rather than the whole screen, and
  // a two-line attribution ate the bottom of it. Both sources are still named.
  var ATTR = 'Roads: City of Grand Rapids · ' +
             '\u00a9 OpenStreetMap contributors (ODbL)';

  function $(id) { return document.getElementById(id); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
  function getVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000';
  }

  // The hint line under the address field rests EMPTY: it exists only to
  // carry transient guidance (pin arming) and returns to nothing afterwards.
  function setHint(text) { $('hint').textContent = text || ''; }

  // ---- color scheme ----------------------------------------------------
  //
  // Three states: light, dark, or follow the system. The choice is stamped as
  // data-theme on <html> (absent means follow the system) and mirrored into
  // localStorage, where the inline script in the head reads it before first
  // paint so an explicit choice never flashes the other scheme.

  function themeChoice() {
    try {
      var t = localStorage.getItem('theme');
      return (t === 'light' || t === 'dark') ? t : 'system';
    } catch (e) { return 'system'; }
  }

  // What is actually on screen, which is what the map has to match.
  function prefersDark() {
    var c = themeChoice();
    if (c === 'dark') return true;
    if (c === 'light') return false;
    return !!(window.matchMedia &&
              window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function applyTheme(choice) {
    var root = document.documentElement;
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
    try {
      if (choice === 'system') localStorage.removeItem('theme');
      else localStorage.setItem('theme', choice);
    } catch (e) { /* private mode: the page still works, it just forgets */ }

    var sw = $('themeSwitch');
    if (sw) {
      Array.prototype.forEach.call(sw.querySelectorAll('button'), function (b) {
        var on = b.dataset.themeChoice === choice;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    onSchemeChanged();
  }

  // Everything drawn with a color read from CSS has to be redrawn when the
  // scheme flips: the tile layer, the route casings, the markers.
  function onSchemeChanged() {
    if (!map) return;
    ownBase.setDark(prefersDark());
    if (cityRings) drawBoundary();
    if (routes) renderAll(false);
    else if (cameras) drawCameras();
    // The key is the same drawing as the marker and reads --pin-ring the same
    // way, so it has to be repainted here too. Without this it kept the ink of
    // whichever theme happened to be active when the page first loaded.
    paintLegendCamera();
  }

  // ---- about modal -----------------------------------------------------
  function initAbout() {
    var wrap = $('aboutModal');
    if (!wrap) return;
    function open() {
      wrap.hidden = false;
      var x = wrap.querySelector('.modal-x');
      if (x) x.focus();
    }
    function close() { wrap.hidden = true; }

    // The footer About is the only opener now; the header carries just the
    // wordmark, and the theme switch holds the other end of the footer.
    var btnF = $('aboutBtnFoot');
    if (btnF) btnF.onclick = open;
    // The intro's How? opens the same panel. Two openers, one concept: the
    // intro scrolls away once a result renders, and the footer is what stays
    // reachable at the point someone is looking at a route and wondering how
    // it was worked out.
    var howL = $('howLink');
    if (howL) howL.onclick = function (e) { e.preventDefault(); open(); };
    wrap.addEventListener('click', function (e) {
      if (e.target.closest('[data-close]')) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !wrap.hidden) close();
    });
  }

  // ---- map layers ------------------------------------------------------
  var LAYER_KEYS = { lyrPrecincts: 'precincts', lyrNumbers: 'numbers',
                     lyrWards: 'wards', lyrPolling: 'polling',
                     lyrCameras: 'cameras' };

  function layerState() {
    var o = {};
    Object.keys(LAYER_KEYS).forEach(function (id) {
      var el = $(id);
      o[LAYER_KEYS[id]] = el ? el.checked : true;
    });
    return o;
  }

  function applyLayers() {
    var o = layerState();
    ownBase.setLayerOpts(o);
    if (pollLayer) {
      if (o.polling) { if (!map.hasLayer(pollLayer)) pollLayer.addTo(map); }
      else map.removeLayer(pollLayer);
    }
    if (camLayer) {
      if (o.cameras && camerasInScope()) { if (!map.hasLayer(camLayer)) camLayer.addTo(map); }
      else map.removeLayer(camLayer);
      syncLabelObstacles();
    }
    try { localStorage.setItem('layers', JSON.stringify(o)); } catch (e) { /* private mode */ }
  }

  function initLayers() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem('layers') || 'null'); } catch (e) { saved = null; }
    Object.keys(LAYER_KEYS).forEach(function (id) {
      var el = $(id);
      if (!el) return;
      if (saved && typeof saved[LAYER_KEYS[id]] === 'boolean') el.checked = saved[LAYER_KEYS[id]];
      el.addEventListener('change', applyLayers);
    });
    applyLayers();
  }

  function initTheme() {
    var sw = $('themeSwitch');
    if (sw) {
      sw.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-theme-choice]');
        if (b) applyTheme(b.dataset.themeChoice);
      });
    }
    applyTheme(themeChoice());
  }

  // ---- the result map --------------------------------------------------
  //
  // The map is part of the answer rather than part of the furniture, so it
  // stays out of the document until there is something to show on it. It
  // replaces a bottom sheet that used to slide over a full-screen map: with
  // the map inline in a single column there is nothing to slide over, and
  // the three snap points, the drag handling and the sheet-aware fit padding
  // all went with it.

  function isPhone() { return window.matchMedia('(max-width: 700px)').matches; }

  // Clicking a marker used to open a Leaflet popup. That was fine over a
  // full-screen map and is not fine over a card: a 260px popup does not fit
  // inside a 320px box, Leaflet pans the map out from under you trying to
  // make it fit, and the rounded corner clips whatever still overflows.
  //
  // The detail is shown UNDER the map instead, at the full width of the
  // column, where it can be read at any screen size and nothing is covered.
  // The markup is unchanged: the same builders that fed the popups feed this.
  function showDetail(html) {
    var d = $('mapDetail');
    $('mapDetailBody').innerHTML = html;
    d.hidden = false;
    // Only chase it into view if it actually sits off the bottom, so a click
    // on a marker does not yank a map the reader is looking at.
    var r = d.getBoundingClientRect();
    if (r.bottom > window.innerHeight) d.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function hideDetail() {
    var d = $('mapDetail');
    if (d) { d.hidden = true; $('mapDetailBody').innerHTML = ''; }
  }


  // Leaflet measures its container once. A map revealed after layout has
  // therefore sized itself against a hidden element and renders a sliver of
  // tiles in the corner, so it has to be told to measure again. Callers fit
  // bounds AFTER this, since fitting against the stale size picks the wrong
  // zoom.
  function revealMap() {
    var b = $('mapBlock'), rb = $('routeBlock');
    if (!b) return;
    // The map lives INSIDE the route section now, so revealing the map block
    // alone does nothing while its parent is still hidden: this is exactly how
    // the pin button came to open onto no map at all. When the section is
    // being opened just for the map (pin picking, no route yet), map-only
    // hides the section's own chrome so a "How to get there" heading does not
    // float over an empty pick-a-spot view.
    if (rb && rb.hidden) { rb.hidden = false; rb.classList.add('map-only'); }
    var wasHidden = b.hidden;
    b.hidden = false;
    // Re-measure on any reveal path: either hidden flag may have left it 0x0.
    if (map && (wasHidden || map.getSize().x === 0)) map.invalidateSize(false);
    updateMapScope();
  }

  // What you are looking at, updated as you pan.
  //
  // Once there is an answer the map is the biggest thing on the page and it is
  // easy to lose track of which part of the city is on it, especially with the
  // ward tints on and no labels for them. The section heading carries the ward
  // and precinct under the CENTRE of the view, which is the ordinary reading of
  // "what am I looking at" and the only one that stays a single short answer:
  // a wide view can straddle a dozen precincts, and listing them would be
  // noise rather than orientation.
  function updateMapScope() {
    var el = $('mapScope');
    if (!el) return;
    if (!map || !precincts || $('mapBlock').hidden) { el.textContent = ''; return; }
    var c = map.getCenter();
    el.textContent = scopeText(c.lat, c.lng);
  }

  // "Ward 2 \u00b7 Precinct 40", "Outside the city", or nothing when no precinct
  // claims the point. One writer for the status bar whether it is following
  // the view centre or the cursor, so the two cannot word one spot
  // differently.
  function scopeText(lat, lng) {
    var pr = precinctAt(lat, lng);
    return pr ? placeLine(pr) : 'Outside Kent County';
  }

  // "Grand Rapids \u00b7 Ward 2 \u00b7 Precinct 40", or "Kentwood \u00b7 Ward 1
  // \u00b7 Precinct 3", or "Ada Township \u00b7 Precinct 4". The ward only where the
  // jurisdiction has them: 99 of the county's 202 precincts do not, and a
  // "Ward" with nothing after it would read as a gap in the data rather than
  // a fact about the township.
  function placeLine(pr) {
    return (pr.jurisdiction ? esc(pr.jurisdiction) + ' \u00b7 ' : '') +
      (pr.ward != null && pr.ward !== '' ? 'Ward ' + esc(pr.ward) + ' \u00b7 ' : '') +
      'Precinct ' + esc(pr.precinct);
  }

  // One builder for "what precinct is this", fed by both input worlds:
  // the desktop hover chip and the touch tap-for-detail card. Content, not
  // an event handler, so the two cannot describe the same spot differently.
  // Every polling place and early voting site in this data is in Grand
  // Rapids, so the five digits tell a reader nothing they did not already
  // know and cost a line of width on a phone. Stripped when drawing only.
  // The stored value keeps its ZIP: /simple builds "..., Grand Rapids, MI
  // 49504" from it to hand OpenStreetMap something it can geocode.
  // The full list of somewhere-to-go, for either kind, in a panel rather than
  // inline. Eleven addresses do not belong under the one address the row is
  // about, and inline they buried it.
  //
  // It also has to live OUTSIDE the row. Nested inside it, a click on an entry
  // bubbled to the cell's own handler, which re-routed to the nearest place a
  // heartbeat after routing to the chosen one -- so picking one appeared to
  // redraw the map and change nothing.
  //
  // Picking sets the choice for that kind, which the card then shows and the
  // router then drives to. The two used to disagree: the map went to the
  // library you picked while the card still named the nearest.
  // Named at the moment the panel opens, not when the page loads: the
  // jurisdiction is whichever one the current answer is in, and at load
  // there is no answer yet. (Built as a constant, this read "Ballot drop
  // boxes in " with nothing after it.)
  function listTitle(kind) {
    var where = (current && current.jurisdiction) || 'Grand Rapids';
    if (kind === 'dropbox' && officeOnly(boxesFor(current))) {
      return 'Returning an absentee ballot in ' + where;
    }
    return (kind === 'dropbox' ? 'Ballot drop boxes in ' : 'Early voting sites in ') + where;
  }

  function wirePlaceLists(r) {
    var wrap = $('placeModal'), body = $('placeModalBody'), title = $('placeTitle');
    if (!wrap || !body) return;
    var opts = destinations(r);

    function close() { wrap.hidden = true; }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !wrap.hidden) close();
    });

    ['dropbox', 'early'].forEach(function (kind) {
      var btn = $(kind === 'dropbox' ? 'boxListBtn' : 'evListBtn');
      var opt = opts.filter(function (o) { return o.kind === kind; })[0];
      if (!btn || !opt) return;
      btn.onclick = function () {
        title.textContent = listTitle(kind);
        body.innerHTML = placeListHtml(kind, opt);
        wrap.hidden = false;
        var x = wrap.querySelector('.modal-x');
        if (x) x.focus();
      };
    });

    wrap.onclick = function (e) {
      if (e.target.closest('[data-close]')) { close(); return; }
      var li = e.target.closest('li[data-pick]');
      if (!li || !current) return;
      chosen[li.dataset.kind] = Number(li.dataset.pick);
      close();
      // Redraw the card with the chosen place, then drive to it.
      show(current, li.dataset.kind);
    };
    body.onkeydown = function (e) {
      var li = e.target.closest && e.target.closest('li[data-pick]');
      if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); li.click(); }
    };
  }

  function placeListHtml(kind, opt) {
    var html = '<ul class="box-list">';
    opt.all.forEach(function (b, i) {
      html += '<li data-pick="' + i + '" data-kind="' + kind + '"' +
        ' role="button" tabindex="0" title="Get directions here"' +
        (i === chosen[kind] ? ' class="is-chosen"' : '') + '>' +
        '<span class="bx-name">' + esc(boxLabel(b)) +
        (b.metres != null
          ? '<span class="bx-dist">' + RoutePanel.fmtMi(b.metres) + '</span>'
          : '') + '</span>' +
        '<span class="bx-addr">' + esc(addressForDisplay(b.address)) + '</span>' +
        (b.entrance_note || b.note
          ? '<span class="bx-where">Location: ' +
            esc(sentenceCase(b.entrance_note || b.note)) + '</span>' : '') +
        // "Open 24/7" is a whole sentence; a bare "Mon-Fri, 8am to 5pm" is not,
        // and next to an address it can be read as the hours of the building
        // rather than of the box. The label says which.
        (b.office
          ? '<span class="bx-hours-odd">Office hours' +
            (b.phone ? ' \u00b7 ' + esc(b.phone) : '') + '</span>'
          : b.hours
          ? '<span class="' + (ALWAYS_OPEN.test(b.hours) ? 'bx-hours' : 'bx-hours-odd') +
            '">' + (ALWAYS_OPEN.test(b.hours) ? 'Open 24/7'
                                              : 'Open hours: ' + esc(b.hours)) + '</span>'
          : '') +

        '</li>';
    });
    // The City Hall boxes are real and cannot be driven to as an address, so
    // they are listed and plainly not offered as a destination.
    if (kind === 'dropbox' && inGrandRapids(current)) {
      ((clerk && clerk.unrouted) || []).forEach(function (b) {
        html += '<li class="bx-noroute"><span class="bx-name">' +
          esc(boxLabel(b)) + '</span><span class="bx-where">' +
          esc(sentenceCase(b.note || '')) + '</span>' +
          '<span class="bx-addr">Inside the building, so there is no address ' +
          'to route to.</span></li>';
      });
    }
    // No caption under the list. Every row already carries its own distance,
    // and every row is visibly a button, so a paragraph explaining the order
    // and the click was telling the reader what they could see.
    return html + '</ul>' + provenanceHtml();
  }

  // Where this list came from, said in the panel that shows it rather than
  // only in a file nobody opens. These addresses move between elections and
  // are typed by hand at the other end, so a reader deciding whether to trust
  // one is entitled to see the source, the date it was read, and -- when the
  // archive took a copy -- the page as it stood that day.
  // Resolved through sources.json rather than read out of the data file. A
  // record says which source it came from -- "src": "gr-clerk-current-election"
  // -- and the registry says who that is, what licence it carries, when it was
  // read and where the archive copy sits. So a list whose entries come from
  // two places can credit both, without either file repeating a publisher's
  // name on every row.
  function provenanceHtml(opt) {
    var ids = [], seen = {};
    ((opt && opt.all) || []).concat([clerk || {}]).forEach(function (r) {
      var id = r && r.src;
      if (id && sources[id] && !seen[id]) { seen[id] = 1; ids.push(id); }
    });
    if (!ids.length) return '';

    return '<p class="bx-prov">' + ids.map(function (id) {
      var s = sources[id];
      var bits = ['Source: <a href="' + esc(s.url) + '" target="_blank" ' +
        'rel="noopener">' + esc(s.publisher) + '</a>'];
      if (s.retrieved) bits.push('read ' + esc(Elections.monthDay(s.retrieved)));
      if (s.archived) {
        bits.push('<a href="' + esc(s.archived) + '" target="_blank" ' +
          'rel="noopener">archived copy</a>');
      }
      return bits.join(' \u00b7 ') +
        (s.archive_note ? '<br>' + esc(s.archive_note) : '');
    }).join('<br>') + '</p>';
  }

  // The right-hand cell of every row: what it is called, when it applies, and
  // -- when that window has not opened or has closed -- a line saying so. One
  // shape for all three rows, so a reader compares them down the column
  // instead of learning a new layout per row.
  function whenCell(kind, state, extra) {
    return '<div class="vi-when vi-when-' + kind + '">' +
      '<div class="vi-lbl' + (state.live ? ' live' : '') + '">' +
      esc(state.label) + '</div>' +
      '<div class="vi-val">' + esc(state.status) + '</div>' +
      (state.note ? '<div class="pp-note">' + esc(state.note) + '</div>' : '') +
      (extra || '') + '</div>';
  }

  // A drop box is only useful once there is a ballot to put in it, and the
  // dates for that are statute, not something a clerk publishes per box.
  // Michigan sends absentee ballots to voters 40 days before an election, and
  // a returned ballot must be in hand by the time the polls close. So a box
  // standing open in September accepts nothing, and the page should say that
  // rather than list an address as though it were ready.
  var ABSENTEE_LEAD_DAYS = 40;

  function absenteeState() {
    if (!activeEl) return { label: 'Ballot drop box', status: 'No election scheduled' };
    var start = Elections.dayStart(activeEl.date);
    start.setDate(start.getDate() - ABSENTEE_LEAD_DAYS);
    var from = start.getFullYear() + '-' +
      String(start.getMonth() + 1).padStart(2, '0') + '-' +
      String(start.getDate()).padStart(2, '0');
    var range = Elections.dayMonth(from) + ' to ' + Elections.dayMonth(activeEl.date);
    var today = Elections.todayISO();
    if (today < from) {
      return { label: 'Absentee voting upcoming', status: range, live: true,
               note: 'Absentee ballots are mailed from ' +
                     Elections.monthDay(from) + '. They can be returned from '
                     + 'then until the polls close on election day. ' + boxAccess() };
    }
    if (today > activeEl.date) {
      return { label: 'Absentee voting closed', status: range };
    }
    return { label: 'Absentee voting open', status: range, live: true,
             note: 'A returned ballot has to be in the clerk\'s hands by the '
                   + 'time the polls close on election day. ' + boxAccess() };
  }

  // Today IS the day. The three ways to vote stop being a menu at that point:
  // early voting has closed, a drop box is a race against the poll close, and
  // the polling place is simply the answer. So the card leads with it and the
  // directions go there unless the reader asks otherwise.
  function isElectionDay() {
    return !!activeEl && Elections.todayISO() === activeEl.date;
  }

  // "bike rack" -> "Bike rack", and "Across from Calder Plaza" left alone.
  // Only the first letter moves: the rest may hold names the clerk cased on
  // purpose ("Monroe and Calder Plaza levels").
  function sentenceCase(s) {
    s = String(s || '').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  // "Open 24/7" is what a shop is. A drop box is a slot in a wall, reachable
  // whenever you are awake, and that is a different promise -- especially for
  // someone deciding whether a late-evening trip is worth making.
  // The card names what it is showing. Once the reader picks something other
  // than the nearest, "nearest to you" is no longer true of it, and a label
  // that keeps saying so is the card lying about its own contents.
  function placeLabel(kind, dflt) {
    return chosen[kind] ? 'Custom location selected' : dflt;
  }

  function customClass(kind) { return chosen[kind] ? ' is-custom' : ''; }

  // True of every street box, so it is said once about all of them under the
  // dates rather than eleven times down a column. The video monitoring is not
  // our claim: MCL 168.761d requires the clerk to monitor each box. Worth
  // saying either way -- someone routing around plate readers is entitled to
  // know the destination is watched.
  // Monitoring is true of every box: MCL 168.761d requires the clerk to
  // monitor each one. Access is NOT -- the box in the City Hall lobby is open
  // weekdays, 8 to 5, and somebody driving there on a Saturday with a ballot
  // finds a locked building. So the sentence claims only what holds for all of
  // them, and the rows carry hours wherever they differ.
  function boxAccess() {
    var list = boxesFor(current);
    if (officeOnly(list)) {
      return 'No ballot drop box is published for ' +
        esc((current && current.jurisdiction) || 'this jurisdiction') +
        '. An absentee ballot has to be returned to your own clerk, so the ' +
        'clerk\u2019s office is where it goes, during office hours.';
    }
    var odd = list.filter(function (b) {
      return !ALWAYS_OPEN.test(b.hours || '');
    }).length;
    return 'Drop boxes are monitored by video surveillance, which Michigan law ' +
      'requires.' +
      (odd ? ' Most are accessible 24/7; ' + (odd === 1 ? 'one is not, and its'
                                                        : odd + ' are not, and their') +
             ' hours are on the list.'
           : ' They are accessible 24/7.');
  }

  var ALWAYS_OPEN = /^24\/7$/;

  function boxLabel(box) {
    // An office name is composed here, already cased, with an apostrophe
    // displayCase would capitalise after ("Clerk'S"). Everything else comes
    // from a file in whatever case it was typed and needs the treatment.
    if (box.office) return box.name;
    return displayCase(box.name || box.address || 'Drop box');
  }

  function addressForDisplay(a) {
    return displayCase(String(a || '').replace(/,\s*\d{5}(-\d{4})?\s*$/, ''));
  }

  function precinctInfoHtml(pr) {
    var place = P && P.pollingPlace(P.idOf(pr));
    return '<div class="destpop">' +
      '<div class="dt">' + placeLine(pr) + '</div>' +
      (place ? '<div class="dn">' + esc(displayCase(place.name)) + '</div>' +
               '<div class="da">' + esc(addressForDisplay(place.address)) + '</div>' +
               (place.entrance_note ? '<div class="de">' + esc(place.entrance_note) + '</div>' : '')
             : '<div class="da">No polling place on file.</div>') +
      '</div>';
  }

  // Marker detail opens AT the marker on hover-capable devices, and in the
  // card below the map on touch. ONE helper, used by all three marker kinds
  // (cameras, polling places, the finish flag), so a device can never get a
  // mix of the two behaviours. `html` may be a string or a function that
  // builds one when opened, as Leaflet's own bindPopup allows.
  function hoverPopups() {
    return !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);
  }

  function bindDetail(m, html, maxWidth) {
    if (hoverPopups()) {
      m.bindPopup(html, { maxWidth: maxWidth, className: 'cam-popup' });
    } else {
      m.on('click', function () {
        showDetail(typeof html === 'function' ? html() : html);
      });
    }
  }

  // Desktop hover: the status bar follows the cursor instead of the view
  // centre while a cursor exists to follow; on touch devices it keeps its
  // centre-of-view meaning. Cursor tracking feeds the status bar and nothing
  // else: a per-number tooltip used to live here too, but with the words now
  // drawn on the map and the status bar naming whatever is under the cursor,
  // it said the same thing twice.
  var hoverThrottle = 0;
  function initMapHover() {
    if (!hoverPopups()) return;
    map.on('mousemove', function (e) {
      var now = Date.now();
      if (now - hoverThrottle < 40) return;
      hoverThrottle = now;
      var el = $('mapScope');
      if (el) el.textContent = scopeText(e.latlng.lat, e.latlng.lng);
    });
    map.on('mouseout', updateMapScope);
  }

  function hideMap() {
    var b = $('mapBlock');
    if (b) b.hidden = true;
  }

  // Bring the answer to the top of the viewport. The address bar is sticky,
  // so scrolling the block to y=0 would tuck its heading underneath it.
  function scrollToResult(id) {
    var el = $(id), bar = $('searchBar');
    if (!el || el.hidden) return;
    var offset = (bar ? bar.getBoundingClientRect().height : 0) + 8;
    var y = window.scrollY + el.getBoundingClientRect().top - offset;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }

  function init() {
    initMap();
    initInput();
    initTheme();
    initLayers();
    initMapHover();
    initAbout();
    $('resetBtn').onclick = reset;
    loadData();
  }

  function initMap() {
    map = L.map('map', { zoomControl: true, attributionControl: true }).setView(GR, 13);
    // Added before the data loads so the map paints its ground color rather
    // than flashing empty; setData fills it in when the files arrive.
    ownBase = BasemapLayer({ graph: null, landcover: null, dark: prefersDark() });
    ownBase.addTo(map);
    // Leaflet 1.9 ships a Ukrainian flag SVG inside its default attribution
    // prefix. The library credit stays, the flag does not: this is a voting
    // page, and it should not put an unrelated political statement in front of
    // people who came to find their polling place. Dropping it also buys back
    // the line that was making the attribution wrap on a phone.
    map.attributionControl.setPrefix(
      '<a href="https://leafletjs.com" title="A JavaScript library for interactive maps">Leaflet</a>');
    map.attributionControl.addAttribution(ATTR);
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      // Only matters while following the system; an explicit choice overrides.
      var onScheme = function () {
        if (themeChoice() === 'system') onSchemeChanged();
      };
      if (mq.addEventListener) mq.addEventListener('change', onScheme);
      else if (mq.addListener) mq.addListener(onScheme);
    }
    boundaryLayer = L.layerGroup().addTo(map);
    pollLayer = L.layerGroup().addTo(map);
    camLayer = L.layerGroup().addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    pinLayer = L.layerGroup().addTo(map);
    addGearControl();
    addStatusControl();

    // moveend covers pan, zoom and fitBounds alike, so the readout follows the
    // route fit as well as a hand drag.
    map.on('moveend', updateMapScope);

    // Pin drop is ARMED by the button beside the address field, so an idle
    // click on the map (panning slip, closing a popup) never starts a route.
    // One shot: a successful drop disarms it.
    map.on('click', function (e) {
      if (pinArmed) {
        hideDetail();
        disarmPin();
        pinLookup(e.latlng.lat, e.latlng.lng);
        return;
      }
      // An idle tap asks "what precinct is this". This is the whole touch
      // story: no cursor means no hover, so the tap opens the same detail
      // card under the map that the markers use, with the same dismissals
      // (close button, Escape, a tap outside the city). Marker clicks do not
      // bubble here, so their own detail is never overridden.
      var pr = precinctAt(e.latlng.lat, e.latlng.lng);
      if (pr) showDetail(precinctInfoHtml(pr));
      else hideDetail();
    });
    $('detailX').onclick = hideDetail;
    $('pinBtn').onclick = function () { pinArmed ? disarmPin() : armPin(); };
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      // One surface per press: the pin is the more recent intent, so it backs
      // out first and the detail survives that press.
      if (pinArmed) disarmPin();
      else hideDetail();
    });
  }

  // The layer toggles live in a gear in the map's own corner: they are map
  // settings, and they used to sit in a fold at the bottom of the PAGE,
  // three scrolls from the thing they control. Same input-as-SIBLING-of-
  // label markup as before: wrapping the input in its label makes a click
  // toggle it twice and the box lands back where it started.
  function addGearControl() {
    var gear = L.control({ position: 'topright' });
    gear.onAdd = function () {
      var d = L.DomUtil.create('div', 'map-gear leaflet-bar');
      d.innerHTML =
        '<button type="button" class="gear-btn" title="Map layers" aria-expanded="false">' +
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="12" cy="12" r="3"/>' +
        '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg></button>' +
        '<div class="gear-panel" hidden>' +
        '<div class="layer-toggles" id="layerToggles">' +
        '<div class="lyr"><input type="checkbox" id="lyrPrecincts" checked><label for="lyrPrecincts">Precinct boundaries</label></div>' +
        '<div class="lyr"><input type="checkbox" id="lyrNumbers" checked><label for="lyrNumbers">Precinct numbers</label></div>' +
        '<div class="lyr"><input type="checkbox" id="lyrWards" checked><label for="lyrWards">Ward colors</label></div>' +
        '<div class="lyr"><input type="checkbox" id="lyrPolling" checked><label for="lyrPolling">Polling places</label></div>' +
        '<div class="lyr"><input type="checkbox" id="lyrCameras" checked><label for="lyrCameras">License plate cameras</label></div>' +
        '</div>' +
        '<div class="gear-sec">Camera data</div>' +
        '<div class="cam-count" id="camCountFold"></div>' +
        '</div>';
      // Clicks in the panel are settings work, not map gestures: they must
      // not drop a precinct card or move the map underneath.
      L.DomEvent.disableClickPropagation(d);
      var btn = d.querySelector('.gear-btn'), panel = d.querySelector('.gear-panel');
      btn.onclick = function () {
        panel.hidden = !panel.hidden;
        btn.setAttribute('aria-expanded', String(!panel.hidden));
      };
      // Capture phase, so a click on a row that re-renders the DOM is still
      // seen while its target is attached (the dashboard gear lesson).
      document.addEventListener('click', function (e) {
        if (!panel.hidden && !d.contains(e.target)) {
          panel.hidden = true; btn.setAttribute('aria-expanded', 'false');
        }
      }, true);
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !panel.hidden) {
          panel.hidden = true; btn.setAttribute('aria-expanded', 'false');
        }
      });
      return d;
    };
    gear.addTo(map);
  }

  // The ward/precinct readout lives in the map's own bottom-left corner, a
  // status bar opposite the attribution. Every writer finds it by its id.
  function addStatusControl() {
    var status = L.control({ position: 'bottomleft' });
    status.onAdd = function () {
      var d = L.DomUtil.create('div', 'map-status');
      d.id = 'mapScope';
      return d;
    };
    status.addTo(map);
  }

  // The suggestion list is autocomplete.js. It owns the widget; this page
  // says what searching, choosing and missing mean.
  function initInput() {
    ac = Autocomplete.attach({
      input: $('addr'),
      suggest: suggestWithNeighbours,
      hasNumber: function (text) { return P.parseTyped(text).number != null; },
      onChoose: choose,
      onMiss: function (text) { showError(missExplanation(text)); }
    });
  }

  // One JSON file from data/. The first four the page cannot work without,
  // so a failure there fails the whole load; the rest degrade to a page with
  // no boundary veil, no election line or no precinct polygons.
  function loadJson(name, optional) {
    var p = fetch('data/' + name + '.json').then(function (r) { return r.json(); });
    return optional ? p.catch(function () { return null; }) : p;
  }

  // The county road network, streamed.
  //
  // Every jurisdiction is resident at once, so a route that crosses a city
  // line needs no second fetch -- but the chunks are read ONE AT A TIME and
  // each is dropped before the next is asked for. Holding all thirty parsed
  // at once peaks at 102 MiB against a 13 MiB steady state, and that
  // transient is what decides whether an older phone survives the load.
  //
  // The index says how big each chunk is, which is what lets the graph
  // allocate its arrays once before reading any of them.
  //
  // A few requests in flight, but only ONE parsed document alive.
  //
  // Strictly sequential would mean thirty round trips end to end, which on a
  // phone is seconds of nothing but latency. Promise.all would mean thirty
  // parsed chunks landing on top of each other, which is the 102 MiB peak
  // this exists to avoid.
  //
  // So the fetches run a few ahead while the parsing stays in order and one
  // at a time. What is held early is a compressed response body, tens of
  // kilobytes; what is bounded is the parsed form, which is a hundred times
  // larger. Each document is dropped as soon as it is folded in.
  var CHUNK_LOOKAHEAD = 4;

  function loadCountyGraph() {
    return loadJson('graph/index').then(function (index) {
      var g = ALPRRouter.Graph.streaming(index);
      var chunks = index.chunks, inFlight = [];

      function fetchAt(i) {
        return i < chunks.length ? loadJson('graph/' + chunks[i].mcd) : null;
      }
      for (var k = 0; k < CHUNK_LOOKAHEAD && k < chunks.length; k++) {
        inFlight.push(fetchAt(k));
      }

      var at = 0;
      function next() {
        if (at >= chunks.length) return g.finish();
        var pending = inFlight[at];
        var ahead = at + CHUNK_LOOKAHEAD;
        if (ahead < chunks.length) inFlight[ahead] = fetchAt(ahead);
        at++;
        return pending.then(function (doc) {
          g.addChunk(doc);
          doc = null;
          inFlight[at - 1] = null;      // release the settled promise's value
          return next();
        });
      }
      return next();
    });
  }

  // The address index for every jurisdiction in the county, and where each
  // precinct votes. precincts.json is read first because it says which
  // jurisdictions exist; then one address file and one polling file per
  // jurisdiction, all at once -- they are small, 2.8 MiB for the whole county
  // before compression, and unlike the graph they are consumed as they are.
  // Grand Rapids' polling.json rides along as the source of record for the
  // city: hand-transcribed, with entrance notes and the one consolidation the
  // county's page does not carry.
  function loadCountyIndex() {
    return loadJson('precincts').then(function (index) {
      var mcds = (index.jurisdictions || []).map(function (j) { return j.mcd; });
      return Promise.all([
        Promise.all(mcds.map(function (m) { return loadJson('addresses/' + m); })),
        Promise.all(mcds.map(function (m) { return loadJson('polling/' + m, true); })),
        loadJson('polling', true)
      ]).then(function (parts) {
        return {
          index: index,
          P: Precincts.county({
            index: index,
            addresses: parts[0],
            polling: parts[1].filter(Boolean),
            cityPolling: parts[2],
            cityMcd: GR_MCD
          })
        };
      });
    });
  }

  function loadData() {
    var input = $('addr');
    input.disabled = true;
    Promise.all([
      loadCountyGraph(), loadJson('cameras'), loadCountyIndex(),
      loadJson('boundary', true), loadJson('elections', true), loadJson('landcover', true),
      loadJson('neighbors', true),
      loadJson('gr-clerk', true), loadJson('sources', true)
    ]).then(function (res) {
      var cameraData = res[1], county = res[2];
      var boundary = res[3], calendar = res[4], landcover = res[5];
      var neighborData = res[6], clerkData = res[7];
      var sourceData = res[8];

      graph = res[0];
      cachedCameras = cameraData.cameras;
      P = county.P;
      var precinctData = county.index;
      drawPollingPlaces();
      if (boundary && boundary.rings) {
        // boundary.json stores [lng, lat]; everything here wants [lat, lng].
        // The city limits are no longer drawn as a veil -- the lookup covers
        // the whole county, so a veil at the city line would mark the wrong
        // edge -- but they still decide which jurisdiction's own clerk data
        // applies, which only Grand Rapids has.
        cityRings = boundary.rings.map(function (ring) {
          return ring.map(function (p) { return [p[1], p[0]]; });
        });
      }
      neighbors = (neighborData && neighborData.streets) || null;
      precincts = (precinctData && precinctData.precincts) || null;
      if (precincts) ownBase.setPrecincts(precincts);
      ownBase.setData(graph, landcover || null);
      // Every camera in the county, not just the ones inside the city.
      //
      // This used to filter to the city rings, because the routes stopped at
      // the city line and a camera in Wyoming could not be on one. The graph
      // now covers all thirty jurisdictions, so that filter would hide
      // cameras that sit on roads a route actually uses -- and a route drawn
      // as clean past a plate reader we know about is the one failure this
      // whole tool exists to prevent.
      cameras = cachedCameras;
      // Election day hours are statewide and statutory, so they are one
      // object beside the list rather than a field repeated on every election.
      electionDayHours = (calendar && calendar.election_day_hours) || null;
      electionList = (calendar && calendar.elections) || [];
      activeEl = Elections.next(electionList);
      sources = (sourceData && sourceData.sources) || {};
      clerk = placeCoords(clerkData);
      renderElectionBanner();
      startCountdown();
      graph.assignCameras(cameras);
      // The street index and the snap grid are built lazily; build them
      // now, while the page is still saying "loading", rather than on the
      // first address someone types.
      graph.warm();
      drawCameras();
      input.disabled = false;
      // Autofocus on a phone pops the keyboard over the map before the person
      // has seen anything, so it is desktop-only.
      if (!isPhone()) input.focus();
    }).catch(function () {
      // The page is a lookup over these files: with them missing there is
      // nothing to answer with, so say so where the answer would have gone.
      showError('Could not load the map data files. If you are hosting this ' +
        'yourself, check that the data folder sits next to this page.');
    });
  }

  // The city limits, drawn because routing stops at them: without the outline
  // a route that stops at the edge looks like a bug rather than the edge of
  // the data.
  function drawBoundary() {
    if (!cityRings) return;
    boundaryLayer.clearLayers();

    // Everything outside the city is veiled: routing stops at the line, and
    // fading the outside says so before anyone has to read that it does.
    // Built as one polygon whose outer ring is the world and whose holes are
    // the city, so the hole IS the covered area and the two can never disagree.
    var world = [[-85, -180], [-85, 180], [85, 180], [85, -180]];
    L.polygon([world].concat(cityRings), {
      stroke: false,
      fillColor: getVar('--bg'),
      // The light basemap is already near-white, so fading toward the page
      // needs more of it to register than the dark one does.
      fillOpacity: prefersDark() ? 0.66 : 0.78,
      interactive: false,
      className: 'city-veil'
    }).addTo(boundaryLayer);

    L.polygon(cityRings, {
      color: getVar('--dim'), weight: 2, opacity: .6,
      dashArray: '7 6', fill: false, interactive: false
    }).addTo(boundaryLayer);
  }

  // Inside the city limits? Only one thing still turns on this: whether the
  // city clerk's own data applies to a dropped pin. Coverage is decided by
  // the precinct polygons now, which reach every jurisdiction in the county.
  // With no boundary file loaded, nothing counts as inside the city.
  function insideCity(lat, lng) {
    return !!cityRings && Precincts.pointInRings(lat, lng, cityRings);
  }

  // Every polling place in the city, shown from the start. This is a voting
  // tool: where people vote is the subject, and seeing all 59 makes the one
  // that turns out to be yours legible as part of a pattern rather than a
  // lone pin. The active one is drawn separately as the finish flag.
  function drawPollingPlaces(activePrecinct) {
    if (!P || !pollLayer) return;
    pollLayer.clearLayers();
    var seen = {};
    Object.keys(P.polling).forEach(function (pk) {
      var pl = P.pollingPlace(pk);
      if (!pl || pl.lat == null) return;
      // Consolidated precincts share a building; draw it once. The list at a
      // spot keeps growing as later precincts land on it, so the detail reads
      // it when opened rather than when the marker is made.
      var key = pl.lat.toFixed(5) + ',' + pl.lng.toFixed(5);
      if (seen[key]) { seen[key].push(pk); return; }
      var atThisSpot = seen[key] = [pk];
      var isActive = activePrecinct && String(pk) === String(activePrecinct);
      // A hollow ring: present without competing. Fifty-nine filled marks
      // buried the precinct numbers and the route underneath them.
      var S = isActive ? 21 : 15;
      var m = L.marker([pl.lat, pl.lng], {
        icon: L.divIcon({
          className: 'poll-ring' + (isActive ? ' active' : ''),
          html: '<span></span>',
          iconSize: [S, S], iconAnchor: [S / 2, S / 2]
        }),
        zIndexOffset: isActive ? 500 : 300, keyboard: false, riseOnHover: true
      }).addTo(pollLayer);
      bindDetail(m, function () {
        var list = atThisSpot.slice().sort(function (a, b) { return a - b; });
        return '<div class="destpop">' +
          '<div class="dt">Polling place</div>' +
          '<div class="dn">' + esc(displayCase(pl.name)) + '</div>' +
          '<div class="da">' + esc(addressForDisplay(pl.address)) + '</div>' +
          (pl.entrance_note ? '<div class="de">' + esc(pl.entrance_note) + '</div>' : '') +
          '<div class="dw">Precinct' + (list.length > 1 ? 's ' : ' ') +
          esc(list.join(', ')) + '</div></div>';
      }, 280);
    });
  }

  // ---- cameras ---------------------------------------------------------

  // How a camera draws and what its popup says lives in cameras.js. What is
  // left here is what needs the map: the wrapper that makes a Leaflet marker
  // out of the drawing, and the legend key that paints the same figure.
  function cameraIcon(c, flagged) {
    var art = Cameras.markerSvg(c, flagged, getVar('--pin-ring'));
    return L.divIcon({ className: 'cam-icon', html: art.html,
                       iconSize: [art.size, art.size],
                       iconAnchor: [art.centre, art.centre] });
  }

  function paintLegendCamera() {
    var el = document.querySelector('.map-legend .dotk');
    if (!el) return;
    el.innerHTML = Cameras.legendSvg(getVar('--pin-ring'));
    el.setAttribute('title', 'RoboCop');
  }


  // Where to DRAW a camera. OSM maps the pole, which stands beside the road;
  // at street zoom that sideways offset grows to tens of pixels and the dot
  // looks like it has wandered off the road it watches. Display snaps to the
  // nearest road within the standoff; the true position stays in the data.
  function cameraDisplayPos(c) {
    return graph ? graph.cameraPos(c.id, c.lat, c.lng) : [c.lat, c.lng];
  }

  // Every camera in the county now, not the city subset: the routes reach
  // every jurisdiction, so the count has to describe the same area the
  // avoidance does. Rendered from the data rather than written into the copy,
  // so it stays true when the camera file is refreshed.
  function renderCameraCount() {
    var fold = $('camCountFold');
    if (!fold) return;
    var n = cameras ? cameras.length : 0;
    // Names its source. It used to sit above a Cache/OSM toggle and leave that
    // to the toggle; with the toggle gone, nothing else on the map says where
    // these came from or how old they can be.
    fold.textContent = n + ' reported camera' + (n === 1 ? '' : 's') +
      ' in Kent County, from OpenStreetMap as of the last time this page ' +
      'was published. Volunteer-mapped and certainly incomplete, so treat ' +
      'it as a floor rather than a full count.';
  }

  // Cameras appear only once there is a route for them to matter to. A person
  // picking a start point is answering "where am I", and forty-three red
  // markers are noise against that question; they become signal the moment a
  // route exists to pass or avoid them. ONE predicate, consumed by the layer
  // toggle, the draw, and the label-obstacle sync, so the three cannot drift.
  function camerasInScope() { return !!routes; }

  // The label grid needs the camera positions to keep names off them. Hidden
  // cameras are not obstacles: nothing is drawn, so nothing can collide.
  // Guarded by a signature because setObstacles forces a canvas redraw, and
  // drawCameras runs on every route toggle.
  var obstacleSig = null;
  function syncLabelObstacles() {
    var visible = layerState().cameras && camerasInScope();
    var pts = visible && cameras
      ? cameras.map(function (c) { return cameraDisplayPos(c); })
      : [];
    // Count alone is not identity: a re-snap moves markers without changing
    // how many there are, and stale reservations would shield empty ground.
    var sig = visible + ':' + pts.length +
      (pts.length ? ':' + pts[0][0].toFixed(6) + ',' + pts[0][1].toFixed(6) : '');
    if (sig === obstacleSig) return;
    obstacleSig = sig;
    ownBase.setObstacles(pts);
  }

  function drawCameras(flagged) {
    renderCameraCount();
    camLayer.clearLayers();
    if (!camerasInScope()) {
      if (map.hasLayer(camLayer)) map.removeLayer(camLayer);
      syncLabelObstacles();
      return;
    }
    if (layerState().cameras && !map.hasLayer(camLayer)) camLayer.addTo(map);
    var flag = flagged || {};
    cameras.forEach(function (c) {
      var mk = L.marker(cameraDisplayPos(c), {
        icon: cameraIcon(c, !!flag[c.id]),
        zIndexOffset: flag[c.id] ? 600 : 400,
        keyboard: false
      });
      bindDetail(mk, function () { return Cameras.popupHtml(c); }, 300);
      mk.addTo(camLayer);
    });
    syncLabelObstacles();
  }

  // ---- lookup ----------------------------------------------------------

  function reset() {
    hideDetail();
    hideMap();
    routeLayer.clearLayers(); pinLayer.clearLayers();
    current = null;
    $('addr').value = ''; ac.close();
    $('resultBlock').hidden = true; $('routeBlock').hidden = true;
    $('routeBlock').classList.remove('map-only');
    routes = null;   // out of scope: reset also takes the cameras off the map
    $('col').classList.remove('has-result');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    disarmPin();
    ownBase.setRouteStreets([], null);
    ownBase.setActivePrecinct(null);
    drawPollingPlaces();
    drawCameras();
    map.setView(GR, 13);
    $('addr').focus();
  }

  // ---- address entry ---------------------------------------------------

  function choose(item) {
    if (!item) return;
    ac.close();
    if (item.kind === 'outside') {
      $('addr').value = (item.number != null ? item.number + ' ' : '') +
        displayCase(item.street);
      $('addr').blur();
      chooseOutside(item);
      return;
    }
    var input = $('addr');
    if (item.number == null) {
      // a street was picked: keep any number already typed and reopen
      var num = (input.value.match(/^(\d+)/) || [])[1] || '';
      input.value = (num ? num + ' ' : '') + displayCase(item.street) + (num ? '' : ' ');
      input.focus();
      ac.refresh();
      return;
    }
    // The box shows the address the way it is written, not the way the index
    // stores it. ALL CAPS is how the parcel file happens to hold a street, not
    // how anyone writes one, and the lookup uppercases whatever it is given --
    // so nothing downstream cares and the reader gets their own address back.
    input.value = item.number + ' ' + displayCase(item.street);
    resetChoices();
    var r = P.lookup(input.value);
    if (r.error) {
      showError('Could not resolve ' + esc(input.value) + '.');
      return;
    }
    // Where the address was inferred from its neighbors, let the precinct
    // boundary overrule them. See refineWithPolygon in precinct.js.
    P.refineWithPolygon(r, function (n, st) { return graph.geocode(n, st); }, precincts);
    setHint('');
    // Drop focus before rendering, not after. On a phone the soft keyboard is
    // most of the lower screen, and show() fits the map to the viewport it
    // finds, so blurring first means the fit is computed against the real
    // height rather than the keyboard-shortened one. The street-only branch
    // above deliberately keeps focus: that address is not finished yet.
    input.blur();
    show(r);
  }

  // A street in Wyoming or Kentwood is a real street that a person with a
  // Grand Rapids mailing address may well live on, and typing it used to end
  // in an error only once they pressed Enter. It is now offered in the list
  // like any other street, labelled with the jurisdiction it is actually in,
  // so the answer arrives at the moment of picking rather than after a
  // rejection.
  //
  // These come last and only fill what the city's own suggestions leave. A
  // city street is what this tool can answer, and one that matches should
  // never be pushed down the list by a neighbour.
  var GR_CITY = 'Grand Rapids city';
  var GR_MCD = '34000';      // the state's MCD code for the City of Grand Rapids

  // Whether a result is in the one jurisdiction whose own clerk data this
  // page carries. The city clerk's file has the early voting sites and drop
  // boxes for Grand Rapids and nothing else; every other jurisdiction's drop
  // boxes come from the county's page, and its early voting sites are not
  // shown at all, because the county's list is for the wrong election.
  function inGrandRapids(r) {
    return !!(r && r.mcd === GR_MCD);
  }

  function suggestWithNeighbours(text, limit) {
    var out = P.suggest(text, limit) || [];
    // Say which jurisdiction EVERY suggestion is in, not only the ones from
    // outside. A list where some rows are labelled and some are bare reads as
    // "these are the odd ones"; a reader still has to know that the unlabelled
    // ones are the answerable ones. "city" is not padding either -- Grand
    // Rapids Township is a real, different place next door.
    out.forEach(function (o) { if (!o.where) o.where = [GR_CITY]; });
    if (out.length >= limit || !neighbors) return out;

    var typed = P.parseTyped(text);
    if (!typed.rest || typed.rest.length < 2) return out;
    var have = {};
    out.forEach(function (o) { have[o.street] = 1; });

    var names = Object.keys(neighbors).filter(function (name) {
      return !have[name] && name.indexOf(typed.rest) === 0;
    }).sort();

    for (var i = 0; i < names.length && out.length < limit; i++) {
      var where = neighbors[names[i]] || [];
      out.push({ street: names[i], number: typed.number, kind: 'outside',
                 where: where });
    }
    return out;
  }

  // Picking one of those is an answer, not a failure: it says which
  // jurisdiction the street is in and who to ask there. The address stays in
  // the box, because it is a real address and the reader typed it correctly.
  function chooseOutside(item) {
    var where = item.where && item.where.length
      ? (item.where.length === 1 ? esc(item.where[0])
         : esc(item.where.slice(0, -1).join(', ')) + ' or ' +
           esc(item.where[item.where.length - 1]))
      : 'another jurisdiction';
    setHint('');
    showError('That address is in ' + where + ', which this tool does not ' +
      'have an address index for, so it cannot say where you vote. The ' +
      'Michigan Voter Information Center at mvic.sos.state.mi.us will have ' +
      'your polling place.');
  }

  // Most of the "Grand Rapids" postal area is not the City of Grand Rapids.
  // More than half the road segments carrying a Grand Rapids ZIP sit in
  // Wyoming, Kentwood, Walker, East Grand Rapids or Grand Rapids CHARTER
  // TOWNSHIP, which shares the city's name and confuses everyone. Those
  // residents vote somewhere this tool does not cover, and telling them "no
  // street matches" reads as a broken tool rather than an honest limit.
  function missExplanation(typed) {
    // parseTyped already uppercases, collapses spaces and strips the house
    // number, which is exactly the form neighbors.json is keyed by.
    var street = P.parseTyped(typed).rest;
    var hit = neighbors && street ? neighbors[street] : null;
    if (hit && hit.length) {
      var where = hit.length === 1 ? esc(hit[0])
        : esc(hit.slice(0, -1).join(', ')) + ' or ' + esc(hit[hit.length - 1]);
      return 'That street is in ' + where + ', which this tool does not have ' +
        'an address index for. Your clerk is the one for ' + where + '.';
    }
    return 'No Kent County street matches that. Check the spelling, or type ' +
      'just the street name to see the options. This tool covers Kent ' +
      'County, Michigan; an address in Ottawa, Allegan, Barry, Ionia, ' +
      'Montcalm or Newaygo County is not in it.';
  }

  // ---- dropped pin -----------------------------------------------------

  // A dropped pin has no house number, so the address index cannot answer
  // it; the precinct POLYGONS can. Point-in-polygon over the same state
  // boundary file vote-gr uses, entirely on this device like everything else.
  // One ray cast, kept in precinct.js so the lookup and the map cannot drift
  // into disagreeing about which precinct a point falls in.
  function precinctAt(lat, lng) {
    if (!P || !precincts) return null;
    return P.precinctAt(lat, lng, precincts);
  }

  function armPin() {
    pinArmed = true;
    // There may be no map on screen yet: it only appears with an answer.
    // Arming the pin is a request for one, so bring it up and put the whole
    // city in view, which is the right frame for choosing a spot.
    var fresh = $('mapBlock').hidden;
    revealMap();
    if (fresh && map) map.setView(GR, 12);
    $('pinBtn').classList.add('armed');
    $('pinBtn').setAttribute('aria-pressed', 'true');
    $('map').classList.add('pin-armed');
    setHint('Tap the map where you want to start from. Esc cancels.');
    $('mapNote').textContent = 'Tap anywhere in the city to start from that spot.';
    scrollToResult('mapBlock');
  }

  function disarmPin() {
    if (pinArmed) $('mapNote').textContent = '';
    pinArmed = false;
    $('pinBtn').classList.remove('armed');
    $('pinBtn').setAttribute('aria-pressed', 'false');
    $('map').classList.remove('pin-armed');
    setHint('');
  }

  function pinLookup(lat, lng) {
    if (!graph || !P) return;
    resetChoices();
    var pr = precinctAt(lat, lng);
    if (!pr) {
      $('addr').value = ''; ac.close();
      showError('That spot is outside Kent County, or not in any precinct ' +
        'we have. This tool covers Kent County, Michigan. Try dropping the ' +
        'pin on a street, or type the address instead.');
      return;
    }
    var who = P.describe(P.idOf(pr));
    var place = P.pollingPlace(who.code);
    $('addr').value = ''; ac.close();
    setHint('Routing from your dropped pin. Type an address to switch back.');
    show({ pin: true, lat: lat, lng: lng, code: who.code,
           precinct: who.precinct, ward: who.ward,
           jurisdiction: who.jurisdiction, mcd: who.mcd, place: place });
  }

  // ---- the answer ------------------------------------------------------

  function showError(msg) {
    $('resultBlock').hidden = false; $('routeBlock').hidden = true;
    $('precinctInfo').innerHTML = '<div class="err">' + msg + '</div>';
    $('advisory').innerHTML = '';
    routeLayer.clearLayers(); pinLayer.clearLayers();
  }

  function show(r, focusKind) {
    current = r;
    $('col').classList.add('has-result');
    revealMap();
    // No standing caption: the header names the destination and the map shows
    // it. The note is reserved for the one moment it carries an instruction,
    // which is pin picking.
    $('mapNote').textContent = '';
    var place = r.place;
    $('resultBlock').hidden = false;

    // The answer as labelled facts in a grid: one row for early voting, one
    // for election day, each a WHEN cell and a WHERE cell. A row's where-cell
    // is emitted only when there is a place to name, which is why the columns
    // are placed explicitly in CSS rather than left to flow. Ward and Precinct
    // are a rail down the left of the whole table, spanning every row, rather
    // than a row of their own: that is what keeps both place names starting
    // at the same x. The identity names the whole answer, not its first row.
    var html = '<div class="vi-rows"><div class="vi-grid"><div class="vi-rail">' +
      // The jurisdiction first: it is what a precinct number means anything
      // relative to, now that there is a Precinct 1 in twenty-nine places.
      (r.jurisdiction ? '<div><div class="vi-lbl">Where you vote</div>' +
                        '<div class="vi-name">' + esc(r.jurisdiction) + '</div></div>' : '') +
      (r.ward != null && r.ward !== ''
        ? '<div><div class="vi-lbl">Ward</div>' +
          '<div class="vi-num">' + esc(r.ward) + '</div></div>' : '') +
      '<div><div class="vi-lbl">Precinct</div>' +
      '<div class="vi-num">' + esc(r.precinct) + '</div></div></div>';

    // Three ways to cast a ballot, in the order a voter can act on them:
    // the drop box is open first and for longest, early voting comes next,
    // and election day is the deadline. Every row reads the same way -- the
    // place and its hours on the left, when it applies on the right -- so the
    // three can be compared down a column instead of re-read one at a time.
    // A row whose window has not opened, or has closed, says so where the
    // dates are.
    //
    // Each is built into its own string rather than appended straight to the
    // page, because on election day the order changes: see below.
    var boxHtml = '', evHtml = '', pollHtml = '';

    // --- absentee drop box ------------------------------------------------
    // Returning an absentee ballot is the one trip here made entirely at a
    // time of your own choosing, which makes it the one where a record of the
    // journey is least excusable. It gets the same camera-aware routing as a
    // trip to the polls.
    var box = destinations(r).filter(function (o) { return o.kind === 'dropbox'; })[0];
    if (box) {
      boxHtml += '<div class="vi-where vi-dropbox' + customClass('dropbox') +
        '" data-kind="dropbox">' +
        '<div class="vi-lbl">' +
        esc(placeLabel('dropbox', box.place.office
                                    ? 'Where to return an absentee ballot'
                                    : 'Ballot drop box nearest to you')) + '</div>' +
        '<div class="pp-name">' + esc(boxLabel(box.place)) + '</div>' +
        '<div class="pp-addr">' + esc(addressForDisplay(box.place.address)) +
        (box.place.note
          ? '<br>Location: ' + esc(sentenceCase(box.place.note)) : '') +
        (box.place.office
          ? '<br><strong class="bx-hours-odd">Office hours' +
            (box.place.phone ? ' \u00b7 ' + esc(box.place.phone) : '') + '</strong>'
          : box.place.hours
          ? (ALWAYS_OPEN.test(box.place.hours)
              ? '<br>Open 24/7'
              : '<br><strong class="bx-hours-odd">Open hours: ' +
                esc(box.place.hours) + '</strong>')
          : '') +
        '</div>' +
        // One office is not a list to show all of.
        (box.place.office ? '' :
          '<button type="button" class="box-open" id="boxListBtn">' +
          'Show all drop box locations</button>');
      boxHtml += '</div>';

      boxHtml += whenCell('dropbox', absenteeState(), '');
    }

    // --- early voting -----------------------------------------------------
    var evState = earlyVotingForBlock();
    if (evState) {
      // ev can come back empty with a window published, because destinations()
      // also wants sites with coordinates and an origin to measure from: the
      // honest thing then is to give the dates and name nothing, rather than
      // blame the calendar for a gap of our own. destinations() already ranks
      // by distance from this origin, so the nearest is read back from it.
      var ev = evState.site
        ? destinations(r).filter(function (o) { return o.kind === 'early'; })[0]
        : null;
      // Always a two-column row, whether or not a site is named. With no
      // site this cell used to span both columns and push the dates onto a
      // line of their own, so "upcoming" read as a different shape from
      // "open"; a row that says "No site published yet" beside its dates is
      // the same row with one fact missing, and should look like it.
      evHtml += '<div class="vi-where vi-ev-site' + (ev ? customClass('early') : '') + '"' +
        (ev ? ' data-kind="early"' : '') + '>' +
        '<div class="vi-lbl">' +
        esc(placeLabel('early', 'Early voting site nearest to you')) + '</div>' +
        (ev
          ? '<div class="pp-name">' + esc(displayCase(ev.place.name)) + '</div>' +
            '<div class="pp-addr">' + esc(addressForDisplay(ev.place.address)) +
            (ev.place.entrance_note
              ? '<br>Location: ' + esc(sentenceCase(ev.place.entrance_note)) : '') +
            '</div>' +
            (ev.all.length > 1
              ? '<div class="pp-note">Early voting is not tied to your ' +
                'precinct. Any Grand Rapids voter may use any of these ' +
                ev.all.length + ' sites.</div>' +
                '<button type="button" class="box-open" id="evListBtn">' +
                'Show all my early voting site options</button>'
              : '')
          : '<div class="pp-addr">No site published yet.</div>') +
        '</div>';
      evHtml += whenCell('early', { label: evState.label, status: evState.status,
                                    live: true },
                         ev ? evHoursHtml(activeEl) : '');
    }

    // --- election day -----------------------------------------------------
    pollHtml += '<div class="vi-where' + (activeEl ? '' : ' vi-full') +
      '" data-kind="polling"><div class="vi-lbl">Election day polling place</div>';
    if (place) {
      // The name and address ARE the show-on-map control: clicking the place
      // takes you to the place. A separate link said in four words what the
      // affordance can say in zero.
      var clickable = !!(place.lat && place.lng);
      pollHtml += '<div' + (clickable
          ? ' class="pp-place" id="showPlaceBtn" role="button" tabindex="0"' +
            ' title="Show it on the map"'
          : '') + '>' +
        '<div class="pp-name">' + esc(displayCase(place.name)) + '</div>' +
        '<div class="pp-addr">' + esc(addressForDisplay(place.address)) +
        (place.entrance_note
          ? '<br>Location: ' + esc(sentenceCase(place.entrance_note)) : '') + '</div>' +
        '</div>';
      if (place.consolidated_with) {
        pollHtml += '<div class="pp-note">Precinct ' + esc(r.precinct) + ' votes with precinct ' +
          esc(place.consolidated_with) + ' this election' +
          (place.note ? ', because ' + esc(place.note).toLowerCase() : '') + '.</div>';
      }
    } else {
      pollHtml += '<div class="err">No polling place on file for precinct ' + esc(r.precinct) + '.</div>';
    }
    pollHtml += '</div>';

    if (activeEl) {
      pollHtml += whenCell('polling',
        { label: 'Election day', status: Elections.withWeekday(activeEl.date) },
        electionDayHours && electionDayHours.open && electionDayHours.close
          ? '<div class="vi-hours"><span class="vi-hours-lbl">Hours:</span> ' +
            esc(Elections.shortTime(electionDayHours.open)) + ' to ' +
            esc(Elections.shortTime(electionDayHours.close)) + '</div>'
          : '');
    }

    // Normally the order is the order a voter can act: the box is open first
    // and for longest, then early voting, then the deadline. On the day of the
    // election that argument inverts -- the deadline is now, and the polling
    // place is the only one of the three that is not either shut or a race
    // against the same clock -- so it moves to the top.
    html += isElectionDay() ? pollHtml + boxHtml + evHtml
                            : boxHtml + evHtml + pollHtml;

    html += '</div></div>';
    $('precinctInfo').innerHTML = html;
    // The two place cells ARE the destination toggle while both exist. Which
    // address the directions are for was previously legible only from the
    // segmented control below the map, so the block showed two addresses and
    // gave no clue which one it was routing to.
    //
    // Only when there is something to choose between. With a single
    // destination there is nothing to toggle, and the polling place keeps its
    // older job of framing itself on the map.
    wirePlaceLists(r);

    var destCells = $('precinctInfo').querySelectorAll('[data-kind]');
    var multi = destinations(r).length > 1;
    Array.prototype.forEach.call(destCells, function (cell) {
      var kind = cell.dataset.kind;
      if (!multi) return;
      cell.classList.add('vi-dest');
      cell.setAttribute('role', 'button');
      cell.setAttribute('tabindex', '0');
      cell.setAttribute('aria-pressed', 'false');
      cell.title = 'Get directions here instead';
      cell.onclick = function () { if (current) routeTo(current, kind); };
      cell.onkeydown = function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cell.click(); }
      };
    });

    var spb = $('showPlaceBtn');
    if (spb && !multi) {
      spb.onkeydown = function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); spb.click(); }
      };
      spb.onclick = function () {
        if (!place || !place.lat) return;
        revealMap();
        map.setView([place.lat, place.lng], 16);
        $('mapBlock').scrollIntoView({ block: 'center', behavior: 'smooth' });
        // Pulse the polling marker so the eye lands on the right dot rather
        // than just the right neighborhood.
        pollLayer.eachLayer(function (m) {
          var ll = m.getLatLng();
          if (Math.abs(ll.lat - place.lat) < 1e-6 && Math.abs(ll.lng - place.lng) < 1e-6) {
            var el = m.getElement();
            if (el) {
              el.classList.remove('pulse');
              void el.offsetWidth;   // restart the animation on repeat clicks
              el.classList.add('pulse');
            }
          }
        });
      };
    }

    // The caveat that applies to every answer this page gives, so it leads and
    // it is unconditional: the route starts from what you handed the tool, and
    // the ballot follows your registration. Those are the same address for most
    // people and not for anyone who has moved, which is exactly who cannot
    // afford to find out on election day. The notes below it are the
    // exceptions, and they stay conditional.
    //
    // This is the page's only disclaimer. A second one used to sit in a box
    // under the tool, shown on exactly the same condition as this note and
    // saying the same thing about registration and who to ask, so a reader
    // with an answer read the caveat twice. The box is gone; the two claims
    // that were only ever made there, what the tool is not and the reminder
    // that a route is not permission to ignore a sign, lead and close this
    // note instead.
    // Whose clerk to double-check with is the jurisdiction's own. The city
    // has a page to link; a township has the phone number the county
    // publishes for its clerk, which is the same thing said the way a
    // township says it.
    var office = !inGrandRapids(r) && P && r.mcd ? P.clerkOf(r.mcd) : null;
    var whom = inGrandRapids(r) || !r.jurisdiction
      ? '<a href="https://www.grandrapidsmi.gov/departments/clerks-office/" ' +
        'target="_blank" rel="noopener">Grand Rapids City Clerk</a>'
      : 'the ' + esc(r.jurisdiction) + ' clerk' +
        (office && office.phone ? ' (' + esc(office.phone) + ')' : '');
    var adv = ['<strong>Not an official government tool.</strong> Your voting ' +
      'location is based on the address where you registered to vote, not ' +
      'what you enter here. If you are not sure the entered address is the ' +
      'same, double-check with ' + (inGrandRapids(r) || !r.jurisdiction ? 'the ' : '') +
      whom + ' or the ' +
      '<a href="https://mvic.sos.state.mi.us/" target="_blank" ' +
      'rel="noopener">Michigan Voter Information Center</a>.'];
    if (r.rivals) adv.push('This address sits on a precinct line and could be in ' +
      r.rivals.join(' or ') + '.');
    else if (r.inferred) adv.push('This exact number is not in ' +
      'the address list, so the precinct was taken from its neighbors and ' +
      'checked against the precinct boundary.');
    if (r.edgeMetres !== Infinity && r.edgeMetres < 30) adv.push('This address is close ' +
      'to a precinct boundary, so the answer is less certain.');
    if (r.ambiguousStreet) adv.push('Read as ' + esc(displayCase(r.street)) +
      '. Other streets also match what you typed.');
    // Last, because it is about the drive rather than the answer, and the
    // drive is what the reader goes to next.
    adv.push('Obey all traffic signs and laws.');
    $('advisory').innerHTML = '<div class="advisory">' + adv.join(' ') + '</div>';

    routeTo(r, focusKind);
    // After routeTo, because the blocks it fills are hidden until then and a
    // hidden element has no offset to scroll to.
    scrollToResult('resultBlock');
  }

  // ---- election + destination -----------------------------------------
  //
  // Where you should drive depends on the calendar. During an early voting
  // window any registered city voter may use ANY early voting site, so the
  // destination is the nearest one. Outside that window it is your own
  // precinct's polling place, which is the only place you may vote on
  // election day.

  // The calendar arithmetic -- today, the next election, the state of the
  // early voting window, and the date and time formats -- lives in
  // elections.js, which /simple reads too so the two pages cannot disagree
  // about what day it is. What stays here is only the wording, which the two
  // surfaces deliberately do differently.

  // Days left, times right, with today's row picked out: where to go is the
  // answer, when it is open is the detail that follows it. Same shape the
  // /simple page renders, so hours read alike on both surfaces.
  function evHoursHtml(e) {
    var rules = (e && e.early_voting_hours) || [];
    if (!rules.length) return '';
    var today = Elections.todayAbbr();
    var out = '<div class="vi-hours-lbl ev-hours-lbl">Hours:</div>' +
              '<div class="ev-hours">';
    for (var i = 0; i < rules.length; i++) {
      var days = rules[i].days || [];
      var mark = days.indexOf(today) !== -1 ? ' class="is-today"' : '';
      out += '<span' + mark + '>' + esc(days.join(', ')) +
             (mark ? ' (today)' : '') + '</span>' +
             '<span' + mark + '>' + esc(Elections.shortTime(rules[i].open)) + ' to ' +
             esc(Elections.shortTime(rules[i].close)) + '</span>';
    }
    return out + '</div>';
  }

  // Two date formats, on purpose. The footer bar renders its dates in a
  // compact uppercase strip where a weekday would not fit at 320px, so it
  // takes Elections.monthDay; everywhere a voter has to act on a date, the
  // weekday leads and Elections.withWeekday is the one to call.

  // Two lines in the header: election day, then early voting under it.
  //
  // The early voting sentence used to open the page as a paragraph above the
  // headline, which meant the first thing anyone read was a caveat about a
  // thing that had not been scheduled yet. As a labelled line in the chrome it
  // is available at a glance and in the way of nothing.
  //
  // One line per state of Elections.windowState, so the hole this used to
  // have cannot come back: every state that was not before the window or
  // inside it once fell through to 'Start date TBD', including the days after
  // early voting closes and election day itself. Those are the days most
  // people read this line, and it was telling them the start date had not
  // been decided when the window had already been and gone.
  //
  // 'Start date TBD' now means only what it says: the clerk has published
  // nothing. A half-published window counts as nothing, since a start with no
  // end is not a window a voter can act on -- that is windowState's 'none'.
  //
  // 'open' is deliberately the dates alone rather than Elections.isOpen(),
  // which also wants a site list: with a window published and no sites the
  // window is still open and it is our data that is short, and saying nothing
  // about the dates would blame the calendar for a gap of our own.
  // The clerk's published dates when we have them, the calendar's otherwise.
  // ONE accessor, because the answer block, the footer bar and the
  // destination list each ask this question and a page that disagrees with
  // itself about whether early voting is open is worse than one that says
  // nothing.
  function evWindow() {
    if (clerkForThisElection()) {
      return { early_voting_from: clerk.early_voting.from,
               early_voting_to: clerk.early_voting.to,
               early_voting_sites: clerk.sites };
    }
    return activeEl;
  }

  // The clerk's file is only about the election it names. gr-clerk.json says
  // which one -- "election": "2026-11-03" -- and that has to be checked
  // rather than assumed, because the page reads it beside a calendar that
  // moves on its own. A file describing a finished election, or a calendar
  // that has rolled to the next one, must not silently supply dates for an
  // election it was never about. That is the same failure the county's early
  // voting page has right now, in reverse.
  function clerkForThisElection() {
    return !!(clerk && clerk.early_voting && activeEl &&
              clerk.election === activeEl.date);
  }

  function earlyVotingStatus() {
    var to = evWindow().early_voting_to;
    switch (Elections.windowState(evWindow())) {
      case 'none':   return 'Start date TBD';
      case 'closed': return 'Ended ' + Elections.monthDay(to);
      case 'before': return Elections.monthDay(activeEl.early_voting_from) +
                            ' to ' + Elections.monthDay(to);
      default:       return 'Open through ' + Elections.monthDay(to);
    }
  }

  // What the BLOCK says about early voting, which is deliberately not what
  // the footer bar says. The bar labels its row "Early voting" and lets the
  // status carry the state; the block puts the state in the label, in the
  // accent, where it is the first thing read. So the status here drops the
  // state word rather than saying it twice, and the two callers stay
  // independent instead of one wording being wrong for the other surface.
  //
  // The state that matters most is 'closed': after the window ends but before
  // election day, a reader who saw a site listed last week has to be told it
  // is no longer an option, or they drive to a locked door. activeEl is
  // always the NEXT election, so if it exists at all then election day has
  // not passed, and 'closed' means exactly "over, with the election ahead".
  //
  // 'none' returns null rather than a row: a half-published window is not a
  // window a voter can act on, so the block says nothing rather than describe
  // a date range that does not exist yet.
  function earlyVotingForBlock() {
    if (!activeEl) return null;
    var window = evWindow();
    var to = window.early_voting_to;
    switch (Elections.windowState(window)) {
      case 'none':
        return null;
      case 'closed':
        return { label: 'Early voting closed',
                 status: 'Ended ' + Elections.dayMonth(to), site: false };
      case 'before':
        // Name the site before the window opens, but only when the CLERK has
        // published it for this election. The old rule withheld it until the
        // window was open, which made sense when the calendar carried sites
        // with no dates and a site named early might not have been settled.
        // With gr-clerk.json checked against the election it names, an
        // upcoming site is a published, dated fact, and a voter planning
        // around it is better served knowing where than being told to come
        // back in October.
        return { label: 'Early voting upcoming',
                 status: Elections.dayMonth(window.early_voting_from) +
                         ' to ' + Elections.dayMonth(to),
                 site: inGrandRapids(current) && clerkForThisElection() };
      default:
        return { label: 'Early voting open',
                 status: 'Through ' + Elections.dayMonth(to),
                 site: inGrandRapids(current) };
    }
  }

  // ---- election day countdown -----------------------------------------
  //
  // The clock counts to local midnight at the start of election day, because
  // that is what "election day is in" means: the day arrives, not the polls
  // open. The statutory hours are on the page now, in the answer's Election
  // day row, so counting to 7 AM was available and still wrong for this
  // label; a countdown to the opening bell would have to say so.
  //
  // Every tick recomputes from the current instant rather than decrementing a
  // stored figure, so a throttled background tab, a sleeping laptop or a clock
  // correction all come back right instead of drifting.
  //
  // The day figure is elapsed time, not a calendar subtraction. Michigan turns
  // its clocks back on the Sunday before a November election, so a countdown
  // that crosses that Sunday carries one extra real hour: at midnight the clock
  // reads "58 days, 1 hour" where a calendar count would say 58 days flat. That
  // is the true remaining time, and the seconds field has to be real time to
  // tick at all, so the hour is kept rather than rounded away.
  var cdTimer = null;

  function startCountdown() {
    if (cdTimer) { clearInterval(cdTimer); cdTimer = null; }
    renderCountdown();
    // Only worth a heartbeat while there is something ticking; with no election
    // on the calendar the section is hidden and stays hidden.
    if (activeEl) cdTimer = setInterval(renderCountdown, 1000);
  }

  // The election named, then the day it falls on. A colon rather than a comma
  // because these are a label and its value and not a list: "General Election,
  // Tuesday, November 3" reads as three items of equal rank, which buries the
  // one figure a reader came for.
  function noteLine() {
    return '<span class="cd-for">' + esc(activeEl.name) + ':</span> ' +
      '<span class="cd-when">' + esc(Elections.withWeekday(activeEl.date)) + '</span>';
  }

  function renderCountdown() {
    var box = $('countdown'), clock = $('cdClock'), note = $('cdNote'),
        said = $('cdSaid'), label = $('cdLabel');
    if (!box || !clock) return;

    // The day can roll over under a page left open. Re-asking the calendar is
    // cheaper than being wrong about which election is next, and the footer is
    // redrawn with it so the two readings of the calendar cannot disagree.
    if (activeEl && activeEl.date < Elections.todayISO()) {
      activeEl = Elections.next(electionList);
      clerk = placeCoords(clerkData);
      renderElectionBanner();
    }

    if (!activeEl) {
      box.hidden = true;
      if (cdTimer) { clearInterval(cdTimer); cdTimer = null; }
      return;
    }

    var target = Elections.dayStart(activeEl.date);
    if (!target) { box.hidden = true; return; }
    var left = target.getTime() - Date.now();

    if (left <= 0) {
      // Election day itself. The clock has nothing left to count, and saying
      // "0 days 0 hours" on the one day it matters would read as an error.
      // "Election day is in: today" is not a sentence anyone says, so the label
      // gives up its preposition for the one day it does not need it.
      box.classList.add('is-today');
      if (label) label.textContent = 'Election Day:';
      clock.innerHTML = '<span class="cd-today">Today</span>';
      if (note) note.innerHTML = noteLine();
      if (said) said.textContent = 'The ' + activeEl.name + ' is today, ' +
        Elections.withWeekday(activeEl.date) + '.';
      box.hidden = false;
      return;
    }

    box.classList.remove('is-today');
    if (label) label.textContent = 'Election Day is In:';
    var s = Math.floor(left / 1000);
    var days = Math.floor(s / 86400); s -= days * 86400;
    var hrs = Math.floor(s / 3600); s -= hrs * 3600;
    var mins = Math.floor(s / 60); s -= mins * 60;

    // Days unpadded because it is the figure being read; the rest padded so the
    // row keeps its width and nothing shifts as the seconds run.
    var unit = function (n, name, pad) {
      return '<span class="cd-unit"><b class="cd-num">' +
        (pad ? String(n).padStart(2, '0') : String(n)) +
        '</b><span class="cd-lab">' + name + '</span></span>';
    };
    clock.innerHTML =
      unit(days, 'Days', false) + unit(hrs, 'Hours', true) +
      unit(mins, 'Minutes', true) + unit(s, 'Seconds', true);

    if (note) note.innerHTML = noteLine();
    if (said) said.textContent = days + (days === 1 ? ' day' : ' days') +
      ' until the ' + activeEl.name + ' on ' + Elections.withWeekday(activeEl.date) + '.';
    box.hidden = false;
  }

  function renderElectionBanner() {
    var bar = $('electionFoot'), barInfo = $('electionBarInfo');
    if (!barInfo) return;
    if (!activeEl) {
      barInfo.innerHTML = '';
      if (bar) bar.hidden = true;
      return;
    }
    // Emitted as four grid cells rather than two wrapped rows, so the labels
    // share a column and the values share a column and the two lines line up
    // instead of each centring on its own width.
    var cell = function (cls, text) {
      return '<span class="' + cls + '">' + esc(text) + '</span>';
    };
    barInfo.innerHTML =
      cell('elec-name', activeEl.name) +
      cell('elec-date', Elections.monthDay(activeEl.date)) +
      cell('elec-name', 'Early voting') +
      cell('elec-date', earlyVotingStatus());
    if (bar) bar.hidden = false;
  }

  // Which destinations are available for this voter right now.
  // The clerk publishes addresses, not coordinates, so each one is geocoded
  // here against the same street graph the route is drawn on. Deliberately
  // not stored in the data file: a coordinate written down at build time can
  // drift from the streets it is supposed to sit on, and this cannot.
  //
  // The addresses arrive the way a person writes them -- "1430 Quarry, NW",
  // "2350 Eastern Avenue SE" -- with the street type sometimes spelled out
  // and sometimes missing. canonStreet already reduces both to the same key,
  // so all fourteen resolve with no special handling. Alleys share a name
  // with the street they run behind ("FULLER ALY NE"), and they collide in
  // that index, but an alley carries no address ranges so it is skipped on
  // its way past rather than needing a rule.
  function placeCoords(data) {
    if (!data || !graph) return null;
    function fix(place) {
      var m = /^(\d+)\s+(.+)$/.exec(place.address || '');
      var hit = m && graph.geocode(Number(m[1]), m[2]);
      return hit ? Object.assign({}, place, { lat: hit.lat, lng: hit.lng }) : null;
    }
    return {
      // Carried through so the panel can say where its list came from. The
      // file knows; without this the page did not.
      provenance: data.provenance || null,
      src: data.src || null,
      election: data.election,
      early_voting: data.early_voting || null,
      sites: (data.early_voting_sites || []).map(fix).filter(Boolean),
      // A box with no street address -- the City Hall lobby ones -- cannot be
      // routed to, so it is not offered as a destination. It is still real,
      // and the answer block names it.
      boxes: (data.drop_boxes || []).map(fix).filter(Boolean),
      unrouted: (data.drop_boxes || []).filter(function (b) { return !b.address; })
    };
  }

  // Sorted by how far away they are, with the distance carried along so the
  // list can show it. Straight-line, not driving: ranking eleven boxes by
  // road would mean eleven route searches to answer a question the reader is
  // only skimming, and over a few miles of city street the two orders barely
  // differ. The number is labelled as the crow flies so it is not read as a
  // trip length -- the actual drive appears the moment one is chosen.
  function nearest(origin, places) {
    if (!origin || !places || !places.length) return null;
    return places.map(function (p) {
      return Object.assign({}, p, {
        metres: ALPRRouter.haversine(origin.lat, origin.lng, p.lat, p.lng)
      });
    }).sort(function (a, b) { return a.metres - b.metres; });
  }

  // Three places a ballot can go, and every one of them is a drive worth
  // routing around the cameras: voting on the day, voting early, and posting
  // an absentee ballot. The last is the one with the strongest case for it --
  // dropping a ballot off is a discretionary errand, at a time of your
  // choosing, and there is no reason a record of it should exist.
  function resetChoices() { chosen = { dropbox: 0, early: 0 }; }

  var ARRIVED_M = 150;

  // The drop boxes that apply to this result. Grand Rapids: the city clerk's
  // file, the source of record. Anywhere else: the county's page for that
  // jurisdiction, geocoded at build time; only the ones that were placed can
  // be offered as somewhere to drive.
  function boxesFor(r) {
    if (!r) return [];
    if (inGrandRapids(r)) return (clerk && clerk.boxes) || [];
    var boxes = (P ? P.dropBoxes(r.mcd) : []).filter(function (b) {
      return b.lat && b.lng;
    }).map(normaliseHours);
    if (boxes.length) return boxes;
    // No box published -- true of 24 of the 30 jurisdictions. The ballot
    // still has to go somewhere, and the law says where: the voter's own
    // clerk. So the clerk's office is offered as the place to return it,
    // marked as an office so nothing downstream calls it a box, gives it
    // hours it does not keep, or says it is watched.
    var office = P ? P.clerkOf(r.mcd) : null;
    if (!office || !office.lat || !office.lng) return [];
    return [{
      name: (r.jurisdiction || 'Your') + ' Clerk\u2019s Office',
      address: String(office.address || '').split(',')[0],
      phone: office.phone || null,
      lat: office.lat, lng: office.lng,
      hours: null, office: true
    }];
  }

  // The drop-off list is the clerk's office rather than any box.
  function officeOnly(list) {
    return !!(list && list.length && list[0].office);
  }

  // The county writes "24 hours a day, 7 days a week" where the city clerk
  // writes "24/7", and the page tells the two apart by the short form: an
  // hours string that is not "24/7" is shown in amber as an exception, and
  // counted in "N are not accessible 24/7". Left as written, every box in
  // Kentwood was an exception. The scrape stays the record of what the page
  // said; this is the reading of it.
  var ROUND_THE_CLOCK = /24\s*hours?\s*(a|per)\s*day.*7\s*days/i;
  function normaliseHours(b) {
    if (b.hours && ROUND_THE_CLOCK.test(b.hours)) {
      return Object.assign({}, b, { hours: '24/7', hours_as_written: b.hours });
    }
    return b;
  }

  // What the finish flag calls itself.
  function destSub(pick, r) {
    return pick.kind === 'early' ? 'Early voting site'
         : pick.kind === 'dropbox' ? 'Absentee ballot drop box'
         : 'Precinct ' + r.precinct;
  }

  function destinations(r) {
    var out = [];
    var origin = r.pin ? { lat: r.lat, lng: r.lng }
                       : graph.geocode(r.number, r.street);

    // The clerk's own sites when we have them, the calendar's otherwise --
    // and only for Grand Rapids. Both lists are the city's; offering them to
    // a Kentwood voter would send them to the wrong clerk's early voting
    // site, and the county's own list is for the August primary.
    var sites = !inGrandRapids(r) ? []
              : (clerkForThisElection() && clerk.sites.length) ? clerk.sites
              : Elections.sites(activeEl).filter(function (s) { return s.lat && s.lng; });
    var evState = Elections.windowState(evWindow());
    var ranked = nearest(origin, sites);
    if (ranked && evState !== 'closed') {
      out.push({ kind: 'early', label: 'Early voting',
                 place: ranked[chosen.early] || ranked[0],
                 all: ranked, state: evState });
    }

    if (r.place && r.place.lat) {
      out.push({ kind: 'polling', label: 'Election day', place: r.place });
    }

    var boxes = nearest(origin, boxesFor(r));
    if (boxes) {
      out.push({ kind: 'dropbox', label: 'Drop box',
                 place: boxes[chosen.dropbox] || boxes[0],
                 all: boxes });
    }

    // Early voting leads only while it is actually open; before it starts,
    // election day is still the answer to "where do I vote". And on the day
    // itself the polls lead outright, whatever a published early voting window
    // still says -- that is where a voter has to be by 8pm, and it is what the
    // directions should already be pointed at when the answer appears.
    if (out.length > 1 && (evState !== 'open' || isElectionDay())) {
      out.sort(function (a, b) {
        var rank = { polling: 0, early: 1, dropbox: 2 };
        return rank[a.kind] - rank[b.kind];
      });
    }
    return out;
  }

  // ---- routing + drawing ----------------------------------------------

  function routeTo(r, forcedKind, which) {
    var opts = destinations(r);
    routeLayer.clearLayers(); pinLayer.clearLayers();

    if (!opts.length) {
      $('routeBlock').hidden = true;
      return;
    }
    var pick = null;
    if (forcedKind) pick = opts.filter(function (o) { return o.kind === forcedKind; })[0];
    if (!pick) pick = opts[0];
    // A kind can hold several places -- eleven drop boxes, four early voting
    // sites -- and the nearest is only the default. `which` names one of them.
    if (pick && which != null && pick.all && pick.all[which]) {
      pick = Object.assign({}, pick, { place: pick.all[which] });
    }
    destChoice = pick;
    markDestination();

    var origin = r.pin ? { lat: r.lat, lng: r.lng }
                       : graph.geocode(r.number, r.street);
    if (!origin) {
      $('routeBlock').hidden = false;
      $('routes').innerHTML = '<div class="err">Found where you vote, but could not ' +
        'place your address on the street map, so no route is drawn.</div>';
      $('steps').innerHTML = ''; $('unavoid').innerHTML = '';
      return;
    }
    var place = pick.place;

    // 300 Monroe NW routed to the drop box at 300 Monroe NW and produced a
    // quarter-mile walk, because both ends snap to the nearest road node and
    // the router dutifully drove between them. Nobody needs directions to the
    // building they are standing in, and giving them makes the whole page look
    // like it is not paying attention. So the panel says so instead.
    //
    // 150m is the block: far enough to cover an address geocoded to the middle
    // of a long parcel, close enough that "already here" is not a lie.
    if (ALPRRouter.haversine(origin.lat, origin.lng, place.lat, place.lng) <= ARRIVED_M) {
      // Still a `routes` object, so the destination picker stays live: being
      // at the drop box is a good moment to ask for the polling place.
      routes = { here: true, opts: opts, origin: origin, place: place,
                 destSub: destSub(pick, r) };
      renderAll(true);
      return;
    }

    // Split both ends into the graph so a route starts at the address and
    // finishes at the door, rather than at whichever intersection happened to
    // be nearest. Both splits are released in the finally block, leaving the
    // graph exactly as it was found, so the drawable geometry and the step
    // list have to be materialized BEFORE that happens: afterwards the
    // temporary edges they refer to no longer exist.
    var oSplit = graph.splitAt(origin.lat, origin.lng);
    var dSplit = graph.splitAt(place.lat, place.lng);
    var originNode = oSplit ? oSplit.node : graph.snapToRoad(origin.lat, origin.lng).node;
    var destNode = dSplit ? dSplit.node : graph.snapToRoad(place.lat, place.lng).node;

    var fast, avoid;
    try {
      var saved = graph._edgeCams;
      graph._edgeCams = null;
      fast = graph.route(originNode, destNode);
      graph._edgeCams = saved;
      avoid = graph.route(originNode, destNode);
      if (fast) { fast.pts = routePoints(fast); fast.steps = graph.steps(fast); }
      if (avoid) {
        avoid.pts = routePoints(avoid);
        avoid.steps = graph.steps(avoid);
        avoid.camsOnRoute = camsOn(avoid.edges);
      }
      if (fast) fast.camsOnRoute = camsOn(fast.edges);
    } finally {
      if (dSplit) dSplit.release();
      if (oSplit) oSplit.release();
    }

    if (!fast || !avoid) {
      $('routeBlock').hidden = false;
      $('routes').innerHTML = '<div class="err">No drivable route between your address ' +
        'and ' + esc(place.name) + ' on this road network.</div>';
      $('steps').innerHTML = ''; $('unavoid').innerHTML = '';
      map.fitBounds(L.latLngBounds([[origin.lat, origin.lng], [place.lat, place.lng]]).pad(.35), fitOpts());
      return;
    }

    // When the quickest way already passes nothing, the avoiding route is the
    // same road. Showing it twice implies a choice that does not exist, so the
    // two collapse into one.
    var fastExp = Object.keys(fast.camsOnRoute).length;
    var identical = RoutePanel.sameRoute(fast, avoid, fastExp, avoid.cameraCount);

    // A route through cameras earns its place on the page by being faster.
    // When it is not (by the same threshold the cost line uses), offering it
    // would present surveillance exposure as one half of a trade that has no
    // other half, so it collapses into the single-route display.
    var fastDropped = false;
    if (!identical && fastExp > avoid.cameraCount && RoutePanel.noRealSaving(fast, avoid)) {
      identical = true;
      fastDropped = true;
    }

    routes = {
      fast: fast, avoid: avoid, identical: identical, fastDropped: fastDropped,
      fastExp: fastExp,
      avoidExp: avoid.cameraCount,
      flagged: fast.camsOnRoute,
      opts: opts, origin: origin, place: place,
      destSub: destSub(pick, r)
    };
    if (identical) selected = 'avoid';
    // Default to the clean route, but do not fight a choice already made.
    if (selected !== 'fast' && selected !== 'avoid') selected = 'avoid';
    renderAll(true);
  }

  function renderAll(fit) {
    if (!routes) return;

    // Visible FIRST, then measured, then drawn. The map lives inside this
    // section now, and the section starts hidden, so a map measured before the
    // reveal reports zero and paints an empty canvas. Leaflet does redraw on
    // resize, but only if the container has a size to resize to.
    $('routeBlock').hidden = false;
    $('routeBlock').classList.remove('map-only');
    // Unconditional: the map does not only go hidden-to-visible here, it also
    // CHANGES WIDTH when map-only drops and the two-pane grid engages. A fit
    // computed against the stale width centres everything ~200px off, which
    // is exactly the constant offset that kept showing up in verification.
    map.invalidateSize(false);

    routeLayer.clearLayers();
    pinLayer.clearLayers();

    if (routes.here) {
      drawCameras({});
      renderDestPicker();
      $('routes').innerHTML =
        '<div class="here"><div class="here-h">You\u2019re already here</div>' +
        '<div class="here-b">' + esc(displayCase(routes.place.name || '')) +
        ' is at the address you searched, so there is nothing here to navigate. ' +
        'Pick another destination above for directions.</div></div>';
      $('steps').innerHTML = ''; $('unavoid').innerHTML = '';
      renderRouteKey();
      var hereM = marker([routes.place.lat, routes.place.lng], 'dest');
      var hp = routes.place;
      bindDetail(hereM,
        '<div class="destpop">' +
        '<div class="dt">You are here</div>' +
        '<div class="dn">' + esc(displayCase(hp.name)) + '</div>' +
        '<div class="da">' + esc(addressForDisplay(hp.address)) + '</div>' +
        (hp.entrance_note ? '<div class="de">' + esc(hp.entrance_note) + '</div>' : '') +
        '<div class="dw">' + esc(routes.destSub) + '</div>' +
        '</div>', 280);
      if (fit) map.setView([routes.place.lat, routes.place.lng], 17, { animate: false });
      return;
    }

    drawCameras(routes.flagged);

    if (!routes.identical) {
      var other = selected === 'avoid' ? 'fast' : 'avoid';
      drawRoute(routes[other], 'muted', other);
    }
    var main = drawRoute(routes[selected], selected === 'avoid' ? 'avoid' : 'fastmain', selected);
    renderRouteKey();

    // Start and finish are drawn here, not in routeTo, because the start
    // arrow points the way the SELECTED route leaves, and that changes when
    // the reader flips between fastest and avoiding. (The layer was cleared
    // at the top, alongside the route layer.)
    var rp = routes[selected].pts;
    var brg = (rp && rp.length > 1) ? ALPRRouter.bearing(rp[0], rp[1]) : 0;
    originArrow = marker([routes.origin.lat, routes.origin.lng], 'origin', brg);
    // The flag stands alone on the map; the detail is a click away. A
    // permanent card beside it covered the streets around the destination,
    // which is exactly where a reader is trying to look.
    var destM = marker([routes.place.lat, routes.place.lng], 'dest');
    var p = routes.place;
    bindDetail(destM,
      '<div class="destpop">' +
      '<div class="dt">Finish</div>' +
      '<div class="dn">' + esc(displayCase(p.name)) + '</div>' +
      '<div class="da">' + esc(addressForDisplay(p.address)) + '</div>' +
      (p.entrance_note ? '<div class="de">' + esc(p.entrance_note) + '</div>' : '') +
      '<div class="dw">' + esc(routes.destSub) + '</div>' +
      '</div>', 280);

    // With mid-block splitting the route normally begins at the address
    // itself, so these draw nothing. They stay for the fallback case where a
    // split was not possible and the route really does start at a nearby
    // junction: better to show that gap than to leave a line stopping short.
    // Read the ends off the route geometry, never off node ids -- the split
    // nodes are gone by now.
    var pts = routes[selected].pts;
    if (pts && pts.length) {
      connector([routes.origin.lat, routes.origin.lng], pts[0]);
      connector([routes.place.lat, routes.place.lng], pts[pts.length - 1]);
    }
    if (fit) {
      // Frame the whole ANSWER, not the selected line. Fitting only the
      // selected route centred the view on one line's bounding box and let
      // the alternative hang wherever it fell, so the corridor both routes
      // share, which is the part worth looking at, drifted off centre. The
      // union of both routes and both endpoints makes the scene's own
      // centroid the view centre, and the frame no longer changes meaning
      // when the toggle flips.
      var fitB = L.latLngBounds(routes[selected].pts);
      if (!routes.identical) {
        var otherKey = selected === 'avoid' ? 'fast' : 'avoid';
        fitB.extend(L.latLngBounds(routes[otherKey].pts));
      }
      fitB.extend([routes.origin.lat, routes.origin.lng]);
      fitB.extend([routes.place.lat, routes.place.lng]);
      // Centre on the MIDPOINT of start and finish, not on the scene's own
      // bounding-box centre: a route that bulges to one side dragged the box
      // centre with it and could leave the finish flag hugging the map edge.
      // Reflecting the scene bounds through the midpoint makes bounds that
      // are symmetric about it, so fitBounds lands the midpoint dead centre
      // while still guaranteeing the whole scene fits.
      var midLat = (routes.origin.lat + routes.place.lat) / 2;
      var midLng = (routes.origin.lng + routes.place.lng) / 2;
      var sw = fitB.getSouthWest(), ne = fitB.getNorthEast();
      fitB.extend([2 * midLat - sw.lat, 2 * midLng - sw.lng]);
      fitB.extend([2 * midLat - ne.lat, 2 * midLng - ne.lng]);
      map.fitBounds(fitB, fitOpts());
    }

    ownBase.setActivePrecinct(current && current.precinct);
    drawPollingPlaces(current && current.precinct);
    // Tell the basemap which streets this route uses so it names them first.
    ownBase.setRouteStreets(
      (routes[selected].steps || []).map(function (st) { return st.street; })
        .filter(Boolean),
      routes[selected].pts);

    renderDestPicker();
    renderRouteCards();
    renderSteps();
    renderUnavoidable();
  }

  // Mark the block cell whose address the directions are actually for. Driven
  // off destChoice rather than off the click, so the highlight follows what
  // the router picked even when the choice came from the segmented control,
  // from a re-route, or from the fallback to opts[0].
  function markDestination() {
    var box = $('precinctInfo');
    if (!box) return;
    var cells = box.querySelectorAll('[data-kind]');
    Array.prototype.forEach.call(cells, function (cell) {
      var on = !!(destChoice && cell.dataset.kind === destChoice.kind);
      cell.classList.toggle('is-dest', on && cell.classList.contains('vi-dest'));
      if (cell.hasAttribute('aria-pressed')) {
        cell.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    });
  }

  function renderDestPicker() {
    var el = $('destPick');
    if (!el) return;
    el.innerHTML = routes
      ? RoutePanel.destPickerHtml(routes.opts, destChoice && destChoice.kind) : '';
    Array.prototype.forEach.call(el.querySelectorAll('button'), function (b) {
      b.onclick = function () { if (current) routeTo(current, b.dataset.kind); };
    });
  }

  // The map is a fixed-height card with nothing overlapping it, so the whole
  // box is usable and the padding is just breathing room. It is tighter on a
  // phone, where the card is shorter and generous padding would zoom the
  // route out until the streets stopped being readable.
  function fitOpts() {
    var pad = isPhone() ? 24 : 38;
    // Top headroom covers the finish flag, which stands 32px above its
    // anchor; the bottom clears Leaflet's attribution strip.
    return { paddingTopLeft: [pad, Math.max(pad, 36)],
             paddingBottomRight: [pad, pad + 26] };
  }

  function camsOn(edges) {
    var s = {};
    edges.forEach(function (id) {
      var cc = graph._edgeCams && graph._edgeCams[id];
      if (cc) cc.forEach(function (x) { s[x] = 1; });
    });
    return s;
  }

  function routePoints(r) {
    var pts = [];
    r.edges.forEach(function (id, i) {
      var poly = graph.edgePoly(id);
      if (r.nodes[i] !== graph.edgeA(id)) poly.reverse();
      poly.forEach(function (p) { pts.push(p); });
    });
    return pts;
  }

  // Every route is drawn twice: a wide casing underneath, then the color on
  // top. That is what keeps a line readable over any ground.
  // `which` names WHICH route this is ('avoid' or 'fast'); `kind` is how
  // prominently to draw it. They are separate because the unselected route
  // still has an identity worth keeping.
  function drawRoute(r, kind, which) {
    var pts = r.pts || routePoints(r);
    var casing = getVar('--case');
    if (kind === 'muted') {
      // Solid, not dashed. Dashes are how this map draws precinct and city
      // boundaries, so a dashed route read as another border rather than as
      // the other way to go.
      //
      // It keeps its OWN colour rather than a shared grey. Drawing the
      // unselected line grey meant that whenever you were looking at the
      // fastest route, the camera-avoiding alternative faded into the
      // basemap AND wore the fastest route's colour, so the one comparison
      // this page exists to let you make was the hardest thing on the map to
      // see. Selection is carried by weight and by the moving highlight
      // instead, which is a difference in emphasis rather than in meaning.
      var tone = which === 'avoid' ? getVar('--route-avoid') : getVar('--route-fastsel');
      L.polyline(pts, { color: casing, weight: 9.5, opacity: .55,
        lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer);
      var mline = L.polyline(pts, { color: tone, weight: 5.5, opacity: .95,
        lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer);
      // The camera route wears its stripes even when unselected, so the two
      // lines never need the toggle to be told apart.
      if (which !== 'avoid') {
        L.polyline(pts, { color: '#ffffff', weight: 5.5, opacity: .55,
          lineCap: 'butt', dashArray: '6 10', interactive: false }).addTo(routeLayer);
      }
      return mline;
    }
    var color = kind === 'avoid' ? getVar('--route-avoid') : getVar('--route-fastsel');
    L.polyline(pts, { color: casing, weight: 13, opacity: .75,
      lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer);
    var line = L.polyline(pts, { color: color, weight: 7.5, opacity: 1,
      lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer);
    if (kind === 'avoid') {
      // The clean route keeps the subtle animated flow.
      L.polyline(pts, { color: '#ffffff', weight: 7.5, opacity: .3, lineCap: 'butt',
        dashArray: '3 25', className: 'route-flow', interactive: false }).addTo(routeLayer);
    } else {
      // The traversing route reads as a hazard: white stripes over a red
      // DARKER and duller than the camera markers, so the bright coral dots
      // stay the loudest red on the map and are never hard to pick out
      // against the line that runs beneath them.
      L.polyline(pts, { color: '#ffffff', weight: 7.5, opacity: .75, lineCap: 'butt',
        dashArray: '7 11', interactive: false }).addTo(routeLayer);
    }
    return line;
  }

  // A key BELOW the map, not inside it.
  //
  // Tags on the routes themselves could land on a camera or a polling place.
  // Moving them to a corner control fixed that on a desktop but not on a
  // phone, where the map is small and dense: measured, four markers still sat
  // under the corner box. Any control inside the map will eventually cover
  // something. Outside it, the overlap is not reduced, it is impossible.
  function renderRouteKey() {
    var k = $('routeKey');
    if (!k) return;
    if (!routes || routes.here || routes.identical) { k.hidden = true; k.innerHTML = ''; return; }
    var row = function (kind, label) {
      return '<span class="rk-row' + (selected === kind ? ' on' : '') + '">' +
        '<i class="rk-sw ' + kind + '"></i>' + label + '</span>';
    };
    k.innerHTML = row('avoid', 'Avoiding') + row('fast', 'Fastest');
    k.hidden = false;
  }

  function connector(from, to) {
    if (!from || !to) return;
    if (ALPRRouter.haversine(from[0], from[1], to[0], to[1]) < 12) return;
    L.polyline([from, [to[0], to[1]]], {
      color: getVar('--dim'), weight: 2.5, opacity: .8, dashArray: '2 6',
      lineCap: 'round', interactive: false
    }).addTo(routeLayer);
  }

  // The start arrow or the finish flag. Both are 34px; only the anchor
  // differs, since the flag stands on its pole rather than being centred.
  function marker(latlng, kind, bearingDeg) {
    var ring = getVar('--pin-ring');
    var html, anchor;
    if (kind === 'origin') {
      // A compass arrow rotated to the first leg's bearing: the start of the
      // route says which way you set off, not just where you stand.
      anchor = [17, 17];
      html = '<div style="width:34px;height:34px;border-radius:50%;background:' +
        getVar('--accent') + ';border:3px solid ' + ring +
        ';box-shadow:0 1px 8px rgba(0,0,0,.5);display:flex;align-items:center;' +
        'justify-content:center;transform:rotate(' + (bearingDeg || 0) + 'deg)">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="#fff">' +
        '<path d="M12 3l6 15-6-4-6 4z"/></svg></div>';
    } else {
      // A finish flag, because "finish" is what the end of a route is called.
      anchor = [6, 32];
      html = '<div style="width:34px;height:34px;position:relative">' +
        '<div style="position:absolute;left:4px;top:0;width:3px;height:32px;' +
        'border-radius:2px;background:' + ring + ';box-shadow:0 1px 5px rgba(0,0,0,.45)"></div>' +
        '<svg style="position:absolute;left:7px;top:1px" width="22" height="15" viewBox="0 0 22 15">' +
        '<rect width="22" height="15" rx="2" fill="' + getVar('--warn') + '"/>' +
        '<g fill="rgba(20,16,6,.82)"><rect x="0" y="0" width="5.5" height="5"/>' +
        '<rect x="11" y="0" width="5.5" height="5"/><rect x="5.5" y="5" width="5.5" height="5"/>' +
        '<rect x="16.5" y="5" width="5.5" height="5"/><rect x="0" y="10" width="5.5" height="5"/>' +
        '<rect x="11" y="10" width="5.5" height="5"/></g></svg></div>';
    }
    var m = L.marker(latlng, {
      icon: L.divIcon({ className: '', html: html, iconSize: [34, 34],
        iconAnchor: anchor }),
      zIndexOffset: 1000
    }).addTo(pinLayer);
    // The finish gets its detail bound by the caller; the start keeps a
    // hover tooltip so the arrow stays uncluttered.
    if (kind === 'origin') {
      m.bindTooltip('Start', { direction: 'top', offset: [0, -10] });
    }
    return m;
  }

  function renderRouteCards() {
    $('routes').innerHTML = RoutePanel.cardsHtml(routes, selected);
    Array.prototype.forEach.call($('routes').querySelectorAll('button[data-key]'), function (b) {
      b.onclick = function () { selected = b.dataset.key; renderAll(false); };
    });
  }

  function renderSteps() {
    var r = routes[selected];
    var steps = r.steps || graph.steps(r);
    $('steps').innerHTML = RoutePanel.stepsHtml(steps);

    // A step is also a viewport: clicking it frames that stretch of the
    // route. maxZoom keeps a 40-foot leg from being blown up to rooftop
    // level, and on a phone, where the map sits above the list, the map is
    // scrolled back into view so the zoom is not happening off screen.
    Array.prototype.forEach.call($('steps').querySelectorAll('li'), function (li) {
      li.addEventListener('click', function () {
        var st = steps[Number(li.dataset.i)];
        if (!st || !st.points || !st.points.length) return;
        var cur = $('steps').querySelector('li.cur');
        if (cur) cur.classList.remove('cur');
        li.classList.add('cur');
        var o = fitOpts(); o.maxZoom = 17;
        map.fitBounds(L.latLngBounds(st.points).pad(.25), o);
        // Walk the blue arrow to this manoeuvre, pointed the way the leg
        // leaves, so the list and the map agree about where "you" are.
        // Clicking the first step returns it to the true start.
        if (originArrow) {
          pinLayer.removeLayer(originArrow);
          var hb = st.points.length > 1
            ? ALPRRouter.bearing(st.points[0], st.points[1])
            : (function () {
                var rp2 = routes[selected].pts;
                return rp2 && rp2.length > 1
                  ? ALPRRouter.bearing(rp2[rp2.length - 2], rp2[rp2.length - 1]) : 0;
              })();
          originArrow = marker(st.points[0], 'origin', hb);
        }
        if (isPhone()) $('mapBlock').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    });
  }

  function renderUnavoidable() {
    var exp = selected === 'avoid' ? routes.avoidExp : routes.fastExp;
    if (selected !== 'avoid' || exp === 0) { $('unavoid').innerHTML = ''; return; }
    // Read street names off the step list, which was captured while the
    // temporary split edges still existed.
    var names = {};
    (routes.avoid.steps || []).forEach(function (st) {
      if (st.cameras && st.cameras.length) names[st.street || 'an unnamed road'] = 1;
    });
    $('unavoid').innerHTML = RoutePanel.unavoidableHtml(exp, Object.keys(names));
  }

  // ---- camera source ---------------------------------------------------
  //
  // One source: the cameras.json committed beside this page. A Cache/OSM
  // toggle used to sit in the gear panel and ask Overpass for readers mapped
  // since the file was built, behind a dialog naming who got contacted. It is
  // gone. Keeping it meant the page could not simply say it makes no outbound
  // requests, and a claim with an asterisk on it is worth less to a reader
  // than the handful of cameras the live pull occasionally added. Freshness is
  // the build's job now: scripts/refresh_cameras.py rewrites the file, and the
  // daily workflow runs it. reroute() went with the toggle; nothing swaps a
  // camera list under a drawn route any more.

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
