/* RAW AROMA — ws-supply module: Procurement, Receiving, Warehouse view renderers/specials.
 * Depends on globals defined in shell.js (loaded first): tunnel, $, toast, UOM, setTheme,
 * loadView, guessId, escHtml. U2: openRaiseRequirement's dialog markup ported to
 * ui-contract/shell.css .xp-scrim/.xp-sheet (PORTING_GUIDE.md "Dialog") — was a bespoke
 * position:fixed overlay from the app.js mechanical extract; same fields/endpoint/behaviour. */
'use strict';
  // reorder → raise requirement: a confirmation dialog (editable qty/priority/date), not a one-click.
  // Vendor is NOT chosen here — that happens later at RFQ/quotation/PO (per the procurement flow).
  // Markup: ui-contract/shell.css .xp-scrim/.xp-sheet (PORTING_GUIDE.md "Dialog (true modal)") —
  // was a bespoke position:fixed overlay; converted in place, same fields/endpoint/behaviour.
  function fLabel(text, req) { return '<span style="font:var(--w-med) var(--t-cap)/1 var(--font-ui);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)">' + text + (req ? ' <span style="color:var(--red)">*</span>' : '') + '</span>'; }
  function openRaiseRequirement(row) {
    var mat = row.materialCode || row.materialName || 'material';
    var scrim = document.createElement('div');
    scrim.className = 'xp-scrim open'; scrim.id = 'ra-rscrim';
    scrim.innerHTML = '<form id="ra-rform" class="xp-sheet" style="max-width:400px" role="dialog" aria-modal="true" aria-label="Raise requirement">' +
      '<div class="xp-sheet-hd"><h2>Raise requirement</h2><button type="button" class="xp" id="ra-rclose" aria-label="Close">&times;</button></div>' +
      '<div class="xp-sheet-bd">' +
      '<div style="font:var(--w-reg) var(--t-body)/1.3 var(--font-ui);color:var(--ink-2)">' + escHtml(mat) + ' &middot; available ' + row.available + ', reorder level ' + row.reorderLevel + '</div>' +
      '<label style="display:flex;flex-direction:column;gap:5px">' + fLabel('Order quantity', true) + '<input id="ra-rq" class="fld" type="number" inputmode="decimal" value="' + row.shortage + '"></label>' +
      '<label style="display:flex;flex-direction:column;gap:5px">' + fLabel('Unit') + '<select id="ra-ru" class="fld"><option value="">Unit…</option>' + Object.keys(UOM).map(function (id) { return '<option value="' + id + '">' + UOM[id] + '</option>'; }).join('') + '</select></label>' +
      '<label style="display:flex;flex-direction:column;gap:5px">' + fLabel('Priority') + '<select id="ra-rp" class="fld"><option>HIGH</option><option>MEDIUM</option><option>LOW</option></select></label>' +
      '<label style="display:flex;flex-direction:column;gap:5px">' + fLabel('Required by', true) + '<input id="ra-rd" class="fld" type="date"></label>' +
      '<div id="ra-rerr" role="alert" style="min-height:16px;font:var(--w-med) var(--t-cap)/var(--lh-cap) var(--font-ui);color:var(--red)"></div>' +
      '<button type="submit" class="btn p" id="ra-rsave" data-tutorial-target="procurement-raise-requirement-submit" style="width:100%;justify-content:center;height:var(--ch-touch-floor-coarse-pointer)">Raise requirement</button>' +
      '<div style="font:var(--w-reg) var(--t-cap)/1.3 var(--font-ui);color:var(--ink-3);text-align:center">Vendor is chosen at RFQ.</div>' +
      '</div></form>';
    document.body.appendChild(scrim); setTheme();
    function close() { if (scrim.parentNode) scrim.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    $('ra-rclose').onclick = close; scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
    $('ra-rform').onsubmit = function (e) {
      e.preventDefault(); var qty = Number($('ra-rq').value); if (!(qty > 0)) { $('ra-rerr').textContent = 'Enter a quantity.'; return; }
      var d = $('ra-rd').value; if (!d) { $('ra-rerr').textContent = 'A "Required by" date is required.'; return; }
      var body = { materialId: row.materialId, requiredQty: qty, uomId: $('ra-ru').value || undefined, priority: $('ra-rp').value, requirementSource: 'REORDER_SUGGESTION', requiredByDate: d };
      var save = $('ra-rsave'); save.disabled = true; save.textContent = 'Raising…';
      tunnel('/v1/stock-requirements', { method: 'POST', body: body }).then(function (res) {
        if (res.status >= 400) { save.disabled = false; save.textContent = 'Raise requirement'; $('ra-rerr').textContent = (res.json && res.json.error && res.json.error.message) || ('Failed (' + res.status + ')'); return; }
        close(); toast('Requirement raised', 'good'); loadView();
      }).catch(function () { save.disabled = false; save.textContent = 'Raise requirement'; $('ra-rerr').textContent = 'Can\'t connect. Try again.'; });
    };
  }
  // FAIL-branch tail: spawn a replacement PO from a rejected GRN, linked to the original PO.
  function generateReplacementPo(row) {
    if (!window.confirm('Generate a replacement PO for GRN ' + (row.grnNumber || '') + ', linked to the original PO?')) return;
    tunnel('/v1/replacement-po', { method: 'POST', body: { grnId: row.grnId } }).then(function (res) {
      if (res.status >= 400) { toast((res.json && res.json.error && res.json.error.message) || ('Failed (' + res.status + ')'), 'bad'); return; }
      var d = res.json && res.json.data;
      toast('Replacement PO ' + (d && d.poNumber ? d.poNumber : '') + ' created', 'good'); loadView();
    }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
  }
  // G2/V4 §113: a PO beyond DRAFT can't have its items/fields edited directly (409 server-side)
  // — Amend raises a new DRAFT revision linked to this one via replacement_of_po_id, which then
  // needs re-approval per the existing thresholds. Carries the original's lines/fields forward
  // unchanged (server-side default); this dialog only collects the required reason.
  function amendPurchaseOrder(row) {
    var reason = window.prompt('Reason for amending ' + (row.poNumber || 'this purchase order') + ' (required):');
    if (reason === null) return; // cancelled
    reason = reason.trim();
    if (!reason) { toast('A reason is required to amend a purchase order.', 'bad'); return; }
    tunnel('/v1/purchase-orders/' + row.purchaseOrderId + '/amend', { method: 'POST', body: { reason: reason } }).then(function (res) {
      if (res.status >= 400) { toast((res.json && res.json.error && res.json.error.message) || ('Amend failed (' + res.status + ')'), 'bad'); return; }
      var d = res.json && res.json.data;
      var poNo = d && d.purchaseOrder && d.purchaseOrder.poNumber;
      toast('Amendment' + (poNo ? ' ' + poNo : '') + ' created as a draft', 'good'); loadView();
    }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
  }
  // G2/V4 §113: cancel requires a reason (audited on the row + a vendor-notification event) and
  // is refused server-side once a goods receipt already exists against the PO.
  function cancelPurchaseOrderFlow(row) {
    var reason = window.prompt('Reason for cancelling ' + (row.poNumber || 'this purchase order') + ' (required, sent to the vendor):');
    if (reason === null) return; // cancelled
    reason = reason.trim();
    if (!reason) { toast('A reason is required to cancel a purchase order.', 'bad'); return; }
    if (!window.confirm('Cancel ' + (row.poNumber || 'this purchase order') + '? This can\'t be undone.')) return;
    tunnel('/v1/purchase-orders/' + row.purchaseOrderId + '/cancel', { method: 'POST', body: { reason: reason } }).then(function (res) {
      if (res.status >= 400) { toast((res.json && res.json.error && res.json.error.message) || ('Cancel failed (' + res.status + ')'), 'bad'); return; }
      toast('Purchase order cancelled', 'good'); loadView();
    }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
  }
