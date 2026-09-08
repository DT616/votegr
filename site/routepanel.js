// What the route panel SAYS: the two route cards and their verdict line, the
// turn list, the unavoidable-cameras note, and the destination picker.
//
// Split out of app.js to separate wording from wiring. Everything here takes
// route data and returns a string; nothing here touches the map, the graph or
// the page. app.js sets the strings into their elements and binds the clicks,
// so the two halves can be read on their own -- and the phrasing, which is
// where the care in this project actually lives, is no longer buried inside
// Leaflet calls.
//
// The distance and time formats moved with it, because after the split
// nothing else on the page measured anything.
(function (root) {
  'use strict';

  var METERS_PER_MILE = 1609.34;

  function fmtMi(m) { return (m / METERS_PER_MILE).toFixed(1) + ' mi'; }
  function fmtMin(s) { return Math.max(1, Math.round(s / 60)) + ' min'; }
  function plural(n) { return n > 1 ? 's' : ''; }

  // Its own escape, so this module has no load-order dependency on the page
  // that uses it -- the same trade cameras.js makes.
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : s;
    return d.innerHTML;
  }

  // Read at call time rather than captured, so script order cannot matter.
  function cased(s) {
    return typeof root.displayCase === 'function' ? root.displayCase(s) : s;
  }

  // "Would taking the cameras actually get you there faster?" Both routes come
  // out of the same search over the same graph, so this is a direct comparison
  // of their seconds and meters. The threshold is the same one the verdict
  // line has always used for "costs you nothing": a saving the display cannot
  // even show (under 0.05 mi and half a minute) is not a saving.
  //
  // ONE predicate for both decisions that depend on it: whether the fastest
  // route is offered at all, and how its cost is described when it is.
  function noRealSaving(fast, avoid) {
    var dMi = (avoid.meters - fast.meters) / METERS_PER_MILE;
    var dMin = (avoid.seconds - fast.seconds) / 60;
    return dMi <= .05 && dMin <= .5;
  }

  // Two results are the same journey if they use the same roads, or if they
  // are indistinguishable on every figure the page reports.
  //
  // The exposure counts must be passed in. The fastest route is computed with
  // the camera data switched off, so its own cameraCount is always 0 and
  // comparing it against the avoiding route's 0 would call two genuinely
  // different routes identical whenever their distance and time happened to
  // match, hiding a real choice from the reader.
  function sameRoute(a, b, aExp, bExp) {
    if (!a || !b) return false;
    if (a.edges.length === b.edges.length &&
        a.edges.every(function (e, i) { return e === b.edges[i]; })) return true;
    return aExp === bExp &&
           Math.round(a.seconds) === Math.round(b.seconds) &&
           Math.round(a.meters) === Math.round(b.meters);
  }

  function camWord(n) {
    return n === 0 ? '<span class="cam-zero">no cameras</span>'
      : '<span class="cam-big">' + n + ' camera' + (n > 1 ? 's' : '') + '</span>';
  }

  // A glyph per manoeuvre, read off the instruction text. Faster to scan
  // than a numbered list, and it survives being read at arm's length.
  function turnGlyph(text) {
    if (/^Head/i.test(text)) return '↑';
    if (/sharp right/i.test(text)) return '↱';
    if (/sharp left/i.test(text)) return '↰';
    if (/turn right/i.test(text)) return '→';
    if (/turn left/i.test(text)) return '←';
    if (/bear right/i.test(text)) return '↗';
    if (/bear left/i.test(text)) return '↖';
    if (/u-turn/i.test(text)) return '↺';
    return '↑';
  }

  // Case only the street inside the instruction, never the instruction.
  // router.js builds the text as 'Turn left onto ' + leg.name and hands the
  // bare name back as st.street, so the name appears verbatim and a single
  // replace is exact rather than a guess at where it starts.
  function stepText(st) {
    if (!st.street) return st.text;
    var c = cased(st.street);
    return c === st.street ? st.text : st.text.replace(st.street, c);
  }

  // One control, two options, each showing what it costs. Two full-width
  // cards said the same thing in twice the height.
  function option(key, r, exp, saved, selected) {
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
      '<span class="rt-top"><span class="sw ' + key + '"></span>' + label + '</span>' +
      '<span class="rt-sub">' + fmtMi(r.meters) + ' · ' + fmtMin(r.seconds) + '</span>' +
      '</button>';
  }

  function cardsHtml(routes, selected) {
    var fast = routes.fast, avoid = routes.avoid;
    var dMi = (avoid.meters - fast.meters) / METERS_PER_MILE;
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
      return '<div class="one-route"><b>' + fmtMi(avoid.meters) + '</b> · <b>' +
        fmtMin(avoid.seconds) + '</b>' +
        (clean ? '' : ' · ' + camWord(routes.avoidExp)) + '</div>' + note;
    }

    var html = '<div class="route-toggle">' +
      option('avoid', avoid, routes.avoidExp, saved, selected) +
      option('fast', fast, routes.fastExp, saved, selected) + '</div>';

    // The cost line is the avoiding route's price tag, so it sits directly
    // under the two buttons and only while that route is the selection.
    // With Fastest selected it would be arguing with the reader's choice.
    if (saved > 0 && selected === 'avoid') {
      var cost;
      if (noRealSaving(fast, avoid)) cost = 'costs you nothing';
      else {
        var parts = [];
        if (dMi > .05) parts.push(dMi.toFixed(1) + ' mi');
        if (dMin > .5) parts.push(Math.round(dMin) + ' min');
        cost = 'costs an extra ' + parts.join(' and ');
      }
      html += '<div class="verdict">Going around them ' + cost + '.</div>';
    }
    return html;
  }

  function stepsHtml(steps) {
    return '<ol class="steps">' + steps.map(function (st, i) {
      var dist = st.meters ? '<span class="sd">' +
        (st.meters < 160 ? Math.round(st.meters * 3.28084) + ' ft' : fmtMi(st.meters)) +
        '</span>' : '';
      var cam = st.cameras.length
        ? '<span class="scam">' + st.cameras.length + ' camera' +
          (st.cameras.length > 1 ? 's' : '') + '</span>' : '';
      return '<li data-i="' + i + '"' + (st.arrive ? ' class="arrive"' : '') +
        ' title="Show this part of the route on the map">' +
        (st.arrive ? '' : '<span class="glyph">' + turnGlyph(st.text) + '</span>') +
        '<span class="stext">' + esc(stepText(st)) + '</span>' + dist + cam + '</li>';
    }).join('') + '</ol>';
  }

  // Named streets, so "unavoidable" is a fact the reader can check rather
  // than a claim they have to take on trust.
  function unavoidableHtml(count, streets) {
    return '<div class="unavoid">There is no way to reach this destination ' +
      'without passing ' + count + ' known camera' + (count > 1 ? 's' : '') +
      ', on ' + esc(streets.join(', ')) + '. This route passes the fewest it can.</div>';
  }

  // One destination needs no announcement: the answer block above has already
  // named it, so this returns nothing rather than a control with one button.
  function destPickerHtml(opts, chosenKind) {
    if (!opts || opts.length < 2) return '';
    return '<div class="seg">' + opts.map(function (o) {
      return '<button type="button" data-kind="' + o.kind + '"' +
        (o.kind === chosenKind ? ' class="on"' : '') + '>' + esc(o.label) + '</button>';
    }).join('') + '</div>';
  }

  var RoutePanel = {
    METERS_PER_MILE: METERS_PER_MILE,
    fmtMi: fmtMi, fmtMin: fmtMin,
    noRealSaving: noRealSaving, sameRoute: sameRoute,
    camWord: camWord, turnGlyph: turnGlyph, stepText: stepText,
    cardsHtml: cardsHtml, stepsHtml: stepsHtml,
    unavoidableHtml: unavoidableHtml, destPickerHtml: destPickerHtml
  };

  root.RoutePanel = RoutePanel;
  if (typeof module !== 'undefined' && module.exports) module.exports = RoutePanel;
})(typeof self !== 'undefined' ? self : this);
