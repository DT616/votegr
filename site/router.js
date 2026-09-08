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
  var STANDOFF_M = 50;           // a camera "watches" edges within this radius

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

  function haversine(lat1, lng1, lat2, lng2) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toR) * Math.cos(lat2 * toR) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // ---- Graph wrapper ---------------------------------------------------

  // Accepts three shapes, and turns all of them into the same one:
  //
  //   new Graph(wholeCityDocument)      nodes/edges as dense ARRAYS
  //   new Graph(chunkDocument)          nodes/edges as MAPS of global id
  //   new Graph([chunkA, chunkB, ...])  several chunks, merged
  //
  // The chunks exist because the county graph is 39,209 segments and a phone
  // should parse one jurisdiction, not all thirty. They keep the county-wide
  // node and edge ids that build_graph.py assigned once, and store maps
  // rather than arrays, so that merging two of them is a union and nothing
  // has to be renumbered. Adjacent chunks overlap in a 150m ring, so a merged
  // pair really is one connected graph and a route can cross the border.
  //
  // Those global ids are the wire format, not the working format. Everything
  // below -- the adjacency lists, splitAt's temporary nodes, the A* itself --
  // indexes into dense arrays, and rewriting it to walk sparse maps would be
  // slower and touch every method. So the ids are compacted ONCE, here, and
  // the rest of the file never learns that chunks exist.
  function Graph(data) {
    var merged = normalise(data);
    this.meta = merged.meta;
    // Global id -> local index, kept because a caller holding an id from the
    // wire (a chunk's own bbox query, a saved route) has no other way back.
    this.nodeId = merged.nodeId;
    this.edgeId = merged.edgeId;
    this._pack(merged.nodes, merged.edges);
    this._buildAdjacency();
    this._indexRestrictions(merged.restrictions);
    this._maxSpeed = 31.3;            // ~70mph m/s, for the heuristic
  }

  // ---- storage ---------------------------------------------------------
  //
  // The whole county is 30,331 nodes, 39,164 edges and 545,903 polyline
  // points, and it has to sit in a phone's memory all at once so that a
  // lookup anywhere in Kent County needs no second fetch.
  //
  // As ordinary objects that costs 102 MiB, and almost none of it is the
  // data. A point written [lat, lng] is a JS array: two numbers behind about
  // seventy bytes of object header, half a million times over. The
  // coordinates themselves are 4.4 MiB; the wrappers are ninety.
  //
  // So the graph is stored as flat typed arrays -- one Int32Array of
  // microdegrees for every coordinate in the county, one Uint32Array saying
  // where each edge's points begin -- and the same county costs 5.7 MiB,
  // less than half of what Grand Rapids alone costs today.
  //
  // 1e-6 degrees is about 11cm. Road centrelines are not surveyed to
  // anything like that, so nothing is lost by leaving floating point behind.
  var MICRO = 1e6;

  Graph.prototype._pack = function (nodes, edges) {
    var i, j;
    var nodeCount = nodes.length, edgeCount = edges.length, points = 0;
    for (i = 0; i < edgeCount; i++) points += edges[i].p.length;

    this._nodeCount = nodeCount;
    this._edgeCount = edgeCount;
    this._nodeXY = new Int32Array(nodeCount * 2);
    this._eA = new Int32Array(edgeCount);
    this._eB = new Int32Array(edgeCount);
    this._eLen = new Float32Array(edgeCount);
    this._eSec = new Float32Array(edgeCount);
    this._eDir = new Uint8Array(edgeCount);
    this._eCls = new Uint8Array(edgeCount);
    this._eName = new Array(edgeCount);
    // House-number ranges, four per edge: left from/to, right from/to.
    // -1 means "no range on that side", which is not the same as zero.
    this._eRange = new Int32Array(edgeCount * 4);
    this._pOff = new Uint32Array(edgeCount + 1);
    this._pXY = new Int32Array(points * 2);

    for (i = 0; i < nodeCount; i++) {
      this._nodeXY[i * 2] = Math.round(nodes[i][0] * MICRO);
      this._nodeXY[i * 2 + 1] = Math.round(nodes[i][1] * MICRO);
    }
    var at = 0;
    for (i = 0; i < edgeCount; i++) {
      var e = edges[i];
      this._eA[i] = e.a; this._eB[i] = e.b;
      this._eLen[i] = e.l; this._eSec[i] = e.t;
      this._eDir[i] = e.d; this._eCls[i] = e.c || 5;
      this._eName[i] = e.n || '';
      var r = e.r || [];
      for (j = 0; j < 4; j++) {
        this._eRange[i * 4 + j] = (r[j] == null) ? -1 : r[j];
      }
      this._pOff[i] = at;
      for (j = 0; j < e.p.length; j++) {
        this._pXY[at * 2] = Math.round(e.p[j][0] * MICRO);
        this._pXY[at * 2 + 1] = Math.round(e.p[j][1] * MICRO);
        at++;
      }
    }
    this._pOff[edgeCount] = at;

    // splitAt inserts a temporary node and two temporary half-edges for the
    // duration of one lookup. Typed arrays do not grow, and reallocating the
    // county's worth of them per lookup would be absurd, so the handful of
    // temporaries live in plain objects past the end of the packed region.
    // Every accessor checks here first. There are never more than three.
    this._extraNodes = [];
    this._extraEdges = [];
  };

  // ---- accessors -------------------------------------------------------
  //
  // These are the whole public shape of the graph now. They read like field
  // access and compile to an array index, and they hide whether an item is
  // packed or one of splitAt's temporaries.

  Graph.prototype.nodeCount = function () {
    return this._nodeCount + this._extraNodes.length;
  };
  Graph.prototype.edgeCount = function () {
    return this._edgeCount + this._extraEdges.length;
  };
  Graph.prototype.nodeLat = function (i) {
    return i < this._nodeCount ? this._nodeXY[i * 2] / MICRO
                               : this._extraNodes[i - this._nodeCount][0];
  };
  Graph.prototype.nodeLng = function (i) {
    return i < this._nodeCount ? this._nodeXY[i * 2 + 1] / MICRO
                               : this._extraNodes[i - this._nodeCount][1];
  };
  // A fresh [lat, lng] pair. Allocates, so never call it in a loop over the
  // whole graph -- that is what nodeLat/nodeLng are for.
  Graph.prototype.node = function (i) {
    return [this.nodeLat(i), this.nodeLng(i)];
  };

  Graph.prototype.edgeA = function (i) {
    return i < this._edgeCount ? this._eA[i] : this._extraEdges[i - this._edgeCount].a;
  };
  Graph.prototype.edgeB = function (i) {
    return i < this._edgeCount ? this._eB[i] : this._extraEdges[i - this._edgeCount].b;
  };
  Graph.prototype.edgeLen = function (i) {
    return i < this._edgeCount ? this._eLen[i] : this._extraEdges[i - this._edgeCount].l;
  };
  Graph.prototype.edgeSec = function (i) {
    return i < this._edgeCount ? this._eSec[i] : this._extraEdges[i - this._edgeCount].t;
  };
  Graph.prototype.edgeDir = function (i) {
    return i < this._edgeCount ? this._eDir[i] : this._extraEdges[i - this._edgeCount].d;
  };
  Graph.prototype.edgeClass = function (i) {
    return i < this._edgeCount ? this._eCls[i] : this._extraEdges[i - this._edgeCount].c;
  };
  Graph.prototype.edgeName = function (i) {
    return i < this._edgeCount ? this._eName[i] : this._extraEdges[i - this._edgeCount].n;
  };
  // One of the four house-number range slots: 0 left-from, 1 left-to,
  // 2 right-from, 3 right-to. null where the side carries no range.
  Graph.prototype.edgeRange = function (i, slot) {
    if (i >= this._edgeCount) {
      var r = this._extraEdges[i - this._edgeCount].r || [];
      return r[slot] == null ? null : r[slot];
    }
    var v = this._eRange[i * 4 + slot];
    return v === -1 ? null : v;
  };
  Graph.prototype.edgePointCount = function (i) {
    return i < this._edgeCount ? this._pOff[i + 1] - this._pOff[i]
                               : this._extraEdges[i - this._edgeCount].p.length;
  };
  Graph.prototype.edgePointLat = function (i, k) {
    return i < this._edgeCount ? this._pXY[(this._pOff[i] + k) * 2] / MICRO
                               : this._extraEdges[i - this._edgeCount].p[k][0];
  };
  Graph.prototype.edgePointLng = function (i, k) {
    return i < this._edgeCount ? this._pXY[(this._pOff[i] + k) * 2 + 1] / MICRO
                               : this._extraEdges[i - this._edgeCount].p[k][1];
  };
  // The edge's geometry as [[lat,lng], ...]. Allocates the whole polyline,
  // so it is for drawing and for step geometry, not for scanning.
  Graph.prototype.edgePoly = function (i) {
    var n = this.edgePointCount(i), out = new Array(n);
    for (var k = 0; k < n; k++) {
      out[k] = [this.edgePointLat(i, k), this.edgePointLng(i, k)];
    }
    return out;
  };

  function isChunk(doc) {
    return !!doc && doc.nodes && !Array.isArray(doc.nodes);
  }

  // One or more documents -> dense arrays, plus the id maps.
  function normalise(data) {
    var docs = Array.isArray(data) ? data : [data];
    if (!docs.length) throw new Error('Graph: nothing to build from');
    if (!isChunk(docs[0])) {
      if (docs.length > 1) {
        throw new Error('Graph: only chunks can be merged');
      }
      return { nodes: docs[0].nodes, edges: docs[0].edges,
               meta: docs[0].meta || {},
               restrictions: docs[0].restrictions || [],
               nodeId: null, edgeId: null };
    }

    var nodes = [], edges = [], nodeId = {}, edgeId = {};
    var restrictions = [], metas = [], build = null;

    for (var d = 0; d < docs.length; d++) {
      var doc = docs[d], meta = doc.meta || {};
      // Ids are positions in ONE build. Chunks from different builds share
      // numbers that mean different roads, and merging them would splice
      // unrelated streets together silently -- a route down a road that does
      // not exist. Refuse rather than produce that.
      if (build === null) build = meta.build || null;
      else if ((meta.build || null) !== build) {
        throw new Error('Graph: chunk ' + (meta.mcd || '?') + ' is from build ' +
                        meta.build + ', expected ' + build);
      }
      metas.push(meta);

      var id;
      for (id in doc.nodes) {
        if (!Object.prototype.hasOwnProperty.call(doc.nodes, id)) continue;
        // The ring makes border nodes appear in both chunks. Same id, same
        // point: the second sighting is the same node, not another one.
        if (nodeId[id] === undefined) {
          nodeId[id] = nodes.length;
          nodes.push(doc.nodes[id]);
        }
      }
      for (id in doc.edges) {
        if (!Object.prototype.hasOwnProperty.call(doc.edges, id)) continue;
        if (edgeId[id] !== undefined) continue;     // shared border segment
        var e = doc.edges[id];
        var a = nodeId[e.a], b = nodeId[e.b];
        // An edge whose endpoint was filtered out of the chunk cannot be
        // wired to anything. Dropping it is what the chunk builder already
        // does with a restriction that has a leg outside the ring.
        if (a === undefined || b === undefined) continue;
        edgeId[id] = edges.length;
        edges.push(shallowWithEnds(e, a, b));
      }
    }

    // Restrictions come last: every leg has to be resolvable, and the second
    // chunk may be what supplies the edge the first one's restriction names.
    for (d = 0; d < docs.length; d++) {
      var list = docs[d].restrictions || [];
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        var f = edgeId[r.f], v = nodeId[r.v], t = edgeId[r.t];
        if (f === undefined || v === undefined || t === undefined) continue;
        restrictions.push({ f: f, v: v, t: t, no: r.no });
      }
    }

    return { nodes: nodes, edges: edges, restrictions: restrictions,
             nodeId: nodeId, edgeId: edgeId,
             meta: { build: build, chunks: metas,
                     mcds: metas.map(function (m) { return m.mcd; }),
                     nodes: nodes.length, edges: edges.length } };
  }

  // A copy of the edge with LOCAL endpoints. Copied rather than mutated so a
  // chunk document can be handed to Graph twice -- once alone, once merged
  // with a neighbour -- without the first call corrupting it for the second.
  function shallowWithEnds(e, a, b) {
    var out = {};
    for (var k in e) {
      if (Object.prototype.hasOwnProperty.call(e, k)) out[k] = e[k];
    }
    out.a = a;
    out.b = b;
    return out;
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

  // Directed adjacency: adj[node] lists {to, edge, depB, arrB}, the bearing
  // on leaving this node and on arriving at the next, which the turn cost
  // reads. Seconds live on the edge and the camera cost is added at search
  // time, so a new camera set needs no rebuild.
  // Compressed sparse row: one flat array of links, and an offset per node
  // saying where its links begin. 73,015 links as {to, edge, depB, arrB}
  // objects inside 30,331 arrays cost about 12 MiB; the same links as four
  // parallel typed arrays cost 1.2 MiB, and the search reads them faster
  // because each field is contiguous.
  //
  // The links a splitAt adds live in _extraLinks, a plain array consulted
  // after the packed ones, so a lookup does not rebuild the county.
  Graph.prototype._buildAdjacency = function () {
    var n = this._nodeCount, m = this._edgeCount, i, ei;

    // Count first so every array is allocated once at the right size.
    var counts = new Uint32Array(n);
    for (ei = 0; ei < m; ei++) {
      if (this._eCls[ei] === 1) continue;
      if (this._pOff[ei + 1] - this._pOff[ei] < 2) continue;
      var d = this._eDir[ei];
      if (d === 0 || d === 1) counts[this._eA[ei]]++;
      if (d === 0 || d === 2) counts[this._eB[ei]]++;
    }
    var off = new Uint32Array(n + 1), run = 0;
    for (i = 0; i < n; i++) { off[i] = run; run += counts[i]; }
    off[n] = run;

    this._adjOff = off;
    this._adjTo = new Int32Array(run);
    this._adjEdge = new Int32Array(run);
    this._adjDep = new Float32Array(run);
    this._adjArr = new Float32Array(run);
    this._extraLinks = {};        // node -> [{to, edge, depB, arrB}]
    this._hiddenEdge = -1;        // an edge splitAt has taken out of service

    var fill = off.slice();
    for (ei = 0; ei < m; ei++) {
      if (this._eCls[ei] === 1) continue;
      var pts = this._pOff[ei + 1] - this._pOff[ei];
      if (pts < 2) continue;
      var fB = this._segBearing(ei, 0, 1);
      var lB = this._segBearing(ei, pts - 2, pts - 1);
      var dir = this._eDir[ei];
      if (dir === 0 || dir === 1) {
        var a = fill[this._eA[ei]]++;
        this._adjTo[a] = this._eB[ei]; this._adjEdge[a] = ei;
        this._adjDep[a] = fB; this._adjArr[a] = lB;
      }
      if (dir === 0 || dir === 2) {
        var b = fill[this._eB[ei]]++;
        this._adjTo[b] = this._eA[ei]; this._adjEdge[b] = ei;
        this._adjDep[b] = (lB + 180) % 360; this._adjArr[b] = (fB + 180) % 360;
      }
    }
  };

  Graph.prototype._segBearing = function (ei, j, k) {
    return bearing([this.edgePointLat(ei, j), this.edgePointLng(ei, j)],
                   [this.edgePointLat(ei, k), this.edgePointLng(ei, k)]);
  };

  // Every way out of a node, packed links then any temporary ones, skipping
  // an edge splitAt has hidden. The search calls this once per expansion, so
  // it returns a reused scratch array rather than allocating.
  //
  // Freeways never appear: they are left out of the adjacency entirely, not
  // merely discouraged. A trip to a polling place is a neighbourhood trip;
  // taking US-131 to vote saves a minute at best, and surface streets are
  // where the tool's camera knowledge actually applies. Class 1 is the Act 51
  // freeway class.
  Graph.prototype.linksFrom = function (node, into) {
    var out = into || [];
    out.length = 0;
    if (node < this._nodeCount) {
      var lo = this._adjOff[node], hi = this._adjOff[node + 1];
      for (var i = lo; i < hi; i++) {
        if (this._adjEdge[i] === this._hiddenEdge) continue;
        out.push({ to: this._adjTo[i], edge: this._adjEdge[i],
                   depB: this._adjDep[i], arrB: this._adjArr[i] });
      }
    }
    var extra = this._extraLinks[node];
    if (extra) for (var j = 0; j < extra.length; j++) out.push(extra[j]);
    return out;
  };

  // Wire a TEMPORARY edge into the adjacency. Only splitAt's half-edges come
  // through here; the packed ones were laid down in _buildAdjacency.
  Graph.prototype._linkExtraEdge = function (ei) {
    var e = this._extraEdges[ei - this._edgeCount];
    if (e.c === 1 || e.p.length < 2) return;
    var fB = bearing(e.p[0], e.p[1]);
    var lB = bearing(e.p[e.p.length - 2], e.p[e.p.length - 1]);
    var self = this;
    var add = function (node, link) {
      (self._extraLinks[node] || (self._extraLinks[node] = [])).push(link);
    };
    if (e.d === 0 || e.d === 1) {
      add(e.a, { to: e.b, edge: ei, depB: fB, arrB: lB });
    }
    if (e.d === 0 || e.d === 2) {
      add(e.b, { to: e.a, edge: ei,
                 depB: (lB + 180) % 360, arrB: (fB + 180) % 360 });
    }
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
    var edgeTotal = this.edgeCount();
    for (var ei = 0; ei < edgeTotal; ei++) {
      var pts = this.edgePointCount(ei), seen = {};
      for (var k = 0; k < pts; k++) {
        var kk = key(this.edgePointLat(ei, k), this.edgePointLng(ei, k));
        if (!seen[kk]) { seen[kk] = 1; (grid[kk] || (grid[kk] = [])).push(ei); }
      }
    }
    // reset any prior assignment
    this._edgeCams = [];
    for (var z = 0; z < edgeTotal; z++) this._edgeCams.push(null);
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
        var id = +eid;
        var np = this.edgePointCount(id), near = null, nearA = null, nearB = null;
        for (var sg = 0; sg < np - 1; sg++) {
          var segA = [this.edgePointLat(id, sg), this.edgePointLng(id, sg)];
          var segB2 = [this.edgePointLat(id, sg + 1), this.edgePointLng(id, sg + 1)];
          var pr = projectOnSeg(cam.lat, cam.lng, segA, segB2);
          if (!near || pr.d < near.d) { near = pr; nearA = segA; nearB = segB2; }
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

  // Point-to-edge distance in metres, min over the edge's segments.
  //
  // Reads coordinates straight out of the packed arrays through two reusable
  // pairs rather than materializing the polyline. snapToRoad calls this once
  // per edge in the county, twice per lookup: building 39,164 polylines to
  // throw them away was the single largest allocation in the whole page.
  Graph.prototype._distToEdge = function (lat, lng, ei) {
    var n = this.edgePointCount(ei);
    if (n === 0) return Infinity;
    var A = this._segA || (this._segA = [0, 0]);
    var B = this._segB || (this._segB = [0, 0]);
    A[0] = this.edgePointLat(ei, 0); A[1] = this.edgePointLng(ei, 0);
    if (n === 1) return haversine(lat, lng, A[0], A[1]);
    var best = Infinity;
    for (var i = 0; i < n - 1; i++) {
      B[0] = this.edgePointLat(ei, i + 1); B[1] = this.edgePointLng(ei, i + 1);
      var d = projectOnSeg(lat, lng, A, B).d;
      if (d < best) best = d;
      A[0] = B[0]; A[1] = B[1];
    }
    return best;
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
  //
  // Search state is (node, edge-arrived-on), not just node, because whether a
  // turn is legal depends on how you got there. That multiplies the state
  // space by the average node degree (about 3 here), which at this size costs
  // a couple of milliseconds and is what makes turn restrictions enforceable.
  Graph.prototype.route = function (srcId, dstId) {
    var self = this;
    var dstLat = this.nodeLat(dstId), dstLng = this.nodeLng(dstId);
    var h = function (nid) {
      return haversine(self.nodeLat(nid), self.nodeLng(nid), dstLat, dstLng) /
             self._maxSpeed;
    };
    var scratch = [];
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

      var outs = this.linksFrom(cur.node, scratch);
      for (var i = 0; i < outs.length; i++) {
        var ev = outs[i];
        if (!this.turnAllowed(cur.edge, cur.node, ev.edge)) continue;
        var passCams = this._edgeCams ? this._edgeCams[ev.edge] : null;
        var addCam = passCams ? passCams.length : 0;
        var nk = key(ev.to, ev.edge);
        var ng = g[cur.k] + this.edgeSec(ev.edge) +
                 (ev.edge === cur.edge ? UTURN_PENALTY : 0) +
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
        return s + self.edgeLen(id);
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

    var parent = snap.edge;
    var poly = this.edgePoly(parent);
    var eA = this.edgeA(parent), eB = this.edgeB(parent);

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
    if (headLen < 8) return { node: eA, lat: poly[0][0], lng: poly[0][1],
                              release: function () {} };
    if (tailLen < 8) return { node: eB, lat: poly[poly.length-1][0],
                              lng: poly[poly.length-1][1], release: function () {} };

    // The temporaries go past the end of the packed arrays, as plain objects.
    // There are exactly three of them and they live for one lookup.
    var extraNodes = this._extraNodes.length, extraEdges = this._extraEdges.length;
    var mid = this._nodeCount + extraNodes;
    this._extraNodes.push([best.lat, best.lng]);

    // Split length and time PROPORTIONALLY out of the parent rather than
    // recomputing them from the geometry, so the two halves always sum to
    // exactly what the parent claimed. Recomputing would let a route's
    // reported distance drift the moment it happened to start mid-block.
    var total = headLen + tailLen;
    var frac = total > 0 ? headLen / total : 0.5;
    var self = this;
    var pLen = this.edgeLen(parent), pSec = this.edgeSec(parent);
    var pDir = this.edgeDir(parent), pCls = this.edgeClass(parent);
    var pName = this.edgeName(parent);
    var pRange = [this.edgeRange(parent, 0), this.edgeRange(parent, 1),
                  this.edgeRange(parent, 2), this.edgeRange(parent, 3)];
    function piece(a, b, pts, lenShare, secShare) {
      return { a: a, b: b, d: pDir, c: pCls, l: Math.round(lenShare * 10) / 10,
               t: Math.round(secShare * 10) / 10, n: pName, r: pRange, p: pts };
    }
    var eHead = this._edgeCount + this._extraEdges.length;
    this._extraEdges.push(piece(eA, mid, head, pLen * frac, pSec * frac));
    var eTail = this._edgeCount + this._extraEdges.length;
    this._extraEdges.push(piece(mid, eB, tail, pLen * (1 - frac), pSec * (1 - frac)));

    // The temporary halves inherit the parent's cameras, so exposure counting
    // does not change just because a route happens to start mid-block.
    if (this._edgeCams) {
      var parentCams = this._edgeCams[parent] || null;
      this._edgeCams[eHead] = parentCams ? parentCams.slice() : null;
      this._edgeCams[eTail] = parentCams ? parentCams.slice() : null;
    }

    // Wire the new pieces in, and hide the original so the router cannot use
    // it to bypass the split point. Hiding is a single id rather than a
    // rebuilt adjacency list: linksFrom skips it wherever it appears.
    var wasHidden = this._hiddenEdge;
    this._hiddenEdge = parent;
    this._linkExtraEdge(eHead);
    this._linkExtraEdge(eTail);

    return {
      node: mid, lat: best.lat, lng: best.lng, meters: best.d,
      release: function () {
        self._extraNodes.length = extraNodes;
        self._extraEdges.length = extraEdges;
        self._hiddenEdge = wasHidden;
        // The only nodes that gained temporary links are the parent's two
        // ends and the new midpoint, so only those three need clearing.
        delete self._extraLinks[eA];
        delete self._extraLinks[eB];
        delete self._extraLinks[mid];
        if (self._edgeCams) self._edgeCams.length = self._edgeCount + extraEdges;
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
    var bestEdge = -1, bestD = Infinity, n = this.edgeCount();
    for (var i = 0; i < n; i++) {
      if (this.edgeClass(i) === 1) continue;  // never snap an end to a freeway
      var d = this._distToEdge(lat, lng, i);
      if (ALLEY.test(this.edgeName(i))) d += 120;   // metres of penalty
      if (d < bestD) { bestD = d; bestEdge = i; }
    }
    if (bestEdge < 0) return this.nearestNode(lat, lng);
    var ea = this.edgeA(bestEdge), eb = this.edgeB(bestEdge);
    var da = haversine(lat, lng, this.nodeLat(ea), this.nodeLng(ea));
    var db = haversine(lat, lng, this.nodeLat(eb), this.nodeLng(eb));
    // A one-way edge can only be entered at its tail.
    var dir = this.edgeDir(bestEdge), node;
    if (dir === 1) node = ea;
    else if (dir === 2) node = eb;
    else node = da <= db ? ea : eb;
    return { node: node, meters: bestD, edge: bestEdge };
  };

  var ALLEY = /\bALY\b|\bALLEY\b/;

  // Where a camera should be DRAWN: on the road it watches, not at the pole
  // beside it. Computed during assignCameras.
  Graph.prototype.cameraPos = function (id, lat, lng) {
    var p = this._camSnap && this._camSnap[id];
    return p || [lat, lng];
  };

  // Nearest node to a lat/lng (linear scan over the packed coordinates).
  Graph.prototype.nearestNode = function (lat, lng) {
    var best = -1, bestD = Infinity, n = this.nodeCount();
    for (var i = 0; i < n; i++) {
      var d = haversine(lat, lng, this.nodeLat(i), this.nodeLng(i));
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
    for (var i = 0; i < this._edgeCount; i++) {
      var k = canonStreet(this._eName[i]);
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

    // The first segment whose address range holds the number wins.
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var lf = this.edgeRange(id, 0), lt = this.edgeRange(id, 1);
      var rf = this.edgeRange(id, 2), rt = this.edgeRange(id, 3);
      var onLeft = inRange(number, lf, lt);
      var onRight = inRange(number, rf, rt);
      if (!onLeft && !onRight) continue;
      // prefer the side whose parity matches (ranges are odd/even per side)
      var from, to;
      if (onLeft && (!onRight || (lf % 2 === number % 2))) { from = lf; to = lt; }
      else { from = rf; to = rt; }
      var span = (to - from);
      var f = span ? (number - from) / span : 0.5;
      var pt = pointAtFraction(this.edgePoly(id), f);
      return { lat: pt[0], lng: pt[1], edge: id, street: this.edgeName(id),
               exact: true, node: this.nearestNode(pt[0], pt[1]).node };
    }
    // number outside every known range on that street: fall back to the
    // midpoint of the nearest-numbered segment, flagged inexact.
    var closest = -1, bestGap = Infinity;
    for (var j = 0; j < ids.length; j++) {
      var ee = ids[j];
      var pairs = [[this.edgeRange(ee, 0), this.edgeRange(ee, 1)],
                   [this.edgeRange(ee, 2), this.edgeRange(ee, 3)]];
      for (var q = 0; q < 2; q++) {
        var pair = pairs[q];
        if (pair[0] == null || pair[1] == null) continue;
        var gap = Math.min(Math.abs(number - pair[0]), Math.abs(number - pair[1]));
        if (gap < bestGap) { bestGap = gap; closest = ee; }
      }
    }
    if (closest < 0) return null;
    var mid = pointAtFraction(this.edgePoly(closest), 0.5);
    var n2 = this.nearestNode(mid[0], mid[1]);
    return { lat: mid[0], lng: mid[1], edge: -1, street: this.edgeName(closest),
             exact: false, node: n2.node };
  };

  // ---- turn-by-turn ----------------------------------------------------
  //
  // Steps are derived from the route geometry: consecutive edges sharing a
  // street name become one leg, and the bearing change where legs meet becomes
  // the turn. One-ways and the turn restrictions the graph carries are already
  // honored by the router, so a step never sends you the wrong way down a
  // one-way street or through a banned turn it knows about.
  //
  // What the data does NOT carry is every restriction on the ground: signs
  // the inventory missed, median divides, signal-only turns. So these are
  // directions to follow along with rather than obey blindly, and the page
  // says so.

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
      var poly = self.edgePoly(id);
      if (route.nodes[i] !== self.edgeA(id)) poly.reverse();
      var name = self.edgeName(id) || '';
      var cams = (self._edgeCams && self._edgeCams[id]) || [];
      var last = legs[legs.length - 1];
      if (last && last.name === name) {
        last.meters += self.edgeLen(id);
        last.points = last.points.concat(poly.slice(1));
        cams.forEach(function (c) { if (last.cameras.indexOf(c) < 0) last.cameras.push(c); });
      } else {
        legs.push({ name: name, meters: self.edgeLen(id), points: poly,
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

  root.ALPRRouter = {
    Graph: Graph, haversine: haversine, bearing: bearing, canonStreet: canonStreet,
    CAMERA_PENALTY: CAMERA_PENALTY, UTURN_PENALTY: UTURN_PENALTY
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ALPRRouter;
})(typeof self !== 'undefined' ? self : this);
