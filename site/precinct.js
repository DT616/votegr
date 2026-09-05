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

  function Precincts(addresses, polling) {
    this.wards = addresses.wards || {};
    this.streets = addresses.streets || {};
    this.streetNames = Object.keys(this.streets);
    this.polling = (polling && polling.precincts) || {};
  }

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

  Precincts.prototype.ward = function (precinct) { return this.wards[precinct] || null; };

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
    if (t.number == null) {
      return streets.slice(0, limit).map(function (s) {
        return { street: s, number: null, kind: 'street' };
      });
    }

    var out = [], self = this;
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
    if (out.length) return out.slice(0, limit);

    // Before falling back to neighbors, try the SAME number on the same
    // street in another quadrant. Grand Rapids numbers radiate from Fulton
    // and Division, so each quadrant starts its own count and the same low
    // number can exist in one quadrant and not the other: there is no 15
    // Burton St SE, though 15 Burton St SW is a real address. A quadrant slip
    // is a far likelier mistake than being three houses out, so it is offered
    // first.
    var base = strippedQuadrant(t.rest);
    if (base) {
      var self2 = this;
      this.streetNames.forEach(function (s) {
        if (streets.indexOf(s) >= 0) return;
        if (strippedQuadrant(s) !== base) return;
        var rows = self2.streets[s] || [];
        for (var i = 0; i < rows.length; i++) {
          if (rows[i][0] === t.number) {
            out.push({ street: s, number: t.number, kind: 'quadrant' });
            break;
          }
        }
      });
      if (out.length) return out.slice(0, limit);
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
    return uniq.slice(0, limit);
  };

  // Full lookup: typed text -> everything the page needs, or a reason it can't.
  Precincts.prototype.lookup = function (text) {
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
    return {
      number: t.number, street: street, precinct: res.precinct,
      ward: this.ward(res.precinct), place: place,
      inferred: res.inferred, rivals: res.rivals, edgeMetres: res.edgeMetres,
      ambiguousStreet: candidates.length > 1 && candidates.indexOf(t.rest) < 0
        ? candidates.slice(0, 6) : null
    };
  };

  // ---- precinct boundaries ---------------------------------------------
  // The one ray cast in the project. app.js delegates to it rather than
  // keeping its own copy, so the map, the lookup and the tests can never
  // drift into disagreeing about which precinct a point is in.
  //
  // precincts.json stores rings as [lat, lng]; the cast works in
  // (x = lng, y = lat), so the indices below are swapped.
  Precincts.prototype.precinctAt = function (lat, lng, polygons) {
    if (!polygons) return null;
    for (var i = 0; i < polygons.length; i++) {
      var pr = polygons[i], inside = false;
      for (var r = 0; r < pr.rings.length; r++) {
        var ring = pr.rings[r];
        for (var a = 0, b = ring.length - 1; a < ring.length; b = a++) {
          var xi = ring[a][1], yi = ring[a][0], xj = ring[b][1], yj = ring[b][0];
          if (((yi > lat) !== (yj > lat)) &&
              (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
        }
      }
      if (inside) return pr;
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
    if (!hit || String(hit.precinct) === String(r.precinct)) return r;
    var was = String(r.precinct);
    r.precinct = String(hit.precinct);
    r.ward = hit.ward;
    r.place = this.pollingPlace(r.precinct);
    r.rivals = [r.precinct, was];
    r.refined = true;
    return r;
  };

  root.Precincts = Precincts;
  if (typeof module !== 'undefined' && module.exports) module.exports = { Precincts: Precincts };
})(typeof self !== 'undefined' ? self : this);
