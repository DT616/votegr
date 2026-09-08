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
    if (!insideCity(lat, lng)) return 'Outside the city';
    var pr = precinctAt(lat, lng);
    return pr ? 'Ward ' + pr.ward + ' \u00b7 Precinct ' + pr.precinct : '';
  }

  // One builder for "what precinct is this", fed by both input worlds:
  // the desktop hover chip and the touch tap-for-detail card. Content, not
  // an event handler, so the two cannot describe the same spot differently.
  // Every polling place and early voting site in this data is in Grand
  // Rapids, so the five digits tell a reader nothing they did not already
  // know and cost a line of width on a phone. Stripped when drawing only.
  // The stored value keeps its ZIP: /simple builds "..., Grand Rapids, MI
  // 49504" from it to hand OpenStreetMap something it can geocode.
  // Eleven addresses do not belong under the one the row is about, and inline
  // they buried it. They open in a panel instead, where the list can be read
  // as a list and a choice made deliberately.
  //
  // It also has to live OUTSIDE the drop box cell. Nested inside it, a click
  // on a row bubbled to the cell's own handler, which re-routed to the
  // nearest box a heartbeat after routing to the chosen one -- so picking a
  // box appeared to redraw the map and change nothing.
  function wireBoxList(r) {
    var btn = $('boxListBtn'), wrap = $('boxModal'), body = $('boxModalBody');
    if (!btn || !wrap || !body) return;
    var box = destinations(r).filter(function (o) { return o.kind === 'dropbox'; })[0];
    if (!box) return;

    var html = '<ul class="box-list">';
    box.all.forEach(function (b, i) {
      html += '<li data-box="' + i + '" role="button" tabindex="0"' +
        ' title="Get directions here">' +
        '<span class="bx-name">' + esc(boxLabel(b)) + '</span>' +
        '<span class="bx-addr">' + esc(addressForDisplay(b.address)) + '</span>' +
        (b.note ? '<span class="bx-where">Location: ' +
                  esc(sentenceCase(b.note)) + '</span>' : '') +
        (b.hours ? '<span class="bx-where">Open ' + esc(b.hours) + '</span>' : '') +
        '</li>';
    });
    // The City Hall boxes are real and cannot be driven to as an address, so
    // they are listed and plainly not offered as a destination.
    ((clerk && clerk.unrouted) || []).forEach(function (b) {
      html += '<li class="bx-noroute"><span class="bx-name">' +
        esc(boxLabel(b)) + '</span><span class="bx-where">' +
        esc(sentenceCase(b.note || '')) + '</span>' +
        '<span class="bx-addr">Inside the building, so there is no address ' +
        'to route to.</span></li>';
    });
    body.innerHTML = html + '</ul>';

    function close() { wrap.hidden = true; }
    btn.onclick = function () {
      wrap.hidden = false;
      var x = wrap.querySelector('.modal-x');
      if (x) x.focus();
    };
    wrap.onclick = function (e) {
      if (e.target.closest('[data-close]')) { close(); return; }
      var li = e.target.closest('li[data-box]');
      if (li && current) { close(); routeTo(current, 'dropbox', Number(li.dataset.box)); }
    };
    body.onkeydown = function (e) {
      var li = e.target.closest && e.target.closest('li[data-box]');
      if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); li.click(); }
    };
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !wrap.hidden) close();
    });
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
                     Elections.monthDay(from) + '. Until then there is nothing '
                     + 'to drop off.' };
    }
    if (today > activeEl.date) {
      return { label: 'Absentee voting closed', status: range };
    }
    return { label: 'Absentee voting open', status: range, live: true,
             note: 'A returned ballot has to be in the clerk\'s hands by the '
                   + 'time the polls close on election day.' };
  }

  // "bike rack" -> "Bike rack", and "Across from Calder Plaza" left alone.
  // Only the first letter moves: the rest may hold names the clerk cased on
  // purpose ("Monroe and Calder Plaza levels").
  function sentenceCase(s) {
    s = String(s || '').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  function boxLabel(box) {
    return displayCase(box.name || box.address || 'Drop box');
  }

  function addressForDisplay(a) {
    return displayCase(String(a || '').replace(/,\s*\d{5}(-\d{4})?\s*$/, ''));
  }

  function precinctInfoHtml(pr) {
    var place = P && P.pollingPlace(pr.precinct);
    return '<div class="destpop">' +
      '<div class="dt">Ward ' + esc(pr.ward) + ' \u00b7 Precinct ' + esc(pr.precinct) + '</div>' +
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
      var pr = insideCity(e.latlng.lat, e.latlng.lng) && precinctAt(e.latlng.lat, e.latlng.lng);
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

  function loadData() {
    var input = $('addr');
    input.disabled = true;
    Promise.all([
      loadJson('graph'), loadJson('cameras'), loadJson('addresses'), loadJson('polling'),
      loadJson('boundary', true), loadJson('elections', true), loadJson('landcover', true),
      loadJson('neighbors', true), loadJson('precincts', true),
      loadJson('gr-clerk', true)
    ]).then(function (res) {
      var graphData = res[0], cameraData = res[1], addresses = res[2], polling = res[3];
      var boundary = res[4], calendar = res[5], landcover = res[6];
      var neighborData = res[7], precinctData = res[8], clerkData = res[9];

      graph = new ALPRRouter.Graph(graphData);
      cachedCameras = cameraData.cameras;
      P = new Precincts(addresses, polling);
      drawPollingPlaces();
      if (boundary && boundary.rings) {
        // boundary.json stores [lng, lat]; everything here wants [lat, lng].
        cityRings = boundary.rings.map(function (ring) {
          return ring.map(function (p) { return [p[1], p[0]]; });
        });
        drawBoundary();
      }
      neighbors = (neighborData && neighborData.streets) || null;
      precincts = (precinctData && precinctData.precincts) || null;
      if (precincts) ownBase.setPrecincts(precincts);
      ownBase.setData(graph, landcover || null);
      // Only cameras inside the city are shown or counted. The Overpass pull
      // is a rectangle, so most of what it returns is Wyoming, Kentwood and
      // Walker -- outside the routes this tool can draw, and outside the map
      // the veil says this tool is about.
      cameras = cityCameras(cachedCameras);
      // Election day hours are statewide and statutory, so they are one
      // object beside the list rather than a field repeated on every election.
      electionDayHours = (calendar && calendar.election_day_hours) || null;
      electionList = (calendar && calendar.elections) || [];
      activeEl = Elections.next(electionList);
      clerk = placeCoords(clerkData);
      renderElectionBanner();
      startCountdown();
      graph.assignCameras(cameras);
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

  // Inside the city limits? Decides which cameras are shown and counted, and
  // whether a tapped spot can be answered at all. The same ray cast as the
  // precinct lookup, so the veil, the markers and the answer always agree.
  // With no boundary file loaded, everything counts as inside.
  function insideCity(lat, lng) {
    return !cityRings || Precincts.pointInRings(lat, lng, cityRings);
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

  // `cameras` is already filtered to the city by cityCameras, so its length is
  // the number reported inside the city limits and not the wider fetch bbox.
  // Rendered from the data rather than written into the copy, so it stays true
  // when the camera file is refreshed.
  function renderCameraCount() {
    var fold = $('camCountFold');
    if (!fold) return;
    var n = cameras ? cameras.length : 0;
    // Names its source. It used to sit above a Cache/OSM toggle and leave that
    // to the toggle; with the toggle gone, nothing else on the map says where
    // these came from or how old they can be.
    fold.textContent = n + ' reported camera' + (n === 1 ? '' : 's') +
      ' in the city, from OpenStreetMap as of the last time this page was ' +
      'published. Volunteer-mapped and certainly incomplete, so treat it as ' +
      'a floor rather than a full count.';
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
    input.value = item.number + ' ' + item.street;
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
  function suggestWithNeighbours(text, limit) {
    var out = P.suggest(text, limit) || [];
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
                 where: where, why: 'in ' + where.join(' or ') });
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
    showError('That address is in ' + where + ', not the City of Grand ' +
      'Rapids, so this tool cannot say where you vote. A Grand Rapids mailing ' +
      'address does not always mean you live in the city. Your clerk is the ' +
      'one for ' + where + ', and the Michigan Voter Information Center at ' +
      'mvic.sos.state.mi.us will have your polling place.');
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
      return 'That street is in ' + where + ', not the City of Grand Rapids. ' +
        'A Grand Rapids mailing address does not always mean you live in the ' +
        'city, and this tool only covers the city. Your clerk is the one for ' +
        where + '.';
    }
    return 'No City of Grand Rapids street matches that. Check the spelling, ' +
      'or type just the street name to see the options. Note that many ' +
      'Grand Rapids mailing addresses are outside the city limits, in ' +
      'Wyoming, Kentwood, Walker, East Grand Rapids or one of the townships, ' +
      'and those are not covered here.';
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
    if (!insideCity(lat, lng)) {
      $('addr').value = ''; ac.close();
      showError('That spot is outside the City of Grand Rapids, and this ' +
        'tool covers the city only. Precincts and polling places out there ' +
        'belong to another clerk.');
      return;
    }
    var pr = precinctAt(lat, lng);
    if (!pr) {
      showError('Could not place that spot in a precinct. Try dropping the ' +
        'pin on a street, or type the address instead.');
      return;
    }
    var place = P.pollingPlace(pr.precinct);
    $('addr').value = ''; ac.close();
    setHint('Routing from your dropped pin. Type an address to switch back.');
    show({ pin: true, lat: lat, lng: lng,
           precinct: pr.precinct, ward: pr.ward, place: place });
  }

  // ---- the answer ------------------------------------------------------

  function showError(msg) {
    $('resultBlock').hidden = false; $('routeBlock').hidden = true;
    $('precinctInfo').innerHTML = '<div class="err">' + msg + '</div>';
    $('advisory').innerHTML = '';
    routeLayer.clearLayers(); pinLayer.clearLayers();
  }

  function show(r) {
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
      (r.ward ? '<div><div class="vi-lbl">Ward</div>' +
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

    // --- absentee drop box ------------------------------------------------
    // Returning an absentee ballot is the one trip here made entirely at a
    // time of your own choosing, which makes it the one where a record of the
    // journey is least excusable. It gets the same camera-aware routing as a
    // trip to the polls.
    var box = destinations(r).filter(function (o) { return o.kind === 'dropbox'; })[0];
    if (box) {
      html += '<div class="vi-where vi-dropbox" data-kind="dropbox">' +
        '<div class="vi-lbl">Ballot drop box nearest to you</div>' +
        '<div class="pp-name">' + esc(boxLabel(box.place)) + '</div>' +
        '<div class="pp-addr">' + esc(addressForDisplay(box.place.address)) +
        (box.place.note
          ? '<br>Location: ' + esc(sentenceCase(box.place.note)) : '') +
        (box.place.hours ? '<br>Open ' + esc(box.place.hours) : '') + '</div>' +
        '<button type="button" class="box-open" id="boxListBtn">All ' +
        (box.all.length + ((clerk && clerk.unrouted.length) || 0)) +
        ' drop boxes in the city</button>';
      html += '</div>';

      html += whenCell('dropbox', absenteeState(), '');
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
      html += '<div class="vi-where vi-ev-site' + (ev ? '' : ' vi-full') + '"' +
        (ev ? ' data-kind="early"' : '') + '>' +
        '<div class="vi-lbl">Early voting site nearest to you</div>' +
        (ev
          ? '<div class="pp-name">' + esc(displayCase(ev.place.name)) + '</div>' +
            '<div class="pp-addr">' + esc(addressForDisplay(ev.place.address)) +
            (ev.place.entrance_note
              ? '<br>Location: ' + esc(sentenceCase(ev.place.entrance_note)) : '') +
            '</div>' +
            (ev.all.length > 1
              ? '<div class="pp-note">Any Grand Rapids voter may use any of the ' +
                ev.all.length + ' sites, whatever precinct they are in.</div>'
              : '')
          : '<div class="pp-addr">No site published yet.</div>') +
        '</div>';
      html += whenCell('early', { label: evState.label, status: evState.status,
                                  live: true },
                       ev ? evHoursHtml(activeEl) : '');
    }

    // --- election day -----------------------------------------------------
    html += '<div class="vi-where' + (activeEl ? '' : ' vi-full') +
      '" data-kind="polling"><div class="vi-lbl">Election day polling place</div>';
    if (place) {
      // The name and address ARE the show-on-map control: clicking the place
      // takes you to the place. A separate link said in four words what the
      // affordance can say in zero.
      var clickable = !!(place.lat && place.lng);
      html += '<div' + (clickable
          ? ' class="pp-place" id="showPlaceBtn" role="button" tabindex="0"' +
            ' title="Show it on the map"'
          : '') + '>' +
        '<div class="pp-name">' + esc(displayCase(place.name)) + '</div>' +
        '<div class="pp-addr">' + esc(addressForDisplay(place.address)) +
        (place.entrance_note
          ? '<br>Location: ' + esc(sentenceCase(place.entrance_note)) : '') + '</div>' +
        '</div>';
      if (place.consolidated_with) {
        html += '<div class="pp-note">Precinct ' + esc(r.precinct) + ' votes with precinct ' +
          esc(place.consolidated_with) + ' this election' +
          (place.note ? ', because ' + esc(place.note).toLowerCase() : '') + '.</div>';
      }
    } else {
      html += '<div class="err">No polling place on file for precinct ' + esc(r.precinct) + '.</div>';
    }
    html += '</div>';

    if (activeEl) {
      html += whenCell('polling',
        { label: 'Election day', status: Elections.withWeekday(activeEl.date) },
        electionDayHours && electionDayHours.open && electionDayHours.close
          ? '<div class="vi-hours"><span class="vi-hours-lbl">Hours:</span> ' +
            esc(Elections.shortTime(electionDayHours.open)) + ' to ' +
            esc(Elections.shortTime(electionDayHours.close)) + '</div>'
          : '');
    }

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
    wireBoxList(r);

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
    var adv = ['<strong>Not an official government tool.</strong> Your voting ' +
      'location is based on the address where you registered to vote, not ' +
      'what you enter here. If you are not sure the entered address is the ' +
      'same, double-check with the ' +
      '<a href="https://www.grandrapidsmi.gov/departments/clerks-office/" ' +
      'target="_blank" rel="noopener">Grand Rapids City Clerk</a> or the ' +
      '<a href="https://mvic.sos.state.mi.us/" target="_blank" ' +
      'rel="noopener">Michigan Voter Information Center</a>.'];
    if (r.rivals) adv.push('This address sits on a precinct line and could be in ' +
      r.rivals.join(' or ') + '.');
    else if (r.inferred) adv.push('This exact number is not in ' +
      'the address list, so the precinct was taken from its neighbors and ' +
      'checked against the precinct boundary.');
    if (r.edgeMetres !== Infinity && r.edgeMetres < 30) adv.push('This address is close ' +
      'to a precinct boundary, so the answer is less certain.');
    if (r.ambiguousStreet) adv.push('Read as ' + esc(r.street) + '. Other streets also match what you typed.');
    // Last, because it is about the drive rather than the answer, and the
    // drive is what the reader goes to next.
    adv.push('Obey all traffic signs and laws.');
    $('advisory').innerHTML = '<div class="advisory">' + adv.join(' ') + '</div>';

    routeTo(r);
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
                 site: clerkForThisElection() };
      default:
        return { label: 'Early voting open',
                 status: 'Through ' + Elections.dayMonth(to), site: true };
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

  function nearest(origin, places) {
    if (!origin || !places || !places.length) return null;
    return places.slice().sort(function (a, b) {
      return ALPRRouter.haversine(origin.lat, origin.lng, a.lat, a.lng) -
             ALPRRouter.haversine(origin.lat, origin.lng, b.lat, b.lng);
    });
  }

  // Three places a ballot can go, and every one of them is a drive worth
  // routing around the cameras: voting on the day, voting early, and posting
  // an absentee ballot. The last is the one with the strongest case for it --
  // dropping a ballot off is a discretionary errand, at a time of your
  // choosing, and there is no reason a record of it should exist.
  function destinations(r) {
    var out = [];
    var origin = r.pin ? { lat: r.lat, lng: r.lng }
                       : graph.geocode(r.number, r.street);

    // The clerk's own sites when we have them, the calendar's otherwise.
    var sites = (clerkForThisElection() && clerk.sites.length) ? clerk.sites
              : Elections.sites(activeEl).filter(function (s) { return s.lat && s.lng; });
    var evState = Elections.windowState(evWindow());
    var ranked = nearest(origin, sites);
    if (ranked && evState !== 'closed') {
      out.push({ kind: 'early', label: 'Early voting', place: ranked[0],
                 all: ranked, state: evState });
    }

    if (r.place && r.place.lat) {
      out.push({ kind: 'polling', label: 'Election day', place: r.place });
    }

    var boxes = nearest(origin, clerk && clerk.boxes);
    if (boxes) {
      out.push({ kind: 'dropbox', label: 'Drop box', place: boxes[0],
                 all: boxes });
    }

    // Early voting leads only while it is actually open; before it starts,
    // election day is still the answer to "where do I vote".
    if (out.length > 1 && evState !== 'open') {
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
      pick = Object.assign({}, pick, { place: pick.all[which], chosen: which });
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
      destSub: pick.kind === 'early' ? 'Early voting site'
             : pick.kind === 'dropbox' ? 'Absentee ballot drop box'
             : 'Precinct ' + r.precinct
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

    drawCameras(routes.flagged);
    routeLayer.clearLayers();

    if (!routes.identical) {
      var other = selected === 'avoid' ? 'fast' : 'avoid';
      drawRoute(routes[other], 'muted', other);
    }
    var main = drawRoute(routes[selected], selected === 'avoid' ? 'avoid' : 'fastmain', selected);
    renderRouteKey();

    // Start and finish are drawn here, not in routeTo, because the start
    // arrow points the way the SELECTED route leaves, and that changes when
    // the reader flips between fastest and avoiding.
    pinLayer.clearLayers();
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
      var e = graph.edges[id], poly = e.p;
      if (r.nodes[i] !== e.a) poly = poly.slice().reverse();
      poly.forEach(function (p) { pts.push([p[0], p[1]]); });
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
    if (!routes || routes.identical) { k.hidden = true; k.innerHTML = ''; return; }
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

  function cityCameras(list) {
    return (list || []).filter(function (c) { return insideCity(c.lat, c.lng); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
