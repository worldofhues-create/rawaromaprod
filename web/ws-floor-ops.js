/* RAW AROMA — ws-floor-ops module (lane pf-c, production-floor plan P3 + P4, sections 2, 6, 8, 9,
 * 12.4-12.6). Screens:
 *
 *   Devices          Admin: add a printer / TV / kiosk / scale for ONE station; a 6-digit code and
 *                    QR (10 minutes); new code; revoke; online/offline; station alerts.
 *   Print queue      a station's labels: printed / queued / failed / parked; print in the browser
 *                    (the fallback, same template); reprint only with a reason (REPRINT); retry.
 *   Maceration       timers ("Day 23 of 45"), freeze step, extend, admin-only early release; the
 *                    per-formula setting (required, min/max days, freeze).
 *   Packing station  QC-approved lots -> units (weight from the scale or typed, within tolerance,
 *                    sealed) -> cartons (scan units; wrong order/lot refused) -> carton weight ->
 *                    finish (carton i of N labels + packing list).
 *   Logistics        scan every carton -> documents -> courier + AWB (scan or type) -> handover;
 *                    exceptions (no-show, damaged, address mismatch).
 *   Couriers         connectors: off/test/live, one-click Connect (credentials sealed, never shown).
 *   Floor board      the TV board: queue, maceration timers, QC backlog, alerts. #floorboard=tv
 *                    opens it full screen.
 *
 * Kiosk lock: a tablet paired at /pair.html as a kiosk keeps {station, screen} in this browser;
 * once someone signs in, the console shows ONLY that station's screen (no rail, no way out short of
 * an admin unpairing it), and every completion is blocked while the network is down.
 *
 * Plain classic script after shell.js (tunnel, escHtml, toast, can, st, session, ROLES, navTo,
 * loadView). Weights are integer mg on the wire; display is lane A's web/weight.js (RaWeight).
 * Labels render with web/label-render.js (RaLabel). Nothing here decides a permission.
 */
'use strict';
(function () {
  var FV = {};
  var W = window.RaWeight || {
    // Only if lane A's web/weight.js failed to load: same interface, plain grams.
    formatWeight: function (mg) { return (Math.round(Number(mg) / 10) / 100) + ' g'; },
    parseToMg: function (t, unit) { var n = Number(String(t).trim()); if (!isFinite(n) || n < 0) return null; var f = { mg: 1, g: 1000, kg: 1000000 }[unit || 'g']; var v = Math.round(n * f); return Math.abs(v - n * f) < 1e-6 ? v : null; }
  };
  function err(res, fallback) { return (res && res.json && res.json.error && res.json.error.message) || fallback; }
  function data(res) { return res && res.json && res.json.data; }
  function chip(tone, text) { return '<span class="chip ' + tone + '"><i class="dot"></i>' + escHtml(text) + '</span>'; }
  function btn(id, label, cls, attrs) { return '<button ' + (/\btype=/.test(attrs || '') ? '' : 'type="button" ') + (id ? 'id="' + id + '" ' : '') + 'class="btn ' + (cls || 'sm') + '"' + (attrs || '') + '>' + label + '</button>'; }
  function fld(id, label, attrs) { return '<label style="display:flex;flex-direction:column;gap:5px;min-width:0"><span class="t-cap">' + escHtml(label) + '</span><input id="' + id + '" class="fld" ' + (attrs || '') + '></label>'; }
  function sel(id, label, opts, cur) { return '<label style="display:flex;flex-direction:column;gap:5px"><span class="t-cap">' + escHtml(label) + '</span><select id="' + id + '" class="fld">' + opts.map(function (o) { return '<option value="' + escHtml(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + '>' + escHtml(o[1]) + '</option>'; }).join('') + '</select></label>'; }
  function card(title, sub, body) { return '<div class="card"><div class="card-hd"><h2>' + escHtml(title) + '</h2>' + (sub ? '<span class="n">' + escHtml(sub) + '</span>' : '') + '</div><div class="card-bd">' + body + '</div></div>'; }
  function grid(cells) { return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;align-items:end">' + cells.join('') + '</div>'; }
  function table(head, rows) {
    return '<div style="overflow-x:auto"><table class="tbl"><thead><tr>' + head.map(function (h) { return '<th>' + escHtml(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      (rows.length ? rows.join('') : '<tr><td colspan="' + head.length + '" style="color:var(--ink-3)">Nothing here yet.</td></tr>') + '</tbody></table></div>';
  }
  function val(id) { var e = document.getElementById(id); return e ? String(e.value || '').trim() : ''; }
  function on(id, ev, fn) { var e = document.getElementById(id); if (e) e.addEventListener(ev, fn); }
  function when(v) { return v ? String(v).replace('T', ' ').slice(0, 16) : ''; }
  async function call(path, method, body) {
    if (method && method !== 'GET' && !navigator.onLine) { toast('No network. Nothing was saved; try again when the network is back.', 'bad'); return null; }
    var res;
    try { res = await tunnel(path, method ? { method: method, body: body || {} } : undefined); } catch (e) { toast('Can\'t connect. Try again.', 'bad'); return null; }
    if (res.status >= 400) { toast(err(res, 'That did not work (' + res.status + ').'), 'bad'); return null; }
    return data(res);
  }
  /** In-page questions (the house rule: never the browser's prompt/confirm). */
  function ask(title, intro, fields, submit) {
    return new Promise(function (resolve) {
      var done = false;
      var m = askForm({ title: title, intro: intro, fields: fields, submit: submit, onSubmit: function (vals, fail, close) { done = true; close(); resolve(vals); } });
      var obs = new MutationObserver(function () { if (!m.scrim.parentNode) { obs.disconnect(); if (!done) resolve(null); } });
      obs.observe(document.body, { childList: true });
    });
  }
  function sure(message, label) { return new Promise(function (resolve) { raConfirm(message, function () { resolve(true); }, { confirmLabel: label || 'Confirm' }); setTimeout(function () { var x = document.getElementById('ra-confirm'); if (x) { var no = x.querySelector('[data-confirm-no]'), xx = x.parentNode.querySelector('[data-sheet-x]'); [no, xx].forEach(function (b) { if (b) b.addEventListener('click', function () { resolve(false); }); }); } }, 0); }); }
  function stationKey(kind) { return 'ra.floor.station.' + kind; }
  function station(kind, dflt) {
    var k = kiosk(); if (k && k.station) return k.station;
    try { return localStorage.getItem(stationKey(kind)) || dflt; } catch (e) { return dflt; }
  }
  function setStation(kind, v) { try { localStorage.setItem(stationKey(kind), v); } catch (e) { /* private mode: not remembered */ } }

  /* ── printing: the browser fallback renders the job's own template ─────────────────────── */
  function printTemplate(title, template) {
    if (!window.RaLabel) { toast('The label renderer did not load. Reload the page.', 'bad'); return false; }
    var html = RaLabel.render(template, 'html').body;
    var w = window.open('', '_blank', 'width=700,height=800');
    if (!w) { toast('Allow pop-ups to print in the browser.', 'bad'); return false; }
    w.document.write('<!doctype html><meta charset="utf-8"><title>' + escHtml(title) + '</title><style>@page{size:' + template.w + 'mm ' + template.h + 'mm;margin:0}body{margin:0}</style>' + html);
    w.document.close();
    // Printed from here, not by a script inside the pop-up (a strict CSP would block that).
    setTimeout(function () { try { w.focus(); w.print(); } catch (e) { /* the person can print from the window */ } }, 250);
    return true;
  }
  async function browserPrint(job) {
    if (!printTemplate(job.labelKind + ' ' + (job.subjectRef || ''), job.template)) return;
    await call('/v1/print-jobs/' + job.printJobId + '/browser-printed', 'POST');
  }
  /** After an action queued labels: print the browser ones now, say where the rest went. */
  async function handleJobs(jobs) {
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i]; if (!j) continue;
      if (j.status === 'browser') await browserPrint(j);
    }
    var sent = jobs.filter(function (j) { return j && j.status === 'queued'; }).length;
    if (sent) toast(sent + ' label(s) sent to the station printer.', 'good');
  }

  /* ── navigation ──────────────────────────────────────────────────────────────────────────── */
  var NAV = {
    devices: ['devices', 'Devices', 'panel', '__devices__'],
    printq: ['printq', 'Print queue', 'tag', '__printq__'],
    maceration: ['maceration', 'Maceration', 'calendar', '__maceration__'],
    packing: ['packing', 'Packing station', 'box', '__packing__'],
    logistics: ['logistics', 'Logistics station', 'truck', '__logistics__'],
    couriers: ['couriers', 'Couriers', 'refresh', '__couriers__'],
    floorboard: ['floorboard', 'Floor board', 'activity', '__floorboard__']
  };
  var BY_ROLE = {
    superadmin: ['devices', 'printq', 'maceration', 'packing', 'logistics', 'couriers', 'floorboard'],
    admin: ['devices', 'maceration', 'couriers', 'floorboard'],
    production: ['maceration', 'printq', 'floorboard'],
    qc: ['maceration', 'floorboard'],
    packaging: ['packing', 'printq', 'floorboard'],
    packing: ['packing', 'printq', 'floorboard'],
    sales: ['logistics', 'printq', 'floorboard'],
    logistics: ['logistics', 'printq', 'floorboard'],
    warehouse: ['printq', 'floorboard']
  };
  Object.keys(BY_ROLE).forEach(function (role) {
    var R = ROLES[role]; if (!R) return;
    BY_ROLE[role].forEach(function (k) {
      if (R.nav.some(function (n) { return n[0] === k; })) return;
      R.nav.push(NAV[k].slice());
    });
  });

  /* ── Devices ─────────────────────────────────────────────────────────────────────────────── */
  var KINDS = [['label_printer', 'Label printer'], ['display', 'TV display'], ['kiosk', 'Kiosk tablet'], ['scale', 'Scale']];
  function pairBlock(dev, p) {
    var url = location.origin + '/pair.html#code=' + p.code;
    var qr = ''; try { var q = qrcode(0, 'M'); q.addData(url); q.make(); qr = q.createSvgTag(4, 2); } catch (e) { /* the code still works */ }
    return '<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap;padding:12px;background:var(--panel-2);border-radius:var(--r-md)">' + qr +
      '<div><div class="t-cap">Pair "' + escHtml(dev.name) + '" at ' + escHtml(dev.station) + '</div><div style="font:600 44px/1.1 var(--font-mono);letter-spacing:.12em">' + escHtml(p.code) + '</div>' +
      '<div class="t-cap">On the device open ' + escHtml(location.origin) + '/pair.html, or scan the QR. Valid until ' + escHtml(when(p.expiresAt)) + ' (10 minutes), once.</div>' +
      (dev.kind === 'label_printer' ? '<div class="t-cap">Print agent: <code>node tools/print-agent/agent.mjs pair --api ' + escHtml(location.origin) + ' --code ' + escHtml(p.code) + '</code></div>' : '') + '</div></div>';
  }
  async function viewDevices(item, V) {
    var canWrite = can('platform:device:write');
    V.innerHTML = '<div class="loading">Loading…</div>';
    var d = await call('/v1/devices'); if (!d) { V.innerHTML = errBox('Devices are not available.'); return; }
    var alerts = (await call('/v1/floor/alerts')) || { items: [] };
    var rows = (d.items || []).map(function (x) {
      var tone = x.status === 'revoked' ? 'neutral' : x.online ? 'ok' : x.status === 'pending' ? 'warn' : 'bad';
      var word = x.status === 'revoked' ? 'Revoked' : x.online ? 'Online' : x.status === 'pending' ? 'Not paired' : 'Offline';
      var cfg = x.config || {};
      return '<tr><td>' + escHtml(x.name) + '</td><td>' + escHtml((KINDS.filter(function (k) { return k[0] === x.kind; })[0] || [0, x.kind])[1]) + '</td><td>' + escHtml(x.station) + '</td><td>' + chip(tone, word) + '</td>' +
        '<td class="t-cap">' + escHtml([cfg.language, cfg.size, cfg.screen, cfg.resolutionMg ? cfg.resolutionMg + ' mg' : ''].filter(Boolean).join(' · ')) + '</td><td>' + escHtml(when(x.lastSeenAt)) + '</td>' +
        '<td style="white-space:nowrap">' + (canWrite && x.status !== 'revoked' ? btn('', 'New code', 'sm', ' data-code="' + x.deviceId + '"') + ' ' + btn('', 'Revoke', 'sm', ' data-revoke="' + x.deviceId + '"') : '') + '</td></tr>';
    });
    var form = canWrite ? card('Add a device', 'one station per device', '<form id="fo-add">' + grid([
      sel('fo-kind', 'Kind', KINDS, FV.kind || 'label_printer'), fld('fo-station', 'Station', 'placeholder="Packing 1" required'), fld('fo-name', 'Name', 'placeholder="Zebra ZD421" required'),
      sel('fo-lang', 'Printer language', [['zpl', 'ZPL (Zebra…)'], ['tspl', 'TSPL (TSC…)'], ['epl', 'EPL'], ['escpos', 'ESC/POS (receipt)'], ['pdf', 'PDF (office)']], 'zpl'),
      sel('fo-size', 'Label size', Object.keys((window.RaLabel || { SIZES: {} }).SIZES).map(function (k) { return [k, RaLabel.SIZES[k].name]; }), '100x50'),
      sel('fo-screen', 'Kiosk screen', [['packing', 'Packing station'], ['logistics', 'Logistics station'], ['maceration', 'Maceration'], ['printq', 'Print queue'], ['floorboard', 'Floor board']], 'packing'),
      fld('fo-res', 'Scale resolution (mg)', 'type="number" min="1" placeholder="10"'), btn('', 'Add device', 'p', ' type="submit"')]) + '</form><div id="fo-pair" style="margin-top:12px">' + (FV.pair || '') + '</div>') : '';
    var al = (alerts.items || []).map(function (a) { return '<tr><td>' + chip('bad', a.kind.replace(/_/g, ' ')) + '</td><td>' + escHtml(a.station || '') + '</td><td>' + escHtml(a.title) + '<div class="t-cap">' + escHtml(a.body || '') + '</div></td><td>' + escHtml(when(a.raisedAt)) + '</td></tr>'; });
    V.innerHTML = form + card('Devices', (d.items || []).length + ' registered', table(['Name', 'Kind', 'Station', 'Status', 'Set-up', 'Last seen', ''], rows)) + card('Station alerts', al.length + ' open', table(['Alert', 'Station', 'What', 'Since'], al));
    on('fo-add', 'submit', async function (e) {
      e.preventDefault();
      var kind = val('fo-kind'); FV.kind = kind;
      var config = kind === 'label_printer' ? { language: val('fo-lang'), size: val('fo-size') } : kind === 'kiosk' ? { screen: val('fo-screen') } : kind === 'scale' && val('fo-res') ? { resolutionMg: Number(val('fo-res')) } : {};
      var r = await call('/v1/devices', 'POST', { kind: kind, station: val('fo-station'), name: val('fo-name'), config: config });
      if (!r) return;
      FV.pair = pairBlock(r.device, r.pairing); viewDevices(item, V);
    });
    V.querySelectorAll('[data-code]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var dev = (d.items || []).filter(function (x) { return x.deviceId === b.getAttribute('data-code'); })[0];
        var r = await call('/v1/devices/' + dev.deviceId + '/pairing-code', 'POST'); if (!r) return;
        FV.pair = pairBlock(dev, r); viewDevices(item, V);
      });
    });
    V.querySelectorAll('[data-revoke]').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!(await sure('Revoke this device now? It stops working at once and must be paired again.', 'Revoke'))) return;
        if (await call('/v1/devices/' + b.getAttribute('data-revoke') + '/revoke', 'POST')) { toast('Revoked.', 'good'); viewDevices(item, V); }
      });
    });
  }

  /* ── Print queue ─────────────────────────────────────────────────────────────────────────── */
  async function viewPrintQueue(item, V) {
    var stn = station('print', '');
    V.innerHTML = card('Print queue', 'labels for one station', '<form id="fo-pq">' + grid([fld('fo-pq-st', 'Station', 'value="' + escHtml(stn) + '" placeholder="Packing 1"'), btn('', 'Show', 'p', ' type="submit"')]) + '</form>') + '<div id="fo-pq-list"><div class="loading">Loading…</div></div>';
    on('fo-pq', 'submit', function (e) { e.preventDefault(); setStation('print', val('fo-pq-st')); viewPrintQueue(item, V); });
    var d = await call('/v1/print-jobs' + (stn ? '?station=' + encodeURIComponent(stn) : '')); var L = document.getElementById('fo-pq-list'); if (!L) return;
    if (!d) { L.innerHTML = errBox('Print jobs are not available.'); return; }
    var TONE = { printed: 'ok', queued: 'warn', sent: 'warn', browser: 'warn', failed: 'bad', parked: 'bad', cancelled: 'neutral' };
    var jobs = d.items || [];
    L.innerHTML = card('Jobs', jobs.length + ' shown', table(['When', 'Label', 'For', 'Status', 'Tries', ''], jobs.map(function (j, i) {
      return '<tr><td>' + escHtml(when(j.createdAt)) + '</td><td>' + escHtml(j.labelKind) + (j.reprintOf ? ' ' + chip('warn', 'REPRINT') : '') + '</td><td class="mono">' + escHtml(j.subjectRef || '') + (j.reprintReason ? '<div class="t-cap">' + escHtml(j.reprintReason) + '</div>' : '') + '</td>' +
        '<td>' + chip(TONE[j.status] || 'neutral', j.status) + (j.lastError ? '<div class="t-cap">' + escHtml(j.lastError) + '</div>' : '') + '</td><td>' + j.attempts + '/' + j.maxAttempts + '</td><td style="white-space:nowrap">' +
        (j.status !== 'printed' && j.status !== 'sent' ? btn('', 'Print in browser', 'sm', ' data-bp="' + i + '"') + ' ' : '') +
        ((j.status === 'parked' || j.status === 'failed') && j.deviceId ? btn('', 'Send again', 'sm', ' data-retry="' + i + '"') + ' ' : '') +
        (j.status === 'printed' ? btn('', 'Reprint', 'sm', ' data-rp="' + i + '"') : '') + '</td></tr>';
    })));
    L.querySelectorAll('[data-bp]').forEach(function (b) { b.addEventListener('click', async function () { await browserPrint(jobs[Number(b.getAttribute('data-bp'))]); viewPrintQueue(item, V); }); });
    L.querySelectorAll('[data-retry]').forEach(function (b) { b.addEventListener('click', async function () { if (await call('/v1/print-jobs/' + jobs[Number(b.getAttribute('data-retry'))].printJobId + '/retry', 'POST')) viewPrintQueue(item, V); }); });
    L.querySelectorAll('[data-rp]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var a = await ask('Reprint', 'The new label says REPRINT, and the reason is logged with your name.', [{ n: 'reason', l: 'Reason', req: true }], 'Reprint');
        if (!a) return; var reason = a.reason;
        var r = await call('/v1/print-jobs/' + jobs[Number(b.getAttribute('data-rp'))].printJobId + '/reprint', 'POST', { reason: reason.trim() });
        if (r) { await handleJobs([r]); viewPrintQueue(item, V); }
      });
    });
  }

  /* ── Maceration ──────────────────────────────────────────────────────────────────────────── */
  async function viewMaceration(item, V) {
    V.innerHTML = '<div class="loading">Loading…</div>';
    var runs = await call('/v1/maceration/runs'); if (!runs) { V.innerHTML = errBox('Maceration is not available.'); return; }
    var settings = can('production:maceration_setting:write') ? await call('/v1/maceration/settings') : null;
    var canWrite = can('production:maceration:write'), canEarly = can('production:maceration:release_early');
    var list = runs.items || [];
    var rows = list.map(function (r, i) {
      var pct = Math.min(100, Math.round(((r.day - 1) / Math.max(1, r.needDays)) * 100));
      var state = r.overMax ? chip('bad', 'Past maximum') : r.readyForQc2 ? chip('ok', 'Ready for QC 2') : r.minReached ? chip('warn', 'Freeze step due') : chip('neutral', 'Macerating');
      return '<tr><td class="mono">' + escHtml(r.batchNumber || r.oilBatchId) + '</td><td><b>' + escHtml(r.label) + '</b><div style="height:6px;background:var(--panel-2);border-radius:3px;margin-top:4px"><div style="height:6px;width:' + pct + '%;background:var(--accent,#c60);border-radius:3px"></div></div><div class="t-cap">ends ' + escHtml(when(r.endsAt)) + ' · max ' + r.maxDays + ' days' + (r.restartCount ? ' · restarted ' + r.restartCount + '×' : '') + '</div></td>' +
        '<td>' + state + (r.releasedEarlyAt ? '<div class="t-cap">Released early: ' + escHtml(r.earlyReleaseReason || '') + ' — QC 2 still required</div>' : '') + '</td>' +
        '<td>' + (r.freezeRequired ? (r.freezeDoneAt ? chip('ok', 'Freeze done') : canWrite ? btn('', 'Freeze done', 'sm', ' data-fz="' + i + '"') : chip('warn', 'Freeze due')) : '<span class="t-cap">none</span>') + '</td>' +
        '<td style="white-space:nowrap">' + (canWrite ? btn('', 'Extend', 'sm', ' data-ext="' + i + '"') + ' ' : '') + (canEarly && !r.releasedEarlyAt && !r.minReached ? btn('', 'Release early', 'sm', ' data-early="' + i + '"') : '') + '</td></tr>';
    });
    var setCard = settings ? card('Maceration per product', 'admin', '<form id="fo-ms">' + grid([fld('fo-ms-f', 'Formula id', 'placeholder="the formula\'s id" required'),
      '<label style="display:flex;gap:6px;align-items:center"><input id="fo-ms-req" type="checkbox" checked> Maceration required</label>', fld('fo-ms-min', 'Minimum days', 'type="number" min="1" max="365" value="30"'), fld('fo-ms-max', 'Maximum days', 'type="number" min="1" max="365" value="120"'),
      '<label style="display:flex;gap:6px;align-items:center"><input id="fo-ms-fz" type="checkbox"> Freeze / chill-filter step</label>', fld('fo-ms-note', 'Freeze note', 'placeholder="chill 24 h at 4 °C, filter"'), btn('', 'Save', 'p', ' type="submit"')]) + '</form>' +
      table(['Formula', 'Required', 'Days', 'Freeze'], (settings.items || []).map(function (s) { return '<tr><td class="mono">' + escHtml(s.formulaId) + '</td><td>' + (s.required ? 'Yes' : 'No') + '</td><td>' + s.minDays + '–' + s.maxDays + '</td><td>' + (s.freezeRequired ? escHtml(s.freezeNote || 'Yes') : 'No') + '</td></tr>'; }))) : '';
    V.innerHTML = card('Macerating now', list.length + ' batches · they cannot ship, go to FG or be reserved until QC 2 passes', table(['Batch', 'Timer', 'State', 'Freeze', ''], rows)) + setCard;
    V.querySelectorAll('[data-fz]').forEach(function (b) { b.addEventListener('click', async function () { if (await call('/v1/maceration/runs/' + list[Number(b.getAttribute('data-fz'))].macerationRunId + '/freeze-done', 'POST', {})) viewMaceration(item, V); }); });
    V.querySelectorAll('[data-ext]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var a = await ask('Extend maceration', 'Never past the product\'s maximum. Logged with your name.', [{ n: 'days', l: 'More days', t: 'number', min: 1, req: true }, { n: 'reason', l: 'Reason', req: true }], 'Extend');
        if (!a) return;
        if (await call('/v1/maceration/runs/' + list[Number(b.getAttribute('data-ext'))].macerationRunId + '/extend', 'POST', { days: a.days, reason: a.reason })) viewMaceration(item, V);
      });
    });
    V.querySelectorAll('[data-early]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var a = await ask('Release early', 'Admin only, logged. QC 2 is still required before the batch is released.', [{ n: 'reason', l: 'Reason', req: true }], 'Release early');
        if (!a) return;
        if (await call('/v1/maceration/runs/' + list[Number(b.getAttribute('data-early'))].macerationRunId + '/release-early', 'POST', { reason: a.reason })) viewMaceration(item, V);
      });
    });
    on('fo-ms', 'submit', async function (e) {
      e.preventDefault();
      var r = await call('/v1/maceration/settings/' + encodeURIComponent(val('fo-ms-f')), 'PUT', { required: document.getElementById('fo-ms-req').checked, minDays: Number(val('fo-ms-min')), maxDays: Number(val('fo-ms-max')), freezeRequired: document.getElementById('fo-ms-fz').checked, freezeNote: val('fo-ms-note') });
      if (r) { toast('Saved.', 'good'); viewMaceration(item, V); }
    });
  }

  /* ── weight entry: from the station's scale, or typed ──────────────────────────────────── */
  function weightField(prefix, label) {
    return '<label style="display:flex;flex-direction:column;gap:5px"><span class="t-cap">' + escHtml(label) + ' (g)</span><div style="display:flex;gap:6px"><input id="' + prefix + '" class="fld" inputmode="decimal" style="flex:1;min-width:0" placeholder="0.00">' +
      btn(prefix + '-sc', 'Read scale', 'sm') + '</div><span id="' + prefix + '-src" class="t-cap">typed</span></label>';
  }
  function bindWeight(prefix, stn) {
    var st = { reading: null };
    on(prefix, 'input', function () { st.reading = null; var s = document.getElementById(prefix + '-src'); if (s) s.textContent = 'typed'; });
    on(prefix + '-sc', 'click', async function () {
      var r = await call('/v1/scales/latest?station=' + encodeURIComponent(stn())); if (!r) return;
      if (!r.reading) { toast('No stable reading from a scale at this station in the last minute.', 'bad'); return; }
      st.reading = r.reading;
      document.getElementById(prefix).value = W.formatWeight(r.reading.mg, 'g', r.reading.resolutionMg || undefined).replace(/\s*(k?g|mg)$/, '') ;
      if (/kg$/.test(W.formatWeight(r.reading.mg, 'g'))) document.getElementById(prefix).value = String(r.reading.mg / 1000);
      document.getElementById(prefix + '-src').textContent = 'from scale · stable · ' + W.formatWeight(r.reading.mg, 'g', r.reading.resolutionMg || undefined);
    });
    return function () {
      if (st.reading) return { mg: st.reading.mg, weightSource: 'scale', scaleReadingId: st.reading.scaleReadingId };
      var mg = W.parseToMg(val(prefix), 'g');
      if (mg === null || !(mg > 0)) { toast('Enter the weight in grams (at most 3 decimals).', 'bad'); return null; }
      return { mg: mg, weightSource: 'typed' };
    };
  }

  /* ── Packing station ─────────────────────────────────────────────────────────────────────── */
  async function viewPacking(item, V) {
    var stn = function () { return val('fo-pk-st') || station('packing', 'Packing 1'); };
    if (FV.shipmentId) return viewShipment(item, V, stn);
    var q = await call('/v1/packing/queue');
    V.innerHTML = card('Packing station', 'QC-approved lots only', grid([fld('fo-pk-st', 'Station', 'value="' + escHtml(station('packing', 'Packing 1')) + '"' + (kiosk() ? ' disabled' : ''))]) +
      '<form id="fo-pk-new" style="margin-top:10px">' + grid([fld('fo-pk-so', 'Sales order id', 'required'), fld('fo-pk-lots', 'Lot ids (comma separated)', 'required'), btn('', 'Start packing', 'p', ' type="submit" data-net')]) + '</form>') +
      card('Being packed', ((q && q.items) || []).length + '', table(['Shipment', 'Order', 'Started', ''], ((q && q.items) || []).map(function (s) {
        return '<tr><td class="mono">' + escHtml(s.shipmentNo) + '</td><td>' + escHtml(s.soNumber || s.salesOrderId) + '</td><td>' + escHtml(when(s.createdAt)) + '</td><td>' + btn('', 'Open', 'sm', ' data-open="' + s.shipmentId + '"') + '</td></tr>';
      })));
    on('fo-pk-st', 'change', function () { setStation('packing', val('fo-pk-st')); });
    on('fo-pk-new', 'submit', async function (e) {
      e.preventDefault();
      var r = await call('/v1/packing/shipments', 'POST', { salesOrderId: val('fo-pk-so'), finishedGoodBatchIds: val('fo-pk-lots').split(/[\s,]+/).filter(Boolean) });
      if (r) { FV.shipmentId = r.shipmentId; viewPacking(item, V); }
    });
    V.querySelectorAll('[data-open]').forEach(function (b) { b.addEventListener('click', function () { FV.shipmentId = b.getAttribute('data-open'); viewPacking(item, V); }); });
  }
  async function viewShipment(item, V, stn) {
    var s = await call('/v1/shipments/' + FV.shipmentId); if (!s) { FV.shipmentId = null; return viewPacking(item, V); }
    var open = (s.cartons || []).filter(function (c) { return c.status === 'OPEN'; })[0];
    var units = s.units || [];
    var unitRows = units.map(function (u) { return '<tr><td class="mono">' + escHtml(u.unitCode) + '</td><td>' + escHtml(u.batchNumber || '') + '</td><td>' + escHtml(W.formatWeight(u.netMg, 'g')) + ' <span class="t-cap">' + escHtml(u.weightSource === 'scale' ? 'from scale' : 'typed') + '</span></td><td>' + (u.cartonId ? chip('ok', 'in carton ' + ((s.cartons || []).filter(function (c) { return c.cartonId === u.cartonId; })[0] || {}).seq) : chip('warn', 'not in a carton')) + '</td></tr>'; });
    var cartonRows = (s.cartons || []).map(function (c) { return '<tr><td class="mono">' + escHtml(c.cartonCode) + '</td><td>' + chip(c.status === 'OPEN' ? 'warn' : 'ok', c.status) + '</td><td>' + (c.grossMg ? escHtml(W.formatWeight(c.grossMg, 'g')) : '') + '</td></tr>'; });
    var packing = s.status === 'PACKING';
    V.innerHTML = '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">' + btn('fo-back', '← Shipments', 'sm') + '<b class="mono">' + escHtml(s.shipmentNo) + '</b> ' + chip(packing ? 'warn' : 'ok', s.status) + ' <span class="t-cap">order ' + escHtml(s.soNumber || s.salesOrderId) + ' · station ' + escHtml(stn()) + '</span></div>' +
      (packing ? card('Fill a unit', 'weigh, seal, label', '<form id="fo-u">' + grid([sel('fo-u-lot', 'Lot', s.lots.map(function (l) { return [l, l.slice(0, 8)]; }), s.lots[0]),
        fld('fo-u-t', 'Target (g)', 'inputmode="decimal" required value="' + escHtml(FV.target || '') + '"'), fld('fo-u-tol', 'Tolerance ± (g)', 'inputmode="decimal" required value="' + escHtml(FV.tol || '') + '"'), weightField('fo-u-w', 'Net weight'),
        '<label style="display:flex;gap:6px;align-items:center"><input id="fo-u-seal" type="checkbox"> Sealed / capped / tamper seal</label>', btn('', 'Record unit + print label', 'p', ' type="submit" data-net')]) + '</form>') +
        card('Carton', open ? 'scan units into ' + open.cartonCode : 'open the next carton', open ? '<form id="fo-scan">' + grid([fld('fo-scan-u', 'Scan unit label', 'autofocus autocomplete="off"'), btn('', 'Add to carton', 'p', ' type="submit" data-net')]) + '</form><form id="fo-close" style="margin-top:10px">' + grid([weightField('fo-c-w', 'Carton gross weight'), btn('', 'Weigh + close carton', 'sm', ' type="submit" data-net')]) + '</form>' : btn('fo-open', 'Open next carton', 'p', ' data-net')) +
        card('Finish', 'every unit in a closed carton, labels printed', btn('fo-finish', 'Finish packing: print carton labels + packing list', 'p', ' data-net')) : '') +
      card('Units', units.length + '', table(['Unit', 'Lot', 'Net', 'Carton'], unitRows)) + card('Cartons', (s.cartons || []).length + '', table(['Carton', 'Status', 'Gross'], cartonRows));
    on('fo-back', 'click', function () { FV.shipmentId = null; viewPacking(item, V); });
    var unitW = packing ? bindWeight('fo-u-w', stn) : null;
    var cartonW = open ? bindWeight('fo-c-w', stn) : null;
    on('fo-u', 'submit', async function (e) {
      e.preventDefault();
      var t = W.parseToMg(val('fo-u-t'), 'g'), tol = W.parseToMg(val('fo-u-tol'), 'g');
      if (t === null || tol === null) { toast('Target and tolerance in grams.', 'bad'); return; }
      FV.target = val('fo-u-t'); FV.tol = val('fo-u-tol');
      var w = unitW(); if (!w) return;
      var r = await call('/v1/packing/shipments/' + s.shipmentId + '/units', 'POST', Object.assign({ station: stn(), finishedGoodBatchId: val('fo-u-lot'), targetMg: t, toleranceMg: tol, sealed: document.getElementById('fo-u-seal').checked }, w));
      if (r) { await handleJobs([r.label]); viewShipment(item, V, stn); }
    });
    on('fo-open', 'click', async function () { if (await call('/v1/packing/shipments/' + s.shipmentId + '/cartons', 'POST')) viewShipment(item, V, stn); });
    on('fo-scan', 'submit', async function (e) {
      e.preventDefault();
      var r = await call('/v1/packing/cartons/' + open.cartonId + '/scan', 'POST', { unitCode: val('fo-scan-u') });
      if (r) { if (window.RaSound) RaSound.play('notify'); viewShipment(item, V, stn); } else if (window.RaSound) RaSound.play('error');
    });
    on('fo-close', 'submit', async function (e) {
      e.preventDefault(); var w = cartonW(); if (!w) return;
      if (await call('/v1/packing/cartons/' + open.cartonId + '/close', 'POST', Object.assign({ station: stn() }, w))) viewShipment(item, V, stn);
    });
    on('fo-finish', 'click', async function () {
      var r = await call('/v1/packing/shipments/' + s.shipmentId + '/finish', 'POST', { station: stn() });
      if (r) { await handleJobs(r.cartonLabels.concat([r.packingList])); toast('Packed. It is on the logistics queue.', 'good'); viewShipment(item, V, stn); }
    });
  }

  /* ── Logistics station ───────────────────────────────────────────────────────────────────── */
  async function viewLogistics(item, V) {
    var stn = function () { return val('fo-lg-st') || station('logistics', 'Logistics 1'); };
    var q = await call('/v1/logistics/queue'); if (!q) { V.innerHTML = errBox('The logistics queue is not available.'); return; }
    var couriers = (await call('/v1/couriers')) || { items: [] };
    var list = q.items || [];
    var cur = list.filter(function (s) { return s.shipmentId === FV.lgId; })[0];
    var TONE = { PACKED: 'warn', DOCS_READY: 'warn', AWB_ASSIGNED: 'ok', HOLD: 'bad' };
    var rows = list.map(function (s) { return '<tr' + (cur && cur.shipmentId === s.shipmentId ? ' style="background:var(--panel-2)"' : '') + '><td class="mono">' + escHtml(s.shipmentNo) + '</td><td>' + escHtml(s.soNumber || '') + '</td><td>' + chip(TONE[s.status] || 'neutral', s.status.replace('_', ' ')) + (s.holdReason ? '<div class="t-cap">' + escHtml(s.holdReason) + '</div>' : '') + '</td><td>' + s.cartonsChecked + ' / ' + (s.cartonCount || 0) + '</td><td>' + escHtml(s.awb || '') + '</td><td>' + btn('', 'Work on it', 'sm', ' data-lg="' + s.shipmentId + '"') + '</td></tr>'; });
    var work = '';
    if (cur) {
      var cOpts = couriers.items.map(function (c) { return [c.provider, c.displayName]; });
      work = card('Shipment ' + cur.shipmentNo, 'order ' + (cur.soNumber || '') + ' · ' + cur.cartonsChecked + ' of ' + (cur.cartonCount || 0) + ' cartons scanned',
        '<form id="fo-lg-c">' + grid([fld('fo-lg-cc', 'Scan carton label', 'autocomplete="off" autofocus'), btn('', 'Check carton', 'p', ' type="submit" data-net')]) + '</form>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' + btn('fo-lg-docs', 'Generate + print documents', 'sm', ' data-net') + '</div>' +
        (cur.docs ? '<div class="t-cap" style="margin-top:8px">' + cur.docs.map(function (d) { return escHtml(d.type.replace(/_/g, ' ')) + (d.blanks && d.blanks.length ? ' (blank: ' + escHtml(d.blanks.join(', ')) + ')' : '') + (d.note ? ' — ' + escHtml(d.note) : ''); }).join('<br>') + '</div>' : '') +
        '<form id="fo-lg-awb" style="margin-top:10px">' + grid([cOpts.length ? sel('fo-lg-cr', 'Courier', cOpts, cur.courierCode || cOpts[0][0]) : fld('fo-lg-cr', 'Courier code', 'placeholder="from the transporter list"'), fld('fo-lg-awbv', 'AWB (scan or type)', 'autocomplete="off" value="' + escHtml(cur.awb || '') + '"'), btn('', 'Save AWB + print courier label', 'sm', ' type="submit" data-net')]) + '</form>' +
        '<form id="fo-lg-ho" style="margin-top:10px">' + grid([fld('fo-lg-to', 'Handed to (courier person)', ''), btn('', 'Handed over', 'p', ' type="submit" data-net')]) + '</form>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' + btn('', 'Courier did not come', 'sm', ' data-ex="COURIER_NO_SHOW" data-net') + btn('', 'Carton damaged', 'sm', ' data-ex="CARTON_DAMAGED" data-net') + btn('', 'Address does not match', 'sm', ' data-ex="ADDRESS_MISMATCH" data-net') + (cur.status === 'HOLD' ? btn('', 'Release hold', 'sm', ' data-ex="RELEASE_HOLD" data-net') : '') + '</div>');
    }
    V.innerHTML = card('Logistics station', 'oldest order first', grid([fld('fo-lg-st', 'Station', 'value="' + escHtml(station('logistics', 'Logistics 1')) + '"' + (kiosk() ? ' disabled' : ''))])) + work + card('Waiting to ship', list.length + '', table(['Shipment', 'Order', 'Status', 'Cartons', 'AWB', ''], rows));
    on('fo-lg-st', 'change', function () { setStation('logistics', val('fo-lg-st')); });
    V.querySelectorAll('[data-lg]').forEach(function (b) { b.addEventListener('click', function () { FV.lgId = b.getAttribute('data-lg'); viewLogistics(item, V); }); });
    if (!cur) return;
    var awbTyped = true;
    on('fo-lg-awbv', 'keydown', function (e) { if (e.key && e.key.length === 1 && e.timeStamp - (FV.lastKey || 0) < 30) awbTyped = false; FV.lastKey = e.timeStamp; });
    on('fo-lg-c', 'submit', async function (e) { e.preventDefault(); var r = await call('/v1/logistics/shipments/' + cur.shipmentId + '/cartons/scan', 'POST', { cartonCode: val('fo-lg-cc') }); if (r) { toast(r.checked + ' of ' + r.total + ' cartons' + (r.complete ? ': all here.' : '.'), 'good'); viewLogistics(item, V); } });
    on('fo-lg-docs', 'click', async function () {
      var r = await call('/v1/logistics/shipments/' + cur.shipmentId + '/documents', 'POST', { station: stn() }); if (!r) return;
      var jobs = []; for (var i = 0; i < r.printJobs.length; i++) { if (r.printJobs[i].status === 'browser') jobs.push((await call('/v1/print-jobs?subjectRef=' + encodeURIComponent(r.printJobs[i].subjectRef))).items[0]); }
      await handleJobs(jobs); viewLogistics(item, V);
    });
    on('fo-lg-awb', 'submit', async function (e) {
      e.preventDefault();
      var r = await call('/v1/logistics/shipments/' + cur.shipmentId + '/awb', 'POST', { station: stn(), courierCode: val('fo-lg-cr'), awb: val('fo-lg-awbv'), source: awbTyped ? 'typed' : 'scan' });
      if (r) { if (r.courierLabel.status === 'browser') await handleJobs([(await call('/v1/print-jobs?subjectRef=' + encodeURIComponent(r.shipment.awb))).items[0]]); viewLogistics(item, V); }
    });
    on('fo-lg-ho', 'submit', async function (e) {
      e.preventDefault();
      var r = await call('/v1/logistics/shipments/' + cur.shipmentId + '/handover', 'POST', { handedTo: val('fo-lg-to') });
      if (r) { toast('Handed over. Tracking goes to ALEMBIC with the AWB.', 'good'); FV.lgId = null; viewLogistics(item, V); }
    });
    V.querySelectorAll('[data-ex]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var kind = b.getAttribute('data-ex'), body = { kind: kind, station: stn() };
        if (kind === 'CARTON_DAMAGED') { var a = await ask('Carton damaged', 'It goes back to packing.', [{ n: 'c', l: 'Carton (scan or type its code)', req: true }], 'Back to packing'); if (!a) return; body.cartonCode = a.c; }
        if (kind === 'ADDRESS_MISMATCH') { var a2 = await ask('Address does not match', 'The shipment is held and Sales / CRM are alerted.', [{ n: 'n', l: 'What does not match', req: true }], 'Hold'); if (!a2) return; body.note = a2.n; }
        if (await call('/v1/logistics/shipments/' + cur.shipmentId + '/exception', 'POST', body)) viewLogistics(item, V);
      });
    });
  }

  /* ── Couriers ────────────────────────────────────────────────────────────────────────────── */
  async function viewCouriers(item, V) {
    var d = await call('/v1/couriers'); if (!d) { V.innerHTML = errBox('Couriers are not available.'); return; }
    var canWrite = can('platform:courier_connector:write');
    var HT = { ok: 'ok', error: 'bad', no_adapter: 'warn', unknown: 'neutral' };
    var list = d.items || [];
    V.innerHTML = (canWrite ? card('Add a courier', 'manual AWB works for every courier; a connector adds booking and tracking when an integration exists', '<form id="fo-cr">' + grid([fld('fo-cr-p', 'Code', 'placeholder="delhivery" required'), fld('fo-cr-n', 'Name', 'placeholder="Delhivery" required'), fld('fo-cr-pat', 'AWB format (pattern, optional)', 'placeholder="\\d{13}"'), fld('fo-cr-t', 'Tracking address with {awb} (optional)', 'placeholder="https://…/{awb}"'), btn('', 'Save', 'p', ' type="submit"')]) + '</form>') : '') +
      card('Couriers', list.length + '', table(['Courier', 'Mode', 'Connection', 'AWB format', 'Last sync', ''], list.map(function (c, i) {
        return '<tr><td>' + escHtml(c.displayName) + ' <span class="t-cap mono">' + escHtml(c.provider) + '</span></td><td>' + chip(c.mode === 'off' ? 'neutral' : 'ok', c.mode) + '</td><td>' + chip(HT[c.health] || 'neutral', c.connected ? 'connected' : 'not connected') + '<div class="t-cap">' + escHtml(c.healthNote || '') + '</div></td><td class="mono">' + escHtml(c.awbPattern || 'any') + '</td><td>' + escHtml(when(c.lastSyncAt)) + '</td><td style="white-space:nowrap">' +
          (canWrite ? btn('', c.connected ? 'Reconnect' : 'Connect', 'sm', ' data-cn="' + i + '"') + ' ' + (c.connected ? btn('', 'Test', 'sm', ' data-ts="' + i + '"') + ' ' + btn('', 'Disconnect', 'sm', ' data-dc="' + i + '"') + ' ' : '') + (c.hasIntegration ? sel('fo-md-' + i, 'Mode', [['off', 'Off'], ['test', 'Test'], ['live', 'Live']], c.mode) : '') : '') + '</td></tr>';
      })));
    on('fo-cr', 'submit', async function (e) { e.preventDefault(); if (await call('/v1/couriers/' + encodeURIComponent(val('fo-cr-p').toLowerCase()), 'PUT', { displayName: val('fo-cr-n'), awbPattern: val('fo-cr-pat'), trackingUrlTemplate: val('fo-cr-t') })) viewCouriers(item, V); });
    V.querySelectorAll('[data-cn]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var c = list[Number(b.getAttribute('data-cn'))];
        var a = await ask('Connect ' + c.displayName, 'The key is sealed on the server and never shown again.', [{ n: 'k', l: 'API key or login token', req: true }], 'Connect');
        if (!a) return;
        var r = await call('/v1/couriers/' + c.provider + '/connect', 'POST', { credentials: { apiKey: a.k } }); if (r) { toast(r.healthNote || 'Saved.', r.health === 'ok' ? 'good' : 'warn'); viewCouriers(item, V); }
      });
    });
    V.querySelectorAll('[data-ts]').forEach(function (b) { b.addEventListener('click', async function () { var r = await call('/v1/couriers/' + list[Number(b.getAttribute('data-ts'))].provider + '/test', 'POST'); if (r) { toast(r.healthNote || r.health, r.health === 'ok' ? 'good' : 'warn'); viewCouriers(item, V); } }); });
    V.querySelectorAll('[data-dc]').forEach(function (b) { b.addEventListener('click', async function () { if (await sure('Disconnect? The stored credentials are deleted.', 'Disconnect') && await call('/v1/couriers/' + list[Number(b.getAttribute('data-dc'))].provider + '/disconnect', 'POST')) viewCouriers(item, V); }); });
    list.forEach(function (c, i) { on('fo-md-' + i, 'change', async function () { await call('/v1/couriers/' + c.provider + '/mode', 'POST', { mode: val('fo-md-' + i) }); viewCouriers(item, V); }); });
  }

  /* ── Floor board (TV) ────────────────────────────────────────────────────────────────────── */
  function boardHtml(b, big) {
    var f = big ? 1.6 : 1;
    var h = function (t) { return '<h2 style="font:600 ' + (20 * f) + 'px/1.2 var(--font-ui);margin:0 0 8px">' + escHtml(t) + '</h2>'; };
    var STAGE = { PICK: 'Pick', VERIFY: 'Verify', MIX: 'Mix' };
    var q = (b.queue || []).map(function (j) { return '<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 10px;background:var(--panel-2);border-radius:8px;font-size:' + (16 * f) + 'px"><b class="mono">' + escHtml(j.jobNo) + '</b><span>' + escHtml(STAGE[j.stage] || j.stage) + '</span><span class="t-cap">' + escHtml(j.orderRef || '') + (j.expedite ? ' · URGENT' : '') + '</span></div>'; }).join('') || '<div class="t-cap">Queue empty.</div>';
    var m = (b.maceration || []).map(function (r) { return '<div style="padding:8px 10px;background:var(--panel-2);border-radius:8px;font-size:' + (16 * f) + 'px"><b class="mono">' + escHtml(r.batchNumber || '') + '</b> <span style="float:right">' + escHtml(r.label) + '</span><div class="t-cap">' + (r.overMax ? 'PAST MAXIMUM' : r.readyForQc2 ? 'Ready for QC 2' : r.freezeDue && r.day >= r.needDays ? 'Freeze step due' : 'ends ' + escHtml(when(r.endsAt))) + '</div></div>'; }).join('') || '<div class="t-cap">Nothing macerating.</div>';
    var qb = b.qcBacklog || {}, q2 = qb.qc2Ready || [], pq = qb.packagingQc || [];
    var qc = '<div style="font-size:' + (16 * f) + 'px">QC 2 ready: <b>' + q2.length + '</b> ' + escHtml(q2.join(', ')) + '<br>Packaging QC waiting: <b>' + pq.length + '</b> ' + escHtml(pq.slice(0, 8).join(', ')) + '</div>';
    var sh = b.shipments || {};
    var al = (b.alerts || []).map(function (a) { return '<div style="padding:8px 10px;border-left:6px solid var(--bad,#c33);background:var(--panel-2);border-radius:6px;font-size:' + (15 * f) + 'px"><b>' + escHtml(a.title) + '</b><div class="t-cap">' + escHtml(a.body || '') + '</div></div>'; }).join('');
    return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;padding:' + (big ? 20 : 0) + 'px">' +
      '<div class="card"><div class="card-bd">' + h('Floor queue') + '<div style="display:grid;gap:6px">' + q + '</div></div></div>' +
      '<div class="card"><div class="card-bd">' + h('Maceration') + '<div style="display:grid;gap:6px">' + m + '</div></div></div>' +
      '<div class="card"><div class="card-bd">' + h('QC backlog') + qc + h('Shipping') + '<div style="font-size:' + (16 * f) + 'px">Packing ' + (sh.PACKING || 0) + ' · Packed ' + (sh.PACKED || 0) + ' · Docs ready ' + (sh.DOCS_READY || 0) + ' · AWB ' + (sh.AWB_ASSIGNED || 0) + ' · Held ' + (sh.HOLD || 0) + '</div></div></div>' +
      (al ? '<div class="card" style="grid-column:1/-1"><div class="card-bd">' + h('Alerts') + '<div style="display:grid;gap:6px">' + al + '</div></div></div>' : '') +
      '</div><div class="t-cap" style="padding:0 ' + (big ? 20 : 0) + 'px">Updated ' + escHtml(when(b.at)) + '</div>';
  }
  async function viewBoard(item, V) {
    clearTimeout(FV.boardTimer);
    var k = kiosk();
    var b = await call('/v1/floor/display' + (k && k.station ? '?station=' + encodeURIComponent(k.station) : ''));
    if (st.nav !== 'floorboard') return;
    if (!b) { V.innerHTML = errBox('The floor board is not available.'); }
    else V.innerHTML = '<div style="display:flex;justify-content:flex-end;margin-bottom:8px">' + btn('fo-tv', 'TV mode (full screen)', 'sm') + '</div>' + boardHtml(b, false);
    on('fo-tv', 'click', function () { location.hash = 'floorboard=tv'; enterBoardTv(); });
    FV.boardTimer = setTimeout(function () { if (st.nav === 'floorboard') viewBoard(item, V); }, 15000);
  }
  function enterBoardTv() {
    if (FV.tvHost) return;
    var h = document.createElement('div'); h.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:var(--bg,#EDEDEB);overflow:auto';
    document.body.appendChild(h); FV.tvHost = h;
    try { var fs = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); if (fs && fs.catch) fs.catch(function () {}); } catch (e) { /* not allowed without a gesture */ }
    // WALK2-RP-3: the TV read the whole floor even on a station's paired display (viewBoard asks for its
    // station), and a failed read left a blank screen, or the last board with nothing saying it was old.
    var tick = async function () {
      var k = kiosk();
      var b = await call('/v1/floor/display' + (k && k.station ? '?station=' + encodeURIComponent(k.station) : ''));
      if (!FV.tvHost) return;
      if (b) FV.tvHost.innerHTML = boardHtml(b, true);
      else {
        var note = '<div id="fo-tv-stale" role="alert" style="margin:20px;padding:14px 18px;border-left:8px solid var(--bad,#c33);background:var(--panel-2);font:600 24px/1.3 var(--font-ui)">The floor board did not update. Showing the last one; trying again every 15 seconds.</div>';
        var old = FV.tvHost.querySelector('#fo-tv-stale'); if (old) old.remove();
        if (FV.tvHost.innerHTML) FV.tvHost.insertAdjacentHTML('afterbegin', note);
        else FV.tvHost.innerHTML = note.replace('Showing the last one; trying', 'Trying');
      }
      FV.tvTimer = setTimeout(tick, 15000);
    };
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape' && FV.tvHost) { FV.tvHost.remove(); FV.tvHost = null; clearTimeout(FV.tvTimer); document.removeEventListener('keydown', esc); } });
    tick();
  }

  window.RA.registerViews({
    __devices__: viewDevices, __printq__: viewPrintQueue, __maceration__: viewMaceration, __packing__: viewPacking,
    __logistics__: viewLogistics, __couriers__: viewCouriers, __floorboard__: viewBoard
  });

  /* ── kiosk lock mode ─────────────────────────────────────────────────────────────────────── */
  function kiosk() { try { var k = JSON.parse(localStorage.getItem('ra.kiosk') || 'null'); return k && k.station && k.screen ? k : null; } catch (e) { return null; } }
  window.RA.floorKiosk = kiosk;
  function netBanner() {
    var b = document.getElementById('fo-net');
    if (!navigator.onLine) {
      if (!b) { b = document.createElement('div'); b.id = 'fo-net'; b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483600;padding:10px 16px;background:#b3261e;color:#fff;font:600 16px/1.3 var(--font-ui);text-align:center'; document.body.appendChild(b); }
      b.textContent = 'No network: read-only. Nothing can be completed until the network is back.';
    } else if (b) b.remove();
    document.querySelectorAll('[data-net]').forEach(function (x) { x.disabled = !navigator.onLine; });
  }
  window.addEventListener('online', netBanner); window.addEventListener('offline', netBanner);
  new MutationObserver(function () { if (!navigator.onLine) netBanner(); }).observe(document.documentElement, { childList: true, subtree: true });

  var K = kiosk();
  if (K) {
    // The kiosk's own heartbeat (its device token from /pair.html), so Admin sees it online.
    var beat = function () {
      var d; try { d = JSON.parse(localStorage.getItem('ra.device') || 'null'); } catch (e) { d = null; }
      if (d && d.token && navigator.onLine) fetch('/v1/device-agent/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-token': d.token }, body: '{}' }).catch(function () {});
    };
    beat(); setInterval(beat, 60000);
    document.documentElement.classList.add('ra-kiosk');
    var css = document.createElement('style');
    // Kiosk: one station's screen, big touch targets for gloved hands, no rail and no way out.
    css.textContent = '.ra-kiosk .rail,.ra-kiosk nav.rail,.ra-kiosk .dock,.ra-kiosk [data-dock]{display:none!important}.ra-kiosk .btn{min-height:52px;font-size:17px}.ra-kiosk .fld{min-height:48px;font-size:17px}';
    document.head.appendChild(css);
    var lockTries = 0;
    var lockT = setInterval(function () {
      if (++lockTries > 240) { clearInterval(lockT); return; }
      if (!session || !st.role || !ROLES[st.role]) return;
      clearInterval(lockT);
      var R = ROLES[st.role], want = NAV[K.screen];
      if (!want) return;
      R.nav = R.nav.filter(function (n) { return n[0] === K.screen; });
      if (!R.nav.length) { toast('This kiosk is for ' + want[1] + ' at ' + K.station + ', which your role cannot open. Ask an admin.', 'bad'); return; }
      var orig = window.navTo;
      window.navTo = function (k, ref) { if (k !== K.screen) { toast('This tablet is locked to ' + want[1] + ' at ' + K.station + '.', 'warn'); return; } return orig(k, ref); };
      var tag = document.createElement('div'); tag.style.cssText = 'position:fixed;top:0;right:0;z-index:2147483500;padding:6px 12px;background:#111;color:#fff;font:600 13px/1.2 var(--font-ui);border-bottom-left-radius:8px';
      tag.textContent = 'Kiosk · ' + K.station + ' · ' + want[1]; document.body.appendChild(tag);
      orig(K.screen);
      netBanner();
    }, 500);
  }

  // #floorboard=tv (a TV signed in as a person): open the board full screen.
  if (/(?:^|[#&])floorboard=tv/.test(location.hash)) {
    var tvTries = 0;
    var tvT = setInterval(function () { if (++tvTries > 120) { clearInterval(tvT); return; } if (!session || !st.role) return; clearInterval(tvT); enterBoardTv(); }, 500);
  }
})();
