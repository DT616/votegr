// Released into the public domain under the Unlicense, see UNLICENSE.
// The election calendar, shared by both pages.
//
// This module exists because the same calendar was being read twice, in
// app.js and in simple/lookup.js, and the two readings drifted. Both files
// carried their own month table, their own "today", their own next-election
// search, and their own three-way branch over the early voting window -- and
// both used the name prettyDate for a DIFFERENT format, one with the weekday
// and one without. That is how the /simple page came to say early voting was
// still available on a day the main page already called it closed.
//
// So the formats are named for what they produce rather than for how pretty
// they are, and the window's state is decided in ONE place, windowState(),
// which both pages ask. Wording stays with each page: the two surfaces say
// different things on purpose, and only the calendar underneath has to agree.
//
// Every date here is a local Y-M-D string. Never new Date(iso): that parses
// as UTC midnight and lands on the previous day for anyone west of
// Greenwich, which prints the wrong weekday for an election.
(function (root) {
  'use strict';

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
                  'Friday', 'Saturday'];
  // The clerk publishes early voting hours as a weekday pattern rather than as
  // dated rows, so a rule is matched by weekday. Indexes line up with the
  // abbreviations the data file uses.
  var DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  var ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }

  // Today's weekday abbreviation, for picking today's row out of the hours.
  function todayAbbr() { return DAY_ABBR[new Date().getDay()]; }

  // Local midnight starting the given date, or null if it is not a date.
  function dayStart(iso) {
    var m = ISO.exec(String(iso || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }

  // "2026-11-03" -> "November 3, 2026". Falls back to what it was handed,
  // since this also formats dates read out of a data file.
  function monthDay(iso) {
    var m = ISO.exec(String(iso || ''));
    return m ? MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1] : (iso || '');
  }

  // "2026-11-03" -> "Tuesday, November 3, 2026". The weekday leads because it
  // is what people plan around; a bare date sends the reader to a calendar.
  function withWeekday(iso) {
    var d = dayStart(iso);
    return d ? WEEKDAYS[d.getDay()] + ', ' + monthDay(iso) : (iso || '');
  }

  // "2026-11-03" -> "Tuesday, November 3". For use next to another date that
  // already carries the year, where repeating it adds nothing.
  function dayMonth(iso) { return withWeekday(iso).replace(/, \d{4}$/, ''); }

  // "7:00 AM" -> "7 AM". Only on the hour: the clerk publishes half hours for
  // early voting and those keep their minutes.
  function shortTime(t) {
    return String(t || '').replace(/:00(?=\s*[AP]M\b)/i, '');
  }

  // The next election on or after today. Sorted rather than trusting file
  // order, so an out-of-order entry cannot hide the election that is next.
  function next(list, today) {
    var t = today || todayISO();
    var future = (list || []).filter(function (e) { return e && e.date >= t; });
    future.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return future[0] || null;
  }

  function sites(e) { return (e && e.early_voting_sites) || []; }

  // "7:00 AM" / "8:00 PM" -> the instant on that date, local time. The
  // statutory hours are written the way the Secretary of State writes them,
  // so this reads that form and nothing else; anything it cannot read is
  // null, and the caller falls back to knowing only that it is election day.
  var CLOCK = /^\s*(\d{1,2})(?::(\d{2}))?\s*([AP])\.?M\.?\s*$/i;
  function atTime(iso, clock) {
    var day = dayStart(iso), m = CLOCK.exec(String(clock || ''));
    if (!day || !m) return null;
    var h = Number(m[1]) % 12 + (m[3].toUpperCase() === 'P' ? 12 : 0);
    day.setHours(h, Number(m[2] || 0), 0, 0);
    return day;
  }

  // Where election day stands right now: 'before' the polls open, 'open',
  // or 'closed'. null on any other day, or when the hours cannot be read.
  // Takes the instant as an argument so it can be tested at fixed times.
  function pollsPhase(e, hours, now) {
    if (!e || !hours) return null;
    var open = atTime(e.date, hours.open), close = atTime(e.date, hours.close);
    if (!open || !close) return null;
    var t = now || new Date();
    if (t < dayStart(e.date)) return null;
    if (t < open) return 'before';
    if (t < close) return 'open';
    return 'closed';
  }

  // The four states of the early voting window, decided once.
  //
  //   'none'    the clerk has published nothing, or only half a window. A
  //             start with no end is not a window a voter can act on.
  //   'before'  published, not started.
  //   'open'    today falls inside it.
  //   'closed'  it has been and gone. Since the election this belongs to is
  //             always the NEXT one, 'closed' means exactly "over, with the
  //             election still ahead" -- the state that matters most, because
  //             a reader who saw a site listed last week would otherwise
  //             drive to a locked door.
  function windowState(e, today) {
    if (!e || !e.early_voting_from || !e.early_voting_to) return 'none';
    var t = today || todayISO();
    if (t > e.early_voting_to) return 'closed';
    if (t < e.early_voting_from) return 'before';
    return 'open';
  }

  // Open AND somewhere to go. Deliberately separate from windowState: with a
  // window published and no sites the window is still open and it is our data
  // that is short, so a caller offering a destination asks this, and a caller
  // describing the calendar asks windowState.
  function isOpen(e, today) {
    return windowState(e, today) === 'open' && sites(e).length > 0;
  }

  var Elections = {
    atTime: atTime, pollsPhase: pollsPhase,
    MONTHS: MONTHS, WEEKDAYS: WEEKDAYS, DAY_ABBR: DAY_ABBR,
    todayISO: todayISO, todayAbbr: todayAbbr, dayStart: dayStart,
    monthDay: monthDay, withWeekday: withWeekday, dayMonth: dayMonth,
    shortTime: shortTime, next: next, sites: sites,
    windowState: windowState, isOpen: isOpen
  };

  root.Elections = Elections;
  if (typeof module !== 'undefined' && module.exports) module.exports = Elections;
})(typeof self !== 'undefined' ? self : this);
