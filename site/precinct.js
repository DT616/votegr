/* Precinct + polling-place lookup.
 * Released into the public domain under the Unlicense, see UNLICENSE.
 *
 * The matching logic here (parseTyped / streetMatches / resolve) is carried
 * over from Cantica's vote-gr project, which is MIT licensed, so the two tools
 * answer "which precinct is this address in" identically. Keeping it a faithful
 * copy is deliberate: two implementations of the same lookup would eventually
 * disagree, and disagreeing about someone's polling place is the one failure
 * this tool must not have.
 *
 * As in vote-gr, the whole lookup is a dictionary hit against a file the page
 * already downloaded. The address is never sent anywhere.
 */
(function (root) {
  'use strict';

  // Two ways to build one.
  //
  // The original: addresses.json and polling.json, the Grand Rapids files,
  // where a precinct is identified by its bare number ("52") and every row is
  // [house number, "52", metres from the precinct edge]. /simple and the
  // tests still build this way, and it keeps working unchanged.
  //
  // Precincts.county(): all thirty jurisdictions at once. There a bare number
  // is no identity at all -- there is a Precinct 1 in twenty-nine places --
  // so every precinct is identified by the state's 13-digit code
  // ("0814282001001": county 081, Kentwood 42820, ward 01, precinct 001),
  // and the display number, the ward if the jurisdiction has wards, and the
  // jurisdiction's name are looked up from that code. Both modes store rows
  // the same way, [number, id, edge metres, rivals], so every method below
  // works on an `id` and does not know which kind it is holding.
  function Precincts(addresses, polling) {
    this.county = false;
    this.wards = addresses.wards || {};
    this.streets = addresses.streets || {};
    this.streetNames = Object.keys(this.streets);
    this.polling = (polling && polling.precincts) || {};
    this.byCode = null;
    this.boxes = {};
    this.clerks = {};
  }

  // opts: { index: precincts.json, addresses: [chunk...], polling: [chunk...],
  //         cityPolling: polling.json, cityMcd: '34000' }
  Precincts.county = function (opts) {
    var P = Object.create(Precincts.prototype);
    P.county = true;
    P.wards = {};
    P.streets = {};
    P.polling = {};
    P.boxes = {};
    P.clerks = {};
    P.byCode = {};
    P.jurisdictions = {};
    var i, j, code;

    // Identity, from the precinct index: what each code means.
    var list = (opts.index && opts.index.precincts) || [];
    for (i = 0; i < list.length; i++) {
      var pr = list[i];
      P.byCode[pr.code] = { mcd: pr.mcd, jurisdiction: pr.jurisdiction,
                            ward: pr.ward == null ? null : pr.ward,
                            precinct: pr.precinct, name: pr.name };
      P.jurisdictions[pr.mcd] = pr.jurisdiction;
    }

    // Addresses. A chunk stores its precincts as a list and each row points
    // at a position in it, so 227,000 rows do not repeat a 13-digit string;
    // here the position becomes the code. Streets that run through more than
    // one jurisdiction -- 28th St SE is in three -- merge into one list,
    // sorted by number, and the rows carry which side of the line they are on.
    var docs = opts.addresses || [];
    var dirty = {};
    for (i = 0; i < docs.length; i++) {
      var doc = docs[i], codes = doc.precincts || [];
      var streets = doc.streets || {};
      for (var name in streets) {
        if (!Object.prototype.hasOwnProperty.call(streets, name)) continue;
        var rows = streets[name];
        var into = P.streets[name] || (P.streets[name] = []);
        if (into.length) dirty[name] = 1;
        for (j = 0; j < rows.length; j++) {
          var r = rows[j];
          var out = [r[0], codes[r[1]], r[2]];
          if (r[3]) {
            out.push(r[3].map(function (k) { return codes[k]; }));
          }
          into.push(out);
        }
      }
    }
    for (var d in dirty) {
      if (Object.prototype.hasOwnProperty.call(dirty, d)) {
        P.streets[d].sort(function (a, b) { return a[0] - b[0]; });
      }
    }
    P.streetNames = Object.keys(P.streets);

    // Polling places, keyed by code. The county's scrape supplies every
    // jurisdiction; Grand Rapids is then overwritten from polling.json, the
    // hand transcription with coordinates, entrance notes and the one
    // consolidation the county page does not know about.
    var pdocs = opts.polling || [];
    for (i = 0; i < pdocs.length; i++) {
      var pd = pdocs[i], recs = pd.precincts || {};
      for (code in recs) {
        if (Object.prototype.hasOwnProperty.call(recs, code)) P.polling[code] = recs[code];
      }
      if (pd.mcd && pd.drop_boxes) P.boxes[pd.mcd] = pd.drop_boxes;
      if (pd.mcd && pd.clerk) P.clerks[pd.mcd] = pd.clerk;
    }
    var cityMcd = opts.cityMcd || '34000';
    var cityRecs = (opts.cityPolling && opts.cityPolling.precincts) || {};
    var numberToCode = {};
    for (code in P.byCode) {
      if (Object.prototype.hasOwnProperty.call(P.byCode, code) &&
          P.byCode[code].mcd === cityMcd) {
        numberToCode[String(P.byCode[code].precinct)] = code;
      }
    }
    for (var num in cityRecs) {
      if (!Object.prototype.hasOwnProperty.call(cityRecs, num)) continue;
      var target = numberToCode[num];
      if (!target) continue;
      var rec = cityRecs[num], copy = {};
      for (var k in rec) if (Object.prototype.hasOwnProperty.call(rec, k)) copy[k] = rec[k];
      if (copy.consolidated_with != null) {
        copy.consolidated_with = numberToCode[String(copy.consolidated_with)] ||
                                 copy.consolidated_with;
      }
      P.polling[target] = copy;
    }
    return P;
  };

  // What an id means for display. In the city files the id IS the number.
  Precincts.prototype.describe = function (id) {
    if (this.byCode) {
      var d = this.byCode[id];
      return d ? { code: id, precinct: d.precinct, ward: d.ward,
                   jurisdiction: d.jurisdiction, mcd: d.mcd }
               : { code: id, precinct: id, ward: null, jurisdiction: null, mcd: null };
    }
    return { code: String(id), precinct: id, ward: this.wards[id] || null,
             jurisdiction: null, mcd: null };
  };

  // The id a polygon carries, in whichever mode this index is in.
  Precincts.prototype.idOf = function (polygon) {
    return this.byCode ? polygon.code : String(polygon.precinct);
  };

  // Which jurisdictions a street's rows fall in. Cached: the type-ahead asks
  // for every suggestion on every keystroke.
  Precincts.prototype.whereIs = function (street) {
    if (!this.byCode) return null;
    this._where = this._where || {};
    if (this._where[street]) return this._where[street];
    var rows = this.streets[street] || [], seen = {}, names = [];
    for (var i = 0; i < rows.length; i++) {
      var d = this.byCode[rows[i][1]];
      if (d && !seen[d.jurisdiction]) { seen[d.jurisdiction] = 1; names.push(d.jurisdiction); }
    }
    return (this._where[street] = names);
  };

  // A jurisdiction's drop boxes, from the county's page. Grand Rapids' own
  // come from the city clerk's file instead and are not here.
  Precincts.prototype.dropBoxes = function (mcd) {
    return (this.boxes && this.boxes[mcd]) || [];
  };

  // The jurisdiction's own clerk: address, phone, and a coordinate where the
  // build could place it. Where no drop box is published this is where an
  // absentee ballot goes, because under MCL 168.764a it has to reach the
  // voter's own clerk and nobody else's.
  Precincts.prototype.clerkOf = function (mcd) {
    return (this.clerks && this.clerks[mcd]) || null;
  };

  // "250 Monroe Ave. NW" -> { number: 250, rest: "MONROE AVE NW" }
  Precincts.prototype.parseTyped = function (text) {
    var clean = String(text || '').toUpperCase().replace(/[.,]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    var m = clean.match(/^(\d+)\s*(.*)$/);
    return m ? { number: Number(m[1]), rest: m[2] } : { number: null, rest: clean };
  };

  // Every typed word must begin a word of the street name, in order.
  function streetMatches(street, tokens) {
    var words = street.split(' '), at = 0;
    for (var i = 0; i < tokens.length; i++) {
      while (at < words.length && words[at].indexOf(tokens[i]) !== 0) at++;
      if (at >= words.length) return false;
      at++;
    }
    return true;
  }

  // "BURTON ST SE" -> "BURTON ST". Used to find the same street in a different
  // quadrant; returns null when there is no quadrant to strip.
  function strippedQuadrant(name) {
    var m = String(name || '').toUpperCase().trim()
      .match(/^(.*?)\s+(NE|NW|SE|SW)$/);
    return m ? m[1] : null;
  }

  Precincts.prototype.matchingStreets = function (rest) {
    var tokens = String(rest || '').split(' ').filter(Boolean);
    if (!tokens.length) return [];
    var hits = this.streetNames.filter(function (s) { return streetMatches(s, tokens); });
    return hits.sort(function (a, b) {
      var lead = function (s) { return s.indexOf(tokens[0]) === 0 ? 0 : 1; };
      return lead(a) - lead(b) || a.length - b.length || a.localeCompare(b);
    });
  };

  // Resolve a house number on a street. Answers only when the neighbors on
  // the SAME SIDE agree, because a precinct line often runs down the middle of
  // a street, putting odd and even in different precincts.
  Precincts.prototype.resolve = function (street, number) {
    var rows = this.streets[street];
    if (!rows) return null;

    var exact = null;
    for (var i = 0; i < rows.length; i++) if (rows[i][0] === number) { exact = rows[i]; break; }
    if (exact) {
      return { precinct: exact[1], edgeMetres: exact[2],
               rivals: exact[3] || null, inferred: false };
    }
    var sameSide = rows.filter(function (r) { return r[0] % 2 === number % 2; });
    var below = null, above = null;
    for (var j = 0; j < sameSide.length; j++) {
      if (sameSide[j][0] < number) below = sameSide[j];
      else if (sameSide[j][0] > number) { above = sameSide[j]; break; }
    }
    if (!below || !above) return null;      // outside known range: do not extrapolate
    if (below[1] !== above[1]) {
      return { precinct: below[1], rivals: [below[1], above[1]], inferred: true,
               edgeMetres: Infinity };
    }
    return { precinct: below[1], edgeMetres: Math.min(below[2], above[2]),
             rivals: null, inferred: true };
  };

  // Where a precinct actually votes. Honors `consolidated_with`, which is how
  // the clerk records a precinct voting at another precinct's location for one
  // election -- it appears only in the directory's FOOTNOTES.
  Precincts.prototype.pollingPlace = function (precinct) {
    var p = this.polling[precinct];
    if (!p) return null;
    if (p.consolidated_with && this.polling[p.consolidated_with]) {
      var host = this.polling[p.consolidated_with];
      return { name: host.name, address: host.address, lat: host.lat, lng: host.lng,
               entrance_note: host.entrance_note,
               consolidated_with: p.consolidated_with, note: p.note };
    }
    return { name: p.name, address: p.address, lat: p.lat, lng: p.lng,
             entrance_note: p.entrance_note };
  };

  Precincts.prototype.ward = function (id) { return this.describe(id).ward; };

  // Suggestions for the type-ahead. Returns real addresses that exist in the
  // index, so the person picks a known answer instead of being told after the
  // fact that what they typed is not in it. A house number that is missing
  // stops being an error and becomes "did you mean one of these".
  Precincts.prototype.suggest = function (text, limit) {
    limit = limit || 8;
    var t = this.parseTyped(text);
    var streets = this.matchingStreets(t.rest);
    if (!streets.length) return [];

    // No number yet: offer streets, so the next keystroke has somewhere to go.
    var self = this;
    var tag = function (o) {
      var w = self.whereIs(o.street);
      if (w && w.length) o.where = w;
      return o;
    };
    if (t.number == null) {
      return streets.slice(0, limit).map(function (s) {
        return tag({ street: s, number: null, kind: 'street' });
      });
    }

    var out = [];
    // Exact hits first, across every matching street.
    streets.forEach(function (s) {
      var rows = self.streets[s] || [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i][0] === t.number) {
          out.push({ street: s, number: t.number, kind: 'exact' });
          break;
        }
      }
    });
    // Then an inferred hit (between known neighbors on the same side).
    streets.forEach(function (s) {
      if (out.some(function (o) { return o.street === s; })) return;
      var r = self.resolve(s, t.number);
      if (r) out.push({ street: s, number: t.number, kind: 'inferred' });
    });
    // Nearby house numbers are a LAST RESORT, offered only when the number
    // typed matches nothing anywhere. Listing a street's other addresses
    // beside a perfectly good answer just makes the reader pick their own
    // address out of a lineup of their neighbors'.
    if (out.length) return out.slice(0, limit).map(tag);

    // Before falling back to neighbors, try the SAME number on the same
    // street in another quadrant. Grand Rapids numbers radiate from Fulton
    // and Division, so each quadrant starts its own count and the same low
    // number can exist in one quadrant and not the other: there is no 15
    // Burton St SE, though 15 Burton St SW is a real address. A quadrant slip
    // is a far likelier mistake than being three houses out, so it is offered
    // first.
    var base = strippedQuadrant(t.rest);
    if (base) {
      this.streetNames.forEach(function (s) {
        if (streets.indexOf(s) >= 0) return;
        if (strippedQuadrant(s) !== base) return;
        var rows = self.streets[s] || [];
        for (var i = 0; i < rows.length; i++) {
          if (rows[i][0] === t.number) {
            out.push({ street: s, number: t.number, kind: 'quadrant' });
            break;
          }
        }
      });
      if (out.length) return out.slice(0, limit).map(tag);
    }

    streets.slice(0, 3).forEach(function (s) {
      var rows = self.streets[s] || [];
      var near = rows.slice().sort(function (a, b) {
        var da = Math.abs(a[0] - t.number), db = Math.abs(b[0] - t.number);
        if (da !== db) return da - db;
        // prefer the same side of the street
        var pa = a[0] % 2 === t.number % 2 ? 0 : 1;
        var pb = b[0] % 2 === t.number % 2 ? 0 : 1;
        return pa - pb;
      });
      for (var i = 0; i < near.length && i < 3; i++) {
        if (near[i][0] === t.number) continue;
        out.push({ street: s, number: near[i][0], kind: 'near' });
      }
    });

    // De-duplicate, keeping the strongest kind for each address.
    var seen = {}, uniq = [];
    out.forEach(function (o) {
      var k = o.number + '|' + o.street;
      if (seen[k]) return;
      seen[k] = 1; uniq.push(o);
    });
    return uniq.slice(0, limit).map(tag);
  };

  // Full lookup: typed text -> everything the page needs, or a reason it can't.
  Precincts.prototype.lookup = function (text) {
    var self = this;
    var t = this.parseTyped(text);
    if (t.number == null) return { error: 'no_number', rest: t.rest,
                                   suggestions: this.matchingStreets(t.rest).slice(0, 6) };
    var candidates = this.matchingStreets(t.rest);
    if (!candidates.length) return { error: 'no_street', rest: t.rest };
    // exact name wins; otherwise the best-ranked match
    var street = candidates.indexOf(t.rest) >= 0 ? t.rest : candidates[0];
    var res = this.resolve(street, t.number);
    if (!res) return { error: 'no_number_on_street', street: street,
                       number: t.number, ambiguous: candidates.slice(0, 6) };
    var place = this.pollingPlace(res.precinct);
    var who = this.describe(res.precinct);
    return {
      number: t.number, street: street,
      // `precinct` is the number a voter recognises; `code` is the identity.
      // In the city files they are the same string.
      code: who.code, precinct: who.precinct, ward: who.ward,
      jurisdiction: who.jurisdiction, mcd: who.mcd, place: place,
      // Rivals as display numbers, since that is what the reader is shown.
      rivals: res.rivals ? res.rivals.map(function (id) {
        return self.describe(id).precinct;
      }) : null,
      inferred: res.inferred, edgeMetres: res.edgeMetres,
      ambiguousStreet: candidates.length > 1 && candidates.indexOf(t.rest) < 0
        ? candidates.slice(0, 6) : null
    };
  };

  // ---- point in polygon --------------------------------------------------
  // The one ray cast in the project. The precinct lookup below, the city
  // limits check in app.js and the audit scripts all call this rather than
  // keeping their own copy, so none of them can drift into disagreeing about
  // which side of a line a point falls on.
  //
  // Rings are [lat, lng] pairs, as precincts.json stores them; a caller
  // holding [lng, lat] rings (boundary.json) swaps them once before calling.
  // A polygon with several rings toggles across all of them, so holes work.
  function pointInRings(lat, lng, rings) {
    var inside = false;
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      for (var a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        var yi = ring[a][0], xi = ring[a][1], yj = ring[b][0], xj = ring[b][1];
        if (((yi > lat) !== (yj > lat)) &&
            (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
      }
    }
    return inside;
  }

  Precincts.prototype.precinctAt = function (lat, lng, polygons) {
    if (!polygons) return null;
    for (var i = 0; i < polygons.length; i++) {
      if (pointInRings(lat, lng, polygons[i].rings)) return polygons[i];
    }
    return null;
  };

  // An inferred address has no parcel of its own, so its precinct is read off
  // the neighbors either side of it. That breaks where a precinct line runs
  // down the middle of a street: 401 Ionia Ave SW has 400, 404 and 408 sitting
  // across the road in precinct 6, while 401 itself is in 15. Where such an
  // address geocodes and the boundary disagrees with the neighbors, the
  // boundary wins, and both precincts are still named so the reader can see
  // the call was close.
  //
  // INFERRED ADDRESSES ONLY. An exact parcel match already got its precinct
  // from the parcel point itself; geocoding it lands on the street centerline
  // instead, which disagrees with the polygon for about 1 in 15 of them.
  // Letting the polygon win there would trade a handful of real corrections
  // for hundreds of fresh errors.
  Precincts.prototype.refineWithPolygon = function (r, geocodeFn, polygons) {
    if (!r || r.error || !r.inferred || !geocodeFn || !polygons) return r;
    var pt = geocodeFn(r.number, r.street);
    if (!pt) return r;
    var hit = this.precinctAt(pt.lat, pt.lng, polygons);
    if (!hit) return r;
    var id = this.idOf(hit);
    if (id === String(r.code)) return r;
    var was = r.precinct;
    var who = this.describe(id);
    r.code = who.code; r.precinct = who.precinct; r.ward = who.ward;
    r.jurisdiction = who.jurisdiction; r.mcd = who.mcd;
    r.place = this.pollingPlace(id);
    r.rivals = [r.precinct, was];
    r.refined = true;
    return r;
  };

  Precincts.pointInRings = pointInRings;
  root.Precincts = Precincts;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Precincts: Precincts, pointInRings: pointInRings };
  }
})(typeof self !== 'undefined' ? self : this);
