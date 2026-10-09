/* RAW AROMA — ws-setup module (lane catalogue, owner decisions 2026-10-05): "we already have
 * inventory — build the factory data and let Ruh/ARIA predict and apply it". Ruh drafts, one
 * person approves.
 *
 *   Factory setup   the checklist: catalogue received from ALEMBIC, pack sizes (and how many still
 *                   need a density — approved in ALEMBIC Admin), QC specs approved / drafted /
 *                   missing, racks laid out, pick-to-light mode, label printing, formulas linked,
 *                   and what is blocking ALEMBIC's requirements — each with its next action.
 *                   Below it, Ruh's drafts: QC specs (approve or reject per row, or tick several and
 *                   decide them together) and the rack layout (change the counts, then accept; the
 *                   bins are built and their QR labels can be printed at once).
 *
 * Plain classic script, loaded after ws-produce.js (see index.html): uses shell.js's globals
 * (tunnel, $, toast, escHtml, can, kpi, icon, raConfirm, ROLES, RA_VIEWS, st, loadView, errBox) and
 * ws-produce's bin-label printer (window.RA.printBinLabels). Nothing here decides a permission:
 * the server re-checks every call. Every figure shows where it came from.
 */
'use strict';
(function () {
  var SV = {};

  function err(res, fallback) { return (res && res.json && res.json.error && res.json.error.message) || fallback; }
  function data(res) { return (res && res.json && res.json.data); }
  function chip(tone, text) { return '<span class="chip ' + tone + '"><i class="dot"></i>' + escHtml(text) + '</span>'; }
  function mono(v) { return '<span style="font-family:var(--font-mono);font-size:var(--t-cap);font-weight:var(--w-med)">' + escHtml(v) + '</span>'; }
  function muted(v) { return '<span style="color:var(--ink-3)">' + escHtml(v) + '</span>'; }
  function btn(attrs, label, cls) { return '<button type="button" class="btn ' + (cls || 'sm') + '" ' + attrs + '>' + label + '</button>'; }
  function stale() { return st.nav !== 'factorysetup'; }
  var SOURCE = { document: ['g', 'From a document'], 'catalogue fact': ['b', 'From the catalogue'], estimate: ['a', 'Ruh\'s estimate'] };
  function sourceChip(s) { var x = SOURCE[s] || ['n', s]; return chip(x[0], x[1]); }
  var LIGHT = { off: 'Off', simulator: 'On-screen (lit bins on the Shelf display)', http: 'Hardware controller', unset: 'Not set yet' };
  var canRackWrite = function () { return can('location:rack_master:write') && can('location:shelf_master:write') && can('location:bin_master:write'); };

  /* ── navigation: one screen for the roles that set the factory up ─────────────────── */
  var NAV = ['factorysetup', 'Factory setup', 'factory', '__factorysetup__'];
  ['superadmin', 'qc', 'warehouse', 'production'].forEach(function (role) {
    var R = ROLES[role]; if (!R || R.nav.some(function (n) { return n[0] === NAV[0]; })) return;
    var at = R.nav.length && R.nav[0][0] === 'dashboard' ? 1 : 0;
    R.nav.splice(at, 0, NAV.slice());
  });

  function step(done, title, line, action) {
    return '<div class="card" style="padding:14px 16px;display:flex;gap:12px;align-items:flex-start;flex:1 1 300px;min-width:0" data-step="' + escHtml(title) + '">' +
      '<span aria-hidden="true" style="flex:none;margin-top:2px;color:' + (done ? 'var(--green)' : 'var(--amber)') + '">' + icon(done ? 'shieldCheck' : 'alert', 18) + '</span>' +
      '<div style="min-width:0;display:flex;flex-direction:column;gap:4px"><strong>' + escHtml(title) + '</strong><span class="t-cap">' + line + '</span>' +
      (action ? '<div style="margin-top:6px">' + action + '</div>' : '') + '</div></div>';
  }

  async function viewSetup(item, V) {
    V.innerHTML = '<div class="loading">Loading…</div>';
    var res;
    try { res = await tunnel('/v1/factory-setup/checklist'); } catch (e) { V.innerHTML = errBox('Can\'t connect. Try again.'); return; }
    if (stale()) return;
    if (res.status === 403) { V.innerHTML = errBox('Your role doesn\'t see the factory setup.'); return; }
    if (res.status >= 400) { V.innerHTML = errBox(err(res, 'The factory setup is not available (' + res.status + ').')); return; }
    var c = data(res) || {};
    var cat = c.catalogue || {}, packs = c.packs || {}, qc = c.qcSpecs || {}, racks = c.racks || {}, fx = c.formulas || {}, bl = c.blocked || {};
    var mode = (c.pickLight || {}).mode || 'unset';
    var canQc = can('production:product_qc_spec:write'), canRack = canRackWrite();
    // Formula setup is ws-formula-setup.js's screen (lane vaultsetup): offered where the role has it.
    var canFormulas = can('packaging:product_formula_link:read') && !!ROLES[st.role] && ROLES[st.role].nav.some(function (n) { return n[0] === 'formulasetup'; });

    var steps = [
      step(cat.products > 0, 'Catalogue from ALEMBIC',
        cat.products > 0 ? escHtml(cat.products + ' products received — ' + cat.singleChemicals + ' single chemicals, ' + cat.blends + ' blends') + (cat.lastSyncedAt ? ' · last update ' + escHtml(new Date(cat.lastSyncedAt).toLocaleString()) : '')
          : 'Nothing received yet. In ALEMBIC Admin, open Produce &amp; dispatch → Factory setup and press “Set up factory catalogue”.'),
      step(packs.needsDensity === 0, 'Pack sizes',
        escHtml(packs.ok + ' pack sizes have a weight') + (packs.needsDensity ? ' · ' + escHtml(packs.needsDensity + ' sold by volume need a density (' + packs.productsNeedingDensity + ' products)') + ' — Ruh drafts them and an admin approves them in ALEMBIC Admin.' : '.')),
      step(qc.products > 0 && qc.missing === 0 && qc.proposed === 0, 'QC specs',
        escHtml(qc.approved + ' approved · ' + qc.proposed + ' drafted, waiting for approval · ' + qc.missing + ' missing') + '. A product with no approved spec cannot get a certificate of analysis, a label or a shelf.',
        canQc && qc.missing > 0 ? btn('id="sv-draft-qc"', 'Ask Ruh to draft QC specs', 'sm p') : ''),
      step(racks.bins > 0, 'Racks',
        escHtml(racks.zones + ' zones · ' + racks.racks + ' racks · ' + racks.bins + ' bins') + (racks.proposed ? ' · a layout from Ruh is waiting below.' : '.'),
        canRack && !racks.proposed && cat.products > 0 ? btn('id="sv-draft-racks"', 'Ask Ruh for a rack layout', 'sm' + (racks.bins ? '' : ' p')) : ''),
      step(mode !== 'off' && mode !== 'unset', 'Pick-to-light', escHtml(LIGHT[mode] || mode) + (mode === 'simulator' ? '. A hardware controller can be connected later in Platform → Pick-to-light.' : '.')),
      step(true, 'Label printer', 'Nothing to set up: labels print from the browser — 100×50 mm, 100×150 mm, 62 mm continuous or an A4 sheet.'),
      step(fx.products > 0 && fx.linked === fx.products && fx.approved === fx.products, 'Formulas linked',
        escHtml(fx.linked + ' of ' + fx.products + ' products have a formula') +
          (fx.approved == null ? (fx.linked ? ' · the Vault did not say how many are approved' : '') : escHtml(' · ' + fx.approved + ' approved')) +
          '. Ruh drafts one formula per product from the catalogue\'s single chemical / blend; formulas are approved in the Vault.',
        canFormulas && fx.linked < fx.products ? btn('id="sv-open-formulas"', 'Open Formula setup', 'sm') : ''),
      step(!(bl.unknownSku || bl.noFormulaLink || bl.noApprovedFormula || bl.qtyNotInKg), 'ALEMBIC requirements blocked',
        escHtml((bl.unknownSku || 0) + ' unknown product · ' + (bl.noFormulaLink || 0) + ' no formula linked · ' + (bl.noApprovedFormula || 0) + ' no approved formula · ' + (bl.qtyNotInKg || 0) + ' quantity not in kg'))
    ];
    var stats = '<div class="stats">' + kpi('pkg', String(cat.products || 0), 'Products') + kpi('award', (qc.approved || 0) + ' / ' + (qc.products || 0), 'QC specs approved') +
      kpi('shelf', String(racks.bins || 0), 'Bins') + kpi('flask', (fx.linked || 0) + ' / ' + (fx.products || 0), 'Formulas linked') + '</div>';
    V.innerHTML = '<div class="stack-base">' + stats +
      '<div class="card"><div class="card-hd"><h2>Factory setup</h2><span class="n">what is ready, and the next thing to do</span></div>' +
      '<div class="card-bd"><div style="display:flex;flex-wrap:wrap;gap:10px">' + steps.join('') + '</div></div></div>' +
      '<div id="sv-qc"></div><div id="sv-racks"></div></div>';

    var dq = $('sv-draft-qc'); if (dq) dq.onclick = function () { draftQc(dq); };
    var of = $('sv-open-formulas'); if (of) of.onclick = function () { navTo('formulasetup'); };
    var dr = $('sv-draft-racks'); if (dr) dr.onclick = function () { draftRacks(dr); };
    if (can('production:product_qc_spec:read')) renderQc(); else $('sv-qc').innerHTML = '';
    if (can('location:rack_master:read')) renderRacks(); else $('sv-racks').innerHTML = '';
  }

  function draftQc(b) {
    b.disabled = true; b.textContent = 'Ruh is drafting…';
    tunnel('/v1/factory-setup/qc-proposals/draft', { method: 'POST', body: {} }).then(function (res) {
      if (res.status >= 400) { toast(err(res, 'Ruh could not draft. Try again.'), 'bad'); b.disabled = false; b.textContent = 'Ask Ruh to draft QC specs'; return; }
      var d = data(res) || {};
      var not = (d.notDrafted || []).length;
      toast(d.message || ((d.drafted || 0) + ' QC specs drafted' + (not ? ' · ' + not + ' could not be drafted' : '') + ' — they wait for approval below.'), not && !d.drafted ? 'bad' : 'good');
      loadView();
    }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); b.disabled = false; });
  }

  function draftRacks(b) {
    b.disabled = true;
    tunnel('/v1/factory-setup/rack-proposals/draft', { method: 'POST', body: {} }).then(function (res) {
      if (res.status >= 400) { toast(err(res, 'Ruh could not draft a layout. Try again.'), 'bad'); b.disabled = false; return; }
      toast('Ruh drafted a rack layout — check the counts below, then accept it.', 'good'); loadView();
    }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); b.disabled = false; });
  }

  /* ── QC drafts ─────────────────────────────────────────────────────────────────────── */
  var QC_FIELDS = [['sg_min', 'SG min'], ['sg_max', 'SG max'], ['flash_point_min_c', 'Flash min °C'], ['flash_point_max_c', 'Flash max °C'], ['shelf_life_months', 'Shelf life (months)'], ['colour_appearance', 'Colour / appearance'], ['odour', 'Odour']];

  async function renderQc() {
    var host = $('sv-qc'); if (!host) return;
    var res;
    try { res = await tunnel('/v1/factory-setup/qc-proposals'); } catch (e) { host.innerHTML = ''; return; }
    if (stale() || !$('sv-qc')) return;
    if (res.status >= 400) { host.innerHTML = errBox(err(res, 'QC drafts are not available (' + res.status + ').')); return; }
    var rows = data(res) || [];
    var canDecide = can('production:product_qc_spec:write');
    var body = rows.map(function (p) {
      var d = p.payload || {};
      var cells = QC_FIELDS.map(function (f) {
        var v = d[f[0]];
        if (!v) return '<td>' + muted('—') + '</td>';
        return '<td title="' + escHtml(v.evidence || '') + '"><div>' + escHtml(v.value) + '</div><div style="margin-top:3px">' + sourceChip(v.source) + '</div></td>';
      }).join('');
      return '<tr data-row="' + p.setupProposalId + '">' + (canDecide ? '<td><input type="checkbox" data-pick="' + p.setupProposalId + '" aria-label="Select ' + escHtml(p.subject) + '"></td>' : '') +
        '<td style="min-width:160px"><strong>' + escHtml(p.subject) + '</strong><div style="margin-top:4px">' + sourceChip(p.source) + '</div>' +
        '<details style="margin-top:4px"><summary class="t-cap" style="cursor:pointer">Why</summary><p class="t-cap" style="max-width:360px;white-space:normal">' + escHtml(p.evidence) + '</p></details></td>' +
        cells + (canDecide ? '<td class="r" style="white-space:nowrap">' + btn('data-approve="' + p.setupProposalId + '"', 'Approve', 'sm p') + ' ' + btn('data-reject="' + p.setupProposalId + '"', 'Reject') + '</td>' : '') + '</tr>';
    }).join('');
    host.innerHTML = '<div class="card"><div class="card-hd"><h2>QC specs drafted by Ruh</h2><span class="n">' + rows.length + ' waiting · nothing reaches a certificate or a label until it is approved</span>' +
      (canDecide && rows.length ? '<span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">' + btn('id="sv-qc-all"', 'Select all') + btn('id="sv-qc-approve"', 'Approve selected', 'sm p') + btn('id="sv-qc-reject"', 'Reject selected') + '</span>' : '') + '</div>' +
      '<div class="card-bd">' + (rows.length ? '<div style="overflow-x:auto"><table><thead><tr>' + (canDecide ? '<th></th>' : '') + '<th>Product</th>' +
        QC_FIELDS.map(function (f) { return '<th>' + f[1] + '</th>'; }).join('') + (canDecide ? '<th class="r">Decide</th>' : '') + '</tr></thead><tbody>' + body + '</tbody></table></div>'
        : '<div class="empty"><h3>No drafts waiting</h3><p>Ask Ruh to draft QC specs for the products that have none.</p></div>') + '</div></div>';
    [].forEach.call(host.querySelectorAll('[data-approve]'), function (b) { b.onclick = function () { decideQc([b.getAttribute('data-approve')], 'approve'); }; });
    [].forEach.call(host.querySelectorAll('[data-reject]'), function (b) { b.onclick = function () { decideQc([b.getAttribute('data-reject')], 'reject'); }; });
    var picked = function () { return [].map.call(host.querySelectorAll('[data-pick]:checked'), function (x) { return x.getAttribute('data-pick'); }); };
    var all = $('sv-qc-all'); if (all) all.onclick = function () { [].forEach.call(host.querySelectorAll('[data-pick]'), function (x) { x.checked = true; }); };
    var ap = $('sv-qc-approve'); if (ap) ap.onclick = function () { var ids = picked(); if (!ids.length) { toast('Tick the drafts to approve first.', 'bad'); return; } raConfirm('Approve ' + ids.length + ' QC spec' + (ids.length === 1 ? '' : 's') + '? Each becomes the product\'s spec, in your name.', function () { decideQc(ids, 'approve'); }); };
    var rj = $('sv-qc-reject'); if (rj) rj.onclick = function () { var ids = picked(); if (!ids.length) { toast('Tick the drafts to reject first.', 'bad'); return; } decideQc(ids, 'reject'); };
  }

  function decideQc(ids, decision) {
    tunnel('/v1/factory-setup/qc-proposals/decide', { method: 'POST', body: { ids: ids, decision: decision } }).then(function (res) {
      if (res.status >= 400) { toast(err(res, 'Not saved. Try again.'), 'bad'); return; }
      var d = data(res) || {}, refused = d.refused || [];
      toast((decision === 'approve' ? (d.approved || 0) + ' approved' : (d.rejected || 0) + ' rejected') + (refused.length ? ' · ' + refused.length + ' not changed: ' + refused[0].reason : ''), refused.length ? 'bad' : 'good');
      loadView();
    }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
  }

  /* ── rack layout ───────────────────────────────────────────────────────────────────── */
  async function renderRacks() {
    var host = $('sv-racks'); if (!host) return;
    var res;
    try { res = await tunnel('/v1/factory-setup/rack-proposals'); } catch (e) { host.innerHTML = ''; return; }
    if (stale() || !$('sv-racks')) return;
    if (res.status >= 400) { host.innerHTML = ''; return; }
    var p = (data(res) || [])[0];
    if (!p) { host.innerHTML = SV.printOffer ? offerPrint() : ''; wirePrint(); return; }
    var L = p.payload || { zones: [] }, canDecide = canRackWrite();
    var num = function (z, k, i, max) { return canDecide ? '<input class="fld" type="number" min="' + (k === 'racks' ? 0 : 1) + '" max="' + max + '" style="width:80px" data-z="' + i + '" data-k="' + k + '" value="' + escHtml(z[k]) + '" aria-label="' + escHtml(z.label + ' ' + k) + '">' : mono(z[k]); };
    var rows = (L.zones || []).map(function (z, i) {
      return '<tr><td>' + mono(z.zone) + '</td><td>' + escHtml(z.label) + '</td><td>' + escHtml(z.products) + '</td><td>' + escHtml(z.onHandKg) + ' kg</td>' +
        '<td>' + num(z, 'racks', i, 99) + '</td><td>' + num(z, 'shelvesPerRack', i, 30) + '</td><td>' + num(z, 'binsPerShelf', i, 50) + '</td><td data-bins="' + i + '">' + (z.racks * z.shelvesPerRack * z.binsPerShelf) + '</td></tr>';
    }).join('');
    host.innerHTML = '<div class="card"><div class="card-hd"><h2>Rack layout drafted by Ruh</h2>' + sourceChip(p.source) +
      '<span class="n">change the counts if the floor differs, then accept — the bins are built and can be labelled at once</span></div><div class="card-bd">' +
      '<p class="t-cap" style="margin:0 0 10px">' + escHtml(p.evidence) + '</p>' +
      '<div style="overflow-x:auto"><table><thead><tr><th>Zone</th><th>Family</th><th>Products</th><th>Held</th><th>Racks</th><th>Shelves / rack</th><th>Bins / shelf</th><th>Bins</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (canDecide ? '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">' + btn('id="sv-rack-accept"', 'Accept and build the racks', 'sm p') + btn('id="sv-rack-reject"', 'Reject') + '</div>' : '') + '</div></div>';
    [].forEach.call(host.querySelectorAll('[data-z]'), function (inp) {
      inp.oninput = function () {
        var z = L.zones[Number(inp.getAttribute('data-z'))]; z[inp.getAttribute('data-k')] = Math.max(0, Math.trunc(Number(inp.value) || 0));
        var cell = host.querySelector('[data-bins="' + inp.getAttribute('data-z') + '"]'); if (cell) cell.textContent = String(z.racks * z.shelvesPerRack * z.binsPerShelf);
      };
    });
    var acc = $('sv-rack-accept');
    if (acc) acc.onclick = function () {
      var bins = (L.zones || []).reduce(function (n, z) { return n + z.racks * z.shelvesPerRack * z.binsPerShelf; }, 0);
      raConfirm('Build ' + bins + ' bins on ' + (L.zones || []).reduce(function (n, z) { return n + z.racks; }, 0) + ' racks? Bins that already exist are kept as they are.', function () {
        acc.disabled = true;
        tunnel('/v1/factory-setup/rack-proposals/' + p.setupProposalId + '/decide', { method: 'POST', body: { decision: 'approve', layout: L } }).then(function (res) {
          if (res.status >= 400) { toast(err(res, 'Not built. Try again.'), 'bad'); acc.disabled = false; return; }
          var a = (data(res) || {}).applied || {};
          toast((a.created || 0) + ' bins built' + (a.existing ? ', ' + a.existing + ' were already there' : '') + '. Print their labels next.', 'good');
          SV.printOffer = true; loadView();
        }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); acc.disabled = false; });
      });
    };
    var rej = $('sv-rack-reject');
    if (rej) rej.onclick = function () {
      tunnel('/v1/factory-setup/rack-proposals/' + p.setupProposalId + '/decide', { method: 'POST', body: { decision: 'reject' } }).then(function (res) {
        if (res.status >= 400) { toast(err(res, 'Not saved. Try again.'), 'bad'); return; }
        toast('Layout rejected. Ask Ruh again, or lay racks out by hand on Rack layout.', 'good'); loadView();
      });
    };
  }

  function offerPrint() {
    return '<div class="card"><div class="card-hd"><h2>Label the shelves</h2><span class="n">so the physical bins match the screen</span></div><div class="card-bd">' +
      '<p class="t-cap">Print a QR label for every bin and stick each on its bin.</p>' + btn('id="sv-print-bins"', 'Print bin QR labels', 'sm p') + '</div></div>';
  }
  function wirePrint() {
    var pb = $('sv-print-bins');
    if (pb) pb.onclick = function () {
      tunnel('/v1/shelf/locations').then(function (res) {
        if (res.status >= 400) { toast(err(res, 'Bins are not available'), 'bad'); return; }
        if (window.RA && window.RA.printBinLabels) window.RA.printBinLabels(data(res) || []);
      });
    };
  }

  window.RA.registerViews({ __factorysetup__: viewSetup });
})();
