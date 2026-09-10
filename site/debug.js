// Released into the public domain under the Unlicense, see UNLICENSE.
//
// The routing engine's debug panel. Loaded by app.js only when the URL
// carries ?debug, and mounted with one object of engine hooks; nothing else
// in the page knows this file exists.
//
//   /?debug                                      the panel, empty
//   /?debug&from=602 Alexander St SE&to=355 48th St SE   filled and run
//   /?debug&from=42.9276,-85.6353&to=42.878,-85.6565     coordinates work too
//
// Each end is resolved the way the page resolves it -- parse, geocode off
// the street centrelines, precinct by point-in-polygon, snap to the road --
// and both routes are computed by the same computeRoutes the answer uses.
// Every number the engine has is dumped as JSON, and the pair is drawn on the
// map through the page's own rendering, so what you see is what a voter sees.
(function (root) {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function param(name) {
    try { return new URLSearchParams(location.search).get(name) || ''; } catch (e) { return ''; }
  }

  // The route objects carry the full geometry and the step list; the dump
  // keeps the numbers and the step text and drops the point arrays, which
  // are hundreds of coordinates that say nothing a map does not.
  function summarise(r) {
    if (!r) return null;
    return {
      meters: Math.round(r.meters), miles: +(r.meters / 1609.344).toFixed(2),
      seconds: Math.round(r.seconds), minutes: +(r.seconds / 60).toFixed(1),
      edges: r.edges.length, nodes: r.nodes.length,
      cameraCount: r.cameraCount, cameras: r.cameras,
      camerasOnRoute: Object.keys(r.camsOnRoute || {}).length,
      steps: (r.steps || []).map(function (s) {
        return s.text + (s.meters ? ' (' + Math.round(s.meters) + ' m)' : '');
      })
    };
  }

  // The text a chosen suggestion puts in the box, written the way somebody
  // writes an address rather than the way the parcel file stores it. Mirrors
  // what choose() does on the main search box.
  function label(item) {
    if (!item) return '';
    var street = typeof root.displayCase === 'function'
      ? root.displayCase(item.street) : item.street;
    return (item.number != null ? item.number + ' ' : '') + street;
  }

  function mount(api) {
    var bar = $('searchBar');
    if (!bar || $('debugPanel')) return;
    var panel = document.createElement('section');
    panel.id = 'debugPanel';
    panel.className = 'debug-panel';
    panel.innerHTML =
      '<div class="dbg-head">Routing engine debug ' +
      '<span class="dbg-sub">' + api.graph.nodeCount() + ' nodes · ' +
      api.graph.edgeCount() + ' edges · ' + (api.cameras || []).length +
      ' cameras</span></div>' +
      '<div class="dbg-row">' +
      '<label>From<input id="dbgFrom" placeholder="address, or lat,lng" spellcheck="false"></label>' +
      '<label>To<input id="dbgTo" placeholder="address, or lat,lng" spellcheck="false"></label>' +
      '</div>' +
      '<div class="dbg-row dbg-actions">' +
      '<button type="button" id="dbgRun">Route</button>' +
      '<button type="button" id="dbgSwap">Swap</button>' +
      '<button type="button" id="dbgLink">Copy link</button>' +
      '<span class="dbg-status" id="dbgStatus"></span>' +
      '</div>' +
      '<pre id="dbgOut" class="dbg-out" hidden></pre>';
    bar.insertAdjacentElement('afterend', panel);

    var from = $('dbgFrom'), to = $('dbgTo'), out = $('dbgOut'), status = $('dbgStatus');
    from.value = param('from');
    to.value = param('to');

    // Both ends get the page's own address picker. Typing a house number
    // offers real addresses out of the index, and picking one fills the box,
    // which is the same widget and the same suggestions a visitor gets. A
    // lat,lng pair still works: the picker offers nothing for text with no
    // house number in it, so coordinates fall straight through to run().
    var pickers = [];
    if (root.Autocomplete && typeof api.suggest === 'function') {
      [from, to].forEach(function (el) {
        var ac = root.Autocomplete.attach({
          input: el,
          suggest: api.suggest,
          onChoose: function (item) {
            el.value = label(item);
            ac.close();
          },
          // Nothing to say here. The panel dumps whatever resolve() makes of
          // the text, which is more use to somebody debugging than a message.
          onMiss: function () {}
        });
        pickers.push(ac);
      });
    }

    function shareUrl() {
      var u = new URL(location.href);
      u.search = '';
      u.searchParams.set('debug', '');
      if (from.value.trim()) u.searchParams.set('from', from.value.trim());
      if (to.value.trim()) u.searchParams.set('to', to.value.trim());
      return u.toString().replace('debug=&', 'debug&').replace(/debug=$/, 'debug');
    }

    function run() {
      var report = { from: null, to: null, route: null };
      out.hidden = false;
      status.textContent = 'working…';
      try {
        report.from = api.resolve(from.value);
        report.to = api.resolve(to.value);
        if (report.from.error || report.to.error) {
          status.textContent = 'could not place one end';
        } else {
          var origin = { lat: report.from.lat, lng: report.from.lng };
          var place = { lat: report.to.lat, lng: report.to.lng,
                        name: 'Debug destination', address: to.value };
          var computed = api.computeRoutes(origin, place);
          if (!computed) {
            report.route = { error: 'no drivable route on this road network' };
            status.textContent = 'no route';
          } else {
            report.route = {
              ms: computed.ms,
              identical: computed.identical, fastDropped: computed.fastDropped,
              originNode: computed.originNode, destNode: computed.destNode,
              originSplit: computed.originSplit, destSplit: computed.destSplit,
              fastest: summarise(computed.fast),
              avoiding: summarise(computed.avoid)
            };
            status.textContent = computed.ms + ' ms';
            api.draw(origin, place, computed);
          }
        }
      } catch (e) {
        report.error = String(e && e.stack || e);
        status.textContent = 'threw';
      }
      out.textContent = JSON.stringify(report, null, 2);
      try { history.replaceState(null, '', shareUrl()); } catch (e) {}
    }

    $('dbgRun').onclick = run;
    $('dbgSwap').onclick = function () {
      var a = from.value; from.value = to.value; to.value = a;
      pickers.forEach(function (p) { p.close(); });
    };
    $('dbgLink').onclick = function () {
      var url = shareUrl();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () {
          status.textContent = 'link copied';
        }, function () { status.textContent = url; });
      } else {
        status.textContent = url;
      }
    };
    // Deferred by a tick on purpose: Enter with a suggestion highlighted is
    // the picker's key first, and running before its onChoose lands would
    // route the half-typed text the reader was replacing.
    [from, to].forEach(function (el) {
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') setTimeout(run, 0);
      });
    });
    if (from.value && to.value) run();
    else from.focus();
  }

  root.VoteGRDebug = { mount: mount };
})(typeof self !== 'undefined' ? self : this);
