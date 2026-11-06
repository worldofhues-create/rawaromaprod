/* RAW AROMA — ws-floord module (lane pf-d: order intelligence and the QC review decision).
 *
 *   Stock cover   the suggested production list (plan 11, 12.9). Each row says what to make and why,
 *                 in the server's words: weighted weekly demand, trend, stock in hand / in production /
 *                 in maceration, lead time, buffer, and the planning.cover rule that sized it. When no
 *                 rule is published the whole screen says so first: every product is held, nothing is
 *                 guessed. A person approves (or dismisses with a reason) each suggestion; approval may
 *                 raise draft purchase requests for short raw stock. Orders can be flagged recurring or
 *                 excluded from the demand.
 *   QC review     batches whose third failure sent them to review (plan 12.7.4). Three outcomes: reject;
 *                 downgrade only when a target grade or product is defined; reblend only when the formula
 *                 allows it. A disabled outcome shows why. One perfumer and one vault approver, two
 *                 different people: one proposes, the other confirms. The decision goes into the batch's
 *                 genealogy.
 *
 * The formulator and the vault approver get a Factory workspace with QC review only (their recipe work
 * stays in the Vault). Uses shell.js globals (tunnel, $, toast, escHtml, can, errBox, gCard, askForm,
 * kpi, ROLES, st, loadView). The server decides every rule, option and signature.
 */
'use strict';
(function () {
  function data(res) { return res && res.json && res.json.data; }
  function err(res, fb) { return (typeof failText === 'function') ? failText(res, fb) : ((res && res.json && res.json.error && res.json.error.message) || fb); }
  function esc(v) { return escHtml(v == null ? '' : String(v)); }
  function chip(tone, text) { return '<span class="chip ' + tone + '"><i class="dot"></i>' + esc(text) + '</span>'; }
  function card(title, body, meta) { return gCard({ title: title, meta: meta || '', span: 'c12', expand: false, body: body }); }
  function stale(nav) { return st.nav !== nav; }
  function scroll(inner) { return '<div style="overflow-x:auto;max-width:100%">' + inner + '</div>'; }
  async function call(path, opts) {
    try { return await tunnel(path, opts); } catch (e) { return { status: 503, json: { error: { message: 'Can\'t connect. Nothing was saved; try again.' } } }; }
  }
  function when(v) { return v ? String(v).replace('T', ' ').slice(0, 16) : ''; }

  /* ── navigation ─────────────────────────────────────────────────────────────────────── */
  var NAV = {
    stockcover: ['stockcover', 'Stock cover', 'activity', '__stockcover__'],
    qcreview: ['qcreview', 'QC review', 'shieldCheck', '__qcreview__']
  };
  var BY_ROLE = { superadmin: ['stockcover', 'qcreview'], admin: ['stockcover', 'qcreview'], production: ['stockcover', 'qcreview'], procurement: ['stockcover'], qc: ['qcreview'] };
  Object.keys(BY_ROLE).forEach(function (role) {
    var R = ROLES[role]; if (!R) return;
    BY_ROLE[role].forEach(function (k) { if (!R.nav.some(function (n) { return n[0] === k; })) R.nav.push(NAV[k].slice()); });
  });
  // The perfumer (formulator) and the vault approver sign QC reviews here; their recipe work is the Vault's.
  var VAULT_SIGNERS = { formulator: ['Perfumer', 'Formulation'], vault_approver: ['Vault approver', 'Vault'] };
  Object.keys(VAULT_SIGNERS).forEach(function (k) {
    if (ROLES[k]) return;
    ROLES[k] = { label: VAULT_SIGNERS[k][0], dept: VAULT_SIGNERS[k][1], user: VAULT_SIGNERS[k][0], nav: [NAV.qcreview.slice(), ['tutorial', 'Tutorials', 'bookOpen', '__tutorial__']] };
  });
  if (window.RaRoutes) {
    var WS = window.RaRoutes.WORKSPACE, SL = window.RaRoutes.SLUG;
    Object.keys(VAULT_SIGNERS).forEach(function (k) { if (!WS[k]) WS[k] = k.replace('_', '-'); });
    SL.__stockcover__ = 'stock-cover'; SL.__qcreview__ = 'qc-review';
  }

  /* ── Stock cover ────────────────────────────────────────────────────────────────────── */
  var TONE = { SUGGEST: ['b', 'Suggested'], NONE: ['g', 'Covered'], HOLD: ['a', 'Held'], BLOCKED: ['r', 'Blocked'], LOCKED: ['n', 'Locked'] };

  async function viewCover(item, V) {
    V.innerHTML = '<div class="loading">Loading…</div>';
    var res = await call('/v1/planning/cover');
    if (stale('stockcover')) return;
    if (res.status >= 400) { V.innerHTML = errBox(err(res, 'Stock cover is not available.')); return; }
    var d = data(res) || { items: [], decided: [] }, ps = d.policyStatus || {}, m = d.measured || {};
    var canWrite = can('production:cover_plan:write');
    var count = function (s) { return d.items.filter(function (i) { return i.status === s; }).length; };
    var banner = ps.published
      ? card('Rules in force', '<p id="sc-policy">' + chip('g', 'planning.cover v' + ps.version) + ' ' + esc(ps.note) + '</p>')
      : '<div class="card c12" id="sc-policy" role="status" style="border:2px solid var(--amber, #b7791f);padding:var(--s-base, 16px);display:flex;flex-direction:column;gap:6px;min-width:0;overflow-wrap:anywhere">' +
        '<strong style="font-size:17px">Every product is held: no stock-cover rules yet</strong><p style="margin:0">' + esc(ps.note) + '</p>' +
        '<p class="t-cap" style="margin:0;color:var(--ink-3)">An admin publishes the planning.cover policy on the Rules screen: for example IF product is seasonal THEN cover 8 weeks, OTHERWISE dynamic.</p></div>';
    var lead = m.stationDays != null && m.qcDays != null
      ? 'Lead time measured from ' + m.samples + ' finished floor job(s): stations ' + m.stationDays + ' days, QC ' + m.qcDays + ' days, plus each formula\'s maceration days.'
      : 'Station or QC times are not measured yet: a product holds unless its rule sets defaultLeadDays.';
    // WALK2-RP-25: the rule line printed the engine's trace with its JSON value
    // ('Rule 1: sku = X → {"mode":"dynamic","defaultLeadDays":21}'); the value in words.
    function sayVal(v) {
      if (v === null || v === undefined) return 'nothing';
      if (typeof v !== 'object') return String(v);
      if (Array.isArray(v)) return v.map(sayVal).join(', ');
      return Object.keys(v).map(function (k) { return k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase() + ': ' + sayVal(v[k]); }).join(', ');
    }
    function ruleWords(x) {
      return String(x || '').replace(/(→|otherwise)\s*(\{.*\}|\[.*\])\s*$/, function (m, arrow, j) { try { return arrow + ' ' + sayVal(JSON.parse(j)); } catch (e) { return m; } });
    }
    var rows = d.items.map(function (it, i) {
      var t = TONE[it.status] || ['n', it.status];
      var act = canWrite && it.status === 'SUGGEST'
        ? '<div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" class="btn p" data-ap="' + i + '">Approve ' + it.qty + '</button><button type="button" class="btn" data-dm="' + i + '">Dismiss</button></div>' : '';
      return '<div class="glass" data-sku="' + esc(it.sku) + '" style="padding:var(--s-snug);display:flex;flex-direction:column;gap:6px">' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><strong>' + esc(it.productName || it.sku) + '</strong><span class="t-cap" style="font-family:var(--font-mono)">' + esc(it.sku) + '</span>' + chip(t[0], t[1]) +
        (it.status === 'SUGGEST' ? '<b style="margin-left:auto;font-size:18px">Make ' + it.qty + '</b>' : '') + '</div>' +
        '<p style="margin:0" data-why>' + esc(it.why) + '</p>' +
        (it.raw && it.raw.checked && it.raw.short.length ? '<p style="margin:0;color:var(--red)">' + esc(it.raw.note) + '</p>' : it.raw && it.status === 'SUGGEST' ? '<p class="t-cap" style="margin:0;color:var(--ink-3)">' + esc(it.raw.note) + '</p>' : '') +
        '<p class="t-cap" style="margin:0;color:var(--ink-3)">Rule: ' + esc(ruleWords(it.policy.explain)) + (it.policy.version ? ' (v' + it.policy.version + ')' : '') + '</p>' + act + '</div>';
    }).join('');
    var decided = (d.decided || []).length
      ? scroll('<table class="tbl" style="min-width:560px"><thead><tr><th>When</th><th>SKU</th><th>Decision</th><th>Qty</th><th>Why</th></tr></thead><tbody>' +
        d.decided.map(function (x) { return '<tr><td>' + esc(when(x.decidedDt)) + '</td><td>' + esc(x.sku) + '</td><td>' + esc(({ APPROVED: 'Approved', DISMISSED: 'Dismissed' })[x.status] || x.status) + (x.floorJobId ? ' · on the floor' : '') + '</td><td>' + esc(x.qty) + '</td><td>' + esc(x.note || x.reasoning) + '</td></tr>'; }).join('') + '</tbody></table>')
      : '<p>No suggestion approved or dismissed yet.</p>';
    V.innerHTML = '<div class="grid">' + banner +
      '<div class="stats c12">' + kpi('activity', String(count('SUGGEST')), 'Suggested') + kpi('lock', String(count('HOLD')), 'Held') + kpi('alert', String(count('BLOCKED')), 'Blocked') + kpi('shieldCheck', String(count('NONE')), 'Covered') + '</div>' +
      card('Suggested production', '<p class="t-cap" style="color:var(--ink-3)">' + esc(lead) + ' Nothing is made until a person approves it; approved suggestions join the floor queue below every customer order.</p>' +
        '<div style="display:flex;flex-direction:column;gap:var(--s-snug)" id="sc-list">' + (rows || '<p>No ALEMBIC orders in the last 26 weeks, so nothing to suggest.</p>') + '</div>') +
      (canWrite ? card('Flag an order', '<form id="sc-flag" style="display:flex;flex-wrap:wrap;gap:var(--s-snug);align-items:flex-end">' +
        '<label style="display:flex;flex-direction:column;gap:4px;min-width:160px;flex:1">Order reference<input id="sc-ref" class="fld" autocomplete="off"></label>' +
        '<label style="display:flex;flex-direction:column;gap:4px">Flag<select id="sc-fl" class="fld"><option value="RECURRING">Recurring (keep in demand)</option><option value="EXCLUDE">Exclude from demand</option></select></label>' +
        '<label style="display:flex;flex-direction:column;gap:4px;min-width:200px;flex:2">Why<input id="sc-why" class="fld"></label><button class="btn" type="submit">Save flag</button>' +
        '<div id="sc-ferr" role="alert" style="color:var(--red);width:100%"></div></form><p class="t-cap" style="color:var(--ink-3)">A one-off bulk order (over 3x the median order) is left out of demand unless flagged recurring.</p>') : '') +
      card('Decided', decided) + '</div>';
    V.querySelectorAll('[data-ap]').forEach(function (b) { b.onclick = function () { approve(d.items[Number(b.getAttribute('data-ap'))]); }; });
    V.querySelectorAll('[data-dm]').forEach(function (b) { b.onclick = function () { dismiss(d.items[Number(b.getAttribute('data-dm'))]); }; });
    var f = $('sc-flag');
    if (f) f.onsubmit = async function (e) {
      e.preventDefault();
      var r = await call('/v1/planning/cover/order-flags', { method: 'POST', body: { orderRef: $('sc-ref').value.trim(), flag: $('sc-fl').value, reason: $('sc-why').value.trim() } });
      if (r.status >= 400) { $('sc-ferr').textContent = err(r, 'The flag was not saved.'); return; }
      toast('Order ' + data(r).orderRef + ' flagged ' + data(r).flag.toLowerCase(), 'good'); loadView();
    };
  }
  function approve(it) {
    askForm({ title: 'Approve: make ' + it.qty + ' of ' + (it.productName || it.sku), submit: 'Approve', intro: it.why,
      fields: [{ n: 'qty', l: 'Units to make', t: 'number', value: String(it.qty), req: true, min: 1 }, { n: 'note', l: 'Note (needed if you change the quantity)', t: 'textarea' }],
      onSubmit: async function (v, fail, close) {
        var body = { sku: it.sku }; if (Number(v.qty) !== it.qty) body.qty = Math.round(Number(v.qty)); if (v.note) body.note = v.note;
        var r = await call('/v1/planning/cover/approve', { method: 'POST', body: body });
        if (r.status >= 400) { fail(err(r, 'Not approved.')); return; }
        var a = data(r); close();
        toast('Approved ' + a.qty + ' of ' + a.sku + (a.purchaseRequestIds.length ? '; ' + a.purchaseRequestIds.length + ' draft purchase request(s) raised for short raw stock' : ''), 'good'); loadView();
      } });
  }
  function dismiss(it) {
    askForm({ title: 'Dismiss the suggestion for ' + (it.productName || it.sku), submit: 'Dismiss', fields: [{ n: 'note', l: 'Why dismiss it?', t: 'textarea', req: true }],
      onSubmit: async function (v, fail, close) {
        var r = await call('/v1/planning/cover/dismiss', { method: 'POST', body: { sku: it.sku, note: v.note } });
        if (r.status >= 400) { fail(err(r, 'Not dismissed.')); return; }
        close(); toast('Suggestion for ' + it.sku + ' dismissed', 'good'); loadView();
      } });
  }

  /* ── QC review ──────────────────────────────────────────────────────────────────────── */
  var OUT = { REJECT: 'Reject', DOWNGRADE: 'Downgrade', REBLEND: 'Reblend' };
  function signer() { var p = can('production:qc_review:perfumer'), a = can('production:qc_review:approve'); return p && a ? 'BOTH' : p ? 'PERFUMER' : a ? 'APPROVER' : null; }

  async function viewReview(item, V) {
    V.innerHTML = '<div class="loading">Loading…</div>';
    var res = await call('/v1/qc-review');
    if (stale('qcreview')) return;
    if (res.status >= 400) { V.innerHTML = errBox(err(res, 'QC review is not available.')); return; }
    var rows = data(res) || [];
    var list = rows.length ? rows.map(function (r) {
      var s = r.decisionStatus === 'CONFIRMED' ? chip('g', 'Decided: ' + OUT[r.proposedOutcome]) : r.decisionStatus === 'PROPOSED' ? chip('a', OUT[r.proposedOutcome] + ' proposed by the ' + (r.proposedAs === 'PERFUMER' ? 'perfumer' : 'vault approver')) : chip('r', 'Waiting for a decision');
      return '<button type="button" class="glass" data-ob="' + esc(r.oilBatchId) + '" style="text-align:left;padding:var(--s-snug);display:flex;flex-direction:column;gap:4px;width:100%;min-width:0;overflow-wrap:anywhere;cursor:pointer;border:1px solid var(--line)">' + // WALK2-RP-26: the batch code was cut at narrow widths
        '<span style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><strong style="font-family:var(--font-mono)">' + esc(r.batchNumber || 'Batch without a number') + '</strong><span>' + esc(r.productName || '') + '</span>' + s + '</span>' +
        '<span class="t-cap" style="color:var(--ink-3)">In review since ' + esc(when(r.reviewSince)) + ' · round ' + esc(r.roundNo) + '</span></button>';
    }).join('') : '<p>No batch is waiting for review.</p>';
    V.innerHTML = '<div class="grid">' + card('Batches in review', '<p class="t-cap" style="color:var(--ink-3)">A batch comes here when it fails again after its last allowed rework, or past its adjustment envelope. A perfumer and a vault approver decide it together: one proposes, the other confirms.</p>' +
      '<div style="display:flex;flex-direction:column;gap:var(--s-snug)" id="qr-list">' + list + '</div>') + '<div id="qr-one" class="c12"></div></div>';
    V.querySelectorAll('[data-ob]').forEach(function (b) { b.onclick = function () { openReview(b.getAttribute('data-ob')); }; });
    if (rows.length === 1) openReview(rows[0].oilBatchId);
  }

  async function openReview(id) {
    var host = $('qr-one'); if (!host) return;
    host.innerHTML = '<div class="loading">Loading…</div>';
    var r = await call('/v1/qc-review/' + id);
    if (r.status >= 400) { host.innerHTML = errBox(err(r, 'This batch cannot be opened.')); return; }
    var d = data(r), o = d.options, dec = d.decision, me = signer();
    var hist = scroll('<table class="tbl" style="min-width:480px"><thead><tr><th>Round</th><th>Decision</th><th>Defect</th><th>Why</th></tr></thead><tbody>' +
      d.rounds.map(function (x) { return '<tr><td>' + x.roundNo + '</td><td>' + esc(x.decision) + '</td><td>' + esc(x.defectType || '') + '</td><td>' + esc((x.reasons || []).join(' ')) + '</td></tr>'; }).join('') + '</tbody></table>') +
      (d.reworks.length ? '<p class="t-cap">Reworks: ' + d.reworks.map(function (w) { return '#' + w.reworkNo + ' ' + esc(w.note); }).join(' · ') + '</p>' : '');
    var opts = ['REJECT', 'DOWNGRADE', 'REBLEND'].map(function (k) {
      var on = o[k].enabled && !dec && me && d.inReview;
      return '<div class="glass" style="padding:var(--s-snug);display:flex;flex-direction:column;gap:6px;flex:1;min-width:220px" data-opt="' + k + '">' +
        // A disabled outcome must look disabled, not like a live yellow button with small print under it.
        '<button type="button" class="btn ' + (on ? (k === 'REJECT' ? 'r' : 'p') : '') + '" data-pick="' + k + '"' + (on ? '' : ' disabled aria-disabled="true" style="opacity:.45;cursor:not-allowed;align-self:flex-start"') + (on ? ' style="align-self:flex-start"' : '') + '>' + OUT[k] + (on ? '' : ' (not available)') + '</button>' +
        '<p style="margin:0" class="t-cap" data-optwhy>' + (o[k].enabled ? '' : '<b>Not available.</b> ') + esc(o[k].why) + '</p></div>';
    }).join('');
    var decBox = '';
    if (dec) {
      var mine = session && session.user && dec.proposedBy === session.user.userId;
      var other = dec.proposedAs === 'PERFUMER' ? 'APPROVER' : 'PERFUMER';
      var mayConfirm = dec.status === 'PROPOSED' && !mine && (me === 'BOTH' || me === other);
      decBox = card(dec.status === 'CONFIRMED' ? 'Decided: ' + OUT[dec.outcome] : OUT[dec.outcome] + ' proposed',
        '<p>' + esc(dec.reason) + '</p><p class="t-cap">Proposed by the ' + (dec.proposedAs === 'PERFUMER' ? 'perfumer' : 'vault approver') + ' at ' + esc(when(dec.proposedDt)) +
        (dec.status === 'CONFIRMED' ? '; confirmed by the ' + (dec.confirmedAs === 'PERFUMER' ? 'perfumer' : 'vault approver') + ' at ' + esc(when(dec.confirmedDt)) + '. Recorded in the batch genealogy.' + (dec.capaId ? ' CAPA opened.' : '') : '') + '</p>' +
        (dec.reblendShareBps ? '<p class="t-cap">Reblend share: ' + (dec.reblendShareBps / 100) + '%' + (dec.reblendIntoOilBatchId ? ' into batch ' + esc(dec.reblendIntoOilBatchId) : '') + '</p>' : '') +
        (dec.status === 'PROPOSED' ? '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          (mayConfirm ? '<button type="button" class="btn p" id="qr-confirm">Confirm as ' + (other === 'APPROVER' ? 'vault approver' : 'perfumer') + '</button>' : '<p class="t-cap" style="margin:0">' + (mine ? 'You proposed this: a different person with the other signature confirms it.' : 'Waiting for the ' + (other === 'APPROVER' ? 'vault approver' : 'perfumer') + ' to confirm.') + '</p>') +
          (mine ? '<button type="button" class="btn" id="qr-withdraw">Withdraw</button>' : '') + '</div>' : ''));
    }
    var setup = can('production:qc_review_setup:write') && d.inReview && !dec ? card('Define what review may choose', '<p class="t-cap" style="color:var(--ink-3)">Defined ahead of a failure for the product or formula, never invented for one batch.</p>' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px">' + (d.product.productId ? '<button type="button" class="btn" id="qr-dg">Downgrade target for ' + esc(d.product.productName || 'this product') + '</button>' : '') +
      (d.product.formulaId ? '<button type="button" class="btn" id="qr-rb">Reblend rule for its formula</button>' : '') + '</div>') : '';
    host.innerHTML = '<div class="grid">' + card('Batch ' + esc(d.batch.batchNumber || d.batch.oilBatchId) + (d.product.productName ? ' · ' + esc(d.product.productName) : ''),
      (d.hold ? '<p>' + chip('r', 'On hold') + ' ' + esc(d.hold.reason) + '</p>' : '') + hist) +
      (dec ? decBox : card('Decide', (me ? '' : '<p>You can read this review; a perfumer or a vault approver decides it.</p>') + '<div style="display:flex;flex-wrap:wrap;gap:var(--s-snug)" id="qr-opts">' + opts + '</div>')) + setup + '</div>';
    host.querySelectorAll('[data-pick]').forEach(function (b) { b.onclick = function () { if (!b.disabled) propose(id, b.getAttribute('data-pick'), d); }; });
    var c = $('qr-confirm'); if (c) c.onclick = function () { confirmIt(id, dec); };
    var w = $('qr-withdraw'); if (w) w.onclick = function () {
      askForm({ title: 'Withdraw the proposal', submit: 'Withdraw', fields: [{ n: 'reason', l: 'Why withdraw it?', t: 'textarea', req: true }], onSubmit: async function (v, fail, close) {
        var x = await call('/v1/qc-review/' + id + '/withdraw', { method: 'POST', body: { reason: v.reason } });
        if (x.status >= 400) { fail(err(x, 'Not withdrawn.')); return; } close(); toast('Proposal withdrawn', 'good'); openReview(id);
      } });
    };
    var dg = $('qr-dg'); if (dg) dg.onclick = function () {
      askForm({ title: 'Downgrade target', submit: 'Save', intro: 'The grade (or another product) a failed batch of this product may be sold as.', fields: [{ n: 'targetGrade', l: 'Grade', req: true }, { n: 'reason', l: 'Why this path exists', t: 'textarea', req: true }],
        onSubmit: async function (v, fail, close) {
          var x = await call('/v1/qc-review/downgrade-targets/' + d.product.productId, { method: 'PUT', body: { targetGrade: v.targetGrade, reason: v.reason } });
          if (x.status >= 400) { fail(err(x, 'Not saved.')); return; } close(); toast('Downgrade target saved: ' + v.targetGrade, 'good'); openReview(id);
        } });
    };
    var rb = $('qr-rb'); if (rb) rb.onclick = function () {
      askForm({ title: 'Reblend rule for the formula', submit: 'Save', intro: 'Whether a failed batch of this formula may be folded into another batch of it, and the most it may make up.', fields: [{ n: 'pct', l: 'Most share of the receiving batch (%), empty = not allowed', t: 'number' }, { n: 'reason', l: 'Why', t: 'textarea', req: true }],
        onSubmit: async function (v, fail, close) {
          var allowed = v.pct !== '' && v.pct != null;
          var x = await call('/v1/qc-review/reblend-rules/' + d.product.formulaId, { method: 'PUT', body: { reblendAllowed: allowed, maxSharePct: allowed ? Number(v.pct) : undefined, reason: v.reason } });
          if (x.status >= 400) { fail(err(x, 'Not saved.')); return; } close(); toast(allowed ? 'Reblend allowed up to ' + v.pct + '%' : 'Reblend not allowed for this formula', 'good'); openReview(id);
        } });
    };
  }

  function propose(id, k, d) {
    var fields = [{ n: 'reason', l: 'Why ' + OUT[k].toLowerCase() + '?', t: 'textarea', req: true }];
    if (k === 'REBLEND') fields.push({ n: 'share', l: 'Share of the receiving batch (%)', t: 'number', req: true }, { n: 'into', l: 'Receiving batch id (optional)' });
    if (signer() === 'BOTH') fields.push({ n: 'signAs', l: 'Sign as PERFUMER or APPROVER', value: 'PERFUMER', req: true });
    askForm({ title: OUT[k] + ' batch ' + (d.batch.batchNumber || ''), submit: 'Propose ' + OUT[k].toLowerCase(), tone: k === 'REJECT' ? 'bad' : '', intro: d.options[k].why + ' The other signature confirms it.', fields: fields,
      onSubmit: async function (v, fail, close) {
        var body = { outcome: k, reason: v.reason };
        if (k === 'REBLEND') { body.reblendShareBps = Math.round(Number(v.share) * 100); if (v.into) body.reblendIntoOilBatchId = v.into; }
        if (v.signAs) body.signAs = String(v.signAs).toUpperCase();
        var r = await call('/v1/qc-review/' + id + '/propose', { method: 'POST', body: body });
        if (r.status >= 400) { fail(err(r, 'Not proposed.')); return; }
        close(); toast(OUT[k] + ' proposed. ' + data(r).next, 'good'); openReview(id);
      } });
  }
  function confirmIt(id, dec) {
    var both = signer() === 'BOTH';
    askForm({ title: 'Confirm: ' + OUT[dec.outcome], submit: 'Confirm', tone: dec.outcome === 'REJECT' ? 'bad' : '', intro: dec.reason + ' Confirming makes it final and records it in the batch genealogy.',
      fields: both ? [{ n: 'signAs', l: 'Sign as PERFUMER or APPROVER', value: dec.proposedAs === 'PERFUMER' ? 'APPROVER' : 'PERFUMER', req: true }] : [],
      onSubmit: async function (v, fail, close) {
        var r = await call('/v1/qc-review/' + id + '/confirm', { method: 'POST', body: v.signAs ? { signAs: String(v.signAs).toUpperCase() } : {} });
        if (r.status >= 400) { fail(err(r, 'Not confirmed.')); return; }
        close(); toast('Decided: ' + OUT[dec.outcome] + (data(r).capaId ? '; CAPA opened' : ''), 'good'); openReview(id);
      } });
  }

  window.RA.registerViews({ __stockcover__: viewCover, __qcreview__: viewReview });
})();
