/* ruh.js — always-on Ruh in every RawProd console (owner rulings 2026-10-06), published as
 * window.RaRuh. Identical copies live in web/, web-platform/ and web-vault/ because each console is
 * served from its own root (like dock.js and sound.js). Edit one, copy it to the other two.
 *
 *   The badge     a quiet button in the top bar (not a dock entry): Ruh's glyph, how many notes are
 *                 open, coloured by the most serious one (urgent → warn → suggest → info).
 *   The panel     a side panel: each note with its body, a prediction's basis when there is one, and
 *                 Open (the exact screen and record), Snooze, Done, Dismiss. Owners and platform
 *                 admins also get Ruh's settings and "Check now".
 *   Urgent        a new urgent note pops up with a short sound (sound.js: nothing plays before the
 *                 person's first click or key; Ruh has its own mute switch in the panel).
 *   RuhConfirm    one modal for every guarded action: the console's call came back
 *                 RUH_CONFIRM_REQUIRED, so the risks are shown and a typed reason (8+ characters)
 *                 lets the action go ahead. Ruh warns; it never blocks. Admins are told.
 *
 * Live updates: the consoles' own pattern — a poll through the encrypted tunnel every 20 s while
 * the tab is visible, answered "unchanged" cheaply by the server (rev). No other connection.
 * Everything shown comes from the server; nothing here decides a permission.
 */
(function (g) {
  'use strict';
  if (g.RaRuh) return;

  var SEV = ['urgent', 'warn', 'suggest', 'info'];
  var SEV_LABEL = { urgent: 'Urgent', warn: 'Warning', suggest: 'Suggestion', info: 'Note' };
  var CONSOLE_LABEL = { factory: 'Factory', platform: 'Platform', vault: 'Vault' };
  var POLL_MS = 20000;
  var MUTE_KEY = 'rac.ruh.sound.v1';
  var GLYPH = 'M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z';

  var cfg = null;          // { console, call(method, path, body) -> Promise<{status, json}>, open(insight) -> bool, canSettings() -> bool, toast(msg, bad) }
  var state = { rev: null, items: [], counts: { urgent: 0, warn: 0, suggest: 0, info: 0 }, top: null, seen: {}, first: true, tab: 'now', settings: null };
  var timer = null;
  var panel = null;
  var badges = [];

  function el(tag, attrs, kids) {
    var e = g.document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.indexOf('on') === 0 && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    (kids || []).forEach(function (c) { if (c == null) return; e.appendChild(typeof c === 'string' ? g.document.createTextNode(c) : c); });
    return e;
  }
  function svg(path, size) {
    var s = g.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size || 15); s.setAttribute('height', size || 15);
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.6');
    s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    var p = g.document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', path); s.appendChild(p);
    return s;
  }

  /* ── style (tokens only; the consoles' CSP allows inline styles) ─────────────────────── */
  function injectStyle() {
    if (g.document.getElementById('ra-ruh-style')) return;
    var css = [
      '.ruh-badge{display:inline-flex;align-items:center;gap:6px;position:relative}',
      '.ruh-badge .ruh-n{min-width:18px;height:18px;padding:0 5px;border-radius:999px;font:600 11px/18px var(--font-ui);text-align:center;color:#fff;background:var(--ink-3)}',
      '.ruh-badge[data-top="urgent"] .ruh-n{background:var(--red)}.ruh-badge[data-top="warn"] .ruh-n{background:var(--amber)}',
      '.ruh-badge[data-top="suggest"] .ruh-n{background:var(--blue)}.ruh-badge[data-top="info"] .ruh-n{background:var(--ink-3)}',
      '.ruh-badge[data-top="urgent"]{box-shadow:0 0 0 2px color-mix(in srgb,var(--red) 35%,transparent)}',
      '.ruh-panel{position:fixed;top:0;right:0;bottom:0;width:min(420px,100vw);z-index:9010;display:flex;flex-direction:column;background:var(--panel);border-left:1px solid var(--line);box-shadow:-18px 0 44px -24px rgba(0,0,0,.35);transform:translateX(102%);transition:transform .22s ease}',
      '.ruh-panel.open{transform:none}',
      '.ruh-hd{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid var(--line)}',
      '.ruh-hd h2{margin:0;font:600 15px/1.2 var(--font-ui);color:var(--ink)}.ruh-hd small{display:block;font:400 11.5px/1.3 var(--font-ui);color:var(--ink-3)}',
      '.ruh-hd .sp{flex:1}.ruh-ib{border:0;background:none;color:var(--ink-2);cursor:pointer;padding:6px;border-radius:8px;display:inline-flex}',
      '.ruh-ib:hover{background:var(--panel-2)}.ruh-tabs{display:flex;gap:4px;padding:8px 16px 0}',
      '.ruh-tabs button{border:0;background:none;padding:6px 10px;border-radius:999px;font:500 12px/1 var(--font-ui);color:var(--ink-3);cursor:pointer}',
      '.ruh-tabs button[aria-selected="true"]{background:var(--panel-2);color:var(--ink)}',
      '.ruh-bd{flex:1;overflow:auto;padding:12px 16px 24px;display:flex;flex-direction:column;gap:10px}',
      '.ruh-card{border:1px solid var(--line);border-radius:12px;padding:12px 12px 10px;background:var(--panel);display:flex;flex-direction:column;gap:6px}',
      '.ruh-card[data-sev="urgent"]{border-left:3px solid var(--red)}.ruh-card[data-sev="warn"]{border-left:3px solid var(--amber)}',
      '.ruh-card[data-sev="suggest"]{border-left:3px solid var(--blue)}.ruh-card[data-sev="info"]{border-left:3px solid var(--line-2)}',
      '.ruh-card h3{margin:0;font:600 13px/1.35 var(--font-ui);color:var(--ink)}.ruh-card p{margin:0;font:400 12.5px/1.45 var(--font-ui);color:var(--ink-2)}',
      '.ruh-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font:400 11px/1.3 var(--font-ui);color:var(--ink-3)}',
      '.ruh-pred{font:400 11.5px/1.4 var(--font-ui);color:var(--ink-2);background:var(--panel-2);border-radius:8px;padding:6px 8px}',
      '.ruh-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}.ruh-acts .btn{font-size:12px}',
      '.ruh-empty{padding:28px 8px;text-align:center;color:var(--ink-3);font:400 13px/1.5 var(--font-ui)}',
      '.ruh-toast{position:fixed;right:16px;top:16px;z-index:9020;max-width:min(380px,calc(100vw - 32px));background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--red);border-radius:12px;padding:12px 14px;box-shadow:0 18px 44px -14px rgba(0,0,0,.45);display:flex;flex-direction:column;gap:6px}',
      '.ruh-toast strong{font:600 13px/1.35 var(--font-ui);color:var(--ink)}.ruh-toast span{font:400 12px/1.4 var(--font-ui);color:var(--ink-2)}',
      '.ruh-modal{position:fixed;inset:0;z-index:9030;display:flex;align-items:center;justify-content:center;padding:16px}',
      '.ruh-modal .ruh-scrim{position:absolute;inset:0;background:rgba(10,10,10,.42)}',
      '.ruh-dlg{position:relative;width:min(560px,100%);max-height:calc(100vh - 32px);overflow:auto;background:var(--panel);border-radius:16px;border:1px solid var(--line);padding:18px 18px 16px;display:flex;flex-direction:column;gap:12px;box-shadow:0 30px 80px -20px rgba(0,0,0,.5)}',
      '.ruh-dlg h2{margin:0;font:600 16px/1.3 var(--font-ui);color:var(--ink)}.ruh-dlg p{margin:0;font:400 13px/1.5 var(--font-ui);color:var(--ink-2)}',
      '.ruh-risk{border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:4px}',
      '.ruh-risk strong{font:600 13px/1.35 var(--font-ui);color:var(--ink)}.ruh-risk span{font:400 12.5px/1.45 var(--font-ui);color:var(--ink-2)}',
      '.ruh-dlg textarea{width:100%;min-height:84px;box-sizing:border-box;border:1px solid var(--line-2);border-radius:10px;padding:9px 10px;font:400 13px/1.45 var(--font-ui);color:var(--ink);background:var(--panel);resize:vertical}',
      '.ruh-row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;align-items:center}.ruh-row .sp{flex:1;font:400 11.5px/1.3 var(--font-ui);color:var(--ink-3)}',
      '.ruh-set{display:grid;grid-template-columns:1fr 120px;gap:8px 10px;align-items:center;font:400 12.5px/1.35 var(--font-ui);color:var(--ink-2)}',
      '.ruh-set input{width:100%;box-sizing:border-box;border:1px solid var(--line-2);border-radius:8px;padding:5px 7px;font:400 12.5px/1.3 var(--font-ui);color:var(--ink);background:var(--panel)}',
      '.ruh-set .wide{grid-column:1/-1}.ruh-focus{outline:2px solid var(--amber);outline-offset:2px;border-radius:6px;transition:outline-color 1.6s}',
      '@media (max-width:640px){.ruh-badge .ruh-l{display:none}.ruh-set{grid-template-columns:1fr 96px}}'
    ].join('\n');
    g.document.head.appendChild(el('style', { id: 'ra-ruh-style', text: css }));
  }

  /* ── sound: urgent only, after a gesture (sound.js), with Ruh's own mute ─────────────── */
  function ruhSoundOn() { try { return g.localStorage.getItem(MUTE_KEY) !== '0'; } catch (e) { return true; } }
  function setRuhSound(on) { try { g.localStorage.setItem(MUTE_KEY, on ? '1' : '0'); } catch (e) { /* storage off */ } }
  function chime() { if (ruhSoundOn() && g.RaSound) g.RaSound.play('alert'); }

  /* ── data ────────────────────────────────────────────────────────────────────────────── */
  function listPath(full) {
    var q = [];
    if (!full && state.rev !== null) q.push('since=' + state.rev);
    if (cfg.console === 'vault') q.push('console=vault');
    return '/v1/ruh/insights' + (q.length ? '?' + q.join('&') : '');
  }
  function refresh(full) {
    if (!cfg) return Promise.resolve();
    return cfg.call('GET', listPath(full)).then(function (r) {
      var d = r && r.status < 400 && r.json ? r.json.data : null;
      if (!d) return;
      if (d.unchanged) { state.rev = d.rev; return; }
      var fresh = [];
      (d.items || []).forEach(function (i) {
        if (!state.seen[i.id] && i.status === 'open' && i.severity === 'urgent') fresh.push(i);
        state.seen[i.id] = true;
      });
      state.rev = d.rev; state.items = d.items || []; state.counts = d.counts || state.counts; state.top = d.top || null;
      paintBadges();
      if (panel && panel.classList.contains('open') && state.tab === 'now') paintList();
      if (fresh.length) popUrgent(fresh, state.first);
      state.first = false;
    }).catch(function () { /* offline or signed out: try again on the next tick */ });
  }
  function act(item, action, body) {
    return cfg.call('POST', '/v1/ruh/insights/' + item.id + '/' + action, body || {}).then(function (r) {
      if (r.status >= 400) { say((r.json && r.json.error && r.json.error.message) || 'Ruh could not save that. Try again.', true); return; }
      say(action === 'snooze' ? 'Snoozed. Ruh will bring it back.' : action === 'done' ? 'Marked done.' : 'Dismissed.');
      return refresh(true);
    }).catch(function () { say('Ruh could not save that. Try again.', true); });
  }
  function say(msg, bad) { if (cfg && cfg.toast) cfg.toast(msg, !!bad); }

  /* ── badge ───────────────────────────────────────────────────────────────────────────── */
  function openCount() { return (state.counts.urgent || 0) + (state.counts.warn || 0) + (state.counts.suggest || 0) + (state.counts.info || 0); }
  function paintBadge(b) {
    var n = openCount();
    b.setAttribute('data-top', state.top || 'none');
    var label = n ? 'Ruh: ' + n + ' open' + (state.counts.urgent ? ', ' + state.counts.urgent + ' urgent' : '') : 'Ruh: nothing needs you';
    b.setAttribute('aria-label', label); b.title = label;
    var c = b.querySelector('.ruh-n'); if (c) { c.textContent = n > 99 ? '99+' : String(n); c.style.display = n ? '' : 'none'; }
  }
  function paintBadges() { badges = badges.filter(function (b) { return b.isConnected; }); badges.forEach(paintBadge); }
  /** A badge button for the console's top bar. `cls` matches the bar's own buttons. */
  function badge(cls) {
    var b = el('button', { type: 'button', class: (cls || 'gbtn') + ' ruh-badge', 'data-ruh-badge': true, onclick: function (e) { e.stopPropagation(); toggle(); } },
      [svg(GLYPH, 15), el('span', { class: 'ruh-l', text: 'Ruh' }), el('span', { class: 'ruh-n', text: '0', style: 'display:none' })]);
    badges.push(b); paintBadge(b);
    return b;
  }

  /* ── panel ───────────────────────────────────────────────────────────────────────────── */
  function ensurePanel() {
    if (panel && panel.isConnected) return panel;
    var mute = el('button', { type: 'button', class: 'ruh-ib', 'data-ruh-mute': true });
    function paintMute() {
      var on = ruhSoundOn();
      mute.setAttribute('aria-pressed', on ? 'true' : 'false');
      mute.setAttribute('aria-label', on ? 'Mute Ruh’s urgent sound' : 'Unmute Ruh’s urgent sound');
      mute.title = on ? 'Urgent sound on' : 'Urgent sound muted';
      mute.innerHTML = '';
      mute.appendChild(svg(on ? 'M4 9.5h3l4.5-3.6v12.2L7 14.5H4zM15.6 9a4.2 4.2 0 0 1 0 6M18.2 6.6a7.6 7.6 0 0 1 0 10.8' : 'M4 9.5h3l4.5-3.6v12.2L7 14.5H4zM16 9.6l4.4 4.8M20.4 9.6 16 14.4', 15));
    }
    mute.addEventListener('click', function () { setRuhSound(!ruhSoundOn()); paintMute(); });
    paintMute();
    var tabs = el('div', { class: 'ruh-tabs', role: 'tablist', 'aria-label': 'Ruh' });
    panel = el('aside', { class: 'ruh-panel', id: 'ra-ruh-panel', role: 'complementary', 'aria-label': 'Ruh', 'aria-hidden': 'true', inert: true }, [
      el('div', { class: 'ruh-hd' }, [
        svg(GLYPH, 18),
        el('div', {}, [el('h2', { text: 'Ruh' }), el('small', { text: 'Watching ' + (cfg.console === 'vault' ? 'the Vault' : cfg.console === 'platform' ? 'the platform' : 'the factory') + ' for you' })]),
        el('span', { class: 'sp' }), mute,
        el('button', { type: 'button', class: 'ruh-ib', 'aria-label': 'Close Ruh', onclick: close }, [svg('m6 6 12 12M18 6 6 18', 15)]),
      ]),
      tabs,
      el('div', { class: 'ruh-bd', id: 'ra-ruh-body' }),
    ]);
    g.document.body.appendChild(panel);
    paintTabs();
    return panel;
  }
  function paintTabs() {
    var tabs = panel.querySelector('.ruh-tabs'); tabs.innerHTML = '';
    var list = [['now', 'Now']];
    if (cfg.canSettings && cfg.canSettings()) list.push(['settings', 'Settings']);
    if (list.length < 2) { tabs.style.display = 'none'; state.tab = 'now'; return; }
    tabs.style.display = '';
    list.forEach(function (t) {
      tabs.appendChild(el('button', { type: 'button', role: 'tab', 'aria-selected': state.tab === t[0] ? 'true' : 'false', text: t[1],
        onclick: function () { state.tab = t[0]; paintTabs(); paint(); } }));
    });
  }
  function isOpen() { return !!(panel && panel.classList.contains('open')); }
  function open() {
    ensurePanel(); paintTabs();
    panel.classList.add('open'); panel.removeAttribute('aria-hidden'); panel.removeAttribute('inert');
    paint(); refresh(true);
    var f = panel.querySelector('.ruh-ib'); if (f) f.focus();
  }
  function close() { if (!panel) return; panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true'); panel.setAttribute('inert', ''); }
  function toggle() { if (isOpen()) close(); else open(); }
  function paint() { if (state.tab === 'settings') paintSettings(); else paintList(); }

  function when(iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    var s = Math.max(1, Math.round((Date.now() - d.getTime()) / 1000));
    if (s < 60) return 'just now'; var m = Math.round(s / 60); if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60); if (h < 24) return h + ' h ago'; return Math.round(h / 24) + ' d ago';
  }
  function predictionLine(p) {
    if (!p || !p.basis) return null;
    var conf = typeof p.confidence === 'number' ? ' · confidence ' + Math.round(p.confidence * 100) + '%' : '';
    return el('div', { class: 'ruh-pred' }, ['Predicted from ', p.basis, conf]);
  }
  function snoozeButton(i) {
    var b = el('button', { type: 'button', class: 'btn sm', text: 'Snooze' });
    b.addEventListener('click', function () {
      var opts = [[60, '1 hour'], [240, '4 hours'], [1440, 'Tomorrow']];
      var row = b.parentNode; b.remove();
      opts.forEach(function (o) { row.insertBefore(el('button', { type: 'button', class: 'btn sm', text: o[1], onclick: function () { act(i, 'snooze', { minutes: o[0] }); } }), row.lastChild); });
    });
    return b;
  }
  function card(i) {
    var other = i.console !== cfg.console;
    var openLabel = other ? 'Open in ' + (CONSOLE_LABEL[i.console] || 'its console') : 'Open';
    var acts = el('div', { class: 'ruh-acts' }, [
      i.deepLink ? el('button', { type: 'button', class: 'btn sm p', text: openLabel, onclick: function () { openInsight(i); } }) : null,
      i.status === 'open' ? snoozeButton(i) : null,
      el('button', { type: 'button', class: 'btn sm', text: 'Done', onclick: function () { act(i, 'done'); } }),
      el('button', { type: 'button', class: 'btn sm', text: 'Dismiss', onclick: function () { act(i, 'dismiss'); } }),
    ]);
    return el('article', { class: 'ruh-card', 'data-sev': i.severity, 'data-ruh-insight': i.id }, [
      el('div', { class: 'ruh-meta' }, [
        el('span', { class: 'chip ' + ({ urgent: 'r', warn: 'a', suggest: 'b', info: 'n' }[i.severity] || 'n'), text: SEV_LABEL[i.severity] || 'Note' }),
        el('span', { text: when(i.createdAt) }),
        i.status === 'snoozed' ? el('span', { text: 'snoozed until ' + new Date(i.snoozedUntil).toLocaleString() }) : null,
        other ? el('span', { text: CONSOLE_LABEL[i.console] }) : null,
      ]),
      el('h3', { text: i.title }),
      el('p', { text: i.body }),
      predictionLine(i.prediction),
      acts,
    ]);
  }
  function paintList() {
    var body = panel && panel.querySelector('#ra-ruh-body'); if (!body) return;
    body.innerHTML = '';
    if (!state.items.length) {
      body.appendChild(el('div', { class: 'ruh-empty' }, ['All clear. Ruh is watching and will tell you when something needs you.']));
      return;
    }
    var order = state.items.slice().sort(function (a, b) {
      if ((a.status === 'snoozed') !== (b.status === 'snoozed')) return a.status === 'snoozed' ? 1 : -1;
      return SEV.indexOf(a.severity) - SEV.indexOf(b.severity);
    });
    order.forEach(function (i) { body.appendChild(card(i)); });
  }

  /* ── settings (owner / platform admin) ───────────────────────────────────────────────── */
  var SETTING_LABELS = [
    ['watch.intervalSeconds', 'How often Ruh checks (seconds; 0 turns it off)', 'number'],
    ['qc.coaWaitHours', 'Batch waiting for COA results (hours)', 'number'],
    ['qc.releaseWaitHours', 'Passed QC but not released (hours)', 'number'],
    ['shelf.taskOverdueHours', 'Put-away or pick open too long (hours)', 'number'],
    ['shelf.binMaxBatches', 'Most batches one bin should hold', 'number'],
    ['shelf.binMaxQty', 'Most units one bin should hold (blank: not checked)', 'number'],
    ['shelf.binNearPct', '"Nearly full" from (%)', 'number'],
    ['stock.runoutWarnDays', 'Warn when a raw material runs out within (days)', 'number'],
    ['stock.consumptionWindowDays', 'Use rate worked out over (days)', 'number'],
    ['production.throughputWindowDays', 'Production rate worked out over (days)', 'number'],
    ['bridge.staleMinutes', 'Updates to ALEMBIC waiting too long (minutes)', 'number'],
    ['catalogue.staleHours', 'Catalogue not refreshed for (hours)', 'number'],
    ['guard.coaEdgeMarginPct', 'COA result "at the edge" within (% of the spec range)', 'number'],
    ['guard.bulkApproveMinVersions', 'Ask for a reason when approving at least (recipes at once)', 'number'],
    ['guard.pickLightProductionOnly', 'Pick-to-light warning only in the live factory', 'checkbox'],
    ['signals.enabled', 'Send Ruh’s notes to ALEMBIC', 'checkbox'],
    ['links.factoryUrl', 'Factory console address', 'url'],
    ['links.platformUrl', 'Platform console address', 'url'],
    ['links.vaultUrl', 'Vault console address', 'url']
  ];
  function paintSettings() {
    var body = panel && panel.querySelector('#ra-ruh-body'); if (!body) return;
    body.innerHTML = '';
    body.appendChild(el('div', { class: 'ruh-empty', text: 'Loading…' }));
    cfg.call('GET', '/v1/ruh/settings').then(function (r) {
      var rows = r && r.status < 400 && r.json ? r.json.data : null;
      body.innerHTML = '';
      if (!rows) { body.appendChild(el('div', { class: 'ruh-empty', text: 'Ruh’s settings are for the owner and platform admins.' })); return; }
      var byKey = {}; rows.forEach(function (x) { byKey[x.key] = x; });
      var grid = el('div', { class: 'ruh-set' });
      var inputs = {};
      SETTING_LABELS.forEach(function (s) {
        var cur = byKey[s[0]]; if (!cur) return;
        var input;
        if (s[2] === 'checkbox') input = el('input', { type: 'checkbox', checked: !!cur.value, 'aria-label': s[1] });
        else input = el('input', { type: s[2] === 'url' ? 'url' : 'number', value: cur.value === null || cur.value === undefined ? '' : String(cur.value), 'aria-label': s[1], placeholder: s[2] === 'url' ? 'https://' : '' });
        inputs[s[0]] = [input, s[2], cur.value];
        if (s[2] === 'url') { grid.appendChild(el('label', { class: 'wide', text: s[1] })); input.className = 'wide'; grid.appendChild(input); }
        else { grid.appendChild(el('label', { text: s[1] })); grid.appendChild(input); }
      });
      var save = el('button', { type: 'button', class: 'btn sm p', text: 'Save' });
      var check = el('button', { type: 'button', class: 'btn sm', text: 'Check now' });
      save.addEventListener('click', function () {
        var change = {};
        Object.keys(inputs).forEach(function (k) {
          var x = inputs[k], v;
          if (x[1] === 'checkbox') v = x[0].checked;
          else if (x[1] === 'url') v = x[0].value.trim() || null;
          else v = x[0].value.trim() === '' ? null : Number(x[0].value);
          if (JSON.stringify(v) !== JSON.stringify(x[2])) change[k] = v;
        });
        if (!Object.keys(change).length) { say('Nothing changed.'); return; }
        cfg.call('PUT', '/v1/ruh/settings', change).then(function (res) {
          if (res.status >= 400) { say((res.json && res.json.error && res.json.error.message) || 'Not saved.', true); return; }
          say('Ruh’s settings are saved.'); paintSettings();
        });
      });
      check.addEventListener('click', function () {
        check.disabled = true;
        cfg.call('POST', '/v1/ruh/watch/run', {}).then(function (res) {
          check.disabled = false;
          if (res.status >= 400) { say('Ruh could not check just now.', true); return; }
          say('Ruh checked everything.'); state.tab = 'now'; paintTabs(); refresh(true).then(paintList);
        });
      });
      body.appendChild(grid);
      body.appendChild(el('div', { class: 'ruh-row' }, [el('span', { class: 'sp', text: 'Changes apply from Ruh’s next check.' }), check, save]));
    }).catch(function () { body.innerHTML = ''; body.appendChild(el('div', { class: 'ruh-empty', text: 'Can’t connect. Try again.' })); });
  }

  /* ── deep links ──────────────────────────────────────────────────────────────────────── */
  function openInsight(i) {
    if (i.console !== cfg.console) {
      if (i.href) { g.open(i.href, '_blank', 'noopener'); return; }
      say('Open it in the ' + (CONSOLE_LABEL[i.console] || 'other') + ' console.');
      return;
    }
    var handled = cfg.open ? cfg.open(i) : false;
    if (handled === false) say('That screen is not part of your workspace.');
    else close(); // the record is on screen now; the badge brings Ruh back
  }
  /** After a navigation: find the record on the new screen (by its id), scroll to it and mark it. */
  function focusRecord(id, root) {
    if (!id) return;
    var tries = 0;
    (function look() {
      var scope = root || g.document;
      var hit = scope.querySelector('[data-ruh-id="' + id + '"]') || scope.querySelector('[data-rid="' + id + '"]');
      if (!hit) {
        var all = scope.querySelectorAll('[data-plan],[data-id],[data-k],[data-coa],[data-task]');
        for (var n = 0; n < all.length && !hit; n++) {
          for (var a = 0; a < all[n].attributes.length; a++) { if (all[n].attributes[a].value === id) { hit = all[n].closest('tr,article,.card') || all[n]; break; } }
        }
      }
      if (!hit) { if (++tries < 30) setTimeout(look, 200); return; }
      if (hit.scrollIntoView) hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
      hit.classList.add('ruh-focus');
      if (hit.classList.contains('ra-drow') && hit.getAttribute('aria-expanded') !== 'true') hit.click();
      setTimeout(function () { hit.classList.remove('ruh-focus'); }, 4000);
    })();
  }

  /* ── urgent pop-up ───────────────────────────────────────────────────────────────────── */
  function popUrgent(list, firstLoad) {
    var i = list[0];
    var t = el('div', { class: 'ruh-toast', role: 'alert' }, [
      el('strong', { text: list.length > 1 ? (firstLoad ? list.length + ' urgent notes from Ruh' : list.length + ' new urgent notes from Ruh') : 'Urgent: ' + i.title }),
      el('span', { text: list.length > 1 ? i.title : i.body }),
      el('div', { class: 'ruh-acts' }, [
        el('button', { type: 'button', class: 'btn sm p', text: list.length > 1 ? 'Show' : 'Open', onclick: function () { t.remove(); if (list.length > 1) open(); else openInsight(i); } }),
        el('button', { type: 'button', class: 'btn sm', text: 'Later', onclick: function () { t.remove(); } }),
      ]),
    ]);
    var old = g.document.querySelector('.ruh-toast'); if (old) old.remove();
    g.document.body.appendChild(t);
    chime();
    setTimeout(function () { if (t.parentNode) t.remove(); }, 12000);
  }

  /* ── RuhConfirm: the one modal for every guarded action ──────────────────────────────── */
  function needsConfirm(res) {
    return !!(res && res.status === 409 && res.json && res.json.error && res.json.error.code === 'RUH_CONFIRM_REQUIRED');
  }
  /** Shows the risks and asks why. Resolves to the typed reason, or null when the person cancels. */
  function confirm(error, opts) {
    opts = opts || {};
    var details = (error && error.details) || {};
    var risks = Array.isArray(details.risks) ? details.risks : [];
    return new Promise(function (resolve) {
      var reason = el('textarea', { id: 'ra-ruh-reason', 'aria-label': 'Why are you going ahead?', placeholder: 'Why are you going ahead? (at least 8 characters)', maxlength: '1000' });
      if (opts.prefill) reason.value = String(opts.prefill).slice(0, 1000);
      var left = el('span', { class: 'sp' });
      var go = el('button', { type: 'button', class: 'btn p', text: 'Go ahead' });
      var cancel = el('button', { type: 'button', class: 'btn', text: 'Cancel' });
      function check() {
        var n = reason.value.trim().length;
        go.disabled = n < 8;
        left.textContent = n < 8 ? (8 - n) + ' more character' + (8 - n === 1 ? '' : 's') + ' needed' : 'Your reason is kept and the admins are told.';
      }
      reason.addEventListener('input', check);
      var wrap = el('div', { class: 'ruh-modal', id: 'ra-ruh-confirm' }, [
        el('div', { class: 'ruh-scrim', onclick: function () { done(null); } }),
        el('div', { class: 'ruh-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ra-ruh-confirm-t' }, [
          el('h2', { id: 'ra-ruh-confirm-t', text: 'Ruh has a warning' }),
          el('p', { text: details.actionLabel ? 'You are about to ' + details.actionLabel + '. Ruh found:' : 'Before you go ahead, Ruh found:' }),
          el('div', {}, risks.map(function (r) {
            return el('div', { class: 'ruh-risk' }, [
              el('div', { class: 'ruh-meta' }, [el('span', { class: 'chip ' + ({ urgent: 'r', warn: 'a', suggest: 'b', info: 'n' }[r.severity] || 'a'), text: SEV_LABEL[r.severity] || 'Warning' })]),
              el('strong', { text: r.title }), el('span', { text: r.detail }),
            ]);
          })),
          el('p', { text: 'You can go ahead: Ruh never blocks. Type why, and your reason goes to the admins with this warning.' }),
          reason,
          el('div', { class: 'ruh-row' }, [left, cancel, go]),
        ]),
      ]);
      function done(v) {
        g.document.removeEventListener('keydown', onKey, true);
        if (wrap.parentNode) wrap.remove();
        resolve(v);
      }
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); done(null); } }
      cancel.addEventListener('click', function () { done(null); });
      go.addEventListener('click', function () { var v = reason.value.trim(); if (v.length >= 8) done(v); });
      g.document.addEventListener('keydown', onKey, true);
      g.document.body.appendChild(wrap);
      check();
      if (g.RaSound) g.RaSound.play('notify');
      setTimeout(function () { reason.focus(); }, 0);
    });
  }
  /** The same request again, carrying the typed reason. */
  function withOverride(opts, reason) {
    var o = {}; for (var k in opts || {}) { if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k]; }
    var body = {}; var b = (opts && opts.body) || {};
    if (b && typeof b === 'object' && !Array.isArray(b)) for (var j in b) { if (Object.prototype.hasOwnProperty.call(b, j)) body[j] = b[j]; }
    body.ruhOverride = { reason: reason };
    o.body = body; o.ruhConfirmed = true;
    return o;
  }
  /** What a guarded call answers when the person chose not to go ahead. */
  function cancelled() {
    return { status: 409, json: { data: null, error: { code: 'RUH_CANCELLED', message: 'Not done: you chose not to go ahead.' } } };
  }
  /**
   * The consoles' tunnel hook: when `res` is a Ruh warning, show RuhConfirm and resend with the
   * reason (`resend(opts)`); otherwise return `res` as it is.
   */
  function guard(res, opts, resend) {
    if (!needsConfirm(res) || (opts && opts.ruhConfirmed)) return Promise.resolve(res);
    return g.RaRuh.confirm(res.json.error, { prefill: opts && opts.body && typeof opts.body.reason === 'string' ? opts.body.reason : '' }).then(function (reason) {
      if (reason === null) return cancelled();
      return resend(withOverride(opts, reason));
    });
  }

  /* ── lifecycle ───────────────────────────────────────────────────────────────────────── */
  function start(options) {
    stop();
    cfg = options;
    state = { rev: null, items: [], counts: { urgent: 0, warn: 0, suggest: 0, info: 0 }, top: null, seen: {}, first: true, tab: 'now', settings: null };
    injectStyle();
    refresh(true);
    timer = setInterval(function () { if (!g.document.hidden) refresh(false); }, POLL_MS);
    g.document.addEventListener('visibilitychange', onVisible);
  }
  function onVisible() { if (!g.document.hidden && cfg) refresh(false); }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    g.document.removeEventListener('visibilitychange', onVisible);
    if (panel && panel.parentNode) panel.remove();
    panel = null; cfg = null; badges = [];
    var t = g.document.querySelector('.ruh-toast'); if (t) t.remove();
  }

  g.RaRuh = {
    start: start, stop: stop, refresh: refresh, badge: badge, open: open, close: close, toggle: toggle, isOpen: isOpen,
    focusRecord: focusRecord, needsConfirm: needsConfirm, confirm: confirm, withOverride: withOverride, cancelled: cancelled, guard: guard,
    state: function () { return state; }, POLL_MS: POLL_MS
  };
})(window);
