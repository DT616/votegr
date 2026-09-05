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
  var cachedCameras = null, cachedMeta = null, current = null;
  var elections = null, activeEl = null, destMode = 'auto', destChoice = null;
  var cityRings = null, landcover = null, ownBase = null;
  var neighbors = null, precincts = null;
  var pinArmed = false;
  var routes = null, selected = 'avoid';
  var originArrow = null;   // the blue you-are-here arrow; steps advance it
  var liveState = 'idle';            // idle | loading | live | failed
  var GR = [42.9634, -85.6681];

  // There is deliberately no tile layer. Tiles would be fetched from a third
  // party on every pan, which is the one thing that stopped this page being
  // able to say nothing leaves your browser. The basemap is drawn from files
  // the page already holds; see basemap.js.
  // Kept to one line: the map is now a card rather than the whole screen, and
  // a two-line attribution ate the bottom of it. Both sources are still named.
  var ATTR = 'Roads: City of Grand Rapids · ' +
             '\u00a9 OpenStreetMap contributors (ODbL)';

  // The hint line rests EMPTY: it exists only to carry transient guidance
  // (pin arming) and returns to nothing afterwards.
  var HINT_DEFAULT = '';

  function $(id) { return document.getElementById(id); }

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
    if (ownBase) ownBase.setDark(prefersDark());
    if (cityRings) drawBoundary({ rings: cityRings });
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
    // The address is assembled here rather than written in the HTML, so
    // scrapers reading the raw page for mailto: patterns find nothing while
    // a person gets an ordinary working link. Still zero requests: mailto is
    // navigation into the reader's own mail client.
    var ml = $('mailLink');
    if (ml) ml.href = 'mailto:' + ['info', 'votegr.org'].join('\u0040');

    paintLegendCamera();

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
    if (ownBase) ownBase.setLayerOpts(o);
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
  function fmtMi(m) { return (m / 1609.34).toFixed(1) + ' mi'; }
  function fmtMin(s) { return Math.max(1, Math.round(s / 60)) + ' min'; }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }

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
    if (!insideCity(c.lat, c.lng)) { el.textContent = 'Outside the city'; return; }
    var pr = precinctAt(c.lat, c.lng);
    el.textContent = pr
      ? 'Ward ' + pr.ward + ' \u00b7 Precinct ' + pr.precinct
      : '';
  }

  // One builder for "what precinct is this", fed by both input worlds:
  // the desktop hover chip and the touch tap-for-detail card. Content, not
  // an event handler, so the two cannot describe the same spot differently.
  // Every polling place and early voting site in this data is in Grand
  // Rapids, so the five digits tell a reader nothing they did not already
  // know and cost a line of width on a phone. Stripped when drawing only.
  // The stored value keeps its ZIP: /simple builds "..., Grand Rapids, MI
  // 49504" from it to hand OpenStreetMap something it can geocode.
  function addressForDisplay(a) {
    return String(a || '').replace(/,\s*\d{5}(-\d{4})?\s*$/, '');
  }

  function precinctInfoHtml(pr) {
    var place = P && P.pollingPlace(pr.precinct);
    return '<div class="destpop">' +
      '<div class="dt">Ward ' + esc(pr.ward) + ' \u00b7 Precinct ' + esc(pr.precinct) + '</div>' +
      (place ? '<div class="dn">' + esc(place.name) + '</div>' +
               '<div class="da">' + esc(addressForDisplay(place.address)) + '</div>' +
               (place.entrance_note ? '<div class="de">' + esc(place.entrance_note) + '</div>' : '')
             : '<div class="da">No polling place on file.</div>') +
      '</div>';
  }

  // Marker detail opens AT the marker on hover-capable devices, and in the
  // card below the map on touch. ONE predicate, read by all three marker
  // kinds (cameras, polling places, the finish flag), so a device can never
  // get a mix of the two behaviours.
  function hoverPopups() {
    return !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);
  }

  // Desktop hover, two readers of one mousemove. The STATUS readout (the
  // ward/precinct line in the map's header row) follows the cursor instead of
  // the view centre while a cursor exists to follow; on touch devices it
  // keeps its centre-of-view meaning. And when the cursor comes within a few
  // pixels of a precinct NUMBER, a small tip names it, because the numbers
  // are canvas ink with no element to hover: the hit test is against the 59
  // label anchors directly.
  var hoverThrottle = 0;
  function initMapHover() {
    if (!window.matchMedia || !window.matchMedia('(hover: hover)').matches) return;
    // Cursor tracking feeds the bottom-left status bar and nothing else: a
    // per-number tooltip used to live here too, but with the words now drawn
    // on the map and the status bar naming whatever is under the cursor, it
    // said the same thing twice.
    map.on('mousemove', function (e) {
      var now = Date.now();
      if (now - hoverThrottle < 40) return;
      hoverThrottle = now;
      var el = $('mapScope');
      if (!el) return;
      var pr = insideCity(e.latlng.lat, e.latlng.lng)
        ? precinctAt(e.latlng.lat, e.latlng.lng) : null;
      el.textContent = pr ? 'Ward ' + pr.ward + ' \u00b7 Precinct ' + pr.precinct
                          : 'Outside the city';
    });
    map.on('mouseout', function () { updateMapScope(); });
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
    map = L.map('map', { zoomControl: true, attributionControl: true }).setView(GR, 13);
    // Added before the data loads so the map paints its ground color rather
    // than flashing empty; setData fills it in when the files arrive.
    ownBase = BasemapLayer({ graph: null, landcover: null, dark: prefersDark() });
    ownBase.addTo(map);
    window.__base = ownBase;   // exposed for the label-coverage check
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

    // The layer toggles live in a gear in the map's own corner: they are map
    // settings, and they used to sit in a fold at the bottom of the PAGE,
    // three scrolls from the thing they control. Same input-as-SIBLING-of-
    // label markup as before: wrapping the input in its label makes a click
    // toggle it twice and the box lands back where it started.
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
        '<div class="src" id="srcToggle">' +
        '<button type="button" id="srcCached" class="on">Cache</button>' +
        '<button type="button" id="srcLive">OSM</button>' +
        '</div>' +
        '<div class="src-note" id="srcNote"></div>' +
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

    // The ward/precinct readout lives in the map's own bottom-left corner,
    // a status bar opposite the attribution. Same id as before, so every
    // writer (centre updates, cursor tracking) is unaffected by the move.
    var status = L.control({ position: 'bottomleft' });
    status.onAdd = function () {
      var d = L.DomUtil.create('div', 'map-status');
      d.id = 'mapScope';
      return d;
    };
    status.addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    pinLayer = L.layerGroup().addTo(map);

    var input = $('addr');
    input.disabled = true;

    // Pin drop is ARMED by the button beside the address field, so an idle
    // click on the map (panning slip, closing a popup) never starts a route.
    // One shot: a successful drop disarms it.
    // moveend covers pan, zoom and fitBounds alike, so the readout follows the
    // route fit as well as a hand drag.
    map.on('moveend', updateMapScope);

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

    Promise.all([
      fetch('data/graph.json').then(r => r.json()),
      fetch('data/cameras.json').then(r => r.json()),
      fetch('data/addresses.json').then(r => r.json()),
      fetch('data/polling.json').then(r => r.json()),
      fetch('data/boundary.json').then(r => r.json()).catch(function () { return null; }),
      fetch('data/elections.json').then(r => r.json()).catch(function () { return null; }),
      fetch('data/landcover.json').then(r => r.json()).catch(function () { return null; }),
      fetch('data/neighbors.json').then(r => r.json()).catch(function () { return null; }),
      fetch('data/precincts.json').then(r => r.json()).catch(function () { return null; })
    ]).then(function (res) {
      graph = new ALPRRouter.Graph(res[0]);
      cachedCameras = res[1].cameras; cachedMeta = res[1].meta;
      P = new Precincts(res[2], res[3]);
      drawPollingPlaces();
      if (res[4]) drawBoundary(res[4]);
      landcover = res[6] || null;
      neighbors = (res[7] && res[7].streets) || null;
      precincts = (res[8] && res[8].precincts) || null;
      if (ownBase && precincts) ownBase.setPrecincts(precincts);
      ownBase.setData(graph, landcover);
      // Only cameras inside the city are shown or counted. The Overpass pull
      // is a rectangle, so most of what it returns is Wyoming, Kentwood and
      // Walker -- outside the routes this tool can draw, and outside the map
      // the veil says this tool is about.
      cameras = cityCameras(cachedCameras);
      elections = (res[5] && res[5].elections) || [];
      activeEl = nextElection(elections);
      renderElectionBanner();
      graph.assignCameras(cameras);
      drawCameras();
      // The count in the explainer is read from the data, not typed into the
      // copy, so it cannot drift when the camera file is refreshed.
      var cc = $('camCount');
      if (cc) cc.textContent = cameras.length;
      // Optional: the Sources section this belonged to now lives in the
      // repository README instead, so guard rather than assume the element.
      var dn = $('dataNote');
      if (dn) dn.innerHTML = 'This page is carrying ' +
        graph.meta.edges.toLocaleString() + ' street segments, ' +
        Object.keys(P.polling).length + ' polling places, and ' +
        cameras.length + ' known license plate cameras inside the city.';
      setSrcNote('Cached list: ' + cameras.length + ' cameras in the city. Complete as published.');
      input.disabled = false;
      // Autofocus on a phone pops the keyboard over the map before the person
      // has seen anything, so it is desktop-only.
      if (!isPhone()) input.focus();
    }).catch(function () {
      $('dataNote').innerHTML = '<span class="err">Could not load the map data files.</span>';
    });

    var t;
    input.addEventListener('input', function () {
      clearTimeout(t); t = setTimeout(refreshSuggestions, 120);
    });
    input.addEventListener('keydown', onInputKey);
    input.addEventListener('blur', function () {
      // let a click on an item land before the list closes
      setTimeout(function () { closeAC(); }, 150);
    });
    document.addEventListener('click', function (e) {
      if (!$('addr').parentNode.contains(e.target)) closeAC();
    });
    initTheme();
    initLayers();
    initMapHover();
    initAbout();
    $('resetBtn').onclick = reset;
    $('srcCached').onclick = function () { useCached(); };
    // The live lookup is this page's ONE outbound request, so the OSM side
    // of the toggle never fires it directly: it opens a dialog that names
    // who gets contacted, and only the dialog's explicit yes fetches.
    var osmWrap = $('osmConfirm');
    function closeOsmConfirm() { osmWrap.hidden = true; }
    $('srcLive').onclick = function () { osmWrap.hidden = false; };
    $('osmGo').onclick = function () { closeOsmConfirm(); tryLive(); };
    osmWrap.addEventListener('click', function (e) {
      if (e.target.closest('[data-close]')) closeOsmConfirm();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !osmWrap.hidden) closeOsmConfirm();
    });
  }

  // The city limits, drawn because routing stops at them: without the outline
  // a route that stops at the edge looks like a bug rather than the edge of
  // the data.
  function drawBoundary(b) {
    if (!b || !b.rings) return;
    cityRings = b.rings;
    boundaryLayer.clearLayers();

    var holes = b.rings.map(function (ring) {
      return ring.map(function (p) { return [p[1], p[0]]; });
    });

    // Everything outside the city is veiled: routing stops at the line, and
    // fading the outside says so before anyone has to read that it does.
    // Built as one polygon whose outer ring is the world and whose holes are
    // the city, so the hole IS the covered area and the two can never disagree.
    var world = [[-85, -180], [-85, 180], [85, 180], [85, -180]];
    L.polygon([world].concat(holes), {
      stroke: false,
      fillColor: getVar('--bg'),
      // The light basemap is already near-white, so fading toward the page
      // needs more of it to register than the dark one does.
      fillOpacity: prefersDark() ? 0.66 : 0.78,
      interactive: false,
      className: 'city-veil'
    }).addTo(boundaryLayer);

    L.polygon(holes, {
      color: getVar('--dim'), weight: 2, opacity: .6,
      dashArray: '7 6', fill: false, interactive: false
    }).addTo(boundaryLayer);
  }

  // Ray casting against the city rings. Used to fade cameras that sit outside
  // the covered area, so the markers agree with the veil under them.
  function insideCity(lat, lng) {
    if (!cityRings) return true;
    var inside = false;
    for (var r = 0; r < cityRings.length; r++) {
      var ring = cityRings[r];
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if (((yi > lat) !== (yj > lat)) &&
            (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
      }
    }
    return inside;
  }

  // Every polling place in the city, shown from the start. This is a voting
  // tool: where people vote is the subject, and seeing all 59 makes the one
  // that turns out to be yours legible as part of a pattern rather than a
  // lone pin. The active one is drawn separately as the finish flag.
  function drawPollingPlaces(activePrecinct) {
    if (!P || !pollLayer) return;
    pollLayer.clearLayers();
    var ring = getVar('--pin-ring'), gold = getVar('--warn');
    var seen = {};
    Object.keys(P.polling).forEach(function (pk) {
      var pl = P.pollingPlace(pk);
      if (!pl || pl.lat == null) return;
      // Consolidated precincts share a building; draw it once.
      var key = pl.lat.toFixed(5) + ',' + pl.lng.toFixed(5);
      if (seen[key]) { seen[key].push(pk); return; }
      seen[key] = [pk];
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
      m.__precincts = seen[key];
      if (hoverPopups()) {
        m.bindPopup(function () { return m.__detail(); },
                    { maxWidth: 280, className: 'cam-popup' });
      } else {
        m.on('click', function () { showDetail(m.__detail()); });
      }
      m.__detail = (function () {
        var list = m.__precincts.sort(function (a, b) { return a - b; });
        return '<div class="destpop">' +
          '<div class="dt">Polling place</div>' +
          '<div class="dn">' + esc(pl.name) + '</div>' +
          '<div class="da">' + esc(addressForDisplay(pl.address)) + '</div>' +
          (pl.entrance_note ? '<div class="de">' + esc(pl.entrance_note) + '</div>' : '') +
          '<div class="dw">Precinct' + (list.length > 1 ? 's ' : ' ') +
          esc(list.join(', ')) + '</div></div>';
      });
    });
  }

  // ---- cameras ---------------------------------------------------------

  var FIELD_LABELS = {
    manufacturer: 'Made by', model: 'Model', brand: 'Brand',
    'camera:type': 'Camera type', 'camera:mount': 'Mounted on',
    operator: 'Operated by', 'operator:type': 'Operator type',
    surveillance: 'Watches', 'surveillance:zone': 'Zone',
    electricity: 'Power', height: 'Height', level: 'Level', support: 'Support',
    note: 'Note', description: 'Description', ref: 'Reference',
    'survey:date': 'Surveyed', check_date: 'Last checked', start_date: 'Installed'
  };
  var FIELD_ORDER = ['manufacturer', 'model', 'brand', 'operator', 'operator:type',
    'camera:type', 'camera:mount', 'support', 'surveillance', 'surveillance:zone',
    'electricity', 'height', 'level', 'start_date', 'survey:date', 'check_date',
    'ref', 'note', 'description'];

  function ago(iso) {
    var then = new Date(iso + 'T00:00:00Z').getTime();
    if (isNaN(then)) return '';
    var days = Math.floor((Date.now() - then) / 86400000);
    if (days < 0) return '';
    if (days === 0) return ' · today';
    if (days === 1) return ' · yesterday';
    if (days < 31) return ' · ' + days + ' days ago';
    var months = Math.round(days / 30.44);
    if (months < 24) return ' · ' + months + ' month' + (months > 1 ? 's' : '') + ' ago';
    return ' · ' + (days / 365.25).toFixed(1) + ' years ago';
  }

  function compass(deg) {
    var pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
               'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return pts[Math.round((deg % 360) / 22.5) % 16];
  }

  function cameraPopup(c) {
    var f = c.f || {};
    var rows = '';
    // Direction first: what a camera points at is the thing that matters most
    // for whether you drive past it.
    var dir = f.direction || f['camera:direction'];
    if (dir != null && dir !== '' && !isNaN(parseFloat(dir))) {
      var d = parseFloat(dir);
      rows += '<div class="cf"><span class="ck">Faces</span>' +
        '<span class="cv">' + compass(d) + ' · ' + Math.round(d) + '°</span></div>';
    }
    FIELD_ORDER.forEach(function (k) {
      if (f[k] == null || f[k] === '') return;
      var val = String(f[k]).replace(/;/g, ', ');
      rows += '<div class="cf"><span class="ck">' + esc(FIELD_LABELS[k] || k) +
        '</span><span class="cv">' + esc(val) + '</span></div>';
    });
    // Version 1 means the object has never been edited, so its timestamp is
    // genuinely when the camera was first mapped. Past v1 all we honestly know
    // is when someone last touched it, and saying otherwise would overstate it.
    var seen = c.t ? String(c.t).slice(0, 10) : null;
    if (seen) {
      var firstMapped = c.v === 1;
      rows += '<div class="cf"><span class="ck">' +
        (firstMapped ? 'First mapped' : 'Last edited') + '</span>' +
        '<span class="cv">' + seen + '<span class="cago">' + ago(seen) + '</span></span></div>';
    }
    if (!rows) rows = '<div class="cf"><span class="cv">No details recorded in OpenStreetMap.</span></div>';
    var foot = '<div class="cfoot">OpenStreetMap ' + esc(c.id) +
      (c.v ? ' · version ' + c.v : '') + '</div>';
    return '<div class="campop"><div class="ctitle">License plate camera</div>' + rows + foot + '</div>';
  }

  // Cameras are drawn as a view cone pointing the way the camera faces, the
  // convention DeFlock and the OSM surveillance renderers use. The bearing is
  // in OSM's `direction` tag, present on every camera in this data, and it is
  // the thing that decides whether driving a street actually passes a reader.
  function cameraIcon(c, flagged) {
    var f = c.f || {};
    var raw = f.direction != null ? f.direction : f['camera:direction'];
    var deg = (raw != null && raw !== '' && !isNaN(parseFloat(raw))) ? parseFloat(raw) : null;
    var S = 58, C = S / 2;
    var fill = flagged ? '#ff2d2d' : '#ff4d4d';
    var cone = '';
    if (deg != null) {
      // Cone drawn pointing north from center, then rotated to the bearing.
      cone = '<g transform="rotate(' + deg.toFixed(1) + ' ' + C + ' ' + C + ')">' +
        '<path d="M' + C + ',' + C + ' L' + (C - 11) + ',' + (C - 24) +
        ' A26,26 0 0,1 ' + (C + 11) + ',' + (C - 24) + ' Z" ' +
        'fill="' + fill + '" fill-opacity="' + (flagged ? '.42' : '.26') + '" ' +
        'stroke="' + fill + '" stroke-opacity="' + (flagged ? '.85' : '.5') + '" stroke-width="1.5"/></g>';
    }
    var ring = flagged
      ? '<circle cx="' + C + '" cy="' + C + '" r="15" fill="none" stroke="' + fill +
        '" stroke-width="2.5" opacity=".9" class="cam-pulse"/>'
      : '';
    // A robot officer: pale metal head under a police peaked cap, and two
    // red glowing eyes. The eyes carry the state colour, which is the honest
    // mapping: the glow IS the plate reader, and it burns brighter when this
    // camera sits on your route. Cap and head are fixed colours so the only
    // thing that changes with state is the part that watches. Upright at
    // every bearing; the cone alone says which way it looks.
    var body = cameraBodySvg(fill, C);
    var html = '<svg width="' + S + '" height="' + S + '" viewBox="0 0 ' + S + ' ' + S + '">' +
      cone + ring + body + '</svg>';
    // The hover title. RoboCop is what he is.
    return L.divIcon({ className: 'cam-icon', html:
      '<span title="RoboCop" style="display:block;width:100%;height:100%">' + html + '</span>',
                       iconSize: [S, S], iconAnchor: [C, C] });
  }

  // The robot itself, with no direction cone and no route pulse. Split out so
  // the map marker and the legend key are literally the same drawing: the key
  // used to be a separate CSS approximation built from radial-gradients, and
  // it had drifted into something that plainly did not match the map.
  function cameraBodySvg(fill, C) {
    var ring2 = getVar('--pin-ring');
    // Cap in a real police blue rather than near-black navy; face in a
    // light skin tone (the RoboCop read: human face, machine everything
    // else). The ear bolts stay pale metal so the hardware still shows.
    var dark = '#0e1116', cap = '#2a52c8', skin = '#f0c8a2';
    var body =
      '<g stroke-linejoin="round" transform="translate(' + C + ',' + C +
        ') scale(1.15) translate(-' + C + ',-' + C + ')">' +
      // ear bolts first, so the head overlaps their inner edge
      '<rect x="' + (C - 10.6) + '" y="' + (C - 1) + '" width="3" height="4.6" rx="1" ' +
        'fill="' + ring2 + '" stroke="' + dark + '" stroke-width="1.2"/>' +
      '<rect x="' + (C + 7.6) + '" y="' + (C - 1) + '" width="3" height="4.6" rx="1" ' +
        'fill="' + ring2 + '" stroke="' + dark + '" stroke-width="1.2"/>' +
      // head: squarer block; the small radius is the robot tell
      '<rect x="' + (C - 8.5) + '" y="' + (C - 4) + '" width="17" height="13.5" rx="2.2" ' +
        'fill="' + skin + '" stroke="' + dark + '" stroke-width="1.6"/>' +
      // faceplate seam under the eyes
      '<path d="M' + (C - 8.5) + ',' + (C + 3.6) + ' H' + (C + 8.5) + '" ' +
        'stroke="' + dark + '" stroke-width=".9" opacity=".45"/>' +
      // mouth grille: three teeth, not lips
      '<rect x="' + (C - 4.2) + '" y="' + (C + 5.2) + '" width="2.2" height="1.8" rx=".5" fill="' + dark + '" opacity=".8"/>' +
      '<rect x="' + (C - 1.1) + '" y="' + (C + 5.2) + '" width="2.2" height="1.8" rx=".5" fill="' + dark + '" opacity=".8"/>' +
      '<rect x="' + (C + 2) + '" y="' + (C + 5.2) + '" width="2.2" height="1.8" rx=".5" fill="' + dark + '" opacity=".8"/>' +
      // eye glow, then the eyes themselves
      '<circle cx="' + (C - 3.8) + '" cy="' + (C + 1.2) + '" r="4.4" fill="' + fill + '" opacity=".3"/>' +
      '<circle cx="' + (C + 3.8) + '" cy="' + (C + 1.2) + '" r="4.4" fill="' + fill + '" opacity=".3"/>' +
      '<circle cx="' + (C - 3.8) + '" cy="' + (C + 1.2) + '" r="2.1" fill="' + fill + '" stroke="' + dark + '" stroke-width=".8"/>' +
      '<circle cx="' + (C + 3.8) + '" cy="' + (C + 1.2) + '" r="2.1" fill="' + fill + '" stroke="' + dark + '" stroke-width=".8"/>' +
      // peaked cap: crown, then the brim across the brow
      '<path d="M' + (C - 8.5) + ',' + (C - 4.5) + ' Q' + (C - 8) + ',' + (C - 11) + ' ' + C + ',' + (C - 11) +
        ' Q' + (C + 8) + ',' + (C - 11) + ' ' + (C + 8.5) + ',' + (C - 4.5) + ' Z" ' +
        'fill="' + cap + '" stroke="' + dark + '" stroke-width="1.4"/>' +
      '<rect x="' + (C - 10) + '" y="' + (C - 5.4) + '" width="20" height="2.6" rx="1.3" ' +
        'fill="' + cap + '" stroke="' + dark + '" stroke-width="1.2"/>' +
      // badge on the crown
      '<circle cx="' + C + '" cy="' + (C - 7.8) + '" r="1.3" fill="#f0ad2d"/>' +
      '</g>';
    return body;
  }

  // Draw that same robot into the legend key. Cropped to the figure rather
  // than the marker's 58px box, which is mostly empty space reserved for the
  // direction cone the key does not show.
  function paintLegendCamera() {
    var el = document.querySelector('.map-legend .dotk');
    if (!el) return;
    el.innerHTML = '<svg viewBox="16 15 26 26" width="18" height="18" ' +
      'style="display:block">' + cameraBodySvg('#ff4d4d', 29) + '</svg>';
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
    var n = cameras ? cameras.length : 0;
    var one = n === 1;
    var fold = $('camCountFold');
    if (fold) {
      // Sits above the Cache/OSM toggle now, so it must not name a source:
      // that is the toggle's job.
      fold.textContent = n + ' reported camera' + (one ? '' : 's') +
        ' in the city. Volunteer-mapped and certainly incomplete, so treat ' +
        'it as a floor rather than a full count.';
    }
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
    if (!ownBase) return;
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
      // Desktop gets the detail AT the marker: with the map now 400-600px
      // tall there is room for a popup, and eyes are already on the dot that
      // was clicked. Touch keeps the card below the map, where a popup would
      // fight fat fingers and the small viewport.
      if (hoverPopups()) {
        mk.bindPopup(function () { return cameraPopup(c); },
                     { maxWidth: 300, className: 'cam-popup' });
      } else {
        mk.on('click', function () { showDetail(cameraPopup(c)); });
      }
      mk.addTo(camLayer);
    });
    syncLabelObstacles();
  }

  function getVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000';
  }

  // ---- lookup ----------------------------------------------------------

  function reset() {
    hideDetail();
    hideMap();
    routeLayer.clearLayers(); pinLayer.clearLayers();
    current = null;
    $('addr').value = ''; closeAC();
    $('resultBlock').hidden = true; $('routeBlock').hidden = true;
    $('routeBlock').classList.remove('map-only');
    routes = null;   // out of scope: reset also takes the cameras off the map
    $('col').classList.remove('has-result');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    disarmPin();
    if (ownBase) { ownBase.setRouteStreets([], null); ownBase.setActivePrecinct(null); }
    drawPollingPlaces();
    drawCameras();
    map.setView(GR, 13);
    $('addr').focus();
  }

  // ---- type-ahead ------------------------------------------------------
  //
  // Nothing resolves while you type. The list offers addresses that really
  // exist in the index and the answer appears when one is chosen, so a number
  // the index does not carry reads as "did you mean" rather than as an error
  // thrown at you mid-keystroke.

  var acItems = [], acIndex = -1;

  function acBox() {
    var box = $('ac');
    if (!box) {
      box = document.createElement('div');
      box.id = 'ac'; box.className = 'ac'; box.hidden = true;
      box.setAttribute('role', 'listbox');
      $('addr').parentNode.appendChild(box);
    }
    return box;
  }

  function closeAC() { acBox().hidden = true; acIndex = -1; }

  function refreshSuggestions() {
    var text = $('addr').value.trim();
    if (text.length < 2) { closeAC(); return; }
    acItems = P.suggest(text, 8);
    if (!acItems.length) { closeAC(); return; }
    var box = acBox();
    var hasNumber = P.parseTyped(text).number != null;
    var html = acItems.map(function (it, i) {
      var why = it.kind === 'exact' ? '' :
        it.kind === 'inferred' ? 'estimated' :
        it.kind === 'quadrant' ? 'did you mean' :
        it.kind === 'near' ? 'nearest on this street' : 'pick a number';
      return '<button type="button" class="ac-item" role="option" data-i="' + i + '">' +
        (it.number != null ? '<span class="num">' + it.number + '</span>' : '') +
        '<span class="st">' + esc(it.street) + '</span>' +
        (why ? '<span class="why">' + why + '</span>' : '') + '</button>';
    }).join('');
    box.innerHTML = (hasNumber ? '' : '<div class="ac-head">Choose a street</div>') + html;
    Array.prototype.forEach.call(box.querySelectorAll('.ac-item'), function (el) {
      el.addEventListener('mousedown', function (e) {
        e.preventDefault();
        choose(acItems[Number(el.dataset.i)]);
      });
    });
    box.hidden = false; acIndex = -1;
  }

  function highlight(n) {
    var els = acBox().querySelectorAll('.ac-item');
    if (!els.length) return;
    if (acIndex >= 0 && els[acIndex]) els[acIndex].classList.remove('active');
    acIndex = (n + els.length) % els.length;
    els[acIndex].classList.add('active');
    els[acIndex].scrollIntoView({ block: 'nearest' });
  }

  function onInputKey(e) {
    var open = !acBox().hidden;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) refreshSuggestions(); highlight(acIndex + 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (open) highlight(acIndex - 1); return; }
    if (e.key === 'Escape') { closeAC(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (open && acIndex >= 0) { choose(acItems[acIndex]); return; }
      // Enter with no pick: take the best suggestion if there is one.
      var items = P.suggest($('addr').value.trim(), 1);
      if (items.length && items[0].number != null) { choose(items[0]); return; }
      if (items.length) { $('addr').value = items[0].street + ' '; refreshSuggestions(); return; }
      showError(missExplanation($('addr').value.trim()));
    }
  }

  function choose(item) {
    if (!item) return;
    closeAC();
    if (item.number == null) {
      // a street was picked: keep any number already typed and reopen
      var num = ($('addr').value.match(/^(\d+)/) || [])[1] || '';
      $('addr').value = (num ? num + ' ' : '') + item.street + (num ? '' : ' ');
      $('addr').focus();
      refreshSuggestions();
      return;
    }
    $('addr').value = item.number + ' ' + item.street;
    var r = P.lookup($('addr').value);
    if (r.error) {
      showError('Could not resolve ' + esc($('addr').value) + '.');
      return;
    }
    // Where the address was inferred from its neighbors, let the precinct
    // boundary overrule them. See refineWithPolygon in precinct.js.
    if (graph) P.refineWithPolygon(r, function (n, st) { return graph.geocode(n, st); }, precincts);
    $('hint').textContent = HINT_DEFAULT;
    // Drop focus before rendering, not after. On a phone the soft keyboard is
    // most of the lower screen, and show() fits the map to the viewport it
    // finds, so blurring first means the fit is computed against the real
    // height rather than the keyboard-shortened one. The street-only branch
    // above deliberately keeps focus: that address is not finished yet.
    $('addr').blur();
    show(r);
  }

  // Most of the "Grand Rapids" postal area is not the City of Grand Rapids.
  // More than half the road segments carrying a Grand Rapids ZIP sit in
  // Wyoming, Kentwood, Walker, East Grand Rapids or Grand Rapids CHARTER
  // TOWNSHIP, which shares the city's name and confuses everyone. Those
  // residents vote somewhere this tool does not cover, and telling them "no
  // street matches" reads as a broken tool rather than an honest limit.
  function missExplanation(typed) {
    var t = P.parseTyped(typed);
    var street = (t.rest || typed || '').trim().toUpperCase();
    var hit = null;
    if (neighbors && street) {
      hit = neighbors[street];
      if (!hit) {
        // try without a house number and with light normalization
        var keys = Object.keys(neighbors), needle = street.replace(/\s+/g, ' ');
        for (var i = 0; i < keys.length; i++) {
          if (keys[i] === needle) { hit = neighbors[keys[i]]; break; }
        }
      }
    }
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
    $('hint').textContent = 'Tap the map where you want to start from. Esc cancels.';
    $('mapNote').textContent = 'Tap anywhere in the city to start from that spot.';
    scrollToResult('mapBlock');
  }

  function disarmPin() {
    if (pinArmed) $('mapNote').textContent = '';
    pinArmed = false;
    $('pinBtn').classList.remove('armed');
    $('pinBtn').setAttribute('aria-pressed', 'false');
    $('map').classList.remove('pin-armed');
    $('hint').textContent = HINT_DEFAULT;
  }

  function pinLookup(lat, lng, src) {
    if (!graph || !P) return;
    if (!insideCity(lat, lng)) {
      $('addr').value = ''; closeAC();
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
    $('addr').value = ''; closeAC();
    $('hint').textContent = src === 'geo'
      ? 'Routing from your location. Type an address to switch back.'
      : 'Routing from your dropped pin. Type an address to switch back.';
    show({ pin: true, geo: src === 'geo', lat: lat, lng: lng,
           precinct: pr.precinct, ward: pr.ward, place: place });
  }

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

    // The answer as labelled facts rather than one eyebrow line. Order is
    // who you are, then what is true today, then where you vote on the day:
    // during early voting there are TWO places you could go, and a block
    // that names only the election-day one is wrong for the nine days it
    // matters most.
    var html = '<div class="vi-rows"><div class="vi-two-up">' +
      (r.ward ? '<div><div class="vi-lbl">Ward</div>' +
                '<div class="vi-num">' + esc(r.ward) + '</div></div>' : '') +
      '<div><div class="vi-lbl">Precinct</div>' +
      '<div class="vi-num">' + esc(r.precinct) + '</div></div></div>';

    // The site is named only when the window is actually open. Note ev can
    // still come back empty then: destinations() also wants sites with
    // coordinates and an origin to measure from, and with the window open
    // and our site list short, the honest thing is to say the window is open
    // and name nothing, rather than blame the calendar for a gap of our own.
    // destinations() already ranks by distance from this origin, so the
    // nearest is read back from it rather than sorted a second time here.
    var evState = earlyVotingForBlock();
    if (evState) {
      var ev = evState.site
        ? destinations(r).filter(function (o) { return o.kind === 'early'; })[0]
        : null;
      html += '<div>' +
        '<div class="vi-lbl live">' + esc(evState.label) + '</div>' +
        '<div class="vi-val">' + esc(evState.status) + '</div>';
      if (ev) {
        html += '<div class="vi-lead">Early Voting Site Nearest to You:</div>' +
          '<div class="pp-name">' + esc(ev.place.name) + '</div>' +
          '<div class="pp-addr">' + esc(addressForDisplay(ev.place.address)) + '</div>' +
          evHoursHtml(activeEl);
      }
      html += '</div>';
    }

    if (activeEl) {
      html += '<div><div class="vi-lbl">Election day</div>' +
        '<div class="vi-val">' + esc(prettyDate(activeEl.date)) + '</div></div>';
    }

    html += '<div><div class="vi-lbl">Election day polling place</div>';
    if (place) {
      // The name and address ARE the show-on-map control: clicking the place
      // takes you to the place. A separate link said in four words what the
      // affordance can say in zero.
      var clickable = !!(place.lat && place.lng);
      html += '<div' + (clickable
          ? ' class="pp-place" id="showPlaceBtn" role="button" tabindex="0"' +
            ' title="Show it on the map"'
          : '') + '>' +
        '<div class="pp-name">' + esc(place.name) + '</div>' +
        '<div class="pp-addr">' + esc(addressForDisplay(place.address)) +
        (place.entrance_note ? '<br>' + esc(place.entrance_note) : '') + '</div>' +
        '</div>';
      if (place.consolidated_with) {
        html += '<div class="pp-note">Precinct ' + esc(r.precinct) + ' votes with precinct ' +
          esc(place.consolidated_with) + ' this election' +
          (place.note ? ', because ' + esc(place.note).toLowerCase() : '') + '.</div>';
      }
    } else {
      html += '<div class="err">No polling place on file for precinct ' + esc(r.precinct) + '.</div>';
    }
    html += '</div></div>';
    $('precinctInfo').innerHTML = html;
    var spb = $('showPlaceBtn');
    if (spb) spb.onkeydown = function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); spb.click(); }
    };
    if (spb) spb.onclick = function () {
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

    var adv = [];
    if (r.pin) adv.push(r.geo
      ? 'From the location your device provided, so accuracy may vary. Your ' +
        'legal precinct is set by your registered address.'
      : 'The start location is based on where you dropped your pin. Your ' +
        'real location is your registered voter address, so if you live ' +
        'somewhere else, type that address instead.');
    if (r.rivals) adv.push('This address sits on a precinct line and could be in ' +
      r.rivals.join(' or ') + '. Worth confirming with the clerk.');
    else if (r.inferred && !r.fromPolygon) adv.push('This exact number is not in ' +
      'the address list, so the precinct was taken from its neighbors and ' +
      'checked against the precinct boundary.');
    if (r.edgeMetres !== Infinity && r.edgeMetres < 30) adv.push('This address is close ' +
      'to a precinct boundary, so the answer is less certain.');
    if (r.ambiguousStreet) adv.push('Read as ' + esc(r.street) + '. Other streets also match what you typed.');
    $('advisory').innerHTML = adv.length ? '<div class="advisory">' + adv.join(' ') + '</div>' : '';

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

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }

  function nextElection(list) {
    var t = todayStr();
    var future = (list || []).filter(function (e) { return e.date >= t; });
    future.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return future[0] || null;
  }

  function evSites(e) { return (e && e.early_voting_sites) || []; }

  function evOpen(e) {
    if (!e || !e.early_voting_from || !e.early_voting_to) return false;
    var t = todayStr();
    return t >= e.early_voting_from && t <= e.early_voting_to && evSites(e).length > 0;
  }

  function prettyDate(iso) {
    if (!iso) return '';
    var p = iso.split('-');
    var months = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];
    return months[Number(p[1]) - 1] + ' ' + Number(p[2]) + ', ' + p[0];
  }

  // The clerk publishes early voting hours as a weekday pattern rather than
  // as dated rows, so a rule is matched by weekday. Indexes line up with the
  // abbreviations the data file uses.
  var DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Days left, times right, with today's row picked out: where to go is the
  // answer, when it is open is the detail that follows it. Same shape the
  // /simple page renders, so hours read alike on both surfaces.
  function evHoursHtml(e) {
    var rules = (e && e.early_voting_hours) || [];
    if (!rules.length) return '';
    var today = DAY_ABBR[new Date().getDay()];
    var out = '<div class="ev-hours">';
    for (var i = 0; i < rules.length; i++) {
      var days = rules[i].days || [];
      var mark = days.indexOf(today) !== -1 ? ' class="is-today"' : '';
      out += '<span' + mark + '>' + esc(days.join(', ')) +
             (mark ? ' (today)' : '') + '</span>' +
             '<span' + mark + '>' + esc(rules[i].open) + ' to ' +
             esc(rules[i].close) + '</span>';
    }
    return out + '</div>';
  }

  // Two lines in the header: election day, then early voting under it.
  //
  // The early voting sentence used to open the page as a paragraph above the
  // headline, which meant the first thing anyone read was a caveat about a
  // thing that had not been scheduled yet. As a labelled line in the chrome it
  // is available at a glance and in the way of nothing.
  //
  // Written as the calendar rather than as a set of conditions, because the
  // conditions had a hole in them: every state that was not before the window
  // or inside it fell through to 'Start date TBD', including the day or two
  // after early voting closes and election day itself. Those are the days the
  // most people read this line, and it was telling them the start date had
  // not been decided when in fact the window had already been and gone.
  //
  // 'Start date TBD' now means only what it says: the clerk has published
  // nothing. A half-published window counts as nothing, since a start with no
  // end is not a window a voter can act on.
  function earlyVotingStatus() {
    var from = activeEl.early_voting_from, to = activeEl.early_voting_to;
    if (!from || !to) return 'Start date TBD';

    var t = todayStr();
    if (t > to) return 'Ended ' + prettyDate(to);
    if (t < from) return prettyDate(from) + ' to ' + prettyDate(to);
    // Inside the window. Deliberately the dates alone and not evOpen(), which
    // also wants a site list: with a window published and no sites, the window
    // is still open and it is our data that is short. Saying nothing about the
    // dates would be blaming the calendar for a gap of our own.
    return 'Open through ' + prettyDate(to);
  }

  // What the BLOCK says about early voting, which is deliberately not what
  // the footer bar says. The bar labels its row "Early voting" and lets the
  // status carry the state; the block puts the state in the label, in the
  // accent, where it is the first thing read. So the status here drops the
  // state word rather than saying it twice, and the two callers stay
  // independent instead of one wording being wrong for the other surface.
  //
  // Four states. The one that matters most is the third: after the window
  // closes but before election day, a reader who saw a site listed last week
  // has to be told it is no longer an option, or they drive to a locked door.
  // activeEl is always the NEXT election, so if it exists at all then
  // election day has not passed, and t > to means exactly "closed, with the
  // election still ahead".
  function earlyVotingForBlock() {
    if (!activeEl) return null;
    var from = activeEl.early_voting_from, to = activeEl.early_voting_to;
    // A half-published window is not a window a voter can act on, so say
    // nothing rather than describe a date range that does not exist yet.
    if (!from || !to) return null;
    var t = todayStr();
    if (t > to) {
      return { label: 'Early voting closed', status: 'Ended ' + prettyDate(to),
               site: false };
    }
    if (t < from) {
      return { label: 'Early voting upcoming',
               status: prettyDate(from) + ' to ' + prettyDate(to), site: false };
    }
    return { label: 'Early voting open', status: 'Through ' + prettyDate(to),
             site: true };
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
      cell('elec-date', prettyDate(activeEl.date)) +
      cell('elec-name', 'Early voting') +
      cell('elec-date', earlyVotingStatus());
    if (bar) bar.hidden = false;
  }

  // Which destinations are available for this voter right now.
  function destinations(r) {
    var out = [];
    if (evOpen(activeEl)) {
      var origin = r.pin ? { lat: r.lat, lng: r.lng }
                         : graph.geocode(r.number, r.street);
      var sites = evSites(activeEl).filter(function (s) { return s.lat && s.lng; });
      if (origin && sites.length) {
        sites = sites.slice().sort(function (a, b) {
          return ALPRRouter.haversine(origin.lat, origin.lng, a.lat, a.lng) -
                 ALPRRouter.haversine(origin.lat, origin.lng, b.lat, b.lng);
        });
        out.push({ kind: 'early', label: 'Early voting', place: sites[0],
                   all: sites });
      }
    }
    if (r.place && r.place.lat) {
      out.push({ kind: 'polling', label: 'Election day', place: r.place });
    }
    return out;
  }

  // ---- routing + drawing ----------------------------------------------

  function routeTo(r, forcedKind) {
    var opts = destinations(r);
    routeLayer.clearLayers(); pinLayer.clearLayers();

    if (!opts.length) {
      $('routeBlock').hidden = true;
      return;
    }
    var pick = null;
    if (forcedKind) pick = opts.filter(function (o) { return o.kind === forcedKind; })[0];
    if (!pick) pick = opts[0];
    destChoice = pick;

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

    var originLabel = null;

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
    var identical = sameRoute(fast, avoid, fastExp, avoid.cameraCount);

    // A route through cameras earns its place on the page by being faster.
    // When it is not (by the same threshold the cost line uses), offering it
    // would present surveillance exposure as one half of a trade that has no
    // other half, so it collapses into the single-route display.
    var fastDropped = false;
    if (!identical && fastExp > avoid.cameraCount && noRealSaving(fast, avoid)) {
      identical = true;
      fastDropped = true;
    }

    routes = {
      fast: fast, avoid: avoid, identical: identical, fastDropped: fastDropped,
      fastExp: fastExp,
      avoidExp: avoid.cameraCount,
      flagged: fast.camsOnRoute,
      opts: opts, origin: origin, place: place, originLabel: originLabel,
      destSub: (pick.kind === 'early') ? 'Early voting site'
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
    originArrow = marker([routes.origin.lat, routes.origin.lng], 'origin', routes.originLabel, brg);
    // The flag stands alone on the map; the detail is a click away. A
    // permanent card beside it covered the streets around the destination,
    // which is exactly where a reader is trying to look.
    var destM = marker([routes.place.lat, routes.place.lng], 'dest', 'Finish');
    var p = routes.place;
    var destHtml =
      '<div class="destpop">' +
      '<div class="dt">Finish</div>' +
      '<div class="dn">' + esc(p.name) + '</div>' +
      '<div class="da">' + esc(addressForDisplay(p.address)) + '</div>' +
      (p.entrance_note ? '<div class="de">' + esc(p.entrance_note) + '</div>' : '') +
      '<div class="dw">' + esc(routes.destSub) + '</div>' +
      '</div>';
    if (hoverPopups()) {
      destM.bindPopup(destHtml, { maxWidth: 280, className: 'cam-popup' });
    } else {
      destM.on('click', function () { showDetail(destHtml); });
    }

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

    if (ownBase) ownBase.setActivePrecinct(current && current.precinct);
    drawPollingPlaces(current && current.precinct);
    // Tell the basemap which streets this route uses so it names them first.
    if (ownBase) {
      ownBase.setRouteStreets(
        (routes[selected].steps || []).map(function (st) { return st.street; })
          .filter(Boolean),
        routes[selected].pts);
    }

    renderDestPicker();
    renderRouteCards();
    renderSteps();
    renderUnavoidable();
  }

  function renderDestPicker() {
    var el = $('destPick');
    if (!el) return;
    if (!routes || routes.opts.length < 2) {
      // One destination needs no announcement: the answer block above has
      // already named it.
      el.innerHTML = '';
      return;
    }
    el.innerHTML = '<div class="seg">' + routes.opts.map(function (o) {
      return '<button type="button" data-kind="' + o.kind + '"' +
        (destChoice && o.kind === destChoice.kind ? ' class="on"' : '') + '>' +
        esc(o.label) + '</button>';
    }).join('') + '</div>';
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

  // Two results are the same journey if they use the same roads, or if they
  // are indistinguishable on every figure the page reports.
  //
  // The exposure counts must be passed in. The fastest route is computed with
  // the camera data switched off, so its own cameraCount is always 0 and
  // comparing it against the avoiding route's 0 would call two genuinely
  // different routes identical whenever their distance and time happened to
  // match, hiding a real choice from the reader.
  // "Would taking the cameras actually get you there faster?" Both routes come
  // out of the same search over the same graph, so this is a direct comparison
  // of their seconds and meters. The threshold is the same one the verdict
  // line has always used for "costs you nothing": a saving the display cannot
  // even show (under 0.05 mi and half a minute) is not a saving.
  //
  // ONE predicate for both decisions that depend on it: whether the fastest
  // route is offered at all, and how its cost is described when it is.
  function noRealSaving(fast, avoid) {
    var dMi = (avoid.meters - fast.meters) / 1609.34;
    var dMin = (avoid.seconds - fast.seconds) / 60;
    return dMi <= .05 && dMin <= .5;
  }

  function sameRoute(a, b, aExp, bExp) {
    if (!a || !b) return false;
    if (a.edges.length === b.edges.length &&
        a.edges.every(function (e, i) { return e === b.edges[i]; })) return true;
    return aExp === bExp &&
           Math.round(a.seconds) === Math.round(b.seconds) &&
           Math.round(a.meters) === Math.round(b.meters);
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

  function marker(latlng, kind, label, bearingDeg) {
    var ring = getVar('--pin-ring');
    var html, size, anchor, tag;
    if (kind === 'origin') {
      // A compass arrow rotated to the first leg's bearing: the start of the
      // route says which way you set off, not just where you stand.
      size = 34; anchor = [17, 17]; tag = 'Start';
      html = '<div style="width:34px;height:34px;border-radius:50%;background:' +
        getVar('--accent') + ';border:3px solid ' + ring +
        ';box-shadow:0 1px 8px rgba(0,0,0,.5);display:flex;align-items:center;' +
        'justify-content:center;transform:rotate(' + (bearingDeg || 0) + 'deg)">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="#fff">' +
        '<path d="M12 3l6 15-6-4-6 4z"/></svg></div>';
    } else {
      // A finish flag, because "finish" is what the end of a route is called.
      size = 34; anchor = [6, 32]; tag = 'Finish';
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
      icon: L.divIcon({ className: '', html: html, iconSize: [size, size],
        iconAnchor: anchor }),
      zIndexOffset: 1000
    }).addTo(pinLayer);
    // The finish gets a permanent label bound by the caller; the start keeps
    // a hover tooltip so the arrow stays uncluttered.
    if (kind === 'origin') {
      m.bindTooltip(tag, { direction: 'top', offset: [0, -10] });
    }
    return m;
  }

  function camWord(n) {
    return n === 0 ? '<span class="cam-zero">no cameras</span>'
      : '<span class="cam-big">' + n + ' camera' + (n > 1 ? 's' : '') + '</span>';
  }

  function renderRouteCards() {
    var fast = routes.fast, avoid = routes.avoid;
    var dMi = (avoid.meters - fast.meters) / 1609.34;
    var dMin = (avoid.seconds - fast.seconds) / 60;
    var saved = routes.avoidExp < routes.fastExp ? routes.fastExp - routes.avoidExp : 0;

    if (routes.identical) {
      var clean = routes.avoidExp === 0;
      var note = routes.fastDropped
        ? '<div class="verdict">Going through the cameras would not get you ' +
          'there any faster, so only this route is offered.</div>'
        : clean ? ''
        : '<div class="verdict">This is also the way that passes ' +
          'the fewest cameras.</div>';
      $('routes').innerHTML =
        '<div class="one-route"><b>' + fmtMi(avoid.meters) + '</b> · <b>' +
        fmtMin(avoid.seconds) + '</b>' +
        (clean ? '' : ' · ' + camWord(routes.avoidExp)) + '</div>' + note;
      return;
    }

    // One control, two options, each showing what it costs. Two full-width
    // cards said the same thing in twice the height.
    function opt(key, r, exp) {
      var plural = function (n) { return n > 1 ? 's' : ''; };

      // Each option is named by what it does with the cameras, so the two read
      // as a choice rather than as two labels with counts bolted on. Naming it
      // twice ("Avoiding" above "avoiding 1 camera") was the redundancy this
      // replaces.
      //
      // The avoiding route reports how many it DODGES, measured against the
      // fastest route; the fastest reports how many it DRIVES PAST. Where no
      // camera-free route exists the search falls back to fewest exposures, so
      // that route can still pass some: it says "passing" plainly rather than
      // claiming an avoidance it did not achieve.
      var label;
      if (key === 'avoid') {
        label = exp > 0 ? 'Passing ' + exp + ' camera' + plural(exp)
          : saved > 0 ? 'Avoiding ' + saved + ' camera' + plural(saved)
          : 'No cameras';
      } else {
        label = exp === 0 ? 'No cameras'
          : 'Traversing ' + exp + ' camera' + plural(exp);
      }

      return '<button type="button" class="' + key +
        (selected === key ? ' on' : '') + '" data-key="' + key + '">' +
        '<span class="rt-top"><span class="sw ' + key + '"></span>' +
        label + '</span>' +
        '<span class="rt-sub">' + fmtMi(r.meters) + ' \u00b7 ' + fmtMin(r.seconds) + '</span>' +
        '</button>';
    }
    var html = '<div class="route-toggle">' +
      opt('avoid', avoid, routes.avoidExp) +
      opt('fast', fast, routes.fastExp) + '</div>';

    if (saved > 0) {
      var cost;
      if (noRealSaving(fast, avoid)) cost = 'and costs you nothing';
      else {
        var parts = [];
        if (dMi > .05) parts.push(dMi.toFixed(1) + ' mi');
        if (dMin > .5) parts.push(Math.round(dMin) + ' min');
        cost = 'for an extra ' + parts.join(' and ');
      }
      // The cost line is the avoiding route's price tag, so it sits directly
      // under the two buttons and only while that route is the selection.
      // With Fastest selected it would be arguing with the reader's choice.
      if (selected === 'avoid') {
        html += '<div class="verdict">Going around them ' +
          (cost === 'and costs you nothing' ? 'costs you nothing'
                                            : cost.replace(/^for /, 'costs ')) + '.</div>';
      }
    }
    $('routes').innerHTML = html;
    Array.prototype.forEach.call($('routes').querySelectorAll('button[data-key]'), function (b) {
      b.onclick = function () { selected = b.dataset.key; renderAll(false); };
    });
  }

  // A glyph per manoeuvre, read off the instruction text. Faster to scan
  // than a numbered list, and it survives being read at arm's length.
  function turnGlyph(text) {
    if (/^Head/i.test(text)) return '\u2191';
    if (/sharp right/i.test(text)) return '\u21b1';
    if (/sharp left/i.test(text)) return '\u21b0';
    if (/turn right/i.test(text)) return '\u2192';
    if (/turn left/i.test(text)) return '\u2190';
    if (/bear right/i.test(text)) return '\u2197';
    if (/bear left/i.test(text)) return '\u2196';
    if (/u-turn/i.test(text)) return '\u21ba';
    return '\u2191';
  }

  function renderSteps() {
    var r = routes[selected];
    var steps = r.steps || graph.steps(r);
    var html = '<ol class="steps">' + steps.map(function (st) {
      var dist = st.meters ? '<span class="sd">' +
        (st.meters < 160 ? Math.round(st.meters * 3.28084) + ' ft'
                         : (st.meters / 1609.34).toFixed(1) + ' mi') + '</span>' : '';
      var cam = st.cameras.length
        ? '<span class="scam">' + st.cameras.length + ' camera' +
          (st.cameras.length > 1 ? 's' : '') + '</span>' : '';
      return '<li data-i="' + steps.indexOf(st) + '"' + (st.arrive ? ' class="arrive"' : '') +
        ' title="Show this part of the route on the map">' +
        (st.arrive ? '' : '<span class="glyph">' + turnGlyph(st.text) + '</span>') +
        '<span class="stext">' + esc(st.text) + '</span>' + dist + cam + '</li>';
    }).join('') + '</ol>' +
    '';
    $('steps').innerHTML = html;

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
          originArrow = marker(st.points[0], 'origin', null, hb);
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
    $('unavoid').innerHTML = '<div class="unavoid">There is no way to reach this ' +
      'destination without passing ' + exp + ' known camera' + (exp > 1 ? 's' : '') +
      ', on ' + esc(Object.keys(names).join(', ')) + '. This route passes the fewest it can.</div>';
  }

  // ---- camera source: cached is the floor, live may only ADD -----------

  function setSrcNote(text, bad) {
    var el = $('srcNote');
    el.innerHTML = text;
    el.className = 'src-note' + (bad ? ' bad' : '');
  }

  function cityCameras(list) {
    return (list || []).filter(function (c) { return insideCity(c.lat, c.lng); });
  }

  function useCached() {
    liveState = 'idle';
    $('srcCached').classList.add('on'); $('srcLive').classList.remove('on');
    $('srcCached').disabled = false; $('srcLive').disabled = false;
    cameras = cityCameras(cachedCameras);
    graph.assignCameras(cameras);
    reroute(true);
    setSrcNote('Cached list: ' + cameras.length + ' cameras in the city. Complete as published.');
  }

  function tryLive() {
    liveState = 'loading';
    $('srcLive').classList.add('on'); $('srcCached').classList.remove('on');
    $('srcLive').disabled = true; $('srcCached').disabled = false;
    setSrcNote('<span class="spin"></span>Asking OpenStreetMap for the current list…');

    liveOverpass().then(function (live) {
      $('srcLive').disabled = false;
      if (!live) return liveFailed('OpenStreetMap did not answer.');
      if (live.length < cachedCameras.length) {
        return liveFailed('OpenStreetMap returned only ' + live.length + ' cameras, ' +
          'fewer than the ' + cachedCameras.length + ' already cached, so the answer ' +
          'looks incomplete.');
      }
      var byId = {};
      cachedCameras.forEach(function (c) { byId[c.id] = c; });
      live.forEach(function (c) { byId[c.id] = byId[c.id] || c; });
      var merged = Object.keys(byId).map(function (k) { return byId[k]; });
      cameras = cityCameras(merged);
      var added = cameras.length - cityCameras(cachedCameras).length;
      liveState = 'live';
      graph.assignCameras(cameras);
      reroute(true);
      setSrcNote('Live from OpenStreetMap: ' + cameras.length + ' cameras in the city' +
        (added > 0 ? ', ' + added + ' newer than the cache' : ', same as the cache') + '.');
    });
  }

  // Failing back to the cache is always safe, because the cache is complete:
  // it can only ever show MORE than a broken live answer, never fewer.
  function liveFailed(why) {
    liveState = 'failed';
    $('srcCached').classList.add('on'); $('srcLive').classList.remove('on');
    cameras = cityCameras(cachedCameras);
    graph.assignCameras(cameras);
    reroute(true);
    setSrcNote(why + ' Showing the cached list of ' + cameras.length +
      ' in the city instead, which is complete, so you are not seeing fewer ' +
      'cameras than you should. Flip to OSM to retry.', true);
  }

  function reroute(keepView) {
    if (!current) { drawCameras(); return; }
    var b = keepView ? map.getBounds() : null;
    routeTo(current, destChoice && destChoice.kind);
    if (b) map.fitBounds(b, { animate: false });
  }

  function liveOverpass() {
    var bb = cachedMeta.bbox;
    var ql = '[out:json][timeout:60];(' +
      'node["surveillance:type"="ALPR"](' + bb.join(',') + ');' +
      'way["surveillance:type"="ALPR"](' + bb.join(',') + '););out center tags;';
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 25000);
    return fetch('https://overpass-api.de/api/interpreter',
      { method: 'POST', body: 'data=' + encodeURIComponent(ql), signal: ctl.signal })
      .then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error('http'); return r.json(); })
      .then(function (j) {
        if (j.remark && /timed out|truncated/i.test(j.remark)) return null;
        return (j.elements || []).map(function (el) {
          var lat = el.lat != null ? el.lat : (el.center && el.center.lat);
          var lng = el.lon != null ? el.lon : (el.center && el.center.lon);
          if (lat == null) return null;
          var t = el.tags || {};
          return { id: el.type[0] + el.id, lat: lat, lng: lng, operator: t.operator,
                   zone: t['surveillance:zone'] || t.surveillance };
        }).filter(Boolean);
      }).catch(function () { clearTimeout(timer); return null; });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
