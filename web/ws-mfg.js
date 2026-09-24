/* RAW AROMA — ws-mfg module: QC, Production/Compounding/Filling, Packaging, Dispatch/Sales
 * view renderers/specials. Depends on globals defined in shell.js (loaded first): tunnel,
 * $, toast, setTheme, loadView, guessId, escHtml.
 *
 * U3: dialogs converted from the workspace's original bespoke inline-overlay markup (a raw
 * `position:fixed` <div> per call site) to ALEMBIC's true-modal primitive — PORTING_GUIDE.md
 * "Dialog (true modal)": .xp-scrim (backdrop) + .xp-sheet (panel), role="dialog" aria-modal,
 * Escape-to-close, visibility toggled by class only (never a transitioned property). Two
 * deliberate departures from the guide's literal markup, both because it describes ALEMBIC's own
 * React app and this is plain DOM in a different stylesheet (web/ui-contract/shell.css, written by
 * U1 for this codebase, not copied wholesale from ALEMBIC's console.css):
 *  - No `.glass.glass-deep` classes: shell.css's `.xp-sheet` rule already bakes in that exact
 *    look (background:var(--gl-tint), backdrop-filter blur+saturate, the same rim/shadow stack) —
 *    `.glass`/`.glass-deep` aren't defined here at all, and layering them on top would just
 *    double/fight the same properties.
 *  - Sheet nested INSIDE the scrim, not a sibling: `.xp-scrim.open{display:flex;align-items:
 *    center;justify-content:center}` (shell.css:213-214) is what centers the panel, and that only
 *    works on a child.
 * `.t-h1`/`.t-cap`/`.t-micro` are compound-selector font tokens in this stylesheet (e.g.
 * `.xp-sheet-hd h2`), not standalone utility classes, so captions/labels below use the same
 * `font:var(--w-*) var(--t-*)/…` shorthand inline instead of a nonexistent class.
 * Fields/buttons use the shared .fld/.btn primitives (shell.css), which already carry the 44px
 * touch-target floor under `@media (pointer:coarse)` — Addendum §10 — so no per-dialog
 * touch-target CSS is needed. */
'use strict';
  // Shared dialog chrome for this module's three modals. NAMED openMfgSheet, NOT openSheet: every
  // script here loads as a plain classic <script> in ONE shared global scope (no module, no IIFE —
  // see index.html's own comment on the load order), so a same-named top-level function in a later
  // <script> silently OVERWRITES an earlier one's global binding. shell.js's openSheet(o) (object:
  // {id,tag,style,cls,title,body}) and this module's original 3-positional-arg openSheet(title,
  // bodyHtml, maxWidth) were exactly that collision: ws-mfg.js loads AFTER shell.js in index.html,
  // so ITS declaration won globally, and every shell.js call site — raConfirm, openEdit, openCreate
  // (this is what broke "Bins → + New": CREATE['/v1/bins'] is correct, but by the time a click ran,
  // window.openSheet was ws-mfg's version) — landed its {..., title: cfg.title, body} object into
  // this function's `title` PARAMETER as a whole object (renders "[object Object]" wherever `title`
  // is interpolated as a string) with `bodyHtml` left unpassed (renders the literal text "undefined"
  // where `bodyHtml` is concatenated into the sheet body). Renamed rather than reconciled: the two
  // signatures genuinely differ (this one is a simple title+bodyHtml+maxWidth convenience the three
  // call sites below use; shell.js's carries id/tag/style/cls for real forms), so a shared name was
  // never correct — it happened to work only by nobody having loaded ws-mfg.js's *last* until now.
  function openMfgSheet(title, bodyHtml, maxWidth) {
    var scrim = document.createElement('div'); scrim.className = 'xp-scrim open';
    var sheet = document.createElement('div'); sheet.className = 'xp-sheet open';
    sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', title);
    if (maxWidth) sheet.style.maxWidth = maxWidth;
    sheet.innerHTML = '<div class="xp-sheet-hd"><h2>' + escHtml(title) + '</h2>' +
      '<button type="button" class="xp" aria-label="Close">&times;</button></div>' +
      '<div class="xp-sheet-bd">' + bodyHtml + '</div>';
    scrim.appendChild(sheet); document.body.appendChild(scrim); setTheme();
    function close() { document.removeEventListener('keydown', onKey); if (scrim.parentNode) scrim.remove(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
    sheet.querySelector('.xp').onclick = close;
    return { scrim: scrim, sheet: sheet, close: close };
  }
  // G1/PB-08: sales orders should originate from the ALEMBIC bridge, not a manual click here —
  // confirming one through the UI is a break-glass CONTINUITY action, gated server-side on
  // sales:manual_continuity:write (owner/admin only; the ACTIONS entry's `perm` already hides
  // this button for every other role — see shell.js's '/v1/sales-orders' ACTIONS block) and
  // always requires a plain-language reason, which the server audits (origin=MANUAL_CONTINUITY
  // on the row + a bridge.outbox event toward ALEMBIC — see OrdersService.confirmSalesOrder).
  function confirmSalesOrderManual(row) {
    var reason = window.prompt('Reason for confirming ' + (row.soNumber || 'this sales order') + ' manually, outside the ALEMBIC bridge (required — audited):');
    if (reason === null) return; // cancelled
    reason = reason.trim();
    if (!reason) { toast('A reason is required for this break-glass action.', 'bad'); return; }
    tunnel('/v1/sales-orders/' + row.salesOrderId + '/confirm', { method: 'POST', body: { reason: reason } }).then(function (res) {
      if (res.status >= 400) { toast((res.json && res.json.error && res.json.error.message) || ('Confirm failed (' + res.status + ')'), 'bad'); return; }
      toast('Confirmed ✓ (manual continuity, audited)', 'good'); loadView();
    }).catch(function () { toast('Could not reach the secure channel', 'bad'); });
  }
  // Dispatch a confirmed sales order: pick an FG batch that actually has stock (FEFO, avail > 0)
  // and a real quantity. The server re-checks available (produced − reserved − already dispatched)
  // and rejects over-dispatch (409). One line per dispatch here; add more via the Dispatches list.
  async function openDispatch(row) {
    var res0;
    try { res0 = await tunnel('/v1/fg-stock?onlyAvailable=1&limit=100'); }
    catch (e) { toast('Could not reach the secure channel', 'bad'); return; }
    // A server error is not "no stock" — the original code let `(res0.json && res0.json.data) ||
    // []` fold a failed fetch's `data: null` into the same empty array as a genuine zero-stock
    // result, so a 500 silently looked identical to "nothing to dispatch yet" (a fake empty state
    // for a real error — exactly what Addendum §12D's "0 accidental placeholder pages" rules out).
    // Fixed here rather than left as visual-only: distinguishing error from empty is the same
    // state-authority the addendum requires elsewhere (§9), not new business logic.
    if (res0.status >= 400) { toast((res0.json && res0.json.error && res0.json.error.message) || ('Could not load finished-good stock (' + res0.status + ')'), 'bad'); return; }
    var batches = (res0.json && res0.json.data) || [];
    var byId = {}; batches.forEach(function (b) { byId[b.finishedGoodBatchId] = b; });
    // Batch/lot + status always visible in the picker itself (Addendum §10), not just after pick.
    var opts = batches.map(function (b) {
      return '<option value="' + b.finishedGoodBatchId + '">' + (b.batchNumber || String(b.finishedGoodBatchId).slice(0, 8)) + (b.skuCode ? ' · ' + b.skuCode : '') + ' · avail ' + b.availableQty + '</option>';
    }).join('');
    var body = '<div style="font:var(--w-reg) var(--t-cap)/1.35 var(--font-ui);color:var(--ink-3);margin-bottom:2px">' + escHtml(row.soNumber || 'Sales order') + ' → ship finished goods. Only batches with available stock are listed.</div>' +
      (batches.length
        ? '<label style="display:flex;flex-direction:column;gap:5px"><span style="font:var(--w-med) var(--t-micro)/1 var(--font-ui);letter-spacing:var(--ls-wide);text-transform:uppercase;color:var(--ink-3)">Finished-good batch *</span><select id="ra-dfg" class="fld">' + opts + '</select></label>' +
          '<label style="display:flex;flex-direction:column;gap:5px"><span style="font:var(--w-med) var(--t-micro)/1 var(--font-ui);letter-spacing:var(--ls-wide);text-transform:uppercase;color:var(--ink-3)">Dispatch qty *</span><input id="ra-dq" type="number" min="1" value="1" class="fld"><span id="ra-dhint" style="font:var(--w-reg) var(--t-cap)/1.35 var(--font-ui);color:var(--ink-3)"></span></label>' +
          '<label style="display:flex;flex-direction:column;gap:5px"><span style="font:var(--w-med) var(--t-micro)/1 var(--font-ui);letter-spacing:var(--ls-wide);text-transform:uppercase;color:var(--ink-3)">Vehicle number</span><input id="ra-dv" type="text" placeholder="e.g. TN-22-0001" class="fld"></label>' +
          '<label style="display:flex;flex-direction:column;gap:5px"><span style="font:var(--w-med) var(--t-micro)/1 var(--font-ui);letter-spacing:var(--ls-wide);text-transform:uppercase;color:var(--ink-3)">Dispatch date</span><input id="ra-dd" type="date" value="' + new Date().toISOString().slice(0, 10) + '" class="fld"></label>' +
          '<div id="ra-derr" style="min-height:16px;font-size:12.5px;color:var(--red);font-weight:600"></div>' +
          '<button type="submit" id="ra-dsave" class="btn p" style="width:100%;justify-content:center">Dispatch</button>' +
          // Irreversible-action language up front (Addendum §10) — no separate hidden reason.
          '<div style="font:var(--w-reg) var(--t-cap)/1.35 var(--font-ui);color:var(--ink-3);text-align:center">Dispatching commits stock and cannot be undone from this screen.</div>'
        : '<div class="empty"><h3>Nothing to dispatch yet</h3><p>No finished-good stock is available to dispatch. Produce or release stock first, then try again.</p></div>');
    var d = openMfgSheet('Dispatch order', '<form id="ra-dform" style="display:flex;flex-direction:column;gap:12px">' + body + '</form>');
    if (!batches.length) return;
    function syncHint() { var b = byId[$('ra-dfg').value]; if (b) { $('ra-dhint').textContent = 'Available in this batch: ' + b.availableQty; $('ra-dq').setAttribute('max', b.availableQty); } }
    $('ra-dfg').onchange = syncHint; syncHint();
    $('ra-dform').onsubmit = function (e) {
      e.preventDefault();
      var b = byId[$('ra-dfg').value]; if (!b) { $('ra-derr').textContent = 'Pick a batch.'; return; }
      var qty = Number($('ra-dq').value);
      if (!(qty > 0)) { $('ra-derr').textContent = 'Enter a quantity.'; return; }
      if (qty > Number(b.availableQty)) { $('ra-derr').textContent = 'Only ' + b.availableQty + ' available in this batch.'; return; }
      if (!window.confirm('Dispatch ' + qty + ' unit(s) of batch ' + (b.batchNumber || String(b.finishedGoodBatchId).slice(0, 8)) + ' for ' + (row.soNumber || 'this order') + '? This commits stock and cannot be undone from here.')) return;
      var body = { salesOrderId: row.salesOrderId, customerId: row.customerId, dispatchDate: $('ra-dd').value || null, vehicleNumber: $('ra-dv').value || null, items: [{ finishedGoodBatchId: b.finishedGoodBatchId, dispatchedQty: qty, uomId: b.uomId || undefined }] };
      var save = $('ra-dsave'); save.disabled = true; save.textContent = 'Dispatching…';
      tunnel('/v1/dispatches', { method: 'POST', body: body }).then(function (res) {
        if (res.status >= 400) { save.disabled = false; save.textContent = 'Dispatch'; $('ra-derr').textContent = (res.json && res.json.error && res.json.error.message) || ('Failed (' + res.status + ')'); return; }
        d.close(); toast('Dispatched ✓', 'good'); loadView();
      }).catch(function () { save.disabled = false; save.textContent = 'Dispatch'; $('ra-derr').textContent = 'Could not reach the secure channel.'; });
    };
  }
  // delivery confirmation — the last flow stage (dispatch → delivered).
  function markDelivered(row) {
    var id = row.dispatchId != null ? row.dispatchId : guessId(row);
    tunnel('/v1/masters/dispatches/' + id, { method: 'PATCH', body: { status: 'DELIVERED' } }).then(function (res) {
      if (res.status >= 400) { toast((res.json && res.json.error && res.json.error.message) || 'Failed', 'bad'); return; }
      toast('Marked delivered ✓', 'good'); loadView();
    }).catch(function () { toast('Could not reach the secure channel', 'bad'); });
  }
  // Build a scannable QR (byte mode, ECC-M) as an inline SVG using the vendored qrcode generator.
  function qrSvg(text, cell) {
    if (typeof qrcode === 'undefined') return '';
    try { var q = qrcode(0, 'M'); q.addData(String(text)); q.make(); return q.createSvgTag({ cellSize: cell || 6, margin: (cell || 6) * 2, scalable: true }); }
    catch (e) { return ''; }
  }
  // Open a print-ready label window: QR (encoding the traceable payload) + human-readable code.
  // In-page QR preview: renders the scannable code inline (on a white tile so it scans regardless
  // of theme) with the human code + a Print button. Print still opens a clean print-ready window.
  // Scanner-friendly (Addendum §10): the human-readable code sits in a monospace field a barcode
  // scanner's keyboard-wedge input can land on/select, right below the QR it re-encodes.
  function openQrLabel(title, code, payload, sub) {
    var svg = qrSvg(payload, 6);
    if (!svg) { toast('QR generator not loaded — hard-refresh the page.', 'bad'); return; }
    var body = '<div style="text-align:center;display:flex;flex-direction:column;gap:10px">' +
      '<div style="width:220px;height:220px;margin:0 auto;background:#fff;border-radius:var(--r-md);padding:12px;box-sizing:border-box;box-shadow:0 0 0 1px var(--line) inset"><div id="ra-qrbox" style="width:100%;height:100%">' + svg + '</div></div>' +
      '<input id="ra-qrcode" class="fld" readonly value="' + escHtml(code) + '" style="text-align:center;font-family:var(--font-mono);font-weight:800;letter-spacing:.03em;font-size:16px" aria-label="Scannable code (also selectable for a keyboard-wedge scanner)">' +
      '<div style="font:var(--w-reg) var(--t-cap)/1.35 var(--font-ui);color:var(--ink-3)">' + escHtml(sub) + '</div>' +
      '<button type="button" id="ra-qrprint" class="btn p" style="justify-content:center">Print label</button></div>';
    var d = openMfgSheet(title, body, '330px');
    var svgEl = d.sheet.querySelector('#ra-qrbox svg'); if (svgEl) { svgEl.style.width = '100%'; svgEl.style.height = '100%'; svgEl.style.display = 'block'; }
    $('ra-qrprint').onclick = function () { printQrLabel(title, code, svg, sub); };
  }
  function printQrLabel(title, code, svg, sub) {
    var w = window.open('', '_blank', 'width=420,height=580');
    if (!w) { toast('Allow pop-ups to print the QR label (the preview above is still scannable).', 'warn'); return; }
    var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; }); };
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title>' +
      '<style>body{font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:26px;margin:0;color:#141413}' +
      '.qr{width:250px;height:250px;margin:0 auto 10px}.qr svg{width:100%;height:100%}' +
      '.code{font-family:ui-monospace,Menlo,monospace;font-size:22px;font-weight:800;letter-spacing:.04em;margin:6px 0 2px}' +
      '.sub{color:#66665E;font-size:13px}.brand{margin-top:18px;font-size:10px;letter-spacing:.22em;color:#66665E}' +
      '@media print{@page{margin:8mm}}</style></head><body>' +
      '<div class="qr">' + svg + '</div><div class="code">' + esc(code) + '</div><div class="sub">' + esc(sub) + '</div>' +
      '<div class="brand">RAW AROMACHEM</div>' +
      '<scr' + 'ipt>window.onload=function(){setTimeout(function(){window.print();},180);};</scr' + 'ipt>' +
      '</body></html>');
    w.document.close();
  }
  // Record QC results (physical/technical parameters, each Pass/Fail). Coded/masked context only
  // — this never receives or displays formula composition (V4 §106/§108); it posts against a
  // qc-parameter catalogue and an inspection id, nothing formula-shaped ever enters this form.
  function openRecordQc(inspection) {
    var iid = inspection.qcInspectionId != null ? inspection.qcInspectionId : guessId(inspection);
    var params = [];
    var body = '<div style="font:var(--w-reg) var(--t-cap)/1.35 var(--font-ui);color:var(--ink-3)">Physical (color/odor/clarity) → text · Technical (density/solubility…) → value. Each line marked Pass/Fail.</div>' +
      '<div id="ra-qlines" style="display:flex;flex-direction:column;gap:8px"></div>' +
      '<button type="button" id="ra-qadd" class="btn sm" style="align-self:flex-start">+ Add parameter</button>' +
      '<div id="ra-qerr" style="min-height:16px;font-size:12.5px;color:var(--red);font-weight:600"></div>' +
      '<button type="submit" id="ra-qsave" class="btn p" style="width:100%;justify-content:center">Save results</button>';
    var d = openMfgSheet('Record QC results', '<form id="ra-qform" style="display:flex;flex-direction:column;gap:12px">' + body + '</form>', '640px');
    var linesEl = d.sheet.querySelector('#ra-qlines');
    function paramOptions() { return '<option value="">Parameter…</option>' + params.map(function (p) { var v = p.qcParameterId != null ? p.qcParameterId : guessId(p); return v ? '<option value="' + v + '">' + (p.parameterName || p.parameterCode || String(v).slice(0, 8)) + '</option>' : ''; }).join(''); }
    function addLine() {
      var row = document.createElement('div'); row.className = 'ra-qline'; row.style.cssText = 'display:flex;gap:7px;align-items:center;flex-wrap:wrap';
      row.innerHTML = '<div style="flex:2;min-width:150px"><select data-param class="fld">' + paramOptions() + '</select></div>' +
        '<div style="flex:1;min-width:70px"><input data-val type="number" step="0.0001" placeholder="Value" class="fld"></div>' +
        '<div style="flex:1.4;min-width:90px"><input data-text placeholder="Observation" class="fld"></div>' +
        '<div style="flex:1;min-width:80px"><select data-res class="fld"><option value="PASS">PASS</option><option value="FAIL">FAIL</option></select></div>' +
        '<button type="button" class="ra-qrm xp" aria-label="Remove parameter" style="flex:none">&times;</button>';
      linesEl.appendChild(row); row.querySelector('.ra-qrm').onclick = function () { row.remove(); };
    }
    tunnel('/v1/qc-parameters?limit=100').then(function (res) { params = (res.json && res.json.data) || []; [].forEach.call(linesEl.querySelectorAll('[data-param]'), function (s) { s.innerHTML = paramOptions(); }); });
    addLine();
    $('ra-qadd').onclick = addLine;
    $('ra-qform').onsubmit = function (e) {
      e.preventDefault(); var results = [], err = '';
      [].forEach.call(d.sheet.querySelectorAll('.ra-qline'), function (row) {
        var pid = row.querySelector('[data-param]').value;
        var val = row.querySelector('[data-val]').value;
        var txt = row.querySelector('[data-text]').value.trim();
        var res = row.querySelector('[data-res]').value;
        if (!pid) { if (val || txt) err = 'Pick a parameter for each row.'; return; }
        if (val === '' && !txt) { err = 'Each parameter needs a value or an observation.'; return; }
        var r = { qcParameterId: pid, result: res };
        if (val !== '') r.observedValue = val;
        if (txt) r.observedText = txt;
        results.push(r);
      });
      if (!results.length) err = err || 'Add at least one parameter reading.';
      if (err) { $('ra-qerr').textContent = err; return; }
      var save = $('ra-qsave'); save.disabled = true; save.textContent = 'Saving…';
      tunnel('/v1/qc-inspections/' + iid + '/results', { method: 'POST', body: { results: results } }).then(function (res) {
        if (res.status >= 400) { save.disabled = false; save.textContent = 'Save results'; $('ra-qerr').textContent = (res.json && res.json.error && res.json.error.message) || ('Failed (' + res.status + ')'); return; }
        d.close(); toast('QC results recorded ✓', 'good'); loadView();
      }).catch(function () { save.disabled = false; save.textContent = 'Save results'; $('ra-qerr').textContent = 'Could not reach the secure channel.'; });
    };
  }
