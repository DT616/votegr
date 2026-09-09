// Released into the public domain under the Unlicense, see UNLICENSE.
// What a license plate camera looks like and what it says about itself.
//
// Split out of app.js because none of it is about this page: it is the popup
// table, the robot drawing, and the two date helpers that read an
// OpenStreetMap timestamp. app.js keeps everything that needs the map, the
// graph or the current route -- where a camera is drawn, whether cameras are
// in scope at all, and the layer bookkeeping.
//
// Deliberately no Leaflet in here. The marker comes back as SVG plus the box
// it wants, and app.js wraps that in L.divIcon, so this file can be read, and
// tested, without a map.
(function (root) {
  'use strict';

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

  var SIZE = 58, CENTRE = SIZE / 2;

  // Its own escape rather than a shared one, so this module has no load-order
  // dependency on the page that uses it. Four lines is a cheaper price than a
  // coupling.
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : s;
    return d.innerHTML;
  }

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

  // The bearing a camera faces, from OSM's direction tag, or null when it has
  // none. Read by the popup and by the marker's view cone alike.
  function bearing(c) {
    var f = c.f || {};
    var raw = f.direction != null ? f.direction : f['camera:direction'];
    return (raw != null && raw !== '' && !isNaN(parseFloat(raw))) ? parseFloat(raw) : null;
  }

  function popupHtml(c) {
    var f = c.f || {};
    var rows = '';
    // Direction first: what a camera points at is the thing that matters most
    // for whether you drive past it.
    var d = bearing(c);
    if (d != null) {
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
      rows += '<div class="cf"><span class="ck">' +
        (c.v === 1 ? 'First mapped' : 'Last edited') + '</span>' +
        '<span class="cv">' + seen + '<span class="cago">' + ago(seen) + '</span></span></div>';
    }
    if (!rows) rows = '<div class="cf"><span class="cv">No details recorded in OpenStreetMap.</span></div>';
    var foot = '<div class="cfoot">OpenStreetMap ' + esc(c.id) +
      (c.v ? ' · version ' + c.v : '') + '</div>';
    return '<div class="campop"><div class="ctitle">License plate camera</div>' + rows + foot + '</div>';
  }

  // A robot officer: pale metal head under a police peaked cap, and two red
  // glowing eyes. The eyes carry the state colour, which is the honest
  // mapping: the glow IS the plate reader, and it burns brighter when this
  // camera sits on your route. Cap and head are fixed colours so the only
  // thing that changes with state is the part that watches. Upright at every
  // bearing; the cone alone says which way it looks.
  //
  // One drawing, two callers: the map marker and the legend key. The key used
  // to be a separate CSS approximation built from radial-gradients, and it had
  // drifted into something that plainly did not match the map.
  function bodySvg(fill, C, ringColour) {
    // Cap in a real police blue rather than near-black navy; face in a light
    // skin tone (the RoboCop read: human face, machine everything else). The
    // ear bolts stay pale metal so the hardware still shows.
    var dark = '#0e1116', cap = '#2a52c8', skin = '#f0c8a2';
    return '<g stroke-linejoin="round" transform="translate(' + C + ',' + C +
        ') scale(1.15) translate(-' + C + ',-' + C + ')">' +
      // ear bolts first, so the head overlaps their inner edge
      '<rect x="' + (C - 10.6) + '" y="' + (C - 1) + '" width="3" height="4.6" rx="1" ' +
        'fill="' + ringColour + '" stroke="' + dark + '" stroke-width="1.2"/>' +
      '<rect x="' + (C + 7.6) + '" y="' + (C - 1) + '" width="3" height="4.6" rx="1" ' +
        'fill="' + ringColour + '" stroke="' + dark + '" stroke-width="1.2"/>' +
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
  }

  // The marker: a view cone pointing the way the camera faces, the convention
  // DeFlock and the OSM surveillance renderers use, with the robot on top.
  // Returns the drawing and the box it wants; the caller makes it a marker.
  function markerSvg(c, flagged, ringColour) {
    var deg = bearing(c);
    var fill = flagged ? '#ff2d2d' : '#ff4d4d';
    var cone = '';
    if (deg != null) {
      // Cone drawn pointing north from centre, then rotated to the bearing.
      cone = '<g transform="rotate(' + deg.toFixed(1) + ' ' + CENTRE + ' ' + CENTRE + ')">' +
        '<path d="M' + CENTRE + ',' + CENTRE + ' L' + (CENTRE - 11) + ',' + (CENTRE - 24) +
        ' A26,26 0 0,1 ' + (CENTRE + 11) + ',' + (CENTRE - 24) + ' Z" ' +
        'fill="' + fill + '" fill-opacity="' + (flagged ? '.42' : '.26') + '" ' +
        'stroke="' + fill + '" stroke-opacity="' + (flagged ? '.85' : '.5') + '" stroke-width="1.5"/></g>';
    }
    var ring = flagged
      ? '<circle cx="' + CENTRE + '" cy="' + CENTRE + '" r="15" fill="none" stroke="' + fill +
        '" stroke-width="2.5" opacity=".9" class="cam-pulse"/>'
      : '';
    return {
      // The hover title. RoboCop is what he is.
      html: '<span title="RoboCop" style="display:block;width:100%;height:100%">' +
        '<svg width="' + SIZE + '" height="' + SIZE + '" viewBox="0 0 ' + SIZE + ' ' + SIZE + '">' +
        cone + ring + bodySvg(fill, CENTRE, ringColour) + '</svg></span>',
      size: SIZE,
      centre: CENTRE
    };
  }

  // The same robot for the legend key, cropped to the figure rather than the
  // marker's 58px box, which is mostly empty space held for the direction cone
  // the key does not show.
  function legendSvg(ringColour) {
    return '<svg viewBox="16 15 26 26" width="18" height="18" style="display:block">' +
      bodySvg('#ff4d4d', 29, ringColour) + '</svg>';
  }

  var Cameras = {
    FIELD_LABELS: FIELD_LABELS, FIELD_ORDER: FIELD_ORDER,
    ago: ago, compass: compass, bearing: bearing,
    popupHtml: popupHtml, bodySvg: bodySvg, markerSvg: markerSvg,
    legendSvg: legendSvg
  };

  root.Cameras = Cameras;
  if (typeof module !== 'undefined' && module.exports) module.exports = Cameras;
})(typeof self !== 'undefined' ? self : this);
