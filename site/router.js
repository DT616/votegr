/* Client-side ALPR-aware route planner core.
 * Released into the public domain under the Unlicense, see UNLICENSE.
 *
 * No network, no framework. Loaded by index.html; also runnable under node
 * for tests (module.exports at the bottom).
 *
 * Cost model (the whole trick): cost = camerasPassed * CAMERA_PENALTY + seconds.
 * CAMERA_PENALTY is large enough that any camera-free route beats any faster
 * surveilled one -> hard exclusion where a clean route exists. Where none
 * exists, the SAME A* returns the fewest-cameras route -> min-exposure
 * fallback, no separate code path.
 */
(function (root) {
  'use strict';

  var CAMERA_PENALTY = 1e9;      // seconds-equivalent per camera passed
  var UTURN_PENALTY = 90;        // seconds; discourages, does not forbid

  // Turn costs, in seconds. Added after a differential test against OSRM
  // showed our routes zigzagging between fast streets that OSRM would not:
  // with no cost on turning, a grid city rewards constant lane-hopping. A
  // left costs more than a right because it waits to cross oncoming traffic.
  var TURN_STRAIGHT_DEG = 25;
  var TURN_COST_RIGHT = 6;
  var TURN_COST_LEFT = 12;
  var TURN_COST_SHARP = 25;

  function turnCost(fromBearing, toBearing) {
    var d = ((toBearing - fromBearing + 540) % 360) - 180;
    var a = Math.abs(d);
    if (a < TURN_STRAIGHT_DEG) return 0;
    if (a > 150) return TURN_COST_SHARP;
    return d > 0 ? TURN_COST_RIGHT : TURN_COST_LEFT;
  }
  var STANDOFF_M = 50;           // a camera "watches" edges within this radius

  function haversine(lat1, lng1, lat2, lng2) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toR) * Math.cos(lat2 * toR) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // ---- Graph wrapper ---------------------------------------------------

  function Graph(data) {
    this.nodes = data.nodes;          // [ [lat,lng], ... ]
    this.edges = data.edges;          // [ {a,b,d,l,t,n,r,z,p}, ... ]
    this.meta = data.meta || {};
    this._buildAdjacency();
    this._indexRestrictions(data.restrictions || []);
    this._maxSpeed = 31.3;            // ~70mph m/s, for the heuristic
  }

  // Turn restrictions, keyed "<fromEdge>|<viaNode>" so a lookup during search
  // is a single map hit. `no` lists turns that are forbidden; `only` lists the
  // single turn that is permitted, which forbids every other exit.
  Graph.prototype._indexRestrictions = function (list) {
    var idx = {};
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var k = r.f + '|' + r.v;
      var slot = idx[k] || (idx[k] = { no: null, only: null });
      if (r.no) (slot.no || (slot.no = {}))[r.t] = 1;
      else (slot.only || (slot.only = {}))[r.t] = 1;
    }
    this._restr = idx;
    this.restrictionCount = list.length;
  };

  // May a vehicle that arrived on fromEdge leave node via toEdge?
  Graph.prototype.turnAllowed = function (fromEdge, node, toEdge) {
    if (fromEdge == null) return true;          // start of the route
    // A U-turn stays legal, because on a dead-end street it is the only way
    // out, but it carries a time penalty at the cost function so the router
    // reaches for one only when it genuinely has to.
    if (fromEdge === toEdge) return true;
    var slot = this._restr && this._restr[fromEdge + '|' + node];
    if (!slot) return true;
    if (slot.no && slot.no[toEdge]) return false;
    if (slot.only && !slot.only[toEdge]) return false;
    return true;
  };

  // Directed adjacency: list of {to, edge, cost0} where cost0 is seconds only
  // (camera cost is added at search time so a new camera set needs no rebuild).
  Graph.prototype._buildAdjacency = function () {
    var adj = [];
    for (var i = 0; i < this.nodes.length; i++) adj.push([]);
    for (var ei = 0; ei < this.edges.length; ei++) {
      var e = this.edges[ei];
      // Freeways are excluded outright, not merely discouraged. A trip to a
      // polling place is a neighborhood trip: taking US-131 to vote saves a
      // minute at best, and surface streets are where the tool's camera
      // knowledge actually applies. Class 1 is the Act 51 freeway class.
      if (e.c === 1) continue;
      var p = e.p;
      if (p.length >= 2) {
        var fB = bearing(p[0], p[1]);
        var lB = bearing(p[p.length - 2], p[p.length - 1]);
        if (e.d === 0 || e.d === 1) {
          adj[e.a].push({ to: e.b, edge: ei, depB: fB, arrB: lB });
        }
        if (e.d === 0 || e.d === 2) {
          adj[e.b].push({ to: e.a, edge: ei,
                          depB: (lB + 180) % 360, arrB: (fB + 180) % 360 });
        }
      }
    }
    this.adj = adj;
  };

  // ---- Camera -> edge assignment (in the browser, per the design) ------

  // Grid index over edge vertices so each camera only tests nearby edges.
  Graph.prototype.assignCameras = function (cameras) {
    var CELL = 0.005; // ~500m in lat; good enough as a broad-phase bucket
    var grid = {};
    var key = function (la, ln) {
      return Math.round(la / CELL) + ':' + Math.round(ln / CELL);
    };
    // bucket edges by every vertex cell they touch
    for (var ei = 0; ei < this.edges.length; ei++) {
      var p = this.edges[ei].p, seen = {};
      for (var k = 0; k < p.length; k++) {
        var kk = key(p[k][0], p[k][1]);
        if (!seen[kk]) { seen[kk] = 1; (grid[kk] || (grid[kk] = [])).push(ei); }
      }
    }
    // reset any prior assignment
    this._edgeCams = [];
    for (var z = 0; z < this.edges.length; z++) this._edgeCams.push(null);
    // Display positions are worked out here too. This loop already walks the
    // edges near each camera, so finding the nearest point on the road costs
    // almost nothing; doing it separately meant a full-graph scan per camera.
    this._camSnap = {};

    for (var ci = 0; ci < cameras.length; ci++) {
      var cam = cameras[ci];
      var candidates = {};
      for (var dla = -1; dla <= 1; dla++) {
        for (var dln = -1; dln <= 1; dln++) {
          var cell = (Math.round(cam.lat / CELL) + dla) + ':' +
            (Math.round(cam.lng / CELL) + dln);
          var list = grid[cell];
          if (!list) continue;
          for (var m = 0; m < list.length; m++) candidates[list[m]] = 1;
        }
      }
      // One pass per candidate edge: the closest point is what decides both
      // whether the camera watches this edge and where to draw it. Walking
      // the segments twice, once for distance and once for the point, cost
      // more than the separate full scan it replaced.
      // Watch membership (routing) stays purely distance-based. The DISPLAY
      // snap does not: at a four-camera intersection every corner pole's
      // nearest road point is the same crossing, and the markers collapsed
      // into a pile (measured: poles 22 m apart drawn 4 m apart). A camera
      // that declares a facing prefers the road ALIGNED with that facing,
      // and its marker is seated a few metres along that approach, so the
      // group fans out onto the legs each camera actually reads.
      var faceRaw = cam.f && (cam.f.direction != null ? cam.f.direction : cam.f['camera:direction']);
      var face = (faceRaw != null && faceRaw !== '' && !isNaN(parseFloat(faceRaw)))
        ? parseFloat(faceRaw) : null;
      var bestSnap = null;
      for (var eid in candidates) {
        var poly = this.edges[eid].p, near = null, nearA = null, nearB = null;
        for (var sg = 0; sg < poly.length - 1; sg++) {
          var pr = projectOnSeg(cam.lat, cam.lng, poly[sg], poly[sg + 1]);
          if (!near || pr.d < near.d) { near = pr; nearA = poly[sg]; nearB = poly[sg + 1]; }
        }
        if (!near) continue;
        if (near.d <= STANDOFF_M) {
          (this._edgeCams[eid] || (this._edgeCams[eid] = [])).push(cam.id);
        }
        // Misalignment with the declared facing, 0..90, as a metre-priced
        // penalty: a road at right angles to the camera's view costs ~30 m,
        // so the cross street only wins when the facing road is not there.
        var score = near.d;
        if (face != null) {
          var segB = bearing(nearA, nearB);
          var diff = Math.abs(((segB - face) % 180 + 180) % 180);
          if (diff > 90) diff = 180 - diff;
          score += diff * 0.35;
        }
        if (!bestSnap || score < bestSnap.score) {
          bestSnap = { pt: near, score: score, d: near.d, A: nearA, B: nearB };
        }
      }
      var snap = null;
      if (bestSnap && bestSnap.d <= STANDOFF_M) {
        snap = [bestSnap.pt.lat, bestSnap.pt.lng];
        if (face != null) {
          // Seat the marker along the chosen segment in the direction the
          // camera faces, clamped to the segment, so corner poles step off
          // the shared junction point onto their own approaches.
          var segBrg = bearing(bestSnap.A, bestSnap.B);
          var d1 = Math.abs(((segBrg - face) % 360 + 360) % 360);
          if (d1 > 180) d1 = 360 - d1;
          var sign = d1 <= 90 ? 1 : -1;
          var target = sign > 0 ? bestSnap.B : bestSnap.A;
          var room = haversine(snap[0], snap[1], target[0], target[1]);
          var step = Math.min(12, room);
          if (room > 0.5) {
            var t = step / room;
            snap = [snap[0] + (target[0] - snap[0]) * t,
                    snap[1] + (target[1] - snap[1]) * t];
          }
        }
      }
      this._camSnap[cam.id] = snap || [cam.lat, cam.lng];
    }
    return this._edgeCams;
  };

  // point-to-polyline distance in meters (min over segments)
  Graph.prototype._distToEdge = function (lat, lng, poly) {
    var best = Infinity;
    for (var i = 0; i < poly.length - 1; i++) {
      var d = this._distToSeg(lat, lng, poly[i], poly[i + 1]);
      if (d < best) best = d;
    }
    if (poly.length === 1) best = haversine(lat, lng, poly[0][0], poly[0][1]);
    return best;
  };

  // approximate: project in local equirectangular meters
  Graph.prototype._distToSeg = function (lat, lng, A, B) {
    var toR = Math.PI / 180, R = 6371000;
    var latR = lat * toR;
    var mx = function (ln) { return R * ln * toR * Math.cos(latR); };
    var my = function (la) { return R * la * toR; };
    var px = mx(lng), py = my(lat);
    var ax = mx(A[1]), ay = my(A[0]), bx = mx(B[1]), by = my(B[0]);
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    var cx = ax + t * dx, cy = ay + t * dy;
    return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
  };

  // ---- A* --------------------------------------------------------------

  // Binary min-heap keyed by f.
  function Heap() { this.a = []; }
  Heap.prototype.push = function (item) {
    var a = this.a; a.push(item); var i = a.length - 1;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      var t = a[p]; a[p] = a[i]; a[i] = t; i = p;
    }
  };
  Heap.prototype.pop = function () {
    var a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; var i = 0, n = a.length;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, s = i;
        if (l < n && a[l].f < a[s].f) s = l;
        if (r < n && a[r].f < a[s].f) s = r;
        if (s === i) break;
        var t = a[s]; a[s] = a[i]; a[i] = t; i = s;
      }
    }
    return top;
  };
  Heap.prototype.size = function () { return this.a.length; };

  // Route from node srcId to node dstId. Returns null if unreachable.
  // Result: {edges:[ids], nodes:[ids], seconds, meters, cameras:[ids],
  //          cameraCount}
  // Route from node srcId to node dstId. Returns null if unreachable.
  //
  // Search state is (node, edge-arrived-on), not just node, because whether a
  // turn is legal depends on how you got there. That multiplies the state
  // space by the average node degree (about 3 here), which at this size costs
  // a couple of milliseconds and is what makes turn restrictions enforceable.
  Graph.prototype.route = function (srcId, dstId) {
    var self = this, nodes = this.nodes, adj = this.adj;
    var dst = nodes[dstId];
    var h = function (nid) {
      return haversine(nodes[nid][0], nodes[nid][1], dst[0], dst[1]) / self._maxSpeed;
    };
    var g = {}, cam = {}, prev = {}, closed = {};
    var key = function (n, e) { return n + '|' + (e == null ? '-' : e); };

    var startKey = key(srcId, null);
    g[startKey] = 0; cam[startKey] = 0;
    var open = new Heap();
    open.push({ node: srcId, edge: null, k: startKey, arrB: null, f: h(srcId) });
    var endKey = null;

    while (open.size()) {
      var cur = open.pop();
      if (closed[cur.k]) continue;
      closed[cur.k] = 1;
      if (cur.node === dstId) { endKey = cur.k; break; }

      var outs = adj[cur.node];
      for (var i = 0; i < outs.length; i++) {
        var ev = outs[i];
        if (!this.turnAllowed(cur.edge, cur.node, ev.edge)) continue;
        var e = this.edges[ev.edge];
        var passCams = this._edgeCams ? this._edgeCams[ev.edge] : null;
        var addCam = passCams ? passCams.length : 0;
        var nk = key(ev.to, ev.edge);
        var ng = g[cur.k] + e.t + (ev.edge === cur.edge ? UTURN_PENALTY : 0) +
                 (cur.arrB == null ? 0 : turnCost(cur.arrB, ev.depB));
        var nc = cam[cur.k] + addCam;
        var cost = nc * CAMERA_PENALTY + ng;
        var known = (g[nk] === undefined) ? Infinity
          : cam[nk] * CAMERA_PENALTY + g[nk];
        if (cost < known) {
          g[nk] = ng; cam[nk] = nc;
          prev[nk] = { k: cur.k, edge: ev.edge, node: cur.node };
          open.push({ node: ev.to, edge: ev.edge, k: nk, arrB: ev.arrB,
                      f: cost + h(ev.to) });
        }
      }
    }

    if (endKey === null) return null;

    var eids = [], nids = [], camSet = {}, camList = [];
    var k = endKey, curNode = dstId;
    nids.push(curNode);
    while (k !== startKey) {
      var p = prev[k];
      eids.push(p.edge);
      var pc = this._edgeCams ? this._edgeCams[p.edge] : null;
      if (pc) for (var c = 0; c < pc.length; c++) {
        if (!camSet[pc[c]]) { camSet[pc[c]] = 1; camList.push(pc[c]); }
      }
      curNode = p.node;
      nids.push(curNode);
      k = p.k;
    }
    eids.reverse(); nids.reverse();
    return {
      edges: eids, nodes: nids,
      seconds: g[endKey], meters: eids.reduce(function (s, id) {
        return s + self.edges[id].l;
      }, 0),
      cameras: camList, cameraCount: cam[endKey]
    };
  };

  // ---- Snapping O/D to the graph --------------------------------------

  // Start (or end) a route at an exact point on a street rather than at the
  // nearest intersection.
  //
  // Routing runs node to node, but an address sits mid-block, so snapping to
  // the nearest node could begin the route a block from the door and leave a
  // visible gap. This splits the chosen edge at the closest point to the
  // address and inserts a temporary node there, so the route starts where the
  // person actually is.
  //
  // The split is TEMPORARY and scoped to one lookup: it appends to the live
  // node/edge arrays and `release()` truncates them back. Nothing is
  // persisted, and the graph the next lookup sees is byte-identical to the one
  // this lookup started with.
  Graph.prototype.splitAt = function (lat, lng) {
    var snap = this.snapToRoad(lat, lng);
    if (!snap || snap.edge == null) return null;

    var e = this.edges[snap.edge];
    var poly = e.p;

    // Closest vertex pair, and the fraction along that pair.
    var best = { i: 0, t: 0, d: Infinity };
    for (var i = 0; i < poly.length - 1; i++) {
      var pr = projectOnSeg(lat, lng, poly[i], poly[i + 1]);
      if (pr.d < best.d) best = { i: i, t: pr.t, d: pr.d, lat: pr.lat, lng: pr.lng };
    }
    if (best.d === Infinity) return null;

    // Too close to either end to be worth splitting: reuse the real node.
    var head = poly.slice(0, best.i + 1).concat([[best.lat, best.lng]]);
    var tail = [[best.lat, best.lng]].concat(poly.slice(best.i + 1));
    var headLen = polyLength(head), tailLen = polyLength(tail);
    if (headLen < 8) return { node: e.a, lat: poly[0][0], lng: poly[0][1],
                              release: function () {} };
    if (tailLen < 8) return { node: e.b, lat: poly[poly.length-1][0],
                              lng: poly[poly.length-1][1], release: function () {} };

    var nodeCount = this.nodes.length, edgeCount = this.edges.length;
    var mid = this.nodes.length;
    this.nodes.push([best.lat, best.lng]);

    // Split length and time PROPORTIONALLY out of the parent rather than
    // recomputing them from the geometry, so the two halves always sum to
    // exactly what the parent claimed. Recomputing would let a route's
    // reported distance drift the moment it happened to start mid-block.
    var total = headLen + tailLen;
    var frac = total > 0 ? headLen / total : 0.5;
    var self = this;
    function piece(a, b, pts, lenShare, secShare) {
      return { a: a, b: b, d: e.d, l: Math.round(lenShare * 10) / 10,
               t: Math.round(secShare * 10) / 10, n: e.n, r: e.r, z: e.z, p: pts };
    }
    var eHead = this.edges.length;
    this.edges.push(piece(e.a, mid, head, e.l * frac, e.t * frac));
    var eTail = this.edges.length;
    this.edges.push(piece(mid, e.b, tail, e.l * (1 - frac), e.t * (1 - frac)));

    // The temporary halves inherit the parent's cameras, so exposure counting
    // does not change just because a route happens to start mid-block.
    if (this._edgeCams) {
      var parentCams = this._edgeCams[snap.edge] || null;
      this._edgeCams[eHead] = parentCams ? parentCams.slice() : null;
      this._edgeCams[eTail] = parentCams ? parentCams.slice() : null;
    }

    // Wire the new pieces in, and hide the original so the router cannot use
    // it to bypass the split point.
    var savedAdjA = this.adj[e.a].slice();
    var savedAdjB = this.adj[e.b].slice();
    this.adj.push([]);                       // adjacency for `mid`
    var drop = function (list) {
      return list.filter(function (x) { return x.edge !== snap.edge; });
    };
    this.adj[e.a] = drop(this.adj[e.a]);
    this.adj[e.b] = drop(this.adj[e.b]);
    if (e.d === 0 || e.d === 1) {
      this.adj[e.a].push({ to: mid, edge: eHead });
      this.adj[mid].push({ to: e.b, edge: eTail });
    }
    if (e.d === 0 || e.d === 2) {
      this.adj[e.b].push({ to: mid, edge: eTail });
      this.adj[mid].push({ to: e.a, edge: eHead });
    }

    return {
      node: mid, lat: best.lat, lng: best.lng, meters: best.d,
      release: function () {
        self.nodes.length = nodeCount;
        self.edges.length = edgeCount;
        self.adj.length = nodeCount;
        self.adj[e.a] = savedAdjA;
        self.adj[e.b] = savedAdjB;
        if (self._edgeCams) self._edgeCams.length = edgeCount;
      }
    };
  };

  function polyLength(pts) {
    var t = 0;
    for (var i = 0; i < pts.length - 1; i++) {
      t += haversine(pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1]);
    }
    return t;
  }

  // Project a point onto a segment, returning the closest point and distance.
  function projectOnSeg(lat, lng, A, B) {
    var toR = Math.PI / 180, R = 6371000, latR = lat * toR;
    var mx = function (ln) { return R * ln * toR * Math.cos(latR); };
    var my = function (la) { return R * la * toR; };
    var px = mx(lng), py = my(lat);
    var ax = mx(A[1]), ay = my(A[0]), bx = mx(B[1]), by = my(B[0]);
    var dx = bx - ax, dy = by - ay, len2 = dx*dx + dy*dy;
    var t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return {
      t: t, d: Math.sqrt(Math.pow(px - (ax + t*dx), 2) + Math.pow(py - (ay + t*dy), 2)),
      lat: A[0] + (B[0] - A[0]) * t,
      lng: A[1] + (B[1] - A[1]) * t
    };
  }

  // Snap a point to somewhere a car can actually start. Nearest NODE alone
  // lands you at whatever intersection happens to be closest, which can be an
  // alley mouth; nearest EDGE finds the street the address is actually on, and
  // then the closer of its two ends is where the route begins.
  //
  // Alleys are deprioritized rather than excluded: some addresses genuinely
  // only touch one, so they stay available at a penalty.
  Graph.prototype.snapToRoad = function (lat, lng) {
    var bestEdge = -1, bestD = Infinity;
    for (var i = 0; i < this.edges.length; i++) {
      var e = this.edges[i];
      if (e.c === 1) continue;      // never snap a start or end to a freeway
      var d = this._distToEdge(lat, lng, e.p);
      if (/\bALY\b|\bALLEY\b/.test(e.n || '')) d += 120;   // metres of penalty
      if (d < bestD) { bestD = d; bestEdge = i; }
    }
    if (bestEdge < 0) return this.nearestNode(lat, lng);
    var edge = this.edges[bestEdge];
    var a = this.nodes[edge.a], b = this.nodes[edge.b];
    var da = haversine(lat, lng, a[0], a[1]);
    var db = haversine(lat, lng, b[0], b[1]);
    // A one-way edge can only be entered at its tail.
    var node;
    if (edge.d === 1) node = edge.a;
    else if (edge.d === 2) node = edge.b;
    else node = da <= db ? edge.a : edge.b;
    return { node: node, meters: bestD, edge: bestEdge };
  };

  // Where a camera should be DRAWN: on the road it watches, not at the pole
  // beside it. Computed during assignCameras.
  Graph.prototype.cameraPos = function (id, lat, lng) {
    var p = this._camSnap && this._camSnap[id];
    return p || [lat, lng];
  };

  // Nearest point ON a road to a lat/lng, or null beyond maxMeters.
  //
  // Cameras are mapped where the pole stands, which is beside the road, not
  // on it. At street zoom that offset is tens of pixels and the dot appears
  // to drift away from the road it watches, so the DISPLAY position snaps to
  // the road while the true position stays in the data for the popup.
  Graph.prototype.nearestPointOnRoad = function (lat, lng, maxMeters) {
    var best = null;
    for (var i = 0; i < this.edges.length; i++) {
      var p = this.edges[i].p;
      for (var j = 0; j < p.length - 1; j++) {
        var pr = projectOnSeg(lat, lng, p[j], p[j + 1]);
        if (!best || pr.d < best.meters) {
          best = { lat: pr.lat, lng: pr.lng, meters: pr.d, edge: i };
        }
      }
    }
    if (!best || (maxMeters != null && best.meters > maxMeters)) return null;
    return best;
  };

  // Nearest node to a lat/lng (linear scan; fine at 7.5k nodes).
  Graph.prototype.nearestNode = function (lat, lng) {
    var best = -1, bestD = Infinity;
    for (var i = 0; i < this.nodes.length; i++) {
      var d = haversine(lat, lng, this.nodes[i][0], this.nodes[i][1]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return { node: best, meters: bestD };
  };

  // ---- Address -> coordinate, against the graph's own address ranges ----
  //
  // The road graph doubles as the geocoder: MGF/city centerlines carry the
  // house-number range for each side of every segment, so a typed address is
  // resolved by interpolating along the segment that contains its number.
  // No geocoder, no network call, and the result is a point on the street
  // centerline -- block-granular by construction, never a rooftop.

  // ONE canonicalizer at the comparison boundary. The precinct index and the
  // road graph come from different publishers that disagree about street type
  // ("HAINES AVE" vs "HAINES ST") and spell ordinals out. Canonical form drops
  // the type entirely and keeps name + directional, because the type is
  // exactly what the two sources disagree about; the house number then
  // disambiguates between real distinct streets that share a core.
  var TYPE_WORDS = {
    STREET: 'ST', ST: 'ST', AVENUE: 'AVE', AVE: 'AVE', ROAD: 'RD', RD: 'RD',
    DRIVE: 'DR', DR: 'DR', LANE: 'LN', LN: 'LN', COURT: 'CT', CT: 'CT',
    CIRCLE: 'CIR', CIR: 'CIR', BOULEVARD: 'BLVD', BLVD: 'BLVD',
    PLACE: 'PL', PL: 'PL', TERRACE: 'TER', TER: 'TER', TRAIL: 'TRL',
    TRAILS: 'TRL', TRL: 'TRL', PARKWAY: 'PKWY', PKWY: 'PKWY', WAY: 'WAY',
    HIGHWAY: 'HWY', HWY: 'HWY', SQUARE: 'SQ', SQ: 'SQ', RIDGE: 'RDG'
  };
  var ORDINALS = {
    FIRST: '1ST', SECOND: '2ND', THIRD: '3RD', FOURTH: '4TH', FIFTH: '5TH',
    SIXTH: '6TH', SEVENTH: '7TH', EIGHTH: '8TH', NINTH: '9TH', TENTH: '10TH',
    ELEVENTH: '11TH', TWELFTH: '12TH'
  };
  var DIRS = { N: 1, S: 1, E: 1, W: 1, NE: 1, NW: 1, SE: 1, SW: 1 };

  // "HAINES AVE NW" / "SEVENTH ST NW" -> "HAINES|NW" / "7TH|NW"
  function canonStreet(name) {
    if (!name) return '';
    var w = String(name).toUpperCase().replace(/[.,]/g, ' ')
      .replace(/\s+/g, ' ').trim().split(' ');
    // A directional can lead or trail and the two sources disagree about
    // which ("W FULTON ST" vs "FULTON ST W"), so both land in the same slot.
    var dir = '';
    if (w.length > 1 && DIRS[w[w.length - 1]]) dir = w.pop();
    if (!dir && w.length > 1 && DIRS[w[0]]) dir = w.shift();
    // drop a trailing type word
    if (w.length > 1 && TYPE_WORDS[w[w.length - 1]]) w.pop();
    var core = w.map(function (t) { return ORDINALS[t] || t; }).join(' ');
    return core + '|' + dir;
  }

  // Build (lazily) canonical-street -> [edge ids]
  Graph.prototype._streetIndex = function () {
    if (this._sidx) return this._sidx;
    var idx = {};
    for (var i = 0; i < this.edges.length; i++) {
      var k = canonStreet(this.edges[i].n);
      if (!k) continue;
      (idx[k] || (idx[k] = [])).push(i);
    }
    this._sidx = idx;
    return idx;
  };

  function inRange(n, a, b) {
    if (a == null || b == null || (!a && !b)) return false;
    var lo = Math.min(a, b), hi = Math.max(a, b);
    return n >= lo && n <= hi;
  }

  // Walk a polyline to a fraction of its length -> [lat,lng]
  function pointAtFraction(poly, f) {
    if (poly.length === 1) return poly[0].slice();
    var segs = [], total = 0, i;
    for (i = 0; i < poly.length - 1; i++) {
      var d = haversine(poly[i][0], poly[i][1], poly[i + 1][0], poly[i + 1][1]);
      segs.push(d); total += d;
    }
    if (!total) return poly[0].slice();
    var target = Math.max(0, Math.min(1, f)) * total, run = 0;
    for (i = 0; i < segs.length; i++) {
      if (run + segs[i] >= target) {
        var t = segs[i] ? (target - run) / segs[i] : 0;
        return [poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t,
                poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t];
      }
      run += segs[i];
    }
    return poly[poly.length - 1].slice();
  }

  // number + street text -> {lat,lng,node,edge,street,exact} or null
  Graph.prototype.geocode = function (number, streetText) {
    var idx = this._streetIndex();
    var key = canonStreet(streetText);
    var ids = idx[key];
    if (!ids || !ids.length || number == null) return null;

    var best = null;
    for (var i = 0; i < ids.length; i++) {
      var e = this.edges[ids[i]], r = e.r || [];
      var lf = r[0], lt = r[1], rf = r[2], rt = r[3];
      var onLeft = inRange(number, lf, lt);
      var onRight = inRange(number, rf, rt);
      if (!onLeft && !onRight) continue;
      // prefer the side whose parity matches (ranges are odd/even per side)
      var from, to;
      if (onLeft && (!onRight || (lf % 2 === number % 2))) { from = lf; to = lt; }
      else { from = rf; to = rt; }
      var span = (to - from);
      var f = span ? (number - from) / span : 0.5;
      var pt = pointAtFraction(e.p, f);
      var cand = { lat: pt[0], lng: pt[1], edge: ids[i], street: e.n, exact: true };
      if (!best) best = cand;
    }
    if (best) {
      var nn = this.nearestNode(best.lat, best.lng);
      best.node = nn.node;
      return best;
    }
    // number outside every known range on that street: fall back to the
    // midpoint of the nearest-numbered segment, flagged inexact.
    var closest = null, bestGap = Infinity;
    for (var j = 0; j < ids.length; j++) {
      var ee = this.edges[ids[j]], rr = ee.r || [];
      [[rr[0], rr[1]], [rr[2], rr[3]]].forEach(function (pair) {
        if (pair[0] == null || pair[1] == null) return;
        var gap = Math.min(Math.abs(number - pair[0]), Math.abs(number - pair[1]));
        if (gap < bestGap) { bestGap = gap; closest = ee; }
      });
    }
    if (!closest) return null;
    var mid = pointAtFraction(closest.p, 0.5);
    var n2 = this.nearestNode(mid[0], mid[1]);
    return { lat: mid[0], lng: mid[1], edge: -1, street: closest.n,
             exact: false, node: n2.node };
  };

  // ---- turn-by-turn ----------------------------------------------------
  //
  // Steps are derived from the route geometry: consecutive edges sharing a
  // street name become one leg, and the bearing change where legs meet becomes
  // the turn. One-way restrictions are already honored by the router, so a
  // step can never tell you to drive the wrong way down a one-way street.
  //
  // What the data does NOT carry is turn restrictions -- no-left-turn signs,
  // median divides, signal-only turns. So these are directions to follow along
  // with rather than obey blindly, and the page says so.

  function bearing(a, b) {
    var toR = Math.PI / 180;
    var y = Math.sin((b[1] - a[1]) * toR) * Math.cos(b[0] * toR);
    var x = Math.cos(a[0] * toR) * Math.sin(b[0] * toR) -
            Math.sin(a[0] * toR) * Math.cos(b[0] * toR) * Math.cos((b[1] - a[1]) * toR);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function turnWord(delta) {
    var d = ((delta + 540) % 360) - 180;      // normalize to [-180, 180]
    var a = Math.abs(d);
    if (a < 18) return 'Continue';
    if (a < 50) return d > 0 ? 'Bear right' : 'Bear left';
    if (a < 140) return d > 0 ? 'Turn right' : 'Turn left';
    if (a < 175) return d > 0 ? 'Sharp right' : 'Sharp left';
    return 'Make a U-turn';
  }

  function compassWord(deg) {
    var pts = ['north', 'northeast', 'east', 'southeast',
               'south', 'southwest', 'west', 'northwest'];
    return pts[Math.round((deg % 360) / 45) % 8];
  }

  // route -> [{ text, street, meters, cameras:[ids], turn }]
  Graph.prototype.steps = function (route) {
    if (!route || !route.edges.length) return [];
    var self = this;

    // Orient each edge to travel direction and collect its points.
    var legs = [];
    route.edges.forEach(function (id, i) {
      var e = self.edges[id];
      var poly = (route.nodes[i] !== e.a) ? e.p.slice().reverse() : e.p;
      var name = e.n || '';
      var cams = (self._edgeCams && self._edgeCams[id]) || [];
      var last = legs[legs.length - 1];
      if (last && last.name === name) {
        last.meters += e.l;
        last.points = last.points.concat(poly.slice(1));
        cams.forEach(function (c) { if (last.cameras.indexOf(c) < 0) last.cameras.push(c); });
      } else {
        legs.push({ name: name, meters: e.l, points: poly.slice(),
                    cameras: cams.slice() });
      }
    });

    function legBearing(pts, atStart) {
      if (pts.length < 2) return 0;
      return atStart ? bearing(pts[0], pts[1])
                     : bearing(pts[pts.length - 2], pts[pts.length - 1]);
    }

    // A camera near a corner sits within range of both legs that meet there.
    // Attribute it to the first leg only, so the per-step counts sum to the
    // route's actual exposure instead of double-reporting it.
    var claimed = {};
    legs.forEach(function (leg) {
      leg.cameras = leg.cameras.filter(function (c) {
        if (claimed[c]) return false;
        claimed[c] = 1; return true;
      });
    });

    var out = [];
    for (var i = 0; i < legs.length; i++) {
      var leg = legs[i], text;
      if (i === 0) {
        text = 'Head ' + compassWord(legBearing(leg.points, true)) +
               (leg.name ? ' on ' + leg.name : '');
      } else {
        var delta = legBearing(leg.points, true) - legBearing(legs[i - 1].points, false);
        var word = turnWord(delta);
        text = word === 'Continue'
          ? 'Continue' + (leg.name ? ' onto ' + leg.name : '')
          : word + (leg.name ? ' onto ' + leg.name : '');
      }
      // The leg's own geometry rides along so a step in the list can be
      // shown on the map. Additive: nothing that consumed steps before
      // this field existed has to care.
      out.push({ text: text, street: leg.name, meters: leg.meters,
                 cameras: leg.cameras, points: leg.points });
    }
    var lastLeg = legs[legs.length - 1];
    out.push({ text: 'Arrive at your destination', street: '', meters: 0,
               cameras: [], arrive: true,
               points: lastLeg ? [lastLeg.points[lastLeg.points.length - 1]] : [] });
    return out;
  };

  root.ALPRRouter = { Graph: Graph, haversine: haversine, bearing: bearing,
    UTURN_PENALTY: UTURN_PENALTY,
                      CAMERA_PENALTY: CAMERA_PENALTY, canonStreet: canonStreet };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ALPRRouter;
})(typeof self !== 'undefined' ? self : this);
