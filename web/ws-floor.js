/* RAW AROMA — ws-floor module (lane pf-a, production-floor plan P1, PROD-A-7).
 *
 *   Floor queue   which job is next: strict alternation New / Delayed, expedite and the floor.queue
 *                 rule above it, and what a waiting job waits on. Production opens a job from a run.
 *   Pick / Verify / Mix   kiosk checklists, one line at a time, big targets for gloved hands. Each
 *                 completion prints the hand-off label (PICKED, VERIFIED, MIXED) through the
 *                 browser's print dialog at 75 x 50 mm. A reprint asks for a reason and says REPRINT.
 *   Scan a lot    what a lot label resolves to, under your own permissions.
 *   Rules         the admin Rules screen: IF / ELSE IF / OTHERWISE per policy, test a sample case
 *                 before publishing, versions with who/why, and one-record overrides.
 *   Floor colours the ingredient family -> colour table.
 *
 * Weights are integer mg from the server and shown with web/weight.js (RaWeight). The server
 * decides every permission, the tolerance and the order of steps; this file only shows answers.
 */
'use strict';
(function () {
  var W = window.RaWeight;
  function err(res, f) { return (res && res.json && res.json.error && res.json.error.message) || f; }
  function data(res) { return res && res.json && res.json.data; }
  function esc(v) { return escHtml(v == null ? '' : String(v)); }
  function chip(tone, t) { return '<span class="chip ' + tone + '"><i class="dot"></i>' + esc(t) + '</span>'; }
  function btn(id, label, cls, attrs) { return '<button ' + (/\btype=/.test(attrs || '') ? '' : 'type="button" ') + 'id="' + id + '" class="btn ' + (cls || '') + '"' + (attrs || '') + '>' + label + '</button>'; }
  function big(attrs) { return ' style="min-height:56px;font-size:18px;padding:0 22px"' + (attrs || ''); }
  function swatch(l) {
    if (!l || !l.colourName) return '';
    // Colour is never the only signal: the name and its initial are printed beside it.
    return '<span style="display:inline-flex;align-items:center;gap:8px"><span aria-hidden="true" style="width:22px;height:22px;border-radius:6px;border:1px solid var(--line);background:' + esc(l.colourHex) + '"></span>' +
      '<b>' + esc(l.colourName) + '</b> <span style="font-family:var(--font-mono)">(' + esc(l.initial) + ')</span></span>';
  }
  // WALK2-RP-6: printed and shown times were the UTC clock sliced out of the ISO string (a label's
  // time 5h30 off is a wrong record). Local time, same YYYY-MM-DD HH:mm shape.
  function localTime(v) { var d = new Date(v); if (!v || isNaN(d)) return v ? String(v) : ''; var p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  function code(v) { return '<span style="font-family:var(--font-mono);font-size:20px;font-weight:600">' + esc(v) + '</span>'; }
  async function call(path, opts) {
    // WALK2-RP-28: an unreachable server answered status 0, which every `status >= 400` check read as
    // success: with the API down the picker read "Nothing waiting at this station". 503, so it is a failure.
    try { return await tunnel(path, opts); } catch (e) { return { status: 503, json: { error: { message: 'Can\'t connect. Nothing was saved; try again.' } } }; }
  }

  /* ── nav: new floor roles and who sees which screen ─────────────────────────────────── */
  var NAV = {
    floorqueue: ['floorqueue', 'Floor queue', 'activity', '__floorqueue__'],
    floorpick: ['floorpick', 'Pick', 'boxOut', '__floorpick__'],
    floorverify: ['floorverify', 'Verify', 'scale', '__floorverify__'],
    floormix: ['floormix', 'Mix', 'flask', '__floormix__'],
    floorscan: ['floorscan', 'Scan a lot', 'scan', '__floorscan__'],
    rules: ['rules', 'Rules', 'sliders', '__rules__'],
    floorcolours: ['floorcolours', 'Floor colours', 'tag', '__floorcolours__']
  };
  var NEW_ROLES = {
    picker: ['Picker', 'Picking', ['floorpick', 'floorqueue', 'floorscan']],
    verifier: ['Verifier', 'Verifying', ['floorverify', 'floorqueue', 'floorscan']],
    mixer: ['Mixer', 'Mixing', ['floormix', 'floorqueue', 'floorscan']],
    packing: ['Packing', 'Packing', ['floorscan']],
    logistics: ['Logistics', 'Logistics', ['floorscan']],
    finance: ['Finance', 'Finance', ['rules']]
  };
  Object.keys(NEW_ROLES).forEach(function (k) {
    if (ROLES[k]) return;
    var d = NEW_ROLES[k];
    ROLES[k] = { label: d[0], dept: d[1], user: d[0], nav: d[2].map(function (n) { return NAV[n].slice(); }) };
    ROLES[k].nav.push(['tutorial', 'Tutorials', 'bookOpen', '__tutorial__']);
  });
  var ADD = { superadmin: ['floorqueue', 'rules', 'floorcolours', 'floorscan'], admin: ['rules', 'floorcolours'], production: ['floorqueue', 'floorscan'], warehouse: ['floorscan'] };
  Object.keys(ADD).forEach(function (role) {
    var R = ROLES[role]; if (!R) return;
    ADD[role].forEach(function (k) { if (!R.nav.some(function (n) { return n[0] === k; })) R.nav.push(NAV[k].slice()); });
  });
  if (window.RaRoutes) {
    var WS = window.RaRoutes.WORKSPACE, SL = window.RaRoutes.SLUG;
    Object.keys(NEW_ROLES).forEach(function (k) { if (!WS[k]) WS[k] = k; });
    SL.__floorqueue__ = 'floor-queue'; SL.__floorpick__ = 'pick'; SL.__floorverify__ = 'verify'; SL.__floormix__ = 'mix';
    SL.__floorscan__ = 'scan-a-lot'; SL.__rules__ = 'rules'; SL.__floorcolours__ = 'floor-colours';
  }

  /* ── hand-off labels: browser print at 75 x 50 mm ────────────────────────────────────── */
  // SCAN-5: both codes (Code 128 + QR, same opaque id) from the one renderer. If the value is not an
  // opaque id it is printed as text and says so, rather than encoding something that should not be.
  function scanCodes(code, maxW, o) {
    try { var x = (o || {}); x.maxWidthMm = maxW; return window.RaLabel.codesHtml(String(code), x).html; }
    catch (e) { return '<span style="font:700 12px ui-monospace,monospace">' + esc(code) + '</span><span style="font-size:9px"> (no scan code: not an opaque id)</span>'; }
  }
  function printLabel(l) {
    if (!l) return;
    // the next station scans this: the verifier and mixer find the job by its tote (or job number).
    var payload = l.kind === 'MIXED' && l.batchNo ? l.batchNo : (l.tote || l.jobNo);
    var w = window.open('', '_blank', 'width=420,height=320');
    if (!w) { toast('The label window was blocked. Allow pop-ups for this site, then reprint.', 'bad'); return; }
    var time = localTime(l.printedDt);
    w.document.write('<!doctype html><meta charset="utf-8"><title>' + esc(l.kind) + ' ' + esc(l.jobNo) + '</title>' +
      '<style>@page{size:75mm 50mm;margin:0}body{margin:0;font:9px/1.15 system-ui,sans-serif}.l{width:71mm;height:46mm;padding:2mm;box-sizing:border-box;border:1px solid #000;display:flex;flex-direction:column}.cd{margin-top:auto}' +
      'h1{margin:0 0 .5mm;font-size:18px;letter-spacing:.06em}.r{font-weight:700;border:2px solid #000;padding:0 3px;margin-left:6px;font-size:13px}td{padding:0 4px 0 0;vertical-align:top}</style>' +
      '<div class="l"><h1>' + esc(l.kind) + (l.reprint ? '<span class="r">REPRINT</span>' : '') + '</h1><table>' +
      '<tr><td>Order</td><td><b>' + esc(l.orderRef || '—') + '</b></td></tr><tr><td>Job</td><td><b>' + esc(l.jobNo) + '</b></td></tr>' +
      (l.tote ? '<tr><td>Tote</td><td><b>' + esc(l.tote) + '</b></td></tr>' : '') +
      (l.batchNo ? '<tr><td>Batch</td><td><b>' + esc(l.batchNo) + '</b></td></tr>' : '') +
      '<tr><td>Lots</td><td>' + esc((l.lots || []).join(', ') || '—') + '</td></tr>' +
      '<tr><td>By</td><td>' + esc(l.person) + '</td></tr><tr><td>Time</td><td>' + esc(time) + '</td></tr></table>' +
      (payload ? '<div class="cd">' + scanCodes(payload, 66, { barHeightMm: 7, textMm: 2.2 }) + '</div>' : '') + '</div>' +
      '<script>window.onload=function(){window.print()}<\/script>');
    w.document.close();
  }
  // SCAN-10/11: Print / Reprint for a step's label (ws-floor-ops.js RA.stepButtons), or nothing if it failed to load.
  function SB(id, o) { return window.RA && window.RA.stepButtons ? window.RA.stepButtons(id, o) : ''; }
  function reprint(jobId, kind) {
    askForm({ title: 'Reprint ' + kind, submit: 'Reprint', intro: 'A duplicate label is a recall risk, so the reprint says REPRINT and is logged with your name.',
      fields: [{ n: 'reason', l: 'Why reprint?', req: true }],
      onSubmit: async function (v, fail, close) {
        var res = await call('/v1/floor/jobs/' + jobId + '/labels', { method: 'POST', body: { kind: kind, reason: v.reason } });
        if (res.status >= 400) { fail(err(res, 'The label was not reprinted.')); return; }
        close(); printLabel(data(res));
      } });
  }

  // WALK2-RP-33: the station card read 'New  New: taken in turn…': the chip already says New / Delayed Nd.
  /* ── job picker shared by the three stations ────────────────────────────────────────── */
  var FS = { jobs: {} };
  async function pickJob(V, stage, title, open) {
    V.innerHTML = '<div class="loading">Loading…</div>';
    var res = await call('/v1/floor/queue?stage=' + stage);
    if (res.status === 403) { V.innerHTML = errBox('Your role does not work this station.'); return; }
    if (res.status >= 400) { V.innerHTML = errBox(err(res, 'The floor queue is not available.')); return; }
    var items = (data(res) || {}).items || [];
    var find = stage === 'PICK' ? '' :
      '<form id="fl-find" class="card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><label style="flex:1;min-width:200px">Scan the tote<input id="fl-tote" data-scan class="fld" autocomplete="off" placeholder="T-12" style="min-height:52px;font-size:18px"></label>' + btn('fl-go', 'Open', 'p', big(' type="submit"')) + '</form>';
    V.innerHTML = '<div style="display:flex;flex-direction:column;gap:14px;max-width:880px">' + find +
      (items.length ? items.map(function (j) {
        var tone = j.priority === 'HOLD' ? 'r' : !j.ready ? 'a' : j.lane === 'DELAYED' ? 'r' : 'b';
        return '<div class="card" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><div style="flex:1;min-width:220px">' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' + (j.position ? '<b style="font-size:20px">#' + j.position + '</b>' : '') + code(j.jobNo) + chip(tone, j.priority === 'HOLD' ? 'Held' : !j.ready ? 'Waiting' : j.lane === 'DELAYED' ? 'Delayed ' + j.daysLate + 'd' : 'New') + '</div>' +
          '<div style="color:var(--ink-3);margin-top:4px">' + esc(j.orderRef || '') + (j.tote ? ' · tote ' + esc(j.tote) : '') + '</div><div style="margin-top:4px">' + esc(String(j.why || '').replace(/^(New|Delayed \d+ days?): /, '')) + '</div></div>' +
          (j.ready && j.priority !== 'HOLD' ? btn('fl-open-' + j.floorJobId, title, 'p', big(' data-job="' + esc(j.floorJobId) + '"')) : '') + '</div>';
      }).join('') : '<div class="card">Nothing waiting at this station.</div>') + '</div>';
    V.querySelectorAll('[data-job]').forEach(function (b) { b.onclick = function () { open(b.getAttribute('data-job')); }; });
    var f = $('fl-find');
    if (f) f.onsubmit = async function (e) {
      e.preventDefault();
      var r = await call('/v1/floor/find?ref=' + encodeURIComponent($('fl-tote').value.trim()));
      if (r.status >= 400) { toast(err(r, 'Nothing answers to that tote.'), 'bad'); return; }
      open(data(r).floorJobId);
    };
  }

  /* ── 1 Picker ───────────────────────────────────────────────────────────────────────── */
  function viewPick(item, V) { return pickJob(V, 'PICK', 'Start picking', function (id) { pickJobView(V, id); }); }
  async function pickJobView(V, id) {
    var res = await call('/v1/floor/jobs/' + id + '/pick');
    if (res.status >= 400) { V.innerHTML = errBox(err(res, 'This job cannot be opened.')); return; }
    var d = data(res), open = d.lines.filter(function (l) { return !l.picked; }), next = open[0];
    var head = '<div class="card" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' + code(d.jobNo) + '<span>' + esc(d.orderRef || '') + '</span><span style="margin-left:auto">' + (d.lines.length - open.length) + ' of ' + d.lines.length + ' picked</span></div>';
    var list = d.lines.map(function (l) {
      return '<div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)"><b>' + l.seq + '</b>' + code(l.floorCode) + swatch(l) +
        '<span style="margin-left:auto">' + (l.picked ? chip('g', 'Picked' + (l.offFefoReason ? ' (reason: ' + l.offFefoReason + ')' : '')) : l.waiting ? chip('a', l.waiting) : chip('n', 'Open')) + '</span></div>';
    }).join('');
    var body;
    if (next) {
      var t = next.takeLot;
      body = '<form id="fl-pick" class="card" style="display:flex;flex-direction:column;gap:12px"><div style="font-size:18px">Line ' + next.seq + ': ' + code(next.floorCode) + ' ' + swatch(next) + '</div>' +
        (t ? '<div style="font-size:18px">Go to bin <b>' + esc(t.bin || '—') + '</b>, take lot <b>' + esc(t.lot || t.barcode) + '</b>' + (t.expiry ? ' (expires ' + esc(t.expiry) + ')' : '') + '.</div>' : '<div class="card" role="alert" style="color:var(--red)">' + esc(next.waiting) + '</div>') +
        '<label>Scan the bin<input id="fl-bin" data-scan class="fld" autocomplete="off" style="min-height:52px;font-size:18px"></label>' +
        '<label>Scan the lot label<input id="fl-lot" data-scan class="fld" autocomplete="off" placeholder="L-…" style="min-height:52px;font-size:18px"></label>' +
        '<label id="fl-why-l" hidden>Reason for taking a different lot<input id="fl-why" class="fld" style="min-height:52px;font-size:18px"></label>' +
        '<div id="fl-err" role="alert" style="color:var(--red);min-height:20px"></div>' + btn('fl-tick', 'Picked', 'p', big(' type="submit"')) + '</form>';
    } else {
      body = '<form id="fl-done" class="card" style="display:flex;flex-direction:column;gap:12px"><div style="font-size:18px">Every line is picked. Scan the tote, then finish.</div>' +
        '<label>Tote<input id="fl-tote2" data-scan class="fld" autocomplete="off" placeholder="T-12" style="min-height:52px;font-size:18px"></label><div id="fl-err" role="alert" style="color:var(--red);min-height:20px"></div>' +
        btn('fl-finish', 'Finish and print PICKED', 'p', big(' type="submit"')) + '</form>';
    }
    V.innerHTML = '<div style="display:flex;flex-direction:column;gap:14px;max-width:880px">' + head + body + '<div class="card">' + list + '</div></div>';
    var f = $('fl-pick');
    if (f) { $('fl-bin').focus(); f.onsubmit = async function (e) {
      e.preventDefault();
      var r = await call('/v1/floor/jobs/' + id + '/pick/lines/' + next.floorLineId, { method: 'POST', body: { bin: $('fl-bin').value.trim(), barcode: $('fl-lot').value.trim(), reason: $('fl-why').value.trim() } });
      if (r.status >= 400) {
        $('fl-err').textContent = err(r, 'That scan was refused.');
        if (/give a reason/.test($('fl-err').textContent)) { $('fl-why-l').hidden = false; $('fl-why').focus(); }
        return;
      }
      pickJobView(V, id);
    }; }
    var g = $('fl-done');
    if (g) { $('fl-tote2').focus(); g.onsubmit = async function (e) {
      e.preventDefault();
      var r = await call('/v1/floor/jobs/' + id + '/pick/complete', { method: 'POST', body: { tote: $('fl-tote2').value.trim() } });
      if (r.status >= 400) { $('fl-err').textContent = err(r, 'The pick was not finished.'); return; }
      toast('Picked. The tote goes to the verifier.', 'good'); printLabel(data(r).label); loadView();
    }; }
  }

  /* ── 2 Verifier ─────────────────────────────────────────────────────────────────────── */
  function viewVerify(item, V) { return pickJob(V, 'VERIFY', 'Verify', function (id) { verifyJobView(V, id); }); }
  async function verifyJobView(V, id) {
    var res = await call('/v1/floor/jobs/' + id + '/verify');
    if (res.status >= 400) { V.innerHTML = errBox(err(res, 'This job cannot be opened.')); return; }
    var d = data(res), open = d.lines.filter(function (l) { return !l.verified; }), next = open[0];
    var rows = d.lines.map(function (l) {
      var u = W.lineUnit(l.targetMg, 'g');
      return '<div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line);flex-wrap:wrap"><b>' + l.seq + '</b>' + code(l.floorCode) + swatch(l) +
        '<span>' + esc(W.formatTolerance(l.targetMg, l.toleranceMg, u)) + '</span><span style="margin-left:auto">' +
        (l.verified ? chip('g', W.formatIn(l.actualMg, u) + (l.source === 'typed' ? ' typed' : '')) : chip('n', 'Open')) + '</span></div>';
    }).join('');
    var body;
    if (next) {
      var u = W.lineUnit(next.targetMg, 'g');
      body = '<form id="fl-w" class="card" style="display:flex;flex-direction:column;gap:12px"><div style="font-size:18px">Line ' + next.seq + ': ' + code(next.floorCode) + ' ' + swatch(next) + '</div>' +
        '<div style="font-size:24px;font-weight:600">' + esc(W.formatTolerance(next.targetMg, next.toleranceMg, u)) + '</div>' +
        '<label>Weight on the scale (' + u + ')<input id="fl-wt" class="fld" inputmode="decimal" autocomplete="off" style="min-height:56px;font-size:22px"></label>' +
        '<div id="fl-err" role="alert" style="color:var(--red);min-height:20px"></div>' + btn('fl-wtick', 'Record weight', 'p', big(' type="submit"')) + '</form>';
    } else {
      body = '<div class="card" style="display:flex;flex-direction:column;gap:12px"><div style="font-size:18px">Every line is weighed inside tolerance.</div><div id="fl-err" role="alert" style="color:var(--red);min-height:20px"></div>' + btn('fl-vdone', 'Finish and print VERIFIED', 'p', big()) + '</div>';
    }
    V.innerHTML = '<div style="display:flex;flex-direction:column;gap:14px;max-width:880px"><div class="card" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' + code(d.jobNo) + '<span>tote ' + esc(d.tote || '—') + '</span>' +
      btn('fl-rp', 'Reprint PICKED', 'sm') + '</div>' + body + '<div class="card">' + rows + '</div></div>';
    $('fl-rp').onclick = function () { reprint(id, 'PICKED'); };
    var f = $('fl-w');
    if (f) { $('fl-wt').focus(); f.onsubmit = async function (e) {
      e.preventDefault();
      var u2 = W.lineUnit(next.targetMg, 'g'), mg = W.parseToMg($('fl-wt').value, u2);
      if (mg === null || mg <= 0) { $('fl-err').textContent = 'Type the weight as a number, e.g. 125.5.'; return; }
      var r = await call('/v1/floor/jobs/' + id + '/verify/lines/' + next.floorLineId, { method: 'POST', body: { actualMg: mg, source: 'typed' } });
      if (r.status >= 400) { $('fl-err').textContent = err(r, 'That weight was not recorded.'); return; }
      var x = data(r);
      if (!x.verified) { $('fl-err').textContent = W.formatIn(x.actualMg, u2) + ' is outside ' + W.formatTolerance(x.targetMg, x.toleranceMg, u2) + '. ' + x.message; $('fl-wt').select(); return; }
      verifyJobView(V, id);
    }; }
    var dn = $('fl-vdone');
    if (dn) dn.onclick = async function () {
      var r = await call('/v1/floor/jobs/' + id + '/verify/complete', { method: 'POST' });
      if (r.status >= 400) { $('fl-err').textContent = err(r, 'Verification was not finished.'); return; }
      toast('Verified. The tote goes to the mixer.', 'good'); printLabel(data(r).label); loadView();
    };
  }

  /* ── 3 Mixer ────────────────────────────────────────────────────────────────────────── */
  function viewMix(item, V) { return pickJob(V, 'MIX', 'Mix', function (id) { mixJobView(V, id); }); }
  async function mixJobView(V, id) {
    var res = await call('/v1/floor/jobs/' + id + '/mix');
    if (res.status >= 400) { V.innerHTML = errBox(err(res, 'This job cannot be opened.')); return; }
    var d = data(res), next = d.steps.filter(function (s) { return !s.done; })[0];
    V.innerHTML = '<div style="display:flex;flex-direction:column;gap:14px;max-width:880px"><div class="card" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' + code(d.jobNo) + '<span>tote ' + esc(d.tote || '—') + '</span>' + btn('fl-rpv', 'Reprint VERIFIED', 'sm') + '</div>' +
      '<div class="card" style="display:flex;flex-direction:column;gap:10px">' + d.steps.map(function (s) {
        return '<div style="display:flex;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)' + (s.next ? ';font-weight:600' : '') + '"><b style="font-size:20px">' + s.seq + '</b><span style="flex:1;font-size:18px">' + esc(s.instruction) + '</span>' +
          (s.done ? chip('g', 'Done') : s.next ? btn('fl-st-' + s.seq, 'Done', 'p', big(' data-step="' + s.seq + '"')) : chip('n', 'Later')) + '</div>';
      }).join('') + '</div><div id="fl-err" role="alert" style="color:var(--red);min-height:20px"></div>' + (next ? '' : btn('fl-mdone', 'Finish and print MIXED', 'p', big())) + '</div>';
    $('fl-rpv').onclick = function () { reprint(id, 'VERIFIED'); };
    V.querySelectorAll('[data-step]').forEach(function (b) { b.onclick = async function () {
      var r = await call('/v1/floor/jobs/' + id + '/mix/steps/' + b.getAttribute('data-step'), { method: 'POST' });
      if (r.status >= 400) { $('fl-err').textContent = err(r, 'That step was not recorded.'); return; }
      mixJobView(V, id);
    }; });
    var m = $('fl-mdone');
    if (m) m.onclick = async function () {
      m.disabled = true;
      var r = await call('/v1/floor/jobs/' + id + '/mix/complete', { method: 'POST' });
      if (r.status >= 400) { m.disabled = false; $('fl-err').textContent = err(r, 'The mix was not finished.'); return; }
      toast('Mixed: batch ' + data(r).batchNo, 'good'); printLabel(data(r).label); loadView();
    };
  }

  /* ── Floor queue (overview + open a job from a run) ─────────────────────────────────── */
  async function viewQueue(item, V) {
    V.innerHTML = '<div class="loading">Loading…</div>';
    var res = await call('/v1/floor/queue');
    if (res.status >= 400) { V.innerHTML = errBox(err(res, 'The floor queue is not available.')); return; }
    var d = data(res) || { items: [], counters: {} }, c = d.counters || {};
    var canOpen = can('production:floor_job:write');
    // WALK2-RP-12: the run was typed as a production-order uuid; chosen by its order number.
    var cand = canOpen ? await call('/v1/floor/job-candidates') : null, runs = (cand && cand.status < 400 && (data(cand) || {}).items) || [];
    var candErr = cand && cand.status >= 400 ? err(cand, 'The runs did not load.') : '';
    V.innerHTML = '<div class="stats">' + kpi('activity', String(c.total || 0), 'On the floor') + kpi('zap', String(c.ready || 0), 'Ready') + kpi('alert', String(c.delayed || 0), 'Delayed') +
      kpi('lock', String(c.waiting || 0), 'Waiting on stock') + kpi('shieldCheck', String(c.held || 0), 'Held') + '</div>' +
      (canOpen ? '<form id="fl-new" class="card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end"><label style="flex:1;min-width:240px">Production run (with a pick list)<select id="fl-po" class="fld"><option value="">' + esc(candErr || (runs.length ? 'Choose a run…' : 'No run with a pick list is waiting')) + '</option>' +
        runs.map(function (r) { return '<option value="' + esc(r.productionOrderId) + '">' + esc(r.orderNumber || 'Run without a number') + '</option>'; }).join('') + '</select></label>' +
        '<label style="flex:1;min-width:240px">Extra mixing steps, one per line (optional)<textarea id="fl-steps" class="fld" rows="2"></textarea></label>' +
        '<label style="flex:1;min-width:240px">Approved stock-cover suggestion (optional: ranks below customer orders)<select id="fl-cs" class="fld"><option value="">None</option>' +
          (d.planned || []).map(function (s) { return '<option value="' + esc(s.coverSuggestionId) + '">' + esc(s.sku + ': make ' + s.qty) + '</option>'; }).join('') + '</select></label>' + btn('fl-newgo', 'Put on the floor', 'p', ' type="submit"') + '<div id="fl-nerr" role="alert" style="color:var(--red);width:100%"></div></form>' : '') +
      // PROD-D-2: each job's late prediction from measured station times, maceration and stock; at-risk
      // jobs are flagged before they are Delayed. Approved stock-cover suggestions are listed below.
      (d.pipeline && d.pipeline.atRisk ? '<div class="card" id="fl-risk" role="status">' + chip('r', d.pipeline.atRisk + ' at risk') + ' Predicted to finish after the promise date: expedite before they become Delayed.</div>' : '') +
      '<div class="card" style="overflow-x:auto"><table class="tbl" style="width:100%;min-width:640px"><thead><tr><th>#</th><th>Job</th><th>Station</th><th>Order</th><th>Why here</th><th>Finish</th></tr></thead><tbody>' +
      (d.items.length ? d.items.map(function (j) {
        var p = j.prediction;
        var fin = !p ? '' : p.atRisk ? chip('r', 'Late by ' + p.lateByDays + 'd') + ' ' + esc(p.explain) : esc(p.explain);
        return '<tr><td>' + (j.position || '—') + '</td><td>' + esc(j.jobNo) + (j.expedite ? ' ' + chip('r', 'Expedite') : '') + (j.priority === 'SUGGESTED' ? ' ' + chip('n', 'Suggested') : '') + '</td><td>' + esc(({ PICK: 'Pick', VERIFY: 'Verify', MIX: 'Mix', DONE: 'Done' })[j.stage] || j.stage) + '</td><td>' + esc(j.orderRef || '') + '</td><td>' + esc(j.why) + '</td><td>' + fin +
          // SCAN-11: the job ticket (its job number is what the next station's find field takes); MIXED reprint once done.
          '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">' + SB('fl-jt-' + j.floorJobId, { labelKind: 'floor_job', subjectRef: j.jobNo, code: j.jobNo, title: 'FLOOR JOB', defaultStation: 'Floor', lines: [['Order', j.orderRef], ['Stage', ({ PICK: 'Pick', VERIFY: 'Verify', MIX: 'Mix', DONE: 'Done' })[j.stage] || j.stage]] }) +
          (j.stage === 'DONE' ? btn('fl-rpm-' + j.floorJobId, 'Reprint MIXED', 'sm', ' data-rpm="' + esc(j.floorJobId) + '"') : '') + '</div></td></tr>';
      }).join('') : '<tr><td colspan="6">Nothing on the floor.</td></tr>') + '</tbody></table></div>' +
      ((d.planned || []).length ? '<div class="card" id="fl-planned"><b>Approved stock-cover suggestions (below every customer order)</b>' + d.planned.map(function (s) {
        return '<p style="margin:6px 0 0">' + esc(s.sku) + ': make ' + esc(s.qty) + '. ' + esc(s.reasoning) + ' <span class="t-cap">Choose it as the stock-cover suggestion when you put a run on the floor.</span></p>';
      }).join('') + '</div>' : '');
    V.querySelectorAll('[data-rpm]').forEach(function (b) { b.onclick = function () { reprint(b.getAttribute('data-rpm'), 'MIXED'); }; });
    var f = $('fl-new');
    if (f) f.onsubmit = async function (e) {
      e.preventDefault();
      var steps = $('fl-steps').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      if (!$('fl-po').value) { $('fl-nerr').textContent = 'Choose the run.'; return; }
      var r = await call('/v1/floor/jobs', { method: 'POST', body: { productionOrderId: $('fl-po').value, steps: steps, coverSuggestionId: ($('fl-cs') && $('fl-cs').value) || undefined } });
      if (r.status >= 400) { $('fl-nerr').textContent = err(r, 'The job was not opened.'); return; }
      toast('On the floor as ' + data(r).jobNo, 'good'); loadView();
    };
  }

  /* ── Scan a lot ─────────────────────────────────────────────────────────────────────── */
  function viewScan(item, V) {
    V.innerHTML = '<form id="fl-sc" class="card" style="display:flex;gap:10px;flex-wrap:wrap;max-width:880px"><label style="flex:1;min-width:220px">Scan or type a lot label<input id="fl-sci" data-scan class="fld" placeholder="L-…" autocomplete="off" style="min-height:52px;font-size:18px"></label>' + btn('fl-scgo', 'Look up', 'p', big(' type="submit"')) + '</form><div id="fl-sco" style="max-width:880px;margin-top:14px"></div>';
    $('fl-sci').focus();
    $('fl-sc').onsubmit = async function (e) {
      e.preventDefault();
      var r = await call('/v1/floor/scan?code=' + encodeURIComponent($('fl-sci').value.trim()));
      if (r.status >= 400) { $('fl-sco').innerHTML = errBox(err(r, 'That label is not known.')); return; }
      var x = data(r);
      var row = function (k, v) { return '<tr><th style="text-align:left;padding-right:14px">' + k + '</th><td>' + v + '</td></tr>'; };
      $('fl-sco').innerHTML = '<div class="card"><table>' + row('Floor code', code(x.floorCode || 'No code yet')) + row('Colour', swatch(x) || '—') +
        (x.materialName ? row('Material', esc(x.materialName) + ' (' + esc(x.materialCode) + ')') : '') +
        row('Bin', esc(x.bin || '—')) + row('Lot', esc(x.lot || '—')) + row('Left', esc(x.quantityLeftMg != null ? W.formatWeight(x.quantityLeftMg) : x.quantityLeft || '—')) +
        row('Expiry', esc(x.expiry || 'Not on file')) + row('Status', chip(x.pickable ? 'g' : 'r', (function (v) { v = String(v || '').replace(/_/g, ' ').toLowerCase(); return v ? v.charAt(0).toUpperCase() + v.slice(1) : (x.pickable ? 'Pickable' : 'Not pickable'); })(x.status))) + row('Hazard', esc(x.hazard)) + '</table></div>';
    };
  }

  /* ── Floor colours ──────────────────────────────────────────────────────────────────── */
  async function viewColours(item, V) {
    var res = await call('/v1/floor/families');
    if (res.status >= 400) { V.innerHTML = errBox(err(res, 'The colour table is not available.')); return; }
    var rows = data(res) || [], canEdit = can('masterdata:floor_family:write');
    V.innerHTML = '<div style="display:flex;flex-direction:column;gap:14px;max-width:880px"><div class="card">Each ingredient family has one colour. A code is the colour and a random number inside the family, and every label prints the colour name and its initial too. A colour cannot change once codes are printed under it.</div>' +
      '<div class="card"><table class="tbl" style="width:100%"><thead><tr><th>Family</th><th>Colour</th><th>Codes</th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (f) { return '<tr><td>' + esc(f.familyName) + ' <span style="color:var(--ink-3)">' + esc(f.familyCode) + '</span></td><td>' + swatch(f) + '</td><td>' + esc(f.codes) + '</td></tr>'; }).join('') : '<tr><td colspan="3">No families yet.</td></tr>') + '</tbody></table></div>' +
      (canEdit ? '<form id="fl-fam" class="card form" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;align-items:end">' +
        '<label>Family code<input id="fl-fc" class="fld" placeholder="citrus"></label><label>Family name<input id="fl-fn" class="fld" placeholder="Citrus"></label>' +
        '<label>Colour name<input id="fl-cn" class="fld" placeholder="Yellow"></label><label>Colour<input id="fl-ch" class="fld" type="color" value="#E8C547"></label>' +
        btn('fl-fsave', 'Save family', 'p', ' type="submit"') + '<div id="fl-ferr" role="alert" style="color:var(--red);grid-column:1/-1"></div></form>' : '') + '</div>';
    var f = $('fl-fam');
    if (f) f.onsubmit = async function (e) {
      e.preventDefault();
      var r = await call('/v1/floor/families/' + encodeURIComponent($('fl-fc').value.trim()), { method: 'PUT', body: { familyName: $('fl-fn').value.trim(), colourName: $('fl-cn').value.trim(), colourHex: $('fl-ch').value } });
      if (r.status >= 400) { $('fl-ferr').textContent = err(r, 'The family was not saved.'); return; }
      toast('Saved', 'good'); loadView();
    };
  }

  /* ── Rules (12.0) ───────────────────────────────────────────────────────────────────── */
  var OPS = [['eq', '='], ['neq', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['in', 'is one of'], ['exists', 'is set']];
  var SCOPES = [['record', 'One record'], ['vendor', 'Vendor'], ['material_family', 'Material family'], ['global', 'General']];
  function parseVal(t) { var s = String(t == null ? '' : t).trim(); if (s === '') return ''; try { return JSON.parse(s); } catch (e) { return s; } }
  function showVal(v) { return typeof v === 'string' ? v : JSON.stringify(v); }
  // WALK2-RP-17: the Rules list read 'otherwise {"mode":"alternate"}'. Words for reading; the editor's
  // inputs keep the exact value (showVal) because that is what is published.
  function sayVal(v) {
    if (v === null || v === undefined) return 'nothing';
    if (typeof v !== 'object') return String(v);
    if (Array.isArray(v)) return v.map(sayVal).join(', ');
    return Object.keys(v).map(function (k) { return k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase() + ': ' + sayVal(v[k]); }).join(', ');
  }
  async function viewRules(item, V) {
    V.innerHTML = '<div class="loading">Loading…</div>';
    var res = await call('/v1/policies');
    if (res.status >= 400) { V.innerHTML = errBox(err(res, 'The rules are not available.')); return; }
    var list = data(res) || [];
    V.innerHTML = '<div style="display:flex;flex-direction:column;gap:14px;max-width:1000px"><div class="card">Each policy is a list of rules: IF the conditions hold THEN this value, ELSE IF the next rule…, OTHERWISE the default. A rule for one record beats a vendor rule, which beats a material-family rule, which beats a general rule. With no match and no default the system holds and asks.</div>' +
      list.map(function (p) { return '<div class="card" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><div style="flex:1;min-width:220px"><b>' + esc(p.title) + '</b> <span style="font-family:var(--font-mono);color:var(--ink-3)">' + esc(p.key) + '</span><div style="color:var(--ink-3)">' + esc(p.description || '') + '</div><div>v' + esc(p.version) + ' · ' + (function (n) { return n + (n === 1 ? ' rule' : ' rules'); })((p.body.rules || []).length) + ' · ' + (p.body.hasDefault ? 'otherwise ' + esc(sayVal(p.body.defaultValue)) : chip('a', 'no default: holds')) + (p.activeOverrides ? ' · ' + p.activeOverrides + (Number(p.activeOverrides) === 1 ? ' override' : ' overrides') : '') + '</div></div>' + btn('fl-pol-' + p.key.replace(/\W/g, '_'), 'Open', '', ' data-pol="' + esc(p.key) + '"') + '</div>'; }).join('') + '</div>';
    V.querySelectorAll('[data-pol]').forEach(function (b) { b.onclick = function () { ruleEditor(V, b.getAttribute('data-pol')); }; });
  }
  async function ruleEditor(V, key) {
    var res = await call('/v1/policies/' + encodeURIComponent(key));
    if (res.status >= 400) { V.innerHTML = errBox(err(res, 'This policy cannot be opened.')); return; }
    var h = data(res), cur = (h.versions[0] || {}).body || { rules: [], hasDefault: false };
    var draft = JSON.parse(JSON.stringify(cur));
    var canWrite = can('platform:policy:write'), canOverride = can('platform:policy_override:write');
    function condHtml(ri, ci, c) {
      return '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><input class="fld" data-f="field" data-r="' + ri + '" data-c="' + ci + '" value="' + esc(c.field) + '" placeholder="field (vendor, days_late…)" style="max-width:200px">' +
        '<select class="fld" data-f="op" data-r="' + ri + '" data-c="' + ci + '" style="max-width:140px">' + OPS.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === c.op ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
        '<input class="fld" data-f="value" data-r="' + ri + '" data-c="' + ci + '" value="' + esc(c.value === undefined ? '' : showVal(c.value)) + '" placeholder="value" style="max-width:200px">' +
        btn('fl-dc-' + ri + '-' + ci, 'Remove', 'sm', ' data-delc="' + ri + ':' + ci + '"') + '</div>';
    }
    function render() {
      V.innerHTML = '<div style="display:flex;flex-direction:column;gap:14px;max-width:1000px">' +
        '<div class="card" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' + btn('fl-back', '← All rules', 'sm') + '<b>' + esc(h.title || key) + '</b><span>in force: v' + esc((h.versions[0] || {}).version) + '</span></div>' +
        draft.rules.map(function (r, ri) {
          return '<div class="card" style="display:flex;flex-direction:column;gap:8px"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>' + (ri === 0 ? 'IF' : 'ELSE IF') + '</b> Rule ' + (ri + 1) +
            '<select class="fld" data-f="scope" data-r="' + ri + '" style="max-width:180px">' + SCOPES.map(function (s) { return '<option value="' + s[0] + '"' + (s[0] === r.scope ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') + '</select>' +
            '<input class="fld" data-f="label" data-r="' + ri + '" value="' + esc(r.label || '') + '" placeholder="label (optional)" style="max-width:220px">' + btn('fl-dr-' + ri, 'Remove rule', 'sm', ' data-delr="' + ri + '"') + '</div>' +
            (r.when.length ? r.when.map(function (c, ci) { return condHtml(ri, ci, c); }).join('<div>AND</div>') : '<div style="color:var(--ink-3)">Always (no condition)</div>') +
            btn('fl-ac-' + ri, '+ Condition', 'sm', ' data-addc="' + ri + '"') +
            '<label><b>THEN</b> <input class="fld" data-f="then" data-r="' + ri + '" value="' + esc(showVal(r.then === undefined ? '' : r.then)) + '" placeholder=\'e.g. {"shortPct":10}\'></label></div>';
        }).join('') +
        '<div class="card" style="display:flex;flex-direction:column;gap:8px">' + btn('fl-ar', '+ Rule', 'sm') +
        '<label><input type="checkbox" id="fl-hd"' + (draft.hasDefault ? ' checked' : '') + '> <b>OTHERWISE</b> use</label><input id="fl-dv" class="fld" value="' + esc(draft.hasDefault ? showVal(draft.defaultValue) : '') + '" placeholder="leave unticked to hold and ask"></div>' +
        '<div class="card" style="display:flex;flex-direction:column;gap:8px"><b>Test a sample case</b><textarea id="fl-ctx" class="fld" rows="2" placeholder=\'{"vendor":"Givaudan","material_family":"naturals"}\'></textarea>' + btn('fl-test', 'Test this draft', '') + '<div id="fl-tout" role="status"></div></div>' +
        (canWrite ? '<div class="card" style="display:flex;flex-direction:column;gap:8px"><label>Why are the rules changing?<input id="fl-why" class="fld"></label>' + btn('fl-pub', 'Publish as v' + ((h.versions[0] || {}).version + 1), 'p') + '<div id="fl-perr" role="alert" style="color:var(--red)"></div></div>' : '') +
        (canOverride ? '<form id="fl-ov" class="card" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;align-items:end"><b style="grid-column:1/-1">Override on one record (admin or owner, with a reason)</b>' +
          '<label>Record type<input id="fl-ovt" class="fld" placeholder="po, floor_job"></label><label>Record<input id="fl-ovi" class="fld" placeholder="PO-123"></label><label>Value<input id="fl-ovv" class="fld"></label><label>Reason<input id="fl-ovr" class="fld"></label>' +
          btn('fl-ovgo', 'Override', '', ' type="submit"') + '<div id="fl-overr" role="alert" style="color:var(--red);grid-column:1/-1"></div></form>' : '') +
        '<div class="card"><b>Versions</b>' + h.versions.map(function (v) { return '<div>v' + esc(v.version) + ' · ' + esc(localTime(v.createdDt)) + ' · ' + esc(v.createdByName || 'Someone no longer on file') + ' · ' + esc(v.reason) + '</div>'; }).join('') +
        '<b style="display:block;margin-top:8px">Overrides</b>' + (h.overrides.length ? h.overrides.map(function (o) { return '<div>' + chip(o.revokedDt ? 'n' : 'a', o.revokedDt ? 'Revoked' : 'OVERRIDDEN') + ' ' + esc(o.recordType) + ' ' + esc(o.recordId) + ' → ' + esc(showVal(o.value)) + ' · ' + esc(o.reason) + (!o.revokedDt && canOverride ? ' ' + btn('fl-rv-' + o.overrideId, 'Withdraw', 'sm', ' data-rev="' + esc(o.overrideId) + '"') : '') + '</div>'; }).join('') : '<div>None.</div>') +
        '<b style="display:block;margin-top:8px">Recent decisions</b>' + (h.decisions.length ? h.decisions.map(function (d) { return '<div>v' + esc(d.version) + ' · ' + esc(d.recordType || '') + ' ' + esc(d.recordId || '') + ' · ' + esc(d.explain) + '</div>'; }).join('') : '<div>None yet.</div>') + '</div></div>';
      bind();
    }
    function collect() {
      V.querySelectorAll('[data-f]').forEach(function (el) {
        var r = draft.rules[+el.getAttribute('data-r')], f = el.getAttribute('data-f'), ci = el.getAttribute('data-c');
        if (!r) return;
        if (ci !== null) { var c = r.when[+ci]; c[f] = f === 'value' ? parseVal(el.value) : el.value; if (c.op === 'in' && typeof c.value === 'string') c.value = c.value.split(',').map(function (s) { return s.trim(); }); if (c.op === 'exists') delete c.value; }
        else if (f === 'then') r.then = parseVal(el.value);
        else if (f === 'label') { if (el.value.trim()) r.label = el.value.trim(); else delete r.label; }
        else r[f] = el.value;
      });
      draft.hasDefault = $('fl-hd').checked;
      if (draft.hasDefault) draft.defaultValue = parseVal($('fl-dv').value); else delete draft.defaultValue;
    }
    function bind() {
      $('fl-back').onclick = function () { viewRules(null, V); };
      $('fl-ar').onclick = function () { collect(); draft.rules.push({ id: 'r' + Date.now().toString(36), scope: 'global', when: [], then: '' }); render(); };
      V.querySelectorAll('[data-addc]').forEach(function (b) { b.onclick = function () { collect(); draft.rules[+b.getAttribute('data-addc')].when.push({ field: '', op: 'eq', value: '' }); render(); }; });
      V.querySelectorAll('[data-delc]').forEach(function (b) { b.onclick = function () { collect(); var p = b.getAttribute('data-delc').split(':'); draft.rules[+p[0]].when.splice(+p[1], 1); render(); }; });
      V.querySelectorAll('[data-delr]').forEach(function (b) { b.onclick = function () { collect(); draft.rules.splice(+b.getAttribute('data-delr'), 1); render(); }; });
      $('fl-test').onclick = async function () {
        collect();
        var ctx; try { ctx = $('fl-ctx').value.trim() ? JSON.parse($('fl-ctx').value) : {}; } catch (e) { $('fl-tout').textContent = 'The sample case must be JSON, e.g. {"vendor":"X"}.'; return; }
        var r = await call('/v1/policies/' + encodeURIComponent(key) + '/test', { method: 'POST', body: { body: draft, ctx: ctx } });
        if (r.status >= 400) { $('fl-tout').textContent = err(r, 'The test did not run.'); return; }
        var t = data(r);
        $('fl-tout').innerHTML = !t.valid ? '<span style="color:var(--red)">' + esc(t.problems.join(' ')) + '</span>' : t.resolved ? chip('g', 'Result: ' + showVal(t.value)) + ' ' + esc(t.explain) : chip('a', 'HOLD') + ' ' + esc(t.explain);
      };
      var pub = $('fl-pub');
      if (pub) pub.onclick = async function () {
        collect();
        var r = await call('/v1/policies/' + encodeURIComponent(key) + '/versions', { method: 'POST', body: { body: draft, reason: $('fl-why').value } });
        if (r.status >= 400) { $('fl-perr').textContent = err(r, 'Not published.'); return; }
        toast('Published v' + data(r).version, 'good'); ruleEditor(V, key);
      };
      var ov = $('fl-ov');
      if (ov) ov.onsubmit = async function (e) {
        e.preventDefault();
        var r = await call('/v1/policies/' + encodeURIComponent(key) + '/overrides', { method: 'POST', body: { recordType: $('fl-ovt').value.trim(), recordId: $('fl-ovi').value.trim(), value: parseVal($('fl-ovv').value), reason: $('fl-ovr').value } });
        if (r.status >= 400) { $('fl-overr').textContent = err(r, 'Not overridden.'); return; }
        toast('OVERRIDDEN', 'good'); ruleEditor(V, key);
      };
      V.querySelectorAll('[data-rev]').forEach(function (b) { b.onclick = function () {
        askForm({ title: 'Withdraw override', submit: 'Withdraw', fields: [{ n: 'reason', l: 'Why withdraw it?', req: true }],
          onSubmit: async function (v, fail, close) {
            var r = await call('/v1/policy-overrides/' + b.getAttribute('data-rev') + '/revoke', { method: 'POST', body: { reason: v.reason } });
            if (r.status >= 400) { fail(err(r, 'Not revoked.')); return; }
            close(); ruleEditor(V, key);
          } });
      }; });
    }
    render();
  }

  window.RA.registerViews({
    __floorqueue__: viewQueue, __floorpick__: viewPick, __floorverify__: viewVerify, __floormix__: viewMix,
    __floorscan__: viewScan, __rules__: viewRules, __floorcolours__: viewColours
  });
})();
