/* RAW AROMA — ws-supply module: Procurement, Receiving, Warehouse view renderers/specials.
 * Depends on globals defined in shell.js (loaded first): tunnel, $, fStyle, toast, UOM,
 * setTheme, loadView, guessId. Mechanical extract from app.js — no behaviour change. */
'use strict';
  // reorder → raise requirement: a confirmation dialog (editable qty/priority/date), not a one-click.
  // Vendor is NOT chosen here — that happens later at RFQ/quotation/PO (per the procurement flow).
  function openRaiseRequirement(row) {
    var mat = row.materialCode || row.materialName || 'material';
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:250;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = '<form id="ra-rform" style="width:100%;max-width:400px;background:var(--surface);border:1px solid var(--cbord);backdrop-filter:var(--cblur);border-radius:22px;box-shadow:var(--rai);padding:24px 26px">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px"><div style="font-weight:800;font-size:17px;flex:1">Raise requirement</div><button type="button" id="ra-rclose" style="border:none;background:var(--well);box-shadow:var(--ins-sm);color:var(--t2);width:32px;height:32px;border-radius:10px;cursor:pointer;font-size:17px">&times;</button></div>' +
      '<div style="font-size:12.5px;color:var(--t3);margin-bottom:16px">' + mat + ' · available ' + row.available + ', reorder level ' + row.reorderLevel + '</div>' +
      '<label style="display:block;font-size:12px;font-weight:700;color:var(--t2);margin-bottom:6px">Order quantity <span style="color:#C0492E">*</span></label><input id="ra-rq" type="number" value="' + row.shortage + '" style="' + fStyle() + '">' +
      '<label style="display:block;font-size:12px;font-weight:700;color:var(--t2);margin:12px 0 6px">Unit</label><select id="ra-ru" style="' + fStyle() + '"><option value="">Unit…</option>' + Object.keys(UOM).map(function (id) { return '<option value="' + id + '">' + UOM[id] + '</option>'; }).join('') + '</select>' +
      '<label style="display:block;font-size:12px;font-weight:700;color:var(--t2);margin:12px 0 6px">Priority</label><select id="ra-rp" style="' + fStyle() + '"><option>HIGH</option><option>MEDIUM</option><option>LOW</option></select>' +
      '<label style="display:block;font-size:12px;font-weight:700;color:var(--t2);margin:12px 0 6px">Required by <span style="color:#C0492E">*</span></label><input id="ra-rd" type="date" style="' + fStyle() + '">' +
      '<div id="ra-rerr" style="min-height:16px;font-size:12.5px;color:#C0492E;font-weight:600;margin:8px 0 10px"></div>' +
      '<button type="submit" id="ra-rsave" style="width:100%;padding:13px;border:none;border-radius:14px;background:var(--accent);color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:var(--rai-sm)">Raise requirement</button>' +
      '<div style="font-size:11px;color:var(--t3);text-align:center;margin-top:10px">Vendor is chosen later at RFQ / quotation / PO.</div></form>';
    document.body.appendChild(ov); setTheme();
    function close() { if (ov.parentNode) ov.remove(); }
    $('ra-rclose').onclick = close; ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    $('ra-rform').onsubmit = function (e) {
      e.preventDefault(); var qty = Number($('ra-rq').value); if (!(qty > 0)) { $('ra-rerr').textContent = 'Enter a quantity.'; return; }
      var d = $('ra-rd').value; if (!d) { $('ra-rerr').textContent = 'A "Required by" date is required.'; return; }
      var body = { materialId: row.materialId, requiredQty: qty, uomId: $('ra-ru').value || undefined, priority: $('ra-rp').value, requirementSource: 'REORDER_SUGGESTION', requiredByDate: d };
      var save = $('ra-rsave'); save.disabled = true; save.textContent = 'Raising…';
      tunnel('/v1/stock-requirements', { method: 'POST', body: body }).then(function (res) {
        if (res.status >= 400) { save.disabled = false; save.textContent = 'Raise requirement'; $('ra-rerr').textContent = (res.json && res.json.error && res.json.error.message) || ('Failed (' + res.status + ')'); return; }
        close(); toast('Requirement raised ✓', 'good'); loadView();
      }).catch(function () { save.disabled = false; save.textContent = 'Raise requirement'; $('ra-rerr').textContent = 'Could not reach the secure channel.'; });
    };
  }
  // FAIL-branch tail: spawn a replacement PO from a rejected GRN, linked to the original PO.
  function generateReplacementPo(row) {
    if (!window.confirm('Generate a replacement PO for GRN ' + (row.grnNumber || '') + ', linked to the original PO?')) return;
    tunnel('/v1/replacement-po', { method: 'POST', body: { grnId: row.grnId } }).then(function (res) {
      if (res.status >= 400) { toast((res.json && res.json.error && res.json.error.message) || ('Failed (' + res.status + ')'), 'bad'); return; }
      var d = res.json && res.json.data;
      toast('Replacement PO ' + (d && d.poNumber ? d.poNumber : '') + ' created ✓ (linked to original)', 'good'); loadView();
    }).catch(function () { toast('Could not reach the secure channel', 'bad'); });
  }
