/* dock.js — the quick-access dock model shared by the three RawProd consoles.
 * Identical copy in web/, web-platform/ and web-vault/ (console-dock.test.ts enforces it).
 *
 * Owner, 2026-09-29: "dock is abnormally huge, it won't be responsive". The dock used to carry
 * EVERY destination a role holds (37 for the owner's Factory view) and several sections shared one
 * glyph. The reference QuickDock (rawprod-lanes/reference/admin, rac-console.jsx) carries a short
 * list of primary destinations, then "All sections" and the command button. So:
 *   - the dock shows at most MAX primary destinations — role defaults, or the user's own pins;
 *   - everything else stays one tap away in the sections sheet (the rail) and the go-to palette;
 *   - below 1024px it is the tab bar: the first PHONE destinations, Ask Aria and More;
 *   - GLYPHS gives every section its own artwork (the consoles' tests fail on a repeated glyph).
 * Pure: no DOM. Storage is passed in (localStorage in the browser, a stub in tests). */
(function (G) {
  'use strict';
  var MAX = 8, PHONE = 4;

  // 24-unit, stroke-only, single-path glyphs (the consoles draw each as one <path>).
  var GLYPHS = {
    zap: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
    boxIn: 'M4 13v7h16v-7M12 3v11M8 10l4 4 4-4',
    boxOut: 'M4 13v7h16v-7M12 15V4M8 8l4-4 4 4',
    layout: 'M3 3h18v18H3zM3 9h18M9 9v12M15 9v12',
    monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
    listcheck: 'M11 6h10M11 12h10M11 18h10M3 6l1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17',
    listnum: 'M10 6h11M10 12h11M10 18h11M4 4h1v5M4 9h2M6 19H4c0-1.2 2-2 2-3.2 0-.7-.5-1-1-1s-1 .3-1 .8',
    ruler: 'M3 17 17 3l4 4L7 21zM7.5 12.5l2 2M10.5 9.5l2 2M13.5 6.5l2 2',
    shapes: 'M3 14h7v7H3zM14 6.5a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0M13.5 21l4-7 4 7z',
    folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
    folderTree: 'M4 3v14h6M4 9h6M12 6h9v6h-9zM12 14h9v6h-9z',
    venn: 'M2 12a6 6 0 1 0 12 0 6 6 0 1 0-12 0M10 12a6 6 0 1 0 12 0 6 6 0 1 0-12 0',
    testtube: 'M8 2h8M9.5 2v15.5a2.5 2.5 0 0 0 5 0V2M9.5 11h5',
    thermo: 'M14 4a2 2 0 0 0-4 0v10.5a4 4 0 1 0 4 0zM12 9v7',
    key: 'M3 15.5a4.5 4.5 0 1 0 9 0 4.5 4.5 0 1 0-9 0M10.7 12.3 20 3M16 7l3 3M18.5 4.5l2 2',
    split: 'M16 3h5v5M8 3H3v5M12 22v-8.3a4 4 0 0 0-1.2-2.9L3 3M21 3l-7.8 7.8',
    map: 'M9 3 3 6v15l6-3 6 3 6-3V3l-6 3zM9 3v15M15 6v15',
    globe: 'M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
    cart: 'M2 3h2.5l2.6 12.2a1 1 0 0 0 1 .8h9.8a1 1 0 0 0 1-.8L21 7H5.8M8 20a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0M15.5 20a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0',
    fileText: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8M8 9h2',
    filePlus: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M12 12v6M9 15h6',
    boxes: 'M3 13h8v8H3zM13 13h8v8h-8zM8 3h8v8H8z',
    warehouse: 'M3 21V8l9-5 9 5v13M7 21v-8h10v8M7 17h10',
    branch: 'M6 3v12M15 6a3 3 0 1 0 6 0 3 3 0 1 0-6 0M3 18a3 3 0 1 0 6 0 3 3 0 1 0-6 0M18 9a9 9 0 0 1-9 9',
    archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
    history: 'M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5M12 7v5l4 2',
    edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
    link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
    scale: 'M12 3v18M7 21h10M4 7h16M6 7l-3 7a3 3 0 0 0 6 0zM18 7l-3 7a3 3 0 0 0 6 0z',
    shieldCheck: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
    award: 'M6 9a6 6 0 1 0 12 0 6 6 0 1 0-12 0M8.2 13.9 7 22l5-3 5 3-1.2-8.1',
    bookOpen: 'M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z',
    briefcase: 'M3 7h18v13H3zM8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18',
    signpost: 'M12 3v18M5 6h12l3 3-3 3H5zM9 21h6',
    idcard: 'M3 5h18v14H3zM6.5 10.5a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0M5.5 17a3.5 3.5 0 0 1 7 0M15 9h3M15 13h3',
    flag: 'M4 22V4M4 4h13l-2 4 2 4H4',
    login: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
    clipList: 'M9 4h6v3H9zM8 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2M9 12h6M9 16h6',
    clipCheck: 'M9 4h6v3H9zM8 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2M9 14l2 2 4-4',
    send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
    receipt: 'M5 2v20l3-2 2 2 2-2 2 2 2-2 3 2V2l-3 2-2-2-2 2-2-2-2 2zM9 8h6M9 12h6M9 16h4',
    chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM8 9h8M8 13h5',
    wallet: 'M3 7a2 2 0 0 1 2-2h14v4M3 7v12a2 2 0 0 0 2 2h16V9H5a2 2 0 0 1-2-2zM16.5 15h.01',
    store: 'M3 9l1.5-5h15L21 9M4 9v12h16V9M3 9h18M9 21v-6h6v6',
    trend: 'M3 3v18h18M7 15l4-4 3 3 6-6',
    chart: 'M3 3v18h18M8 17v-6M13 17V7M18 17v-4',
    coins: 'M3 9a6 6 0 1 0 12 0 6 6 0 1 0-12 0M15.5 10.2a6 6 0 1 1-5.3 9.3',
    book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
    door: 'M4 21h16M6 21V3h12v18M14 12h.01',
    inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-7z',
    drum: 'M5 5v14c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 5c0 1.7 3.1 3 7 3s7-1.3 7-3-3.1-3-7-3-7 1.3-7 3M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3',
    microscope: 'M6 18h8M3 22h18M14 22a7 7 0 1 0 0-14h-1M9 14h2M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2zM12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3',
    filter: 'M3 4h18l-7 8.5V19l-4 2v-8.5z',
    wrench: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z',
    move: 'M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4',
    hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
    floors: 'M2 20h20M4 20V10l8-6 8 6v10M4 14h16',
    zone: 'M3 3h4M10 3h4M17 3h4v4M21 10v4M21 17v4h-4M14 21h-4M7 21H3v-4M3 14v-4M3 7V3',
    rack: 'M5 3v18M19 3v18M5 8h14M5 14h14M5 20h14',
    bin: 'M3 8h18l-2 12H5zM8 8V5h8v3',
    ticket: 'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4zM13 5v2M13 11v2M13 17v2',
    package: 'M21 8 12 3 3 8v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8M7.5 5.5l9 5',
    packageCheck: 'M15 17l2 2 4-4M21 11V8l-9-5-9 5v8l9 5 1.5-.8M3 8l9 5 9-5M12 13v8',
    scan: 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M8 12l3 3 5-6',
    bottle: 'M10 2h4v4h-4zM9 6h6l1 3v11a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V9zM8 13h8',
    barcode: 'M3 5v14M6 5v14M10 5v14M13 5v14M17 5v14M21 5v14M8 5v14',
    tree: 'M9 3h6v5H9zM12 8v4M6 16v-4h12v4M3 16h6v5H3zM15 16h6v5h-6z',
    route: 'M3 19a2 2 0 1 0 4 0 2 2 0 1 0-4 0M17 5a2 2 0 1 0 4 0 2 2 0 1 0-4 0M7 19h8.5a3.5 3.5 0 0 0 0-7h-7a3.5 3.5 0 0 1 0-7H17',
    toggle: 'M2 12a5 5 0 0 1 5-5h10a5 5 0 0 1 0 10H7a5 5 0 0 1-5-5zM13 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
    plug: 'M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5',
    bulb: 'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V18h6v-1.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
    factory: 'M2 21V10l6 4V10l6 4V4h6v17zM2 21h20M17 8h.01'
  };

  function has(list, k) { for (var i = 0; i < list.length; i++) if (list[i] === k) return true; return false; }

  // The dock's destinations, in order: the user's pins when they have set any, else the role's
  // defaults — both filtered to what this session actually holds, de-duplicated, capped at `max`.
  // When the defaults resolve to fewer than `want` (a session missing a permission), the role's
  // own section order fills the gap so the dock is never half empty.
  function pick(keys, defaults, pins, max) {
    max = Math.min(max || MAX, MAX);
    var out = [];
    var push = function (k) { if (has(keys, k) && !has(out, k) && out.length < max) out.push(k); };
    if (pins && pins.length) { pins.forEach(push); if (out.length) return out; }
    (defaults || []).forEach(push);
    var uniq = (defaults || []).filter(function (k, i, a) { return a.indexOf(k) === i; }).length;
    var want = Math.min(max, Math.max(uniq, 1), keys.length);
    for (var i = 0; out.length < want && i < keys.length; i++) push(keys[i]);
    return out;
  }

  // Pins are per console, per workspace and per person: one browser can serve several staff.
  function storageKey(consoleName, role, user) {
    return 'rac.dock.v1:' + consoleName + ':' + (role || '-') + ':' + (user || 'anon');
  }
  function loadPins(store, key) {
    try {
      var v = JSON.parse((store && store.getItem(key)) || 'null');
      if (!Array.isArray(v)) return null;
      return v.filter(function (s) { return typeof s === 'string' && s; }).slice(0, MAX);
    } catch (e) { return null; }
  }
  function savePins(store, key, pins) {
    try {
      if (!store) return;
      if (pins == null) store.removeItem(key); else store.setItem(key, JSON.stringify(pins.slice(0, MAX)));
    } catch (e) { /* private window / blocked storage: pins last this page only */ }
  }
  // Pin or unpin `key` against the dock as it stands now. A full dock refuses a new pin.
  function togglePin(current, key) {
    var cur = (current || []).slice();
    var at = cur.indexOf(key);
    if (at >= 0) { cur.splice(at, 1); return { pins: cur, pinned: false, full: false }; }
    if (cur.length >= MAX) return { pins: cur, pinned: false, full: true };
    cur.push(key); return { pins: cur, pinned: true, full: false };
  }
  // Groups of section keys that would draw the same artwork: [[k1, k2], …]. Empty = all distinct.
  function duplicates(entries) {
    var by = {}, order = [];
    entries.forEach(function (e) {
      var sig = String(e[1] || '').replace(/\s+/g, '');
      if (!by[sig]) { by[sig] = []; order.push(sig); }
      if (!has(by[sig], e[0])) by[sig].push(e[0]);
    });
    return order.map(function (s) { return by[s]; }).filter(function (g) { return g.length > 1; });
  }

  G.RaDock = { MAX: MAX, PHONE: PHONE, GLYPHS: GLYPHS, pick: pick, storageKey: storageKey,
    loadPins: loadPins, savePins: savePins, togglePin: togglePin, duplicates: duplicates };
})(typeof window !== 'undefined' ? window : globalThis);
