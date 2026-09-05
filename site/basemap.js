/* Self-drawn basemap.
 * Released into the public domain under the Unlicense, see UNLICENSE.
 *
 * Draws the map from files the page already holds: the road geometry in
 * graph.json, plus water, parks and rail in landcover.json. No tiles, so no
 * request leaves the browser to draw the map, which is the whole point of the
 * tool and something a raster basemap cannot offer at any quality.
 *
 * Rendered to a single canvas via Leaflet's Layer API rather than as SVG
 * paths: 10,521 streets as DOM nodes would crawl on a phone.
 */
(function (root) {
  'use strict';

  // Cartographic hierarchy, keyed by the class stamped in build_graph.py.
  // Width is in screen pixels and grows with zoom, so the map thins out when
  // you pull back instead of turning into a solid mat of lines.
  var CLASS = {
    1: { name: 'motorway', w: [1.6, 2.6, 5.0, 7.0], minZ: 9,  casing: 1.6 },
    2: { name: 'primary',  w: [1.0, 2.0, 3.6, 5.4], minZ: 10, casing: 1.3 },
    3: { name: 'arterial', w: [0.7, 1.4, 2.8, 4.2], minZ: 11, casing: 1.1 },
    4: { name: 'collector',w: [0.5, 1.0, 2.2, 3.4], minZ: 12, casing: 1.0 },
    5: { name: 'local',    w: [0,   0.6, 1.6, 2.6], minZ: 13, casing: 0.9 },
    6: { name: 'private',  w: [0,   0,   0.9, 1.6], minZ: 15, casing: 0    }
  };

  // Interpolate a width across zoom stops 10 / 13 / 15 / 17.
  var ALLEY = /\bALY\b|\bALLEY\b/i;
  // Ramps have long distinct names ("US-131 NB TO I-196 EB RAMP") that carpet
  // every interchange while telling a reader nothing a freeway label has not.
  var RAMP = /\bRAMP\b/i;

  var STOPS = [10, 13, 15, 17];
  function widthFor(cls, z) {
    var w = CLASS[cls] ? CLASS[cls].w : CLASS[5].w;
    if (z <= STOPS[0]) return w[0];
    if (z >= STOPS[3]) return w[3] * Math.pow(1.18, z - STOPS[3]);
    for (var i = 1; i < STOPS.length; i++) {
      if (z <= STOPS[i]) {
        var t = (z - STOPS[i - 1]) / (STOPS[i] - STOPS[i - 1]);
        return w[i - 1] + (w[i] - w[i - 1]) * t;
      }
    }
    return w[3];
  }

  function palette(dark) {
    return dark ? {
      land:   '#20242c',
      water:  '#18303f',
      green:  '#1e2a24',
      rail:   '#333a45',
      casing: '#161a21',
      road: { motorway: '#4a5361', primary: '#3e4652', arterial: '#373e49',
              collector: '#333944', local: '#2e343e', private: '#282d36' },
      label:  '#c3ccd8', labelHalo: '#12161d', labelRoute: '#ffffff',
      wardHue: { '1': 265, '2': 190, '3': 32 },
      wardSat: 54, wardL: 50, wardLStep: 10, wardAlpha: .26,
      precinct: '#b5a6f0', precinctActive: '#ffffff',
      precinctHalo: 'rgba(10,13,18,.8)',
      precinctFill: 'rgba(139,131,176,.12)',
      boundary: '#4a5361'
    } : {
      // The land tone is pulled down from near-white so white roads actually
      // register against it; at #f4f3ef the local streets disappeared.
      land:   '#e9e6df',
      water:  '#bcd6e6',
      green:  '#d7e3cf',
      rail:   '#c9c5bc',
      casing: '#d5d1c7',
      road: { motorway: '#f0c97a', primary: '#fdf6e6', arterial: '#ffffff',
              collector: '#ffffff', local: '#ffffff', private: '#f0ede6' },
      label:  '#4a4640', labelHalo: '#ffffff', labelRoute: '#1d1b17',
      wardHue: { '1': 265, '2': 190, '3': 32 },
      wardSat: 60, wardL: 46, wardLStep: 11, wardAlpha: .22,
      precinct: '#6d4fa8', precinctActive: '#3f1f86',
      precinctHalo: 'rgba(255,255,255,.85)',
      precinctFill: 'rgba(124,108,168,.08)',
      boundary: '#a9a496'
    };
  }

  // Highways read as shields on a real map, not as words. "I-196 FWY" and
  // "US-131 FWY" set in the same type as a residential street is why they
  // disappear into the network. Returns null for an ordinary street.
  function shieldFor(name) {
    var m = String(name || '').toUpperCase()
      .match(/^(I|US|M)[-\s]?(\d+)\b/);
    if (!m) return null;
    return { kind: m[1], num: m[2] };
  }

  // Draw a route shield centred on x,y. Interstates get the blue and red
  // marker, US routes a white escutcheon, state routes a plain square.
  function drawShield(ctx, sh, x, y, dark) {
    var num = sh.num, wide = num.length > 2;
    var w = wide ? 26 : 21, h = 17, r = 3;
    ctx.save();
    ctx.translate(x, y);
    ctx.font = '700 ' + (wide ? 10 : 11) + 'px "Hanken Grotesk", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    function box(fill, stroke, lw) {
      ctx.beginPath();
      var x0 = -w / 2, y0 = -h / 2;
      ctx.moveTo(x0 + r, y0);
      ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
      ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
      ctx.arcTo(x0, y0 + h, x0, y0, r);
      ctx.arcTo(x0, y0, x0 + w, y0, r);
      ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1.5; ctx.stroke(); }
    }

    ctx.globalAlpha = 0.82;
    if (sh.kind === 'I') {
      box('#2c4a86', '#ffffff', 1.4);
      ctx.fillStyle = '#b34a5c';                       // the red cap
      ctx.fillRect(-w / 2 + 1.6, -h / 2 + 1.6, w - 3.2, 3.6);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(num, 0, 2);
    } else {
      box(dark ? '#dcd9d2' : '#fbfaf7', '#6b6d73', 1.3);
      ctx.fillStyle = '#3a3d44';
      ctx.fillText(num, 0, 0.5);
    }
    ctx.restore();
  }

  // Which occupancy cells a rotated text run covers. Sampled along the
  // baseline rather than computed as a rotated rectangle: the sampling is
  // cheap, and a label only needs to reserve roughly what it covers.
  // Half the camera marker's footprint, in CSS pixels. MEASURED from the live
  // icon (58x58, because the box includes the direction cone) rather than
  // guessed. Both things drawn on the label canvas, street names and precinct
  // numbers, clear this radius, and they read it from here so the two passes
  // cannot drift apart.
  var MARKER_R = 29;

  function spanCells(mx, my, ang, tw, fontPx, CELL) {
    var out = [], seen = {};
    var half = tw / 2, cosA = Math.cos(ang), sinA = Math.sin(ang);
    var steps = Math.max(2, Math.ceil(tw / (CELL * 0.55)));
    for (var i = 0; i <= steps; i++) {
      var t = -half + (tw * i / steps);
      var x = mx + t * cosA, y = my + t * sinA;
      for (var s2 = -1; s2 <= 1; s2 += 2) {            // a little vertical body
        var ox = x - s2 * (fontPx * 0.34) * sinA;
        var oy = y + s2 * (fontPx * 0.34) * cosA;
        var k = Math.round(ox / CELL) + ':' + Math.round(oy / CELL);
        if (!seen[k]) { seen[k] = 1; out.push(k); }
      }
    }
    return out;
  }

  // Street names arrive in the data as ALL CAPS, which shouts on a map.
  function titleCase(s) {
    return s.toLowerCase().replace(/\b([a-z])/g, function (m, c) {
      return c.toUpperCase();
    }).replace(/\b(Se|Sw|Ne|Nw)\b/g, function (m) { return m.toUpperCase(); });
  }

  var BasemapLayer = L.Layer.extend({
    initialize: function (opts) {
      this._graph = opts.graph;
      this._land = opts.landcover || null;
      this._dark = !!opts.dark;
      this._buckets = null;
    },

    setDark: function (d) { this._dark = !!d; this._redraw(); },

    // Street names used by the current route. They are labeled before
    // anything else, because a step that says "turn right onto Jefferson"
    // is worthless if Jefferson is the one street on screen without a name.
    // Precinct boundaries, drawn by default. This is a voting tool: the lines
    // that decide where you vote should be visible before you have asked
    // anything, not only after a lookup.
    setPrecincts: function (list) {
      this._precincts = list || null;
      this._redraw();
    },

    // Which of the precinct overlays are drawn. Three wards of twenty-ish
    // precincts each is a lot of ink for someone who only wants the route,
    // so every piece of it can be switched off.
    setLayerOpts: function (o) {
      this._opts = o || {};
      this._redraw();
    },

    // The precinct the current answer belongs to, filled so it reads as
    // "this one is yours" among fifty-nine identical outlines.
    setActivePrecinct: function (id) {
      this._activePrecinct = id == null ? null : String(id);
      this._redraw();
    },

    // Points the label grid must keep clear. Camera markers are DOM elements
    // sitting on top of this canvas, so the grid cannot see them and would
    // happily place a street name directly under one. Feeding their positions
    // in lets the names avoid them the same way they avoid each other.
    setObstacles: function (pts) {
      this._obstacles = pts && pts.length ? pts : null;
      this._redraw();
    },

    setRouteStreets: function (names, pts) {
      this._routeStreets = {};
      (names || []).forEach(function (n) {
        if (n) this._routeStreets[String(n).toUpperCase()] = 1;
      }, this);
      // The route's own geometry, so a route street can be named ON the
      // stretch actually driven. Naming the right street on a block a
      // quarter mile past the turn is technically correct and no help.
      this._routePts = pts || null;
      this._redraw();
    },
    setData: function (graph, land) {
      this._graph = graph; this._land = land; this._buckets = null; this._redraw();
    },

    onAdd: function (map) {
      this._map = map;

      // Ground goes in the tile pane, BELOW the route. Labels go in a pane of
      // their own above the overlay pane, so the route cannot paint over the
      // street names. Drawing both on one canvas is what made the names
      // vanish under the green line, which is also the answer to "is the
      // route helping": it was hiding the thing you were reading.
      this._canvas = L.DomUtil.create('canvas', 'basemap-canvas');
      this._canvas.style.position = 'absolute';
      map.getPane('tilePane').appendChild(this._canvas);

      if (!map.getPane('basemapLabels')) {
        var lp = map.createPane('basemapLabels');
        lp.style.zIndex = 450;             // overlayPane is 400, markers 600
        lp.style.pointerEvents = 'none';
      }
      this._labelCanvas = L.DomUtil.create('canvas', 'basemap-labels');
      this._labelCanvas.style.position = 'absolute';
      map.getPane('basemapLabels').appendChild(this._labelCanvas);

      // Leaflet fires `move` continuously while panning. Redrawing per event
      // meant several full canvas passes inside one frame, all but the last
      // discarded. Coalescing to one per animation frame keeps panning smooth
      // without changing what ends up on screen.
      // Only redraw when the map SETTLES. During a drag Leaflet translates
      // the pane, and these canvases are children of panes, so they move with
      // it for free. Redrawing on every `move` event repainted 10,000 roads
      // per frame and held panning to about 20fps.
      //
      // The canvases are drawn PADDED beyond the viewport so a pan reveals
      // ground that is already there instead of blank edges. Same approach as
      // Leaflet's own canvas renderer.
      this._schedule = this._schedule.bind(this);
      map.on('zoomend moveend viewreset resize', this._schedule, this);
      map.on('zoomanim', this._onZoomAnim, this);
      this._redraw();
    },

    onRemove: function (map) {
      map.off('zoomend moveend viewreset resize', this._schedule, this);
      map.off('zoomanim', this._onZoomAnim, this);
      if (this._raf) cancelAnimationFrame(this._raf);
      [this._canvas, this._labelCanvas].forEach(function (c) {
        if (c && c.parentNode) c.parentNode.removeChild(c);
      });
    },

    // Group edges by class once, so each frame is a few long paths per class
    // rather than 10,521 individual strokes with style changes between them.
    _bucket: function () {
      if (!this._graph) return {};
      if (this._buckets) return this._buckets;
      var b = {};
      var edges = this._graph.edges;
      for (var i = 0; i < edges.length; i++) {
        var c = edges[i].c || 5;
        (b[c] || (b[c] = [])).push(edges[i].p);
      }
      this._buckets = b;
      return b;
    },

    // A zoom animation scales the pane under us; hide until the redraw lands
    // rather than showing stretched roads.
    _onZoomAnim: function () {
      if (this._canvas) this._canvas.style.opacity = '0';
      if (this._labelCanvas) this._labelCanvas.style.opacity = '0';
    },

    _schedule: function () {
      if (this._raf) return;
      var self = this;
      this._raf = requestAnimationFrame(function () {
        self._raf = 0;
        self._redraw();
      });
    },

    _redraw: function () {
      if (!this._map || !this._canvas) return;
      var map = this._map, cv = this._canvas;
      var size = map.getSize();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);

      var lc = this._labelCanvas;
      var PAD = 0.35;                                  // of a viewport, each side
      var padX = Math.round(size.x * PAD), padY = Math.round(size.y * PAD);
      var cw = size.x + padX * 2, ch = size.y + padY * 2;
      [cv, lc].forEach(function (c) {
        if (!c) return;
        if (c.width !== cw * dpr || c.height !== ch * dpr) {
          c.width = cw * dpr; c.height = ch * dpr;
          c.style.width = cw + 'px'; c.style.height = ch + 'px';
        }
        c.style.opacity = '1';
      });
      var tl = map.containerPointToLayerPoint([0, 0]);
      var origin = L.point(tl.x - padX, tl.y - padY);
      L.DomUtil.setPosition(cv, origin);
      if (lc) L.DomUtil.setPosition(lc, origin);

      var ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      var lctx = lc ? lc.getContext('2d') : null;
      if (lctx) {
        lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        lctx.clearRect(0, 0, cw, ch);
      }

      var P = palette(this._dark), z = map.getZoom();

      // Publish the swatch colours the legend needs, from the palette the map
      // is about to draw with. The legend used to hardcode them, which meant
      // it showed the light theme's dark purple on the dark theme's dark
      // background. Reading them from here is the only way the key and the
      // map cannot disagree. Wards are published solid: on the map they are
      // translucent fills lying over streets, but a key has nothing beneath
      // it and the map alpha renders as a washed-out smear at swatch size.
      try {
        var rs = document.documentElement.style;
        rs.setProperty('--lg-precinct', P.precinct);
        for (var wk in P.wardHue) {
          if (!Object.prototype.hasOwnProperty.call(P.wardHue, wk)) continue;
          rs.setProperty('--lg-ward' + wk,
            'hsl(' + P.wardHue[wk] + ',' + P.wardSat + '%,' + P.wardL + '%)');
        }
      } catch (e) {}

      var origin = map.getPixelOrigin(), pane = map.getPixelBounds().min;

      // Project [lat,lng] -> canvas px with a precomputed linear transform.
      //
      // Leaflet's latLngToLayerPoint was the single biggest cost in the whole
      // page: it re-derives the projection and allocates a Point for every
      // coordinate, and a redraw touches roughly 60,000 of them. At a fixed
      // zoom the transform is constant, so it is computed once per frame and
      // each point becomes a multiply and a subtract.
      var ctr = map.getCenter();
      var halfX = cw / 2, halfY = ch / 2;
      var RAD = Math.PI / 180;
      var xScale = 256 * Math.pow(2, z) / 360;     // px per degree of longitude
      var yScale = 256 * Math.pow(2, z) / (2 * Math.PI);
      function mercY(lat) {
        return Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2));
      }
      var cX = ctr.lng * xScale, cY = mercY(ctr.lat) * yScale;
      function pt(p) {
        return [(p[1] * xScale - cX) + halfX, (cY - mercY(p[0]) * yScale) + halfY];
      }

      ctx.fillStyle = P.land;
      ctx.fillRect(0, 0, cw, ch);

      // Before the data arrives there is nothing to draw but the ground.
      if (!this._graph) return;

      // ---- landcover ----
      if (this._land) {
        this._fillRings(ctx, this._land.green, P.green, pt);
        this._fillRings(ctx, this._land.water, P.water, pt);
        this._strokeLines(ctx, this._land.waterways, P.water,
                          Math.max(0.8, widthFor(4, z) * 0.9), pt);
        if (z >= 13) {
          this._strokeLines(ctx, this._land.rail, P.rail,
                            Math.max(0.5, widthFor(5, z) * 0.7), pt);
        }
      }

      // ---- roads: casing pass, then fill pass, so junctions look joined ----
      var buckets = this._bucket();
      var order = [6, 5, 4, 3, 2, 1];
      var i, cls, w;
      for (i = 0; i < order.length; i++) {
        cls = order[i]; w = widthFor(cls, z);
        if (w <= 0 || z < CLASS[cls].minZ) continue;
        // NOT `cw`: that is the canvas width, and `var` hoists to function
        // scope, so reusing the name here silently overwrote it. Every label
        // on the map then failed its bounds check against a 5px-wide
        // viewport and nothing was drawn.
        var casingW = w + (CLASS[cls].casing || 0) * 2;
        this._strokePaths(ctx, buckets[cls], P.casing, casingW, pt);
      }
      for (i = 0; i < order.length; i++) {
        cls = order[i]; w = widthFor(cls, z);
        if (w <= 0 || z < CLASS[cls].minZ) continue;
        this._strokePaths(ctx, buckets[cls],
                          P.road[CLASS[cls].name] || P.road.local, w, pt);
      }

      // ---- precinct boundaries, OVER the roads ----
      // Precinct lines follow streets, so drawing them beneath the road
      // fill hid them completely: the casing painted straight over every
      // boundary. They belong above the roads and below the route.
      var O = this._opts || {};
      if (this._precincts && (O.wards || O.precincts !== false)) {
        var act = this._activePrecinct;

        // Ward colour first, precinct shade within it.
        //
        // There are only three wards, so each gets a hue of its own and they
        // are told apart at a glance. There are fifty-nine precincts, which is
        // far too many for distinct colours, so each takes a lightness step off
        // its ward's hue instead. A precinct then reads as different from the
        // one beside it while the ward still reads as one area.
        //
        // The step is keyed on the precinct number rather than its position in
        // the ward, because precincts are numbered in blocks per ward and
        // consecutive numbers tend to sit next to each other. Stepping by
        // number is therefore what makes NEIGHBOURS differ, which is the whole
        // point.
        if (O.wards) {
          for (var wi = 0; wi < this._precincts.length; wi++) {
            var wp = this._precincts[wi];
            var hue = P.wardHue[String(wp.ward)];
            if (hue == null) hue = P.wardHue['1'];
            var lift = (Number(wp.precinct) % 5) * P.wardLStep;
            this._fillRings(ctx, wp.rings,
              'hsla(' + hue + ',' + P.wardSat + '%,' + (P.wardL + lift) + '%,' +
              P.wardAlpha + ')', pt);
          }
        }
        if (act) {
          for (var pi = 0; pi < this._precincts.length; pi++) {
            if (String(this._precincts[pi].precinct) !== act) continue;
            this._fillRings(ctx, this._precincts[pi].rings, P.precinctFill, pt);
          }
        }
        // Drawn to actually be seen. At 1px and 55% alpha these were present
        // in the canvas and invisible on the screen, which is the same thing
        // as missing. A light halo underneath lifts them off the roads they
        // run along.
        ctx.save();
        ctx.setLineDash([7, 5]);
        ctx.lineCap = 'butt';
        for (var pj = 0; O.precincts !== false && pj < this._precincts.length; pj++) {
          var isAct = act && String(this._precincts[pj].precinct) === act;
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = P.precinctHalo;
          ctx.lineWidth = (isAct ? 4.5 : 3.4);
          this._strokeRings(ctx, this._precincts[pj].rings, pt);
          ctx.globalAlpha = isAct ? 1 : 0.92;
          ctx.strokeStyle = P.precinct;
          ctx.lineWidth = isAct ? 2.6 : 1.7;
          this._strokeRings(ctx, this._precincts[pj].rings, pt);
        }
        ctx.restore();
      }

      // What the precinct pass actually drew, in screen pixels, for _labels
      // to avoid. Cleared on EVERY render and outside the guard below: when
      // numbers are switched off or the zoom is too low, nothing is drawn and
      // the list has to be empty rather than describing the previous view.
      this._precinctBoxes = [];

      // Precinct numbers go on the LABEL canvas, above the route, so the
      // green line cannot cover the number of the precinct it runs through.
      if (lctx && this._precincts && z >= 12 && (this._opts || {}).numbers !== false) {
        var actP = this._activePrecinct;
        // Precinct numbers share the label canvas with the street names, and
        // this pass runs BEFORE _labels, so it cannot inherit that pass's
        // collision work and has to clear the markers itself. Missing this is
        // what left numbers sitting on cameras after the street names had
        // already been fixed.
        var obsN = (this._obstacles || []).map(pt);
        lctx.save();
        lctx.textAlign = 'center';
        lctx.textBaseline = 'middle';
        lctx.lineJoin = 'round';
        for (var pn = 0; pn < this._precincts.length; pn++) {
          var pr = this._precincts[pn];
          if (!pr.label) continue;
          var lp = pt(pr.label);
          if (lp[0] < 12 || lp[0] > cw - 12 || lp[1] < 12 || lp[1] > ch - 12) continue;
          var isA = actP && String(pr.precinct) === actP;
          // The word, not just the digit: a bare "15" floating on a map
          // could be anything; "Precinct 15" says what it is. Smaller than
          // the digits were, since the word carries more ink. From z14 the
          // word fits; wider out, the label would shout over whole blocks,
          // so it stays a digit there.
          var txt = z >= 14 ? 'Precinct ' + pr.precinct : String(pr.precinct);
          var fs = z >= 15 ? 13 : z >= 13 ? 12 : 11;
          lctx.font = (isA ? '800 ' : '700 ') + (isA ? fs + 1 : fs) +
            'px "Hanken Grotesk", system-ui, sans-serif';
          // Box test against the markers: the label is centred, so its reach
          // is half its own width, and a distance test around the anchor
          // alone would let a long word bleed into a marker sideways.
          var tw = lctx.measureText(txt).width;
          var nClash = false;
          for (var oq = 0; oq < obsN.length; oq++) {
            var ndx = Math.abs(lp[0] - obsN[oq][0]), ndy = Math.abs(lp[1] - obsN[oq][1]);
            if (ndx < MARKER_R + tw / 2 + 2 && ndy < MARKER_R + fs * 0.8) { nClash = true; break; }
          }
          if (nClash) continue;
          lctx.strokeStyle = P.labelHalo || P.land;
          lctx.lineWidth = 4;
          lctx.strokeText(txt, lp[0], lp[1]);
          lctx.fillStyle = isA ? P.precinctActive : P.precinct;
          lctx.fillText(txt, lp[0], lp[1]);
          // Record it only here, once it is definitely on the canvas. Boxes
          // for labels that were skipped would reserve space nothing occupies
          // and push street names off good blocks for no reason.
          this._precinctBoxes.push({ x: lp[0], y: lp[1], hw: tw / 2, hh: fs * 0.7 });
        }
        lctx.restore();
      }

      if (lctx) this._labels(lctx, P, z, { x: cw, y: ch }, pt);
    },

    // Street names. Without them this is a diagram rather than a map: you can
    // see the shape of the city but cannot tell anyone which road to take.
    //
    // One label per street name per screen, placed on its longest visible run
    // and rotated to follow it, with a coarse occupancy grid so names do not
    // pile up on each other. Which classes get labelled rises with zoom.
    _labels: function (ctx, P, z, size, pt) {
      if (z < 10 || !this._graph) return;
      // Label more of the network sooner. At z13-14 only arterials were named,
      // which is most of a city with no names on it.
      // Local streets from z14, not z15. At street zoom a reader expects
      // every road they can see to be named; holding locals back one whole
      // level is what left most of the map anonymous.
      var maxCls = z >= 14 ? 5 : z >= 13 ? 4 : 3;
      var edges = this._graph.edges;
      // Up to three candidate blocks per street name, ranked by how close
      // they sit to the screen center. The old rule kept only the LONGEST
      // block city-wide, which for long north-south avenues was usually off
      // screen or clipped by the edge margin, so vertical streets lost their
      // labels; the center-most visible block is the one a reader wants
      // named anyway.
      var best = {};
      var cx = size.x / 2, cy = size.y / 2;
      var route = this._routeStreets || {};
      var routeScreen = null;
      if (this._routePts && this._routePts.length) {
        routeScreen = [];
        for (var rr = 0; rr < this._routePts.length; rr++) {
          routeScreen.push(pt(this._routePts[rr]));
        }
      }

      for (var i = 0; i < edges.length; i++) {
        var e = edges[i];
        if (!e.n || (e.c || 5) > maxCls || ALLEY.test(e.n) || RAMP.test(e.n)) continue;
        var p = e.p, a = pt(p[0]), b = pt(p[p.length - 1]);
        if ((a[0] < 0 && b[0] < 0) || (a[0] > size.x && b[0] > size.x) ||
            (a[1] < 0 && b[1] < 0) || (a[1] > size.y && b[1] > size.y)) continue;
        var dx = b[0] - a[0], dy = b[1] - a[1];
        var len = Math.sqrt(dx * dx + dy * dy);
        // A name needs a long block to sit along; a shield only needs to fit
        // across the road, so freeway blocks qualify at a much shorter run.
        // Filtering both at 42px is what left US-131 unlabelled when zoomed
        // out, since ramps chop a freeway into short pieces.
        // How much on-screen road a name needs before it is worth trying.
        // Bigger roads earn a label on a shorter run, because naming the
        // arterial matters more than naming the side street beside it; and
        // everything relaxes as you zoom in. The old flat 42px at z13-15 is
        // what left those zooms almost entirely anonymous.
        var kls = e.c || 5;
        var minRun;
        if (kls === 1) minRun = 18;
        else if (kls <= 3) minRun = z >= 15 ? 22 : 28;
        else minRun = z >= 17 ? 22 : z >= 16 ? 26 : z >= 15 ? 30 : z >= 14 ? 34 : 40;
        if (len < minRun) continue;
        var mx0 = (a[0] + b[0]) / 2, my0 = (a[1] + b[1]) / 2;
        var d2 = (mx0 - cx) * (mx0 - cx) + (my0 - cy) * (my0 - cy);
        // For a street the route uses, rank by distance to the route line
        // instead of to the screen center.
        if (routeScreen && route[e.n]) {
          var rd = Infinity;
          for (var rp = 0; rp < routeScreen.length; rp++) {
            var ddx = routeScreen[rp][0] - mx0, ddy = routeScreen[rp][1] - my0;
            var dd = ddx * ddx + ddy * ddy;
            if (dd < rd) rd = dd;
          }
          // 30px of the line counts as "on it"; beyond that it sorts worse
          d2 = rd < 900 ? rd : 1e7 + rd;
        }
        var cand = { len: len, a: a, b: b, cls: e.c || 5, d2: d2 };
        var lst = best[e.n] || (best[e.n] = []);
        lst.push(cand);
        // Prefer blocks near the middle of the screen, but keep a deep bench:
        // a long avenue crossing the whole view has many blocks, and if the
        // first few fall in cells already claimed by cross streets the name
        // was being dropped entirely.
        lst.sort(function (x, y) { return x.d2 - y.d2; });
        if (lst.length > ((e.c || 5) === 1 ? 24 : 10)) {
          lst.length = (e.c || 5) === 1 ? 24 : 10;
        }
      }

      var names = Object.keys(best);
      names.sort(function (x, y) {
        // Route streets first, then bigger roads, then longer runs.
        var rx = route[x] ? 0 : 1, ry = route[y] ? 0 : 1;
        if (rx !== ry) return rx - ry;
        var d = best[x][0].cls - best[y][0].cls;
        return d !== 0 ? d : best[y][0].len - best[x][0].len;
      });

      // The collision grid tightens with zoom. One fixed cell size meant the
      // spacing that keeps a city-wide view readable also throttled a street
      // view, where there is room for far more names.
      var CELL = z >= 17 ? 34 : z >= 16 ? 40 : z >= 15 ? 46 : z >= 14 ? 54 : 62;
      var taken = {};

      // Claim the footprint of every visible marker BEFORE any name is placed,
      // so a street name is never drawn under a camera. Reserving up front
      // rather than checking afterwards means a blocked name moves to its next
      // candidate block instead of simply being dropped.
      var obstacles = this._obstacles || [];
      var obsPx = [];                    // on-screen obstacle centres, in pixels
      var OB = MARKER_R;
      for (var oi = 0; oi < obstacles.length; oi++) {
        var op = pt(obstacles[oi]);
        if (op[0] < -OB || op[0] > size.x + OB ||
            op[1] < -OB || op[1] > size.y + OB) continue;
        obsPx.push(op);
        var gx1 = Math.round((op[0] + OB) / CELL);
        var gy1 = Math.round((op[1] + OB) / CELL);
        for (var gx = Math.round((op[0] - OB) / CELL); gx <= gx1; gx++) {
          for (var gy = Math.round((op[1] - OB) / CELL); gy <= gy1; gy++) {
            taken[gx + ':' + gy] = 1;
          }
        }
      }
      // Precinct numbers are drawn on this same canvas by the pass that runs
      // just before this one, and it cannot see the names that do not exist
      // yet. So the avoidance has to happen from this side: reserve what it
      // drew before a single name is placed. Without this the two passes each
      // behaved correctly on their own and still printed over each other.
      var preBoxes = this._precinctBoxes || [];
      for (var pb = 0; pb < preBoxes.length; pb++) {
        var B = preBoxes[pb];
        var bx1 = Math.round((B.x + B.hw) / CELL), by1 = Math.round((B.y + B.hh) / CELL);
        for (var bx = Math.round((B.x - B.hw) / CELL); bx <= bx1; bx++) {
          for (var by = Math.round((B.y - B.hh) / CELL); by <= by1; by++) {
            taken[bx + ':' + by] = 1;
          }
        }
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';

      var wanted = names.length, shown = 0;
      for (var k = 0; k < names.length; k++) {
        var cands = best[names[k]];
        var onRoute = !!route[names[k]];
        var placed = 0;
        // Try each candidate block until one fits on screen, clears the
        // occupancy grid, and is long enough for its own name. A route street
        // may be named twice on a long run, so it stays identifiable as you
        // follow it across the view.
        for (var q = 0; q < cands.length; q++) {
          // One shield per highway per view. Three of them marching down
          // US-131 was clutter, and the routing never uses a freeway anyway:
          // these are context, so they should be findable, not loud.
          if (placed >= (onRoute ? 2 : 1)) break;
          var it = cands[q];
          var mx = (it.a[0] + it.b[0]) / 2, my = (it.a[1] + it.b[1]) / 2;
          if (mx < 16 || mx > size.x - 16 || my < 12 || my > size.y - 12) continue;
          var ang = Math.atan2(it.b[1] - it.a[1], it.b[0] - it.a[0]);
          if (ang > Math.PI / 2) ang -= Math.PI;      // keep text upright
          if (ang < -Math.PI / 2) ang += Math.PI;

          var sh = it.cls <= 2 ? shieldFor(names[k]) : null;
          if (sh) {
            // A shield sits upright across the road rather than running along
            // it, which is how every road map does it and how a driver reads
            // it at a glance.
            // Freeways are split at every ramp, so their on-screen blocks are
            // short when zoomed out. A shield sits ACROSS the road rather than
            // along it, so it needs far less room than a name would.
            if (it.len < 22) continue;
            var shx = Math.round(mx / CELL), shy = Math.round(my / CELL);
            // A shield is a solid badge, so it must not land on a name that is
            // already there. Claim the centre cell and its four neighbors,
            // which is roughly the badge's footprint.
            if (taken[shx + ':' + shy]) continue;
            // A shield is drawn on this same canvas, so it can cover a camera
            // exactly like a name can. It takes the same exact test, since the
            // single-cell check above is far coarser than the marker.
            var shClash = false;
            for (var so = 0; so < obsPx.length; so++) {
              var sdx = mx - obsPx[so][0], sdy = my - obsPx[so][1];
              var sreach = MARKER_R + 15;
              if (sdx * sdx + sdy * sdy < sreach * sreach) { shClash = true; break; }
            }
            if (shClash) continue;
            drawShield(ctx, sh, mx, my, this._dark);
            placed++;
            taken[shx + ':' + shy] = 1;
            taken[(shx + 1) + ':' + shy] = 1;
            taken[(shx - 1) + ':' + shy] = 1;
            taken[shx + ':' + (shy + 1)] = 1;
            taken[shx + ':' + (shy - 1)] = 1;
            continue;
          }
          var size_px = it.cls <= 2 ? 13.5 : it.cls === 3 ? 12.5 : 12;
          ctx.font = '600 ' + size_px + 'px "Hanken Grotesk", system-ui, sans-serif';
          var label = titleCase(names[k]);
          // The name may overrun the block it is anchored to. A block is an
          // arbitrary slice of a street that keeps going, so demanding the
          // text fit inside one was rejecting nearly every label at mid
          // zooms: "Plainfield Ave NE" is ~100px of text and a block at z13
          // is ~40px of road. Overflow is what every road map does.
          var tw = ctx.measureText(label).width;
          if (tw > it.len * 2.6 + 40) continue;

          // Reserve every cell the text actually covers, not just the one it
          // is anchored in. Once labels were allowed to overrun their block a
          // single-cell claim stopped describing the space they occupy, and
          // downtown names began printing over each other.
          var cells = spanCells(mx, my, ang, tw, size_px, CELL);
          var clash = false;
          for (var ci = 0; ci < cells.length; ci++) {
            if (taken[cells[ci]]) { clash = true; break; }
          }
          if (clash) continue;

          // Exact test against the markers, on top of the grid one.
          //
          // The grid works in cells of 34 to 62 pixels and a camera marker is
          // 58 across, so reserving whole cells cannot express the footprint
          // precisely: a name placed in the next cell along still bled into
          // the marker. Measured, that left two markers in eleven covered.
          // Walking the label's own baseline and rejecting any candidate that
          // passes within the marker's radius closes the gap exactly.
          if (obsPx.length) {
            var half = tw / 2, ca = Math.cos(ang), sa = Math.sin(ang);
            var reach = OB + size_px * 0.6;
            var samples = Math.max(2, Math.ceil(tw / 12));
            for (var oi2 = 0; oi2 < obsPx.length && !clash; oi2++) {
              for (var si = 0; si <= samples; si++) {
                var t = -half + (tw * si / samples);
                var lx = mx + ca * t, ly = my + sa * t;
                var dx = lx - obsPx[oi2][0], dy = ly - obsPx[oi2][1];
                if (dx * dx + dy * dy < reach * reach) { clash = true; break; }
              }
            }
            if (clash) continue;
          }

          // Exact test against the precinct words, on top of the grid one,
          // for the reason the markers need one: "Precinct 15" is about 75px
          // of text and a cell is 34 to 62, so whole-cell reservation cannot
          // describe the box. A rectangle rather than a radius, because this
          // label is a horizontal word and a circle round its centre would
          // both miss its ends and over-reserve above and below it.
          if (preBoxes.length) {
            var phalf = tw / 2, pca = Math.cos(ang), psa = Math.sin(ang);
            var psamples = Math.max(2, Math.ceil(tw / 12));
            for (var pi = 0; pi < preBoxes.length && !clash; pi++) {
              var PB = preBoxes[pi];
              var rx = PB.hw + 3, ry = PB.hh + size_px * 0.6;
              for (var pj = 0; pj <= psamples; pj++) {
                var pt2 = -phalf + (tw * pj / psamples);
                var px2 = mx + pca * pt2, py2 = my + psa * pt2;
                if (Math.abs(px2 - PB.x) < rx && Math.abs(py2 - PB.y) < ry) { clash = true; break; }
              }
            }
            if (clash) continue;
          }

          for (var cj = 0; cj < cells.length; cj++) taken[cells[cj]] = 1;
          ctx.save();
          ctx.translate(mx, my);
          ctx.rotate(ang);
          // A fat halo is what lets a name stay readable over a park, a
          // parking lot, or the route line now passing beneath it.
          ctx.strokeStyle = P.labelHalo || P.land;
          ctx.lineWidth = 4.5;
          ctx.strokeText(label, 0, 0);
          ctx.fillStyle = onRoute ? (P.labelRoute || P.label) : P.label;
          ctx.fillText(label, 0, 0);
          ctx.restore();
          placed++;
          if (placed === 1) shown++;
          // block the neighboring cells too, so a repeat is not adjacent
        }
      }
      this.labelCoverage = { wanted: wanted, shown: shown };
    },

    _strokeRings: function (ctx, rings, pt) {
      if (!rings) return;
      ctx.beginPath();
      for (var i = 0; i < rings.length; i++) {
        var r = rings[i];
        if (!r || r.length < 3) continue;
        var a = pt(r[0]);
        ctx.moveTo(a[0], a[1]);
        for (var j = 1; j < r.length; j++) {
          var b = pt(r[j]);
          ctx.lineTo(b[0], b[1]);
        }
        ctx.closePath();
      }
      ctx.stroke();
    },

    _fillRings: function (ctx, rings, color, pt) {
      if (!rings || !rings.length) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      for (var i = 0; i < rings.length; i++) {
        var r = rings[i];
        if (!r || r.length < 3) continue;
        var a = pt(r[0]);
        ctx.moveTo(a[0], a[1]);
        for (var j = 1; j < r.length; j++) {
          var b = pt(r[j]);
          ctx.lineTo(b[0], b[1]);
        }
        ctx.closePath();
      }
      ctx.fill('evenodd');
    },

    _strokeLines: function (ctx, lines, color, width, pt) {
      if (!lines || !lines.length) return;
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (!l || l.length < 2) continue;
        var a = pt(l[0]);
        ctx.moveTo(a[0], a[1]);
        for (var j = 1; j < l.length; j++) {
          var b = pt(l[j]);
          ctx.lineTo(b[0], b[1]);
        }
      }
      ctx.stroke();
    },

    _strokePaths: function (ctx, paths, color, width, pt) {
      if (!paths || !paths.length) return;
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (var i = 0; i < paths.length; i++) {
        var p = paths[i];
        if (!p || p.length < 2) continue;
        var a = pt(p[0]);
        ctx.moveTo(a[0], a[1]);
        for (var j = 1; j < p.length; j++) {
          var b = pt(p[j]);
          ctx.lineTo(b[0], b[1]);
        }
      }
      ctx.stroke();
    }
  });

  root.BasemapLayer = function (opts) { return new BasemapLayer(opts); };
})(typeof self !== 'undefined' ? self : this);
