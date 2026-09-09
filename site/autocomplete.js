// Released into the public domain under the Unlicense, see UNLICENSE.
// The suggestion list under the address box.
//
// Nothing resolves while you type. The list offers addresses that really
// exist in the index, and the answer appears only when one is chosen, so a
// number the index does not carry reads as "did you mean" rather than as an
// error thrown at you mid-keystroke.
//
// This module owns the widget -- the list element, its markup, the keyboard,
// and when it opens and closes. It does not know what an address means: the
// page supplies `suggest` to search, `onChoose` for what picking one does,
// and `onMiss` for what to say when nothing matches. So the list can be read
// without the router, and the lookup can be read without the list.
(function (root) {
  'use strict';

  // The small grey word beside a suggestion that is not an exact hit, saying
  // why it is being offered. Keyed by the `kind` precinct.js assigns.
  var SUGGESTION_WHY = {
    inferred: 'estimated', quadrant: 'did you mean',
    near: 'nearest on this street'
  };

  var LIMIT = 8;
  var DEBOUNCE_MS = 120;
  // Long enough for a click on an item to land before the blur closes the
  // list under the pointer.
  var BLUR_MS = 150;

  // Its own escape, so this module has no load-order dependency on the page
  // that uses it -- the same trade cameras.js and routepanel.js make.
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : s;
    return d.innerHTML;
  }

  // Read at call time rather than captured, so script order cannot matter.
  function cased(s) {
    return typeof root.displayCase === 'function' ? root.displayCase(s) : s;
  }

  function attach(opts) {
    var input = opts.input;
    var items = [], index = -1, timer = null, box = null;

    // Built on first use rather than required in the HTML, so the markup
    // carries the input and this file carries everything the input grew.
    function element() {
      if (!box) {
        box = document.createElement('div');
        box.id = 'ac';
        box.className = 'ac';
        box.hidden = true;
        box.setAttribute('role', 'listbox');
        input.parentNode.appendChild(box);
      }
      return box;
    }

    function close() { element().hidden = true; index = -1; }

    // One glyph, drawn once. Every row in the list is a place on the map, and
    // the same pin marks the button that says "pick a place on the map" -- so
    // the two read as the same idea rather than two unrelated controls.
    // Filled rather than stroked: at 15px a 2px outline collapses into a blob,
    // and evenodd keeps the hole a hole whichever way the arc is wound.
    var PIN_SVG =
      '<svg class="pin-glyph" viewBox="0 0 24 24" width="15" height="15" ' +
      'aria-hidden="true" fill="currentColor" fill-rule="evenodd">' +
      '<path d="M12 2c-3.87 0-7 3.13-7 7 0 5.25 6.3 12.3 6.57 12.6a.58.58 0 0 0 .86 0' +
      'C12.7 21.3 19 14.25 19 9c0-3.87-3.13-7-7-7z' +
      'M12 6.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>';

    function itemHtml(it, i) {
      // A per-item note wins over the per-kind one: a street outside the city
      // has to name WHICH place it is in, and that differs per street.
      var why = it.why || SUGGESTION_WHY[it.kind] || '';
      return '<button type="button" class="ac-item" role="option" data-i="' + i + '">' +
        '<span class="ac-pin">' + PIN_SVG + '</span>' +
        (it.number != null ? '<span class="num">' + it.number + '</span>' : '') +
        '<span class="st">' + esc(cased(it.street)) + '</span>' +
        (why ? '<span class="why">' + why + '</span>' : '') +
        (it.where && it.where.length
          ? '<span class="ac-where">' + esc(it.where.join(' or ')) + '</span>'
          : '') + '</button>';
    }

    function refresh() {
      var text = input.value.trim();
      if (text.length < 2) { close(); return; }
      items = opts.suggest(text, LIMIT) || [];
      if (!items.length) { close(); return; }

      var el = element();
      el.innerHTML = items.map(itemHtml).join('');
      Array.prototype.forEach.call(el.querySelectorAll('.ac-item'), function (button) {
        // mousedown, not click: the input's blur would otherwise close the
        // list before the click could land on it.
        button.addEventListener('mousedown', function (e) {
          e.preventDefault();
          swallowNextClick();
          opts.onChoose(items[Number(button.dataset.i)]);
        });
      });
      el.hidden = false;
      index = -1;
    }

    // Choosing on mousedown leaves the browser's click still on its way,
    // and by the time it lands the list is gone and the answer has been
    // drawn under the finger. On a phone, where a touch is replayed as
    // mousedown then click, that click hit whichever place card had appeared
    // there and scrolled the reader down to its directions. Eat the one
    // click that belongs to the choosing tap; anything later is a real tap.
    function swallowNextClick() {
      var t;
      function eat(e) { e.stopPropagation(); e.preventDefault(); off(); }
      function off() { document.removeEventListener('click', eat, true); clearTimeout(t); }
      document.addEventListener('click', eat, true);
      t = setTimeout(off, 700);
    }

    function highlight(n) {
      var els = element().querySelectorAll('.ac-item');
      if (!els.length) return;
      if (index >= 0 && els[index]) els[index].classList.remove('active');
      index = (n + els.length) % els.length;
      els[index].classList.add('active');
      els[index].scrollIntoView({ block: 'nearest' });
    }

    // Enter with nothing highlighted still has to do something useful: take
    // the best suggestion when there is one, and otherwise hand the text to
    // the page to explain.
    function enter() {
      if (!element().hidden && index >= 0) { opts.onChoose(items[index]); return; }
      var text = input.value.trim();
      var best = opts.suggest(text, 1) || [];
      if (best.length) { opts.onChoose(best[0]); return; }
      opts.onMiss(text);
    }

    function onKey(e) {
      var open = !element().hidden;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!open) refresh();
        highlight(index + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (open) highlight(index - 1);
      } else if (e.key === 'Escape') {
        close();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        enter();
      }
    }

    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(refresh, DEBOUNCE_MS);
    });
    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', function () { setTimeout(close, BLUR_MS); });
    document.addEventListener('click', function (e) {
      if (!input.parentNode.contains(e.target)) close();
    });

    return { refresh: refresh, close: close };
  }

  var Autocomplete = { attach: attach, SUGGESTION_WHY: SUGGESTION_WHY };

  root.Autocomplete = Autocomplete;
  if (typeof module !== 'undefined' && module.exports) module.exports = Autocomplete;
})(typeof self !== 'undefined' ? self : this);
