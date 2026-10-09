/* RAW AROMA — ws-formula-setup module (lane vaultsetup; owner decisions 2026-10-05: products are
 * MOSTLY BLENDED IN-HOUSE; "Ruh drafts, one person approves"; formula content never leaves the
 * Vault and never passes through an AI model).
 *
 *   Formula setup   (owner, admin, production, packaging)
 *     · "Let Ruh draft formulas" — the two owner clicks that give the Ruh (automation) service
 *       principal the formulator role through the ordinary two-person Vault-role grant: one owner
 *       requests, a DIFFERENT owner approves. Shows the pending request and who may approve it.
 *     · Products and their formulas — which products have no formula, which wait for approval,
 *       which are production-ready; choose single chemical / blend per product (pre-filled from the
 *       catalogue's classification when it has one) and "Draft formula shells": Ruh drafts one
 *       Vault formula per product (a single chemical sealed at 100 % of its own material and sent
 *       for approval; a blend left as "recipe needed" for the Vault), each product linked to it.
 *     · Link formula… — set or replace one product's formula (audited, a reason is required).
 *   Also adds "Link formula" to the Products table's row actions.
 *
 * Everything shown comes from the server; this box sees formula CODES and states only — never a
 * name, a material list or an amount. Plain classic script after ws-produce.js; uses shell.js's
 * globals (tunnel, $, toast, escHtml, can, kpi, icon, openSheet, raConfirm, fLabel, ROLES, ACTIONS,
 * session, st, loadView, errBox). The server re-checks every permission.
 */
'use strict';
(function () {
  var FS = {};

  function data(res) { return res && res.json && res.json.data; }
  function err(res, fallback) { return (res && res.json && res.json.error && res.json.error.message) || fallback; }
  function mono(v) { return '<span style="font-family:var(--font-mono);font-size:var(--t-cap);font-weight:var(--w-med)">' + escHtml(v) + '</span>'; }
  function muted(v) { return '<span style="color:var(--ink-3)">' + escHtml(v) + '</span>'; }
  function chip(tone, text) { return '<span class="chip ' + tone + '"><i class="dot"></i>' + escHtml(text) + '</span>'; }
  function day(v) { return v ? String(v).slice(0, 10) : ''; }
  function who(p) { return p ? (p.userName || p.email || String(p.userId).slice(0, 8)) : 'someone'; }

  /* ── navigation ─────────────────────────────────────────────────────────────────────── */
  var NAV = ['formulasetup', 'Formula setup', 'beaker', '__formulasetup__'];
  ['superadmin', 'admin', 'production', 'packaging'].forEach(function (role) {
    var R = ROLES[role]; if (!R || R.nav.some(function (n) { return n[0] === NAV[0]; })) return;
    R.nav.push(NAV.slice());
  });

  /* ── the screen ─────────────────────────────────────────────────────────────────────── */
  async function viewFormulaSetup(item, V) {
    V.innerHTML = '<div class="loading">Loading…</div>';
    var showRuh = can('iam:user_role_mapping:read');
    var showProducts = can('packaging:product_formula_link:read');
    var parts = [];
    try {
      parts = await Promise.all([
        showRuh ? tunnel('/v1/service-principals/ruh') : Promise.resolve(null),
        showProducts ? tunnel('/v1/formula-setup/products') : Promise.resolve(null),
      ]);
    } catch (e) { V.innerHTML = errBox('Can\'t connect. Try again.'); return; }
    if (st.nav !== 'formulasetup') return;
    var html = '';
    if (parts[0]) html += ruhCard(parts[0]);
    if (parts[1]) html += productsCard(parts[1]);
    if (!html) html = errBox('Your role has nothing to set up here.');
    V.innerHTML = html;
    wire(V);
  }

  function ruhCard(res) {
    if (res.status >= 400) return '<div class="card"><div class="card-hd"><h2>Let Ruh draft formulas</h2></div><div class="card-bd">' + errBox(err(res, 'Not available (' + res.status + ').')) + '</div></div>';
    var s = data(res) || {}, f = s.formulator || { state: 'none' }, you = s.you || {};
    var state, action = '';
    if (f.state === 'active') {
      state = chip('g', 'Ruh can draft formulas');
    } else if (f.state === 'pending') {
      state = chip('a', 'Waiting for a second owner') +
        '<p style="margin:10px 0 0">Requested by <b>' + escHtml(who(f.requestedBy)) + '</b> on ' + escHtml(day(f.requestedDt)) + '; expires ' + escHtml(day(f.expiresDt)) + ' if nobody approves.</p>' +
        '<p style="margin:6px 0 0">Can approve: ' + ((f.approvers || []).length ? f.approvers.map(function (a) { return '<b>' + escHtml(who(a)) + '</b>'; }).join(', ') : muted('nobody yet — add a second, independent owner or admin')) + '</p>';
      if (you.canApprove) action = '<button type="button" class="btn p" id="fs-ruh-approve" data-req="' + escHtml(f.requestId) + '">Approve — let Ruh draft formulas</button>';
    } else {
      state = chip('n', 'Not set up');
      if (you.canRequest) action = '<button type="button" class="btn p" id="fs-ruh-request">Let Ruh draft formulas</button>';
    }
    return '<div class="card" data-testid="ruh-card"><div class="card-hd"><h2>Let Ruh draft formulas</h2><span class="chip k">Two owners</span></div><div class="card-bd">' +
      '<p style="margin:0 0 10px;color:var(--ink-2)">Ruh (automation) drafts a Vault formula for every product. It never signs in, never sees anything but what it drafts, and can never approve: one person approves each formula in the Vault.</p>' +
      '<ol style="margin:0 0 12px;padding-left:20px;color:var(--ink-2)"><li><b>Owner 1</b> clicks <i>Let Ruh draft formulas</i>.</li><li><b>A different owner</b> opens this screen and clicks <i>Approve</i>.</li></ol>' +
      state + (you.note ? '<p class="t-cap" style="margin:8px 0 0">' + escHtml(you.note) + '</p>' : '') +
      (action ? '<div style="margin-top:12px">' + action + '</div>' : '') + '</div></div>';
  }

  var STATE = { none: ['r', 'No formula'], linked: ['a', 'Waiting for approval'], approved: ['g', 'Approved'] };

  function productsCard(res) {
    if (res.status >= 400) return '<div class="card"><div class="card-hd"><h2>Products and their formulas</h2></div><div class="card-bd">' + errBox(err(res, 'Not available (' + res.status + ').')) + '</div></div>';
    var d = data(res) || { items: [] }, items = d.items || [];
    FS.products = {}; items.forEach(function (p) { FS.products[p.productId] = p; });
    var canWrite = can('packaging:product_formula_link:write');
    var counts = { none: 0, linked: 0, approved: 0 };
    items.forEach(function (p) { counts[p.state] = (counts[p.state] || 0) + 1; });
    var stats = '<div class="stats">' + kpi('box', String(items.length), 'Products') + kpi('alert', String(counts.none), 'No formula') +
      kpi('history', String(counts.linked), 'Waiting for approval') + kpi('shieldCheck', String(counts.approved), 'Production-ready') + '</div>';
    var rows = items.map(function (p) {
      var sg = STATE[p.state] || ['n', p.state];
      var kind = p.catalogueKind || 'blend';
      var pick = (canWrite && p.state === 'none')
        ? '<input type="checkbox" class="fs-pick" data-id="' + p.productId + '" aria-label="Draft a formula for ' + escHtml(p.productCode) + '" checked>'
        : '';
      var kindCell = (canWrite && p.state === 'none')
        ? '<select class="fld fs-kind" data-id="' + p.productId + '" aria-label="Kind of ' + escHtml(p.productCode) + '">' +
            '<option value="blend"' + (kind === 'blend' ? ' selected' : '') + '>Blend</option>' +
            '<option value="single_chemical"' + (kind === 'single_chemical' ? ' selected' : '') + '>Single chemical</option></select>' +
            (p.catalogueKind ? '<div class="t-cap"' + (p.catalogueBasis ? ' title="' + escHtml(p.catalogueBasis) + '"' : '') + '>from the catalogue</div>' : '')
        : muted(p.catalogueKind === 'single_chemical' ? 'Single chemical' : p.catalogueKind === 'blend' ? 'Blend' : '—');
      // Without masterdata:material:reveal the server says only THAT the material was found (masked).
      var matCell = !p.material ? muted('no material with this code')
        : p.material.materialCode || p.material.materialName ? mono(p.material.materialCode || '') + (p.material.materialName ? '<div class="t-cap">' + escHtml(p.material.materialName) + '</div>' : '')
        : chip('n', p.material.aliasName ? 'found · ' + p.material.aliasName : 'found');
      var formulaCell = p.formula && p.formula.formulaCode
        ? '<span title="Formula code only — the recipe stays in the Vault">' + icon('lock', 12) + ' ' + mono(p.formula.formulaCode + (p.formula.approvedVersionNumber != null ? ' v' + p.formula.approvedVersionNumber : '')) + '</span>'
        : (p.formulaId ? muted('(Vault did not answer)') : muted('—'));
      var link = canWrite ? '<button type="button" class="btn sm" data-link="' + p.productId + '">' + (p.formulaId ? 'Replace formula…' : 'Link formula…') + '</button>' : '';
      return '<tr data-ruh-id="' + escHtml(p.productId) + '"><td>' + pick + '</td><td>' + mono(p.productCode || '') + '<div class="t-cap">' + escHtml(p.productName || '') + '</div></td>' +
        '<td>' + mono((p.skuCodes || []).join(', ')) + '</td><td>' + chip(sg[0], sg[1]) + '</td><td>' + formulaCell + '</td>' +
        '<td>' + kindCell + '</td><td>' + matCell + '</td><td class="r">' + (link || muted('—')) + '</td></tr>';
    }).join('');
    var note = d.vaultError ? '<p class="t-cap" style="color:var(--amber);margin:0 0 var(--s-tight)">The Vault did not answer; formula codes are hidden until it does.</p>' : '';
    var draft = canWrite && counts.none ? '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 12px">' +
      '<button type="button" class="btn p" id="fs-draft">Draft formula shells</button>' +
      '<span class="t-cap">For each ticked product Ruh drafts one formula in the Vault. A single chemical is sealed at 100 % of its own material and sent for approval; a blend waits for its recipe in the Vault (“Recipes needed”).</span></div>' : '';
    return stats + '<div class="card" data-testid="formula-products"><div class="card-hd"><h2>Products and their formulas</h2><span class="chip k">Formula codes only</span>' +
      '<span class="n">' + items.length + ' product(s)</span></div><div class="card-bd">' + note + draft +
      (rows ? '<div style="overflow-x:auto"><table><thead><tr><th></th><th>Product</th><th>SKUs</th><th>State</th><th>Formula</th><th>Kind</th><th>Own material</th><th class="r">Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="empty"><h3>No products yet</h3><p>Products arrive from the ALEMBIC catalogue (or are created under Products).</p></div>') + '</div></div>';
  }

  function wire(V) {
    var req = $('fs-ruh-request');
    if (req) req.onclick = function () {
      raConfirm('Ask for Ruh (automation) to get the formulator role? A different owner or admin must approve it before Ruh can draft anything.', function () {
        req.disabled = true;
        tunnel('/v1/service-principals/ruh/formulator-request', { method: 'POST', body: {} }).then(function (res) {
          if (res.status >= 400) { req.disabled = false; toast(err(res, 'Could not ask. Try again.'), 'bad'); return; }
          toast('Requested — now a second owner approves it here', 'good'); loadView();
        }).catch(function () { req.disabled = false; toast('Can\'t connect. Try again.', 'bad'); });
      }, { title: 'Let Ruh draft formulas', confirmLabel: 'Ask', tone: 'accent' });
    };
    var ap = $('fs-ruh-approve');
    if (ap) ap.onclick = function () {
      raConfirm('Approve: Ruh (automation) may draft and seal formulas in the Vault. It can never approve one.', function () {
        ap.disabled = true;
        tunnel('/v1/vault-role-grant-requests/' + ap.getAttribute('data-req') + '/approve', { method: 'POST', body: {} }).then(function (res) {
          if (res.status >= 400) { ap.disabled = false; toast(err(res, 'Could not approve. Try again.'), 'bad'); return; }
          toast('Approved — Ruh can draft formulas', 'good'); loadView();
        }).catch(function () { ap.disabled = false; toast('Can\'t connect. Try again.', 'bad'); });
      }, { title: 'Approve Ruh', confirmLabel: 'Approve', tone: 'good' });
    };
    var dr = $('fs-draft');
    if (dr) dr.onclick = function () { draftShells(V, dr); };
    [].forEach.call(V.querySelectorAll('[data-link]'), function (b) {
      b.onclick = function () { openLinkFormula(FS.products[b.getAttribute('data-link')]); };
    });
  }

  function draftShells(V, btn) {
    var picks = [].filter.call(V.querySelectorAll('.fs-pick'), function (c) { return c.checked; }).map(function (c) {
      var id = c.getAttribute('data-id');
      var sel = V.querySelector('.fs-kind[data-id="' + id + '"]');
      var p = FS.products[id] || {};
      var body = { productId: id, kind: sel ? sel.value : 'blend' };
      if (body.kind === 'single_chemical' && p.material && p.material.materialId) body.materialId = p.material.materialId;
      // The owner changed a catalogue blend to a single chemical on this screen: say so explicitly
      // (the server refuses to seal a catalogue blend otherwise).
      if (body.kind === 'single_chemical' && p.catalogueKind === 'blend') body.overrideCatalogue = true;
      return body;
    });
    if (!picks.length) { toast('Tick at least one product.', 'bad'); return; }
    var singles = picks.filter(function (p) { return p.kind === 'single_chemical'; }).length;
    var overrides = picks.filter(function (p) { return p.overrideCatalogue; }).length;
    raConfirm('Ruh drafts ' + picks.length + ' formula(s): ' + singles + ' single chemical(s) sealed at 100 % and sent for approval, ' + (picks.length - singles) + ' blend(s) waiting for a recipe in the Vault.' +
      (overrides ? ' ' + overrides + ' of the single chemicals are blends in the ALEMBIC catalogue — you are overriding it.' : ''), function () {
      btn.disabled = true; btn.textContent = 'Drafting…';
      tunnel('/v1/formula-setup/shells', { method: 'POST', body: { products: picks } }).then(function (res) {
        btn.disabled = false; btn.textContent = 'Draft formula shells';
        if (res.status >= 400) { toast(err(res, 'Could not draft. Try again.'), 'bad'); return; }
        var out = (data(res) || {}).results || [];
        var ok = out.filter(function (r) { return r.outcome === 'created' || r.outcome === 'existing'; }).length;
        var bad = out.filter(function (r) { return r.outcome === 'error'; });
        toast(ok + ' product(s) now have a formula' + (bad.length ? ' · ' + bad.length + ' need attention' : ''), bad.length ? 'bad' : 'good');
        if (bad.length) {
          openSheet({ tag: 'div', title: 'Some products need attention', cls: 'xp-wide', body: '<div style="overflow-x:auto"><table><thead><tr><th>Product</th><th>Why</th></tr></thead><tbody>' +
            bad.map(function (r) { return '<tr><td>' + mono(r.productCode || r.productId) + '</td><td>' + escHtml(r.error || '') + '</td></tr>'; }).join('') + '</tbody></table></div>' });
        }
        loadView();
      }).catch(function () { btn.disabled = false; btn.textContent = 'Draft formula shells'; toast('Can\'t connect. Try again.', 'bad'); });
    }, { title: 'Draft formula shells', confirmLabel: 'Draft', tone: 'accent' });
  }

  /** Set or replace one product's formula (audited; the server checks the formula exists). */
  function openLinkFormula(p) {
    if (!p) return;
    var m = openSheet({ id: 'fs-link', tag: 'form', style: 'max-width:440px', title: p.formulaId ? 'Replace formula' : 'Link formula',
      meta: escHtml(p.productCode || '') + (p.productName ? ' · ' + escHtml(p.productName) : ''),
      body: '<label style="display:flex;flex-direction:column;gap:5px">' + fLabel('Formula', true) + '<select id="fs-link-f" class="fld"><option value="">Loading…</option></select></label>' +
        '<label style="display:flex;flex-direction:column;gap:5px">' + fLabel('Why', true) + '<input id="fs-link-why" class="fld" maxlength="500" placeholder="e.g. reformulated blend approved"></label>' +
        '<div id="fs-link-err" role="alert" style="min-height:16px;font:var(--w-med) var(--t-cap)/var(--lh-cap) var(--font-ui);color:var(--red)"></div>' +
        '<button type="submit" id="fs-link-save" class="btn p" style="width:100%;justify-content:center">Save</button>' });
    tunnel('/v1/formulas?limit=500').then(function (res) {
      var sel = $('fs-link-f'); if (!sel) return;
      if (res.status >= 400) { sel.innerHTML = '<option value="">' + escHtml(err(res, 'The formula list is not available')) + '</option>'; return; }
      var list = data(res) || [];
      sel.innerHTML = '<option value="">Select…</option>' + list.map(function (f) {
        var tag = f.approvedVersion ? ' · approved v' + f.approvedVersion.versionNumber : (f.latestVersionStatus ? ' · v' + f.latestVersionNumber + ' ' + String(f.latestVersionStatus).toLowerCase() : '');
        return '<option value="' + escHtml(f.formulaId) + '"' + (f.formulaId === p.formulaId ? ' selected' : '') + '>' + escHtml((f.formulaCode || f.formulaId) + tag) + '</option>';
      }).join('');
    }).catch(function () {});
    m.sheet.onsubmit = function (e) {
      e.preventDefault();
      var fid = $('fs-link-f').value, why = $('fs-link-why').value.trim();
      if (!fid) { $('fs-link-err').textContent = 'Pick a formula.'; return; }
      if (why.length < 3) { $('fs-link-err').textContent = 'Say why (at least 3 characters).'; return; }
      var save = $('fs-link-save'); save.disabled = true;
      tunnel('/v1/products/' + p.productId + '/formula-link', { method: 'POST', body: { formulaId: fid, reason: why } }).then(function (res) {
        if (res.status >= 400) { save.disabled = false; $('fs-link-err').textContent = err(res, 'That did not go through. Try again.'); return; }
        m.close(); toast((data(res) || {}).changed ? 'Formula linked' : 'No change', 'good'); loadView();
      }).catch(function () { save.disabled = false; $('fs-link-err').textContent = 'Can\'t connect. Try again.'; });
    };
  }

  // The Products table gets the same guarded action.
  ACTIONS['/v1/products'] = (ACTIONS['/v1/products'] || []).concat([
    { label: 'Link formula', perm: 'packaging:product_formula_link:write', when: function () { return true; },
      run: function (r) { openLinkFormula({ productId: r.productId, productCode: r.productCode, productName: r.productName, formulaId: r.formulaId }); } }
  ]);

  window.RA.registerViews({ __formulasetup__: viewFormulaSetup });
})();
