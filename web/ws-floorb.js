/* RAW AROMA — ws-floorb module (PROD-B, production floor plan phase P2).
 *
 *   Receiving audit   the material audit kiosk per PO line: tick each check or give a reason, weigh
 *                     what arrived and what is damaged; the server applies the receiving.shortfall
 *                     rule (shown before you start), writes the GRN and any debit note.
 *   Supplier payments 12.8 request -> approve -> release with UTR; who may do which step is the
 *                     server's maker-checker, this screen only shows the buttons.
 *   QC checkpoints    the product's checkpoint list; saving publishes a new version, old batches
 *                     keep theirs.
 *   Batch QC          one round on every checkpoint of the batch's pinned version, the decision from
 *                     the server's table, and the rework record that unlocks the full re-QC.
 *   Lot hold & recall active holds, hold a lot, and from a raw lot every batch and shipped order.
 *   Raw-lot label     printed at putaway from Lot hold & recall or after a receiving audit.
 *
 * Weights are typed in grams and sent as integer mg (RaWeight from web/weight.js when present).
 * Uses shell.js globals (tunnel, $, toast, escHtml, can, errBox, gCard, ROLES, st, failText) and
 * qrcode.js. Nothing here decides a rule or a permission; the server re-checks every call.
 */
'use strict';
(function () {
  function data(res) { return res && res.json && res.json.data; }
  function err(res, fb) { return (typeof failText === 'function') ? failText(res, fb) : ((res && res.json && res.json.error && res.json.error.message) || fb); }
  function esc(v) { return escHtml(v == null ? '' : String(v)); }
  function lbl(t) { return '<span style="font:var(--w-med) var(--t-cap)/1 var(--font-ui);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)">' + t + '</span>'; }
  function chip(tone, text) { return '<span class="chip ' + tone + '"><i class="dot"></i>' + esc(text) + '</span>'; }
  function field(label, inner) { return '<label style="display:flex;flex-direction:column;gap:5px;min-width:0">' + lbl(label) + inner + '</label>'; }
  function row(inner) { return '<div style="display:flex;flex-wrap:wrap;gap:var(--s-snug);align-items:flex-end">' + inner + '</div>'; }
  function inr(p) { var n = Number(p) / 100; return isFinite(n) ? '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }
  function card(title, body, meta) { return gCard({ title: title, meta: meta || '', span: 'c12', expand: false, body: body }); }
  function stale(nav) { return st.nav !== nav; }
  function mg(base, unit) {
    if (unit === 'unit') return String(base) + ' units';
    var n = Number(base);
    if (window.RaWeight && RaWeight.formatWeight) { try { return RaWeight.formatWeight(n); } catch (e) { /* fall through */ } }
    return (n / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 }) + ' g';
  }
  /** grams typed -> integer mg; null when not a weight. */
  function toMg(v) {
    var s = String(v == null ? '' : v).trim(); if (!s) return 0;
    if (window.RaWeight && RaWeight.parseToMg) { try { var r = RaWeight.parseToMg(s, 'g'); if (r != null && typeof r === 'object' && 'mg' in r) return r.mg; if (typeof r === 'number') return r; } catch (e) { return null; } }
    var n = Number(s); return isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
  }
  /** One reason, asked in the console's own sheet (never the browser's prompt). */
  function askReason(title, label, submit, send) {
    askForm({ title: title, submit: submit, fields: [{ n: 'reason', l: label, t: 'textarea', req: true }],
      onSubmit: function (v, fail, close) {
        send(String(v.reason || '').trim()).then(function (r) { if (r.status >= 400) { fail(err(r, 'That did not go through. Try again.')); return; } close(); })
          .catch(function () { fail('Can\'t connect. Try again.'); });
      } });
  }
  /** Every page of a list (WALK2-RP-4: one page of 100 hid every older PO and batch from the pickers,
   *  and a refused or unreachable list read as "nothing open"). The array carries `.failed` when a
   *  page did not load, and pick() says so under the picker. */
  async function getRows(path) {
    var out = [], cursor = null, n = 0;
    do {
      var r; try { r = await tunnel(path + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')); } catch (e) { out.failed = 'Can\'t connect, so this list may be incomplete. Reload to try again.'; return out; }
      if (!r || r.status >= 400) { out.failed = err(r, 'This list did not load.') + (out.length ? ' It may be incomplete.' : ''); return out; }
      var d = data(r); out = out.concat((d && (d.items || d)) || []);
      cursor = r.json && r.json.meta && r.json.meta.cursor;
    } while (cursor && ++n < 100);
    return out;
  }
  function pick(id, rows, val, text, placeholder) {
    return '<select id="' + id + '" class="fld"' + (rows.failed ? ' aria-invalid="true" aria-describedby="' + id + '-err"' : '') + '><option value="">' + esc(placeholder) + '</option>' +
      rows.map(function (r) { return '<option value="' + esc(r[val]) + '">' + esc(text(r)) + '</option>'; }).join('') + '</select>' +
      (rows.failed ? '<span id="' + id + '-err" role="alert" style="color:var(--bad,#b3261e);font:var(--w-reg) var(--t-cap)/1.3 var(--font-ui)">' + esc(rows.failed) + '</span>' : '');
  }

  /* ── navigation ─────────────────────────────────────────────────────────────────────── */
  var NAV = {
    recvaudit: ['recvaudit', 'Receiving audit', 'boxIn', '__recvaudit__'],
    payrelease: ['payrelease', 'Supplier payments', 'zap', '__payrelease__'],
    qccheckpoints: ['qccheckpoints', 'QC checkpoints', 'layout', '__qccheckpoints__'],
    qcgate: ['qcgate', 'Batch QC', 'zap', '__qcgate__'],
    lotrecall: ['lotrecall', 'Lot hold & recall', 'monitor', '__lotrecall__']
  };
  var BY_ROLE = {
    superadmin: ['recvaudit', 'payrelease', 'qccheckpoints', 'qcgate', 'lotrecall'],
    receiving: ['recvaudit'],
    procurement: ['payrelease'],
    finance: ['payrelease'],
    qc: ['qcgate', 'qccheckpoints', 'lotrecall'],
    warehouse: ['lotrecall']
  };
  Object.keys(BY_ROLE).forEach(function (role) {
    var R = ROLES[role]; if (!R) return;
    var at = R.nav.length && R.nav[0][0] === 'dashboard' ? 1 : 0;
    BY_ROLE[role].forEach(function (k, i) {
      if (R.nav.some(function (n) { return n[0] === k; })) return;
      R.nav.splice(at + i, 0, NAV[k].slice());
    });
  });

  /* ── Receiving audit ────────────────────────────────────────────────────────────────── */
  var CHECKS = [['countWeight', 'Count / weight'], ['sealIntact', 'Seal intact'], ['labelMatches', 'Label matches'], ['coaPresent', 'COA present'], ['expiryOk', 'Expiry OK'], ['noDamage', 'No damage']];
  var DEC = { ACCEPT: ['g', 'Accept'], ACCEPT_SHORT: ['a', 'Accept, short'], PENDING_BALANCE: ['n', 'Balance to come'], REJECT_LINE: ['r', 'Reject line'], EXCESS_HELD: ['a', 'Excess held'] };

  async function viewRecv(item, V) {
    V.innerHTML = '<div class="loading">Loading…</div>';
    var pos = (await getRows('/v1/purchase-orders?limit=100')).filter(function (p) { return /APPROVED|ISSUED|ACKNOWLEDGED|PARTIALLY_RECEIVED/i.test(p.status || ''); });
    if (stale('recvaudit')) return;
    V.innerHTML = '<div class="grid">' + card('Which delivery?', row(field('Purchase order', pick('fb-po', pos, 'purchaseOrderId', function (p) { return (p.poNumber || p.purchaseOrderId) + ' · ' + (p.status || ''); }, 'Choose an open PO…'))) +
      '<p class="t-cap" style="margin-top:8px;color:var(--ink-3)">A truck with no PO, a closed PO or the wrong vendor is held at the gate and cannot be audited until purchase resolves it.</p>') +
      '<div id="fb-recv" class="c12"></div></div>';
    $('fb-po').onchange = function () { if (this.value) loadPo(this.value); else $('fb-recv').innerHTML = ''; };
  }

  async function loadPo(poId) {
    var host = $('fb-recv'); host.innerHTML = '<div class="loading">Loading…</div>';
    var res; try { res = await tunnel('/v1/prodfloor/receiving/po/' + poId); } catch (e) { host.innerHTML = errBox('Can\'t connect. Try again.'); return; }
    if (res.status >= 400) { host.innerHTML = errBox(err(res, 'This PO cannot be audited right now.')); return; }
    var d = data(res), rule = d.rule;
    var gates = d.gateEntries.filter(function (g) { return !g.audited; });
    var held = gates.filter(function (g) { return String(g.status).toUpperCase() === 'HELD'; });
    var open = gates.filter(function (g) { return String(g.status).toUpperCase() !== 'HELD'; });
    var ruleText = 'Measured on ' + (rule.scope === 'PO' ? 'the whole PO' : 'each line') + ': short ' + (rule.shortRejectBps / 100) + '% or more at PO close rejects the short line; extra over ' + (rule.extraHoldBps / 100) + '% is held for purchase. ' + esc(d.policy.explain) + ' (v' + d.policy.version + ')';
    var lines = d.lines.map(function (l, i) {
      var checks = CHECKS.map(function (c) {
        return '<div style="display:flex;flex-direction:column;gap:4px;min-width:140px"><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-ck="' + i + ':' + c[0] + '" checked> ' + c[1] + '</label>' +
          '<input class="fld" data-why="' + i + ':' + c[0] + '" placeholder="Reason if not OK" style="display:none"></div>';
      }).join('');
      return '<div class="glass" style="padding:var(--s-snug);display:flex;flex-direction:column;gap:var(--s-snug)" data-line="' + i + '">' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><strong style="font-family:var(--font-mono)">' + esc(l.floorCode || 'Line ' + (i + 1)) + '</strong>' +
        '<span class="t-cap">ordered ' + (l.orderedBase != null ? mg(l.orderedBase, l.unit) : esc(l.uomCode || '?')) + ' · accepted so far ' + mg(l.priorAcceptedBase, l.unit) + '</span>' +
        (l.auditable ? '' : chip('r', 'Unit ' + (l.uomCode || 'none') + ' cannot be weighed here')) + '</div>' +
        row(field(l.unit === 'unit' ? 'Received (units)' : 'Received (g)', '<input class="fld" data-rec="' + i + '" inputmode="decimal" style="width:140px">') +
          field(l.unit === 'unit' ? 'Damaged (units)' : 'Damaged (g)', '<input class="fld" data-dmg="' + i + '" inputmode="decimal" value="0" style="width:140px">') +
          field('Expiry', '<input class="fld" type="date" data-exp="' + i + '">')) +
        '<div style="display:flex;flex-wrap:wrap;gap:var(--s-snug)">' + checks + '</div></div>';
    }).join('');
    host.innerHTML = card('Rule for ' + esc(d.purchaseOrder.poNumber || ''), '<p>' + ruleText + '</p><p class="t-cap">Deliveries so far: ' + d.deliveriesSoFar + '</p>' +
      (held.length ? '<div style="margin-top:8px">' + held.map(function (g) { return chip('r', (g.gateEntryNumber || 'Gate entry') + ' held: ' + (g.holdReason || '')); }).join(' ') + '</div>' : '')) +
      (open.length ? card('Audit the delivery', '<form id="fb-rform" style="display:flex;flex-direction:column;gap:var(--s-base)">' +
        row(field('Gate entry', pick('fb-gate', open, 'gateEntryId', function (g) { return g.gateEntryNumber || g.gateEntryId; }, 'Choose the truck…')) +
          '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="fb-final"> Last delivery: close the PO and judge shortness now</label>') +
        lines + '<div id="fb-rerr" role="alert" style="color:var(--red);min-height:16px"></div>' +
        '<button type="submit" class="btn p" id="fb-rsave">Submit audit</button></form>') : card('Audit the delivery', '<p>No truck waiting for audit on this PO. Make a gate entry first.</p>'));
    if (!open.length) return;
    [].forEach.call(host.querySelectorAll('[data-ck]'), function (cb) {
      cb.onchange = function () { var w = host.querySelector('[data-why="' + cb.getAttribute('data-ck') + '"]'); w.style.display = cb.checked ? 'none' : ''; };
    });
    $('fb-rform').onsubmit = function (e) {
      e.preventDefault(); var errEl = $('fb-rerr'); errEl.textContent = '';
      var gate = $('fb-gate').value; if (!gate) { errEl.textContent = 'Choose the gate entry.'; return; }
      var body = { gateEntryId: gate, finalDelivery: $('fb-final').checked, lines: [] };
      for (var i = 0; i < d.lines.length; i++) {
        var l = d.lines[i], rv = host.querySelector('[data-rec="' + i + '"]').value;
        if (!String(rv).trim()) continue;
        var unit = l.unit === 'unit';
        var rec = unit ? Math.round(Number(rv)) : toMg(rv), dmg = unit ? Math.round(Number(host.querySelector('[data-dmg="' + i + '"]').value || 0)) : toMg(host.querySelector('[data-dmg="' + i + '"]').value);
        if (rec == null || dmg == null || !isFinite(rec) || !isFinite(dmg)) { errEl.textContent = 'Line ' + (i + 1) + ': enter a weight in grams.'; return; }
        var checks = {};
        for (var c = 0; c < CHECKS.length; c++) {
          var k = CHECKS[c][0], ok = host.querySelector('[data-ck="' + i + ':' + k + '"]').checked, why = host.querySelector('[data-why="' + i + ':' + k + '"]').value.trim();
          if (!ok && !why) { errEl.textContent = 'Line ' + (i + 1) + ': give a reason for "' + CHECKS[c][1] + '".'; return; }
          checks[k] = ok ? { ok: true } : { ok: false, reason: why };
        }
        body.lines.push({ poItemId: l.poItemId, receivedBase: rec, damagedBase: dmg, checks: checks, expiryDate: host.querySelector('[data-exp="' + i + '"]').value || undefined });
      }
      if (!body.lines.length) { errEl.textContent = 'Enter what arrived on at least one line.'; return; }
      var b = $('fb-rsave'); b.disabled = true; b.textContent = 'Submitting…';
      tunnel('/v1/prodfloor/receiving/audits', { method: 'POST', body: body }).then(function (res) {
        b.disabled = false; b.textContent = 'Submit audit';
        if (res.status >= 400) { errEl.textContent = err(res, 'The audit was not saved. Try again.'); return; }
        var r = data(res);
        toast('Audit saved · GRN ' + (r.grnNumber || ''), 'good');
        host.innerHTML = card('Delivery ' + r.deliveryNo + ' · GRN ' + esc(r.grnNumber || ''),
          '<div style="overflow-x:auto;max-width:100%"><table class="tbl" style="min-width:520px"><thead><tr><th>Line</th><th>Decision</th><th>Accepted</th><th>Rejected</th><th>Held</th><th>Short</th><th>Why</th></tr></thead><tbody>' +
          r.lines.map(function (l, i) { var dd = DEC[l.decision] || ['n', l.decision]; return '<tr><td>' + (i + 1) + '</td><td>' + chip(dd[0], (l.overridden ? 'OVERRIDDEN · ' : '') + dd[1]) + '</td><td>' + mg(l.acceptedBase, l.unit) + '</td><td>' + mg(l.rejectedBase, l.unit) + '</td><td>' + mg(l.excessHeldBase, l.unit) + '</td><td>' + mg(l.shortBase, l.unit) + '</td><td>' + esc(l.explain) + '</td></tr>'; }).join('') +
          '</tbody></table></div>' + (r.debitNote ? '<p style="margin-top:8px">Debit note ' + esc(r.debitNote.debitNoteNumber) + ' raised for ' + inr(r.debitNote.amountPaise) + '.</p>' : '') +
          '<p class="t-cap">Raw lots go to quarantine for incoming QC; print each lot\'s label at putaway (Lot hold & recall).</p>' +
          '<p>' + r.rmBatches.map(function (x) { return '<span style="font-family:var(--font-mono)">' + esc(x.batchNumber) + '</span>'; }).join(' · ') + '</p>');
      }).catch(function () { b.disabled = false; b.textContent = 'Submit audit'; errEl.textContent = 'Can\'t connect. Try again.'; });
    };
  }

  /* ── Supplier payments ──────────────────────────────────────────────────────────────── */
  var PST = { REQUESTED: ['a', 'Requested'], APPROVED: ['b', 'Approved'], RELEASED: ['g', 'Released'], REFUSED: ['r', 'Refused'] };
  async function viewPay(item, V) {
    V.innerHTML = '<div class="loading">Loading…</div>';
    var pos = await getRows('/v1/purchase-orders?limit=100');
    if (stale('payrelease')) return;
    V.innerHTML = '<div class="grid">' + card('Purchase order', row(field('Purchase order', pick('fb-ppo', pos, 'purchaseOrderId', function (p) { return (p.poNumber || p.purchaseOrderId) + ' · ' + (p.status || ''); }, 'Choose a PO…')))) + '<div id="fb-pay" class="c12"></div></div>';
    $('fb-ppo').onchange = function () { if (this.value) loadPay(this.value); };
  }
  async function loadPay(poId) {
    var host = $('fb-pay'); host.innerHTML = '<div class="loading">Loading…</div>';
    var res; try { res = await tunnel('/v1/prodfloor/payments/po/' + poId); } catch (e) { host.innerHTML = errBox('Can\'t connect. Try again.'); return; }
    if (res.status >= 400) { host.innerHTML = errBox(err(res, 'Payments for this PO are not available.')); return; }
    var d = data(res), t = d.terms;
    var termsText = !t ? 'Held: ' + esc(d.hold) : t.mode === 'ADVANCE_BALANCE' ? (t.advanceBps / 100) + '% advance on approval, balance against GRN' : t.mode === 'CREDIT' ? 'Credit ' + t.days + ' days from ' + t.from + (d.dueDate ? ' · due ' + esc(d.dueDate) : '') : 'Against GRN: only what was accepted';
    var canWrite = can('procurement:po_payment_release:write');
    host.innerHTML = card('Terms and money', '<p>' + termsText + (d.policy ? ' <span class="t-cap">' + esc(d.policy.explain) + '</span>' : '') + '</p>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--s-snug);margin-top:8px">' +
      [['PO value', d.poValuePaise], ['Accepted', d.acceptedValuePaise], ['Released', d.releasedPaise], ['Can request: advance', d.releasablePaise.ADVANCE], ['Can request: balance', d.releasablePaise.BALANCE]]
        .map(function (k) { return '<div>' + lbl(k[0]) + '<div style="font-size:var(--t-h2)">' + inr(k[1]) + '</div></div>'; }).join('') + '</div>') +
      (canWrite && t ? card('Request a payment', '<form id="fb-preq">' + row(field('Kind', '<select id="fb-pkind" class="fld"><option value="BALANCE">Balance (against GRN)</option><option value="ADVANCE">Advance</option></select>') +
        field('Amount (₹)', '<input id="fb-pamt" class="fld" inputmode="decimal" style="width:140px">') + field('Note', '<input id="fb-pnote" class="fld">') +
        '<button type="submit" class="btn p">Request</button>') + '<div id="fb-perr" role="alert" style="color:var(--red);min-height:16px"></div></form>') : '') +
      card('Payments', d.releases.length ? '<div style="overflow-x:auto;max-width:100%"><table class="tbl" style="min-width:520px"><thead><tr><th>Kind</th><th>Amount</th><th>Status</th><th>UTR</th><th></th></tr></thead><tbody>' +
        d.releases.map(function (r) {
          var s = PST[r.status] || ['n', r.status], acts = '';
          if (canWrite && r.status === 'REQUESTED') acts = '<button type="button" class="btn sm" data-pa="approve" data-id="' + r.releaseId + '">Approve</button> ';
          if (canWrite && r.status === 'APPROVED') acts = '<input class="fld" data-utr="' + r.releaseId + '" placeholder="UTR / bank ref" style="width:140px"> <button type="button" class="btn sm p" data-pa="release" data-id="' + r.releaseId + '">Release</button> ';
          if (canWrite && (r.status === 'REQUESTED' || r.status === 'APPROVED')) acts += '<button type="button" class="btn sm" data-pa="refuse" data-id="' + r.releaseId + '">Refuse</button>';
          return '<tr><td>' + esc(r.kind) + '</td><td>' + inr(r.amountPaise) + '</td><td>' + chip(s[0], s[1]) + '</td><td style="font-family:var(--font-mono)">' + esc(r.utr || '') + '</td><td>' + acts + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<p>No payments yet.</p>', 'The person who raised the PO cannot approve or release; the requester cannot approve.');
    var f = $('fb-preq');
    if (f) f.onsubmit = function (e) {
      e.preventDefault(); var amt = Math.round(Number($('fb-pamt').value) * 100);
      if (!(amt > 0)) { $('fb-perr').textContent = 'Enter an amount.'; return; }
      tunnel('/v1/prodfloor/payments', { method: 'POST', body: { purchaseOrderId: poId, kind: $('fb-pkind').value, amountPaise: amt, note: $('fb-pnote').value || undefined } }).then(function (r) {
        if (r.status >= 400) { $('fb-perr').textContent = err(r, 'Not requested.'); return; }
        toast('Payment requested', 'good'); loadPay(poId);
      }).catch(function () { $('fb-perr').textContent = 'Can\'t connect. Try again.'; });
    };
    [].forEach.call(host.querySelectorAll('[data-pa]'), function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-id'), a = b.getAttribute('data-pa'), body = {};
        if (a === 'release') { body.utr = (host.querySelector('[data-utr="' + id + '"]').value || '').trim(); if (!body.utr) { toast('Enter the UTR first.', 'bad'); return; } }
        if (a === 'refuse') {
          askReason('Refuse this payment', 'Why is it refused?', 'Refuse payment', function (why) {
            return tunnel('/v1/prodfloor/payments/' + id + '/refuse', { method: 'POST', body: { reason: why } }).then(function (r) { if (r.status < 400) { toast('Payment refused', 'good'); loadPay(poId); } return r; });
          });
          return;
        }
        b.disabled = true;
        tunnel('/v1/prodfloor/payments/' + id + '/' + a, { method: 'POST', body: body }).then(function (r) {
          b.disabled = false; if (r.status >= 400) { toast(err(r, 'That did not go through.'), 'bad'); return; }
          toast(a === 'approve' ? 'Payment approved' : 'Payment released', 'good'); loadPay(poId);
        }).catch(function () { b.disabled = false; toast('Can\'t connect. Try again.', 'bad'); });
      };
    });
  }

  /* ── QC checkpoints ─────────────────────────────────────────────────────────────────── */
  async function viewCheckpoints(item, V) {
    V.innerHTML = '<div class="loading">Loading…</div>';
    var prods = await getRows('/v1/product-qc-specs?limit=200');
    if (stale('qccheckpoints')) return;
    V.innerHTML = '<div class="grid">' + card('Product', row(field('Product', pick('fb-cprod', prods, 'productId', function (p) { return (p.productCode || '') + ' ' + (p.productName || ''); }, 'Choose a product…')))) + '<div id="fb-cp" class="c12"></div></div>';
    $('fb-cprod').onchange = function () { if (this.value) loadCp(this.value); };
  }
  function cpRow(c) {
    c = c || {};
    return '<div data-cprow style="display:flex;flex-wrap:wrap;gap:var(--s-snug);align-items:flex-end;border-bottom:1px solid var(--line);padding:6px 0">' +
      field('Checkpoint', '<input class="fld" data-f="name" value="' + esc(c.name) + '" placeholder="Odour profile">') +
      field('Type', '<select class="fld" data-f="checkType">' + [['PASS_FAIL', 'Pass / fail'], ['RANGE', 'Numeric range'], ['REFERENCE', 'Compare to reference']].map(function (o) { return '<option value="' + o[0] + '"' + (c.checkType === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>') +
      field('Min', '<input class="fld" data-f="min" value="' + esc(c.min) + '" style="width:80px">') + field('Max', '<input class="fld" data-f="max" value="' + esc(c.max) + '" style="width:80px">') +
      field('Instrument', '<input class="fld" data-f="instrument" value="' + esc(c.instrument) + '" style="width:130px">') +
      '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-f="critical"' + (c.critical ? ' checked' : '') + '> Critical</label>' +
      '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-f="photoRequired"' + (c.photoRequired ? ' checked' : '') + '> Photo</label>' +
      '<button type="button" class="btn sm" data-cpdel>Remove</button></div>';
  }
  async function loadCp(pid) {
    var host = $('fb-cp'); host.innerHTML = '<div class="loading">Loading…</div>';
    var res; try { res = await tunnel('/v1/prodfloor/qc/checkpoints/' + pid); } catch (e) { host.innerHTML = errBox('Can\'t connect. Try again.'); return; }
    if (res.status >= 400) { host.innerHTML = errBox(err(res, 'Checkpoints are not available.')); return; }
    var d = data(res), canWrite = can('quality:qc_parameter_master:write');
    host.innerHTML = card(d.current ? 'Version ' + d.current.version : 'No checkpoints yet',
      '<div id="fb-cprows">' + (d.checkpoints.length ? d.checkpoints : [{}]).map(cpRow).join('') + '</div>' +
      (canWrite ? '<div style="display:flex;gap:var(--s-snug);flex-wrap:wrap;margin-top:8px"><button type="button" class="btn sm" id="fb-cpadd">Add checkpoint</button>' +
        field('Why it changes', '<input class="fld" id="fb-cpwhy" style="min-width:240px">') + '<button type="button" class="btn p" id="fb-cpsave">Publish new version</button></div><div id="fb-cperr" role="alert" style="color:var(--red);min-height:16px"></div>' : ''),
      'Saving publishes a new version. A batch keeps the version it was first tested on.') +
      card('Versions', d.versions.length ? '<div style="overflow-x:auto;max-width:100%"><table class="tbl" style="min-width:520px"><thead><tr><th>Version</th><th>Why</th><th>When</th><th>Batches tested</th></tr></thead><tbody>' + d.versions.map(function (v) {
        var b = d.batchesPerVersion.filter(function (x) { return x.version === v.version; })[0];
        return '<tr><td>v' + v.version + '</td><td>' + esc(v.reason) + '</td><td>' + esc(String(v.publishedDt).slice(0, 10)) + '</td><td>' + (b ? b.batches : 0) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<p>None.</p>');
    function wireDel() { [].forEach.call(host.querySelectorAll('[data-cpdel]'), function (b) { b.onclick = function () { b.parentNode.remove(); }; }); }
    wireDel();
    if (!canWrite) return;
    $('fb-cpadd').onclick = function () { $('fb-cprows').insertAdjacentHTML('beforeend', cpRow({})); wireDel(); };
    $('fb-cpsave').onclick = function () {
      var cps = [].map.call(host.querySelectorAll('[data-cprow]'), function (r) {
        function v(f) { var el = r.querySelector('[data-f="' + f + '"]'); return el.type === 'checkbox' ? el.checked : el.value; }
        return { name: v('name'), checkType: v('checkType'), min: v('min') === '' ? null : Number(v('min')), max: v('max') === '' ? null : Number(v('max')), instrument: v('instrument') || null, critical: v('critical'), photoRequired: v('photoRequired') };
      });
      tunnel('/v1/prodfloor/qc/checkpoints/' + pid, { method: 'POST', body: { reason: $('fb-cpwhy').value, checkpoints: cps } }).then(function (r) {
        if (r.status >= 400) { $('fb-cperr').textContent = err(r, 'Not published.'); return; }
        toast('Version ' + data(r).version + ' published', 'good'); loadCp(pid);
      }).catch(function () { $('fb-cperr').textContent = 'Can\'t connect. Try again.'; });
    };
  }

  /* ── Batch QC ───────────────────────────────────────────────────────────────────────── */
  var QD = { APPROVE: ['g', 'Approve'], REWORK: ['a', 'Rework'], HOLD_RETEST: ['a', 'Hold: retest'], REJECT: ['r', 'Reject'], REVIEW: ['r', 'Review: perfumer + vault approver'], HOLD_CAPA: ['r', 'Hold + CAPA'] };
  var DEFECTS = ['STRENGTH', 'CONCENTRATION', 'COLOUR', 'CLARITY', 'DENSITY', 'REFRACTIVE_INDEX', 'CONTAMINATION', 'FOREIGN_MATTER', 'WRONG_ODOUR', 'MICROBIAL', 'STABILITY', 'FORMULA_MISMATCH', 'FAULTY_RAW_LOT'];
  async function viewQc(item, V) {
    V.innerHTML = '<div class="loading">Loading…</div>';
    var batches = await getRows('/v1/oil-batches?limit=100');
    if (stale('qcgate')) return;
    V.innerHTML = '<div class="grid">' + card('Batch', row(field('Oil batch', pick('fb-qb', batches, 'oilBatchId', function (b) { return (b.batchNumber || b.oilBatchId) + ' · ' + (b.status || ''); }, 'Choose a batch…')))) + '<div id="fb-qc" class="c12"></div></div>';
    $('fb-qb').onchange = function () { if (this.value) loadQc(this.value); };
  }
  async function loadQc(id) {
    var host = $('fb-qc'); host.innerHTML = '<div class="loading">Loading…</div>';
    var res; try { res = await tunnel('/v1/prodfloor/qc/batches/' + id); } catch (e) { host.innerHTML = errBox('Can\'t connect. Try again.'); return; }
    if (res.status >= 400) { host.innerHTML = errBox(err(res, 'This batch is not available.')); return; }
    var d = data(res), last = d.rounds[d.rounds.length - 1], cps = d.checkpoints;
    var prods = cps ? [] : await getRows('/v1/product-qc-specs?limit=200');
    var needRework = last && last.decision === 'REWORK' && d.reworks.length < Number(last.reworkNo) + 1;
    var closed = last && /APPROVE|REJECT|REVIEW|HOLD_CAPA/.test(last.decision);
    var hist = d.rounds.length ? '<div style="overflow-x:auto;max-width:100%"><table class="tbl" style="min-width:520px"><thead><tr><th>Round</th><th>Spec</th><th>Decision</th><th>Defect</th><th>Why</th></tr></thead><tbody>' + d.rounds.map(function (r) {
      var q = QD[r.decision] || ['n', r.decision]; return '<tr><td>' + r.roundNo + '</td><td>v' + r.specVersion + '</td><td>' + chip(q[0], q[1]) + '</td><td>' + esc(r.defectType || '') + '</td><td>' + esc((r.reasons || []).join(' ')) + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '<p>No QC round yet.</p>';
    var form = '';
    if (closed) form = '<p>' + chip('n', 'Last decision ' + last.decision) + ' No further round is taken here.</p>';
    else if (needRework) form = '<form id="fb-rw">' + row(field('Adjustment (g added or removed)', '<input id="fb-rwg" class="fld" inputmode="decimal" style="width:140px">') + field('Raw lot used (optional)', '<input id="fb-rwlot" class="fld" placeholder="RM batch id">') + field('What was adjusted', '<input id="fb-rwnote" class="fld" style="min-width:240px">') + '<button type="submit" class="btn p">Record rework</button>') + '<div id="fb-qerr" role="alert" style="color:var(--red);min-height:16px"></div></form>';
    else {
      var cpList = cps;
      form = '<form id="fb-qr" style="display:flex;flex-direction:column;gap:var(--s-snug)">' +
        (cps ? '' : row(field('Product (pins its current checkpoint version)', pick('fb-qprod', prods, 'productId', function (p) { return (p.productCode || '') + ' ' + (p.productName || ''); }, 'Choose…')))) +
        '<div id="fb-qcps">' + (cpList ? cpList.map(function (c) {
          return '<div data-cp="' + c.id + '" data-type="' + c.checkType + '" style="display:flex;gap:var(--s-snug);align-items:center;flex-wrap:wrap"><strong style="min-width:160px">' + esc(c.name) + (c.critical ? ' ' + chip('r', 'critical') : '') + '</strong>' +
            (c.checkType === 'RANGE' ? '<input class="fld" data-v inputmode="decimal" placeholder="' + esc(c.min) + ' – ' + esc(c.max) + '" style="width:140px">' : '<select class="fld" data-v><option value="">Result…</option><option value="1">Pass</option><option value="0">Fail</option></select>') +
            (c.photoRequired ? '<input class="fld" data-photo placeholder="Photo ref" style="width:140px">' : '') + '</div>';
        }).join('') : '<p class="t-cap">Choose the product to load its checkpoints.</p>') + '</div>' +
        row(field('Defect type (if anything failed)', '<select id="fb-qdef" class="fld"><option value="">—</option>' + DEFECTS.map(function (x) { return '<option>' + x + '</option>'; }).join('') + '</select>') +
          field('Faulty raw lot (RM batch id)', '<input id="fb-qlot" class="fld">') +
          '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="fb-qdoubt"> Instrument doubt</label>') +
        '<div id="fb-qerr" role="alert" style="color:var(--red);min-height:16px"></div><button type="submit" class="btn p">Record QC round</button></form>';
    }
    host.innerHTML = card('Batch ' + esc(d.batch.batchNumber || '') + (d.hold ? ' · ON HOLD' : ''), hist, d.hold ? esc(d.hold.reason) : '') + card(needRework ? 'Rework' : 'QC round', form, 'Every round tests every checkpoint, after a rework too.');
    var sel = $('fb-qprod');
    if (sel) sel.onchange = async function () {
      var r = await tunnel('/v1/prodfloor/qc/checkpoints/' + sel.value); var c = r.status < 400 ? data(r).checkpoints : [];
      $('fb-qcps').innerHTML = c.length ? c.map(function (x) { return '<div data-cp="' + x.id + '" data-type="' + x.checkType + '" style="display:flex;gap:var(--s-snug);align-items:center;flex-wrap:wrap"><strong style="min-width:160px">' + esc(x.name) + '</strong>' + (x.checkType === 'RANGE' ? '<input class="fld" data-v inputmode="decimal" placeholder="' + esc(x.min) + ' – ' + esc(x.max) + '" style="width:140px">' : '<select class="fld" data-v><option value="">Result…</option><option value="1">Pass</option><option value="0">Fail</option></select>') + (x.photoRequired ? '<input class="fld" data-photo placeholder="Photo ref" style="width:140px">' : '') + '</div>'; }).join('') : '<p>This product has no checkpoints published yet.</p>';
    };
    var qr = $('fb-qr');
    if (qr) qr.onsubmit = function (e) {
      e.preventDefault();
      var results = [].map.call(host.querySelectorAll('[data-cp]'), function (el) {
        var v = el.querySelector('[data-v]').value, ph = el.querySelector('[data-photo]'), o = { checkpointId: el.getAttribute('data-cp') };
        if (el.getAttribute('data-type') === 'RANGE') o.value = v === '' ? null : Number(v); else if (v !== '') o.pass = v === '1';
        if (ph) o.photoRef = ph.value; return o;
      });
      var body = { results: results, defectType: $('fb-qdef').value || undefined, instrumentDoubt: $('fb-qdoubt').checked, rmBatchId: $('fb-qlot').value || undefined, productId: sel ? sel.value : undefined };
      tunnel('/v1/prodfloor/qc/batches/' + id + '/rounds', { method: 'POST', body: body }).then(function (r) {
        if (r.status >= 400) { $('fb-qerr').textContent = err(r, 'Not recorded.'); return; }
        var q = QD[data(r).decision] || ['n', data(r).decision]; toast('Decision: ' + q[1], q[0] === 'g' ? 'good' : ''); loadQc(id);
      }).catch(function () { $('fb-qerr').textContent = 'Can\'t connect. Try again.'; });
    };
    var rw = $('fb-rw');
    if (rw) rw.onsubmit = function (e) {
      e.preventDefault(); var m = toMg($('fb-rwg').value); if (m == null) { $('fb-qerr').textContent = 'Enter the adjustment in grams.'; return; }
      tunnel('/v1/prodfloor/qc/batches/' + id + '/reworks', { method: 'POST', body: { adjustmentMg: m, rmBatchId: $('fb-rwlot').value || undefined, note: $('fb-rwnote').value } }).then(function (r) {
        if (r.status >= 400) { $('fb-qerr').textContent = err(r, 'Not recorded.'); return; }
        toast('Rework recorded: now the full re-QC', 'good'); loadQc(id);
      }).catch(function () { $('fb-qerr').textContent = 'Can\'t connect. Try again.'; });
    };
  }

  /* ── Lot hold & recall, raw-lot label ───────────────────────────────────────────────── */
  async function viewRecall(item, V) {
    V.innerHTML = '<div class="loading">Loading…</div>';
    var res; try { res = await tunnel('/v1/prodfloor/holds'); } catch (e) { V.innerHTML = errBox('Can\'t connect. Try again.'); return; }
    if (stale('lotrecall')) return;
    if (res.status >= 400) { V.innerHTML = errBox(err(res, 'Holds are not available.')); return; }
    var hd = data(res), holds = Array.isArray(hd) ? hd : ((hd && hd.items) || []), canWrite = can('inventory:rm_batch_master:write');
    V.innerHTML = '<div class="grid">' +
      card('On hold now', holds.length ? '<div style="overflow-x:auto;max-width:100%"><table class="tbl" style="min-width:520px"><thead><tr><th>What</th><th>Number</th><th>Why</th><th>Since</th><th></th></tr></thead><tbody>' + holds.map(function (h) {
        return '<tr><td>' + (h.subjectType === 'RM_LOT' ? 'Raw lot' : 'Batch') + '</td><td style="font-family:var(--font-mono)">' + esc(h.number || h.subjectId) + '</td><td>' + esc(h.reason) + '</td><td>' + esc(String(h.heldDt).slice(0, 10)) + '</td><td>' +
          (h.subjectType === 'RM_LOT' ? '<button type="button" class="btn sm" data-trace="' + h.subjectId + '">Recall review</button> ' : '') + (canWrite ? '<button type="button" class="btn sm" data-rel="' + h.lotHoldId + '">Release</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<p>Nothing is on hold.</p>') +
      card('A raw lot', row(field('RM batch id', '<input id="fb-lot" class="fld" style="min-width:280px">') + '<button type="button" class="btn p" id="fb-trace">Recall review</button>' +
        (canWrite ? '<button type="button" class="btn" id="fb-hold">Hold this lot</button>' : '') +
        field('Bin (for the label)', '<input id="fb-bin" class="fld" placeholder="Bin id">') + '<button type="button" class="btn" id="fb-label">Print raw-lot label</button>')) +
      '<div id="fb-rc" class="c12"></div></div>';
    [].forEach.call(V.querySelectorAll('[data-trace]'), function (b) { b.onclick = function () { $('fb-lot').value = b.getAttribute('data-trace'); trace(); }; });
    [].forEach.call(V.querySelectorAll('[data-rel]'), function (b) {
      b.onclick = function () {
        askReason('Release the hold', 'Why is the hold lifted? Name the evidence (retest, COA).', 'Release hold', function (why) {
          return tunnel('/v1/prodfloor/holds/' + b.getAttribute('data-rel') + '/release', { method: 'POST', body: { reason: why } }).then(function (r) { if (r.status < 400) { toast('Hold released', 'good'); viewRecall(item, V); } return r; });
        });
      };
    });
    $('fb-trace').onclick = trace;
    var hb = $('fb-hold'); if (hb) hb.onclick = function () {
      var lot = $('fb-lot').value.trim(); if (!lot) { toast('Enter the lot.', 'bad'); return; }
      askReason('Hold this lot', 'Why is this lot held?', 'Hold lot', function (why) {
        return tunnel('/v1/prodfloor/holds', { method: 'POST', body: { subjectType: 'RM_LOT', subjectId: lot, reason: why } }).then(function (r) { if (r.status < 400) { toast('Lot held', 'good'); viewRecall(item, V); } return r; });
      });
    };
    $('fb-label').onclick = function () {
      var lot = $('fb-lot').value.trim(); if (!lot) { toast('Enter the lot.', 'bad'); return; }
      tunnel('/v1/prodfloor/putaway/' + lot + '/label', { method: 'POST', body: { storageLocationId: $('fb-bin').value.trim() || undefined } }).then(function (r) {
        if (r.status >= 400) { toast(err(r, 'No label.'), 'bad'); return; }
        printLabel(data(r));
      });
    };
    async function trace() {
      var lot = $('fb-lot').value.trim(), host = $('fb-rc'); if (!lot) return;
      host.innerHTML = '<div class="loading">Loading…</div>';
      var r = await tunnel('/v1/prodfloor/recall/rm-lot/' + lot);
      if (r.status >= 400) { host.innerHTML = errBox(err(r, 'That lot was not found.')); return; }
      var d = data(r);
      function tbl(rows, cols) { return rows.length ? '<div style="overflow-x:auto;max-width:100%"><table class="tbl" style="min-width:520px"><thead><tr>' + cols.map(function (c) { return '<th>' + c[0] + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.map(function (x) { return '<tr>' + cols.map(function (c) { return '<td>' + esc(x[c[1]]) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>' : '<p>None.</p>'; }
      host.innerHTML = card('Lot ' + esc(d.lot.lotNumber) + (d.hold ? ' · ON HOLD' : ''), '<p>' + (d.hold ? esc(d.hold.reason) : 'Not on hold.') + '</p>') +
        card('Batches that used it (' + d.batches.length + ')', tbl(d.batches, [['Batch', 'batchNumber'], ['Status', 'status'], ['How', 'via']])) +
        card('Finished goods (' + d.finishedGoods.length + ')', tbl(d.finishedGoods, [['FG batch', 'batchNumber'], ['Status', 'status']])) +
        card('Shipped orders (' + d.shippedOrders.length + ')', tbl(d.shippedOrders, [['Sales order', 'salesOrderNumber'], ['Dispatched', 'dispatchDate'], ['Qty', 'dispatchedQty'], ['Status', 'status']]), d.shippedOrders.length ? 'These customers hold product made from this lot.' : '');
    }
  }
  function printLabel(p) {
    var qr = ''; try { var q = qrcode(0, 'M'); q.addData(String(p.lotId)); q.make(); qr = q.createSvgTag(3, 0); } catch (e) { /* no QR */ }
    var w = window.open('', '_blank', 'width=420,height=320'); if (!w) { toast('Allow pop-ups to print the label.', 'bad'); return; }
    w.document.write('<!doctype html><meta charset="utf-8"><title>Raw lot ' + esc(p.lotId) + '</title><style>@page{size:100mm 50mm;margin:2mm}body{font:12px system-ui;margin:0;display:flex;gap:8px}h1{font:700 15px ui-monospace,monospace;margin:0 0 4px}p{margin:2px 0}.hz{font-weight:700}</style>' +
      '<div>' + qr + '</div><div><h1>' + esc(p.lotId) + (p.reprint ? ' · REPRINT' : '') + '</h1><p>Code ' + esc(p.floorCode || '—') + '</p><p>Qty ' + esc(p.qty) + ' ' + esc(p.uom || '') + '</p><p>Expiry ' + esc(p.expiry || '—') + '</p><p>Received ' + esc(p.received || '') + '</p><p>Bin ' + esc(p.storageLocationId || '') + '</p><p class="hz">' + esc(p.hazard) + '</p></div>');
    w.document.close(); w.focus(); setTimeout(function () { w.print(); }, 200);
  }

  window.RA.registerViews({ __recvaudit__: viewRecv, __payrelease__: viewPay, __qccheckpoints__: viewCheckpoints, __qcgate__: viewQc, __lotrecall__: viewRecall });
})();
