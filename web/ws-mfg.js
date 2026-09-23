/* RAW AROMA — ws-mfg module: QC, Production/Compounding/Filling, Packaging, Dispatch/Sales
 * view renderers/specials. Depends on globals defined in shell.js (loaded first): tunnel,
 * $, fStyle, toast, setTheme, loadView, guessId, escHtml. Mechanical extract — no behaviour
 * change. */
'use strict';
  // Dispatch a confirmed sales order: pick an FG batch that actually has stock (FEFO, avail > 0)
  // and a real quantity. The server re-checks available (produced − reserved − already dispatched)
  // and rejects over-dispatch (409). One line per dispatch here; add more via the Dispatches list.
  async function openDispatch(row) {
    var res0;
    try { res0 = await tunnel('/v1/fg-stock?onlyAvailable=1&limit=100'); }
    catch (e) { toast('Could not reach the secure channel', 'bad'); return; }
    var batches = (res0.json && res0.json.data) || [];
    var byId = {}; batches.forEach(function (b) { byId[b.finishedGoodBatchId] = b; });
    var opts = batches.map(function (b) {
      return '<option value="' + b.finishedGoodBatchId + '">' + (b.batchNumber || String(b.finishedGoodBatchId).slice(0, 8)) + (b.skuCode ? ' · ' + b.skuCode : '') + ' · avail ' + b.availableQty + '</option>';
    }).join('');
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:250;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = '<form id="ra-dform" style="width:100%;max-width:420px;background:var(--surface);border:1px solid var(--cbord);backdrop-filter:var(--cblur);border-radius:22px;box-shadow:var(--rai);padding:24px 26px">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px"><div style="font-weight:800;font-size:17px;flex:1">Dispatch order</div><button type="button" id="ra-dclose" style="border:none;background:var(--well);box-shadow:var(--ins-sm);color:var(--t2);width:32px;height:32px;border-radius:10px;cursor:pointer;font-size:17px">&times;</button></div>' +
      '<div style="font-size:12.5px;color:var(--t3);margin-bottom:16px">' + (row.soNumber || 'Sales order') + ' → ship finished goods. Only batches with available stock are listed.</div>' +
      (batches.length
        ? '<label style="display:block;font-size:12px;font-weight:700;color:var(--t2);margin-bottom:6px">Finished-good batch <span style="color:#C0492E">*</span></label><select id="ra-dfg" style="' + fStyle() + '">' + opts + '</select>' +
          '<label style="display:block;font-size:12px;font-weight:700;color:var(--t2);margin:12px 0 6px">Dispatch qty <span style="color:#C0492E">*</span></label><input id="ra-dq" type="number" min="1" value="1" style="' + fStyle() + '"><div id="ra-dhint" style="font-size:11px;color:var(--t3);margin-top:4px"></div>' +
          '<label style="display:block;font-size:12px;font-weight:700;color:var(--t2);margin:12px 0 6px">Vehicle number</label><input id="ra-dv" type="text" placeholder="e.g. TN-22-0001" style="' + fStyle() + '">' +
          '<label style="display:block;font-size:12px;font-weight:700;color:var(--t2);margin:12px 0 6px">Dispatch date</label><input id="ra-dd" type="date" value="' + new Date().toISOString().slice(0, 10) + '" style="' + fStyle() + '">' +
          '<div id="ra-derr" style="min-height:16px;font-size:12.5px;color:#C0492E;font-weight:600;margin:8px 0 10px"></div>' +
          '<button type="submit" id="ra-dsave" style="width:100%;padding:13px;border:none;border-radius:14px;background:var(--accent);color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:var(--rai-sm)">Dispatch</button>'
        : '<div style="font-size:13px;color:#9A6B1E;background:var(--well);border-radius:12px;padding:14px;text-align:center">No finished-good stock is available to dispatch. Produce or release stock first.</div>') +
      '</form>';
    document.body.appendChild(ov); setTheme();
    function close() { if (ov.parentNode) ov.remove(); }
    $('ra-dclose').onclick = close; ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    if (!batches.length) return;
    function syncHint() { var b = byId[$('ra-dfg').value]; if (b) { $('ra-dhint').textContent = 'Available in this batch: ' + b.availableQty; $('ra-dq').setAttribute('max', b.availableQty); } }
    $('ra-dfg').onchange = syncHint; syncHint();
    $('ra-dform').onsubmit = function (e) {
      e.preventDefault();
      var b = byId[$('ra-dfg').value]; if (!b) { $('ra-derr').textContent = 'Pick a batch.'; return; }
      var qty = Number($('ra-dq').value);
      if (!(qty > 0)) { $('ra-derr').textContent = 'Enter a quantity.'; return; }
      if (qty > Number(b.availableQty)) { $('ra-derr').textContent = 'Only ' + b.availableQty + ' available in this batch.'; return; }
      var body = { salesOrderId: row.salesOrderId, customerId: row.customerId, dispatchDate: $('ra-dd').value || null, vehicleNumber: $('ra-dv').value || null, items: [{ finishedGoodBatchId: b.finishedGoodBatchId, dispatchedQty: qty, uomId: b.uomId || undefined }] };
      var save = $('ra-dsave'); save.disabled = true; save.textContent = 'Dispatching…';
      tunnel('/v1/dispatches', { method: 'POST', body: body }).then(function (res) {
        if (res.status >= 400) { save.disabled = false; save.textContent = 'Dispatch'; $('ra-derr').textContent = (res.json && res.json.error && res.json.error.message) || ('Failed (' + res.status + ')'); return; }
        close(); toast('Dispatched ✓', 'good'); loadView();
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
  // In-page QR preview: renders the scannable code inline (on a white tile so it scans in any
  // theme) with the human code + a Print button. Print still opens a clean print-ready window.
  function openQrLabel(title, code, payload, sub) {
    var svg = qrSvg(payload, 6);
    if (!svg) { toast('QR generator not loaded — hard-refresh the page.', 'bad'); return; }
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:250;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = '<div style="width:100%;max-width:330px;background:var(--surface);border:1px solid var(--cbord);backdrop-filter:var(--cblur);border-radius:22px;box-shadow:var(--rai);padding:22px 24px;text-align:center">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px"><div style="font-weight:800;font-size:15px;flex:1;text-align:left">' + escHtml(title) + '</div>' +
      '<button type="button" id="ra-qrclose" style="border:none;background:var(--well);box-shadow:var(--ins-sm);color:var(--t2);width:30px;height:30px;border-radius:10px;cursor:pointer;font-size:16px;line-height:1">&times;</button></div>' +
      '<div style="width:220px;height:220px;margin:6px auto 4px;background:#fff;border-radius:12px;padding:12px;box-sizing:border-box;box-shadow:var(--ins-sm)"><div id="ra-qrbox" style="width:100%;height:100%">' + svg + '</div></div>' +
      '<div style="font-family:\'JetBrains Mono\',monospace;font-size:18px;font-weight:800;letter-spacing:.03em;margin:10px 0 2px;color:var(--t1);word-break:break-all">' + escHtml(code) + '</div>' +
      '<div style="font-size:12px;color:var(--t3);margin-bottom:15px">' + escHtml(sub) + '</div>' +
      '<button type="button" id="ra-qrprint" style="width:100%;padding:11px;border:none;border-radius:13px;background:var(--accent);color:#fff;font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:var(--rai-sm)">Print label</button></div>';
    document.body.appendChild(ov); setTheme();
    var svgEl = ov.querySelector('#ra-qrbox svg'); if (svgEl) { svgEl.style.width = '100%'; svgEl.style.height = '100%'; svgEl.style.display = 'block'; }
    function close() { if (ov.parentNode) ov.remove(); }
    $('ra-qrclose').onclick = close; ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    $('ra-qrprint').onclick = function () { printQrLabel(title, code, svg, sub); };
  }
  function printQrLabel(title, code, svg, sub) {
    var w = window.open('', '_blank', 'width=420,height=580');
    if (!w) { toast('Allow pop-ups to print the QR label (the preview above is still scannable).', 'warn'); return; }
    var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; }); };
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title>' +
      '<style>body{font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:26px;margin:0;color:#111}' +
      '.qr{width:250px;height:250px;margin:0 auto 10px}.qr svg{width:100%;height:100%}' +
      '.code{font-family:ui-monospace,Menlo,monospace;font-size:22px;font-weight:800;letter-spacing:.04em;margin:6px 0 2px}' +
      '.sub{color:#555;font-size:13px}.brand{margin-top:18px;font-size:10px;letter-spacing:.22em;color:#999}' +
      '@media print{@page{margin:8mm}}</style></head><body>' +
      '<div class="qr">' + svg + '</div><div class="code">' + esc(code) + '</div><div class="sub">' + esc(sub) + '</div>' +
      '<div class="brand">RAW AROMACHEM</div>' +
      '<scr' + 'ipt>window.onload=function(){setTimeout(function(){window.print();},180);};</scr' + 'ipt>' +
      '</body></html>');
    w.document.close();
  }
  function openRecordQc(inspection) {
    var iid = inspection.qcInspectionId != null ? inspection.qcInspectionId : guessId(inspection);
    var params = [];
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:250;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = '<form id="ra-qform" style="width:100%;max-width:640px;max-height:90vh;overflow:auto;background:var(--surface);border:1px solid var(--cbord);backdrop-filter:var(--cblur);border-radius:22px;box-shadow:var(--rai);padding:24px 26px">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px"><div style="font-weight:800;font-size:17px;flex:1">Record QC results</div><button type="button" id="ra-qclose" style="border:none;background:var(--well);box-shadow:var(--ins-sm);color:var(--t2);width:32px;height:32px;border-radius:10px;cursor:pointer;font-size:17px">&times;</button></div>' +
      '<div style="font-size:12.5px;color:var(--t3);margin-bottom:14px">Physical (color/odor/clarity) → text · Technical (density/solubility…) → value. Each line marked Pass/Fail.</div>' +
      '<div id="ra-qlines"></div><button type="button" id="ra-qadd" style="padding:6px 12px;border:none;border-radius:9px;background:var(--well);box-shadow:var(--ins-sm);color:var(--accent);font-size:12px;font-weight:700;cursor:pointer;margin-top:4px">+ Add parameter</button>' +
      '<div id="ra-qerr" style="min-height:16px;font-size:12.5px;color:#C0492E;font-weight:600;margin:10px 0"></div>' +
      '<button type="submit" id="ra-qsave" style="width:100%;padding:13px;border:none;border-radius:14px;background:var(--accent);color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:var(--rai-sm)">Save results</button></form>';
    document.body.appendChild(ov); setTheme();
    var linesEl = ov.querySelector('#ra-qlines');
    function paramOptions() { return '<option value="">Parameter…</option>' + params.map(function (p) { var v = p.qcParameterId != null ? p.qcParameterId : guessId(p); return v ? '<option value="' + v + '">' + (p.parameterName || p.parameterCode || String(v).slice(0, 8)) + '</option>' : ''; }).join(''); }
    function addLine() {
      var row = document.createElement('div'); row.className = 'ra-qline'; row.style.cssText = 'display:flex;gap:7px;align-items:center;margin-bottom:8px;flex-wrap:wrap';
      row.innerHTML = '<div style="flex:2;min-width:150px"><select data-param style="' + fStyle() + '">' + paramOptions() + '</select></div>' +
        '<div style="flex:1;min-width:70px"><input data-val type="number" step="0.0001" placeholder="Value" style="' + fStyle() + '"></div>' +
        '<div style="flex:1.4;min-width:90px"><input data-text placeholder="Observation" style="' + fStyle() + '"></div>' +
        '<div style="flex:1;min-width:80px"><select data-res style="' + fStyle() + '"><option value="PASS">PASS</option><option value="FAIL">FAIL</option></select></div>' +
        '<button type="button" class="ra-qrm" style="border:none;background:var(--well);box-shadow:var(--ins-sm);color:#C0492E;width:30px;height:30px;border-radius:9px;cursor:pointer;flex:none">&times;</button>';
      linesEl.appendChild(row); row.querySelector('.ra-qrm').onclick = function () { row.remove(); };
    }
    tunnel('/v1/qc-parameters?limit=100').then(function (res) { params = (res.json && res.json.data) || []; [].forEach.call(linesEl.querySelectorAll('[data-param]'), function (s) { s.innerHTML = paramOptions(); }); });
    addLine();
    function close() { if (ov.parentNode) ov.remove(); }
    $('ra-qclose').onclick = close; ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    $('ra-qadd').onclick = addLine;
    $('ra-qform').onsubmit = function (e) {
      e.preventDefault(); var results = [], err = '';
      [].forEach.call(ov.querySelectorAll('.ra-qline'), function (row) {
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
        close(); toast('QC results recorded ✓', 'good'); loadView();
      }).catch(function () { save.disabled = false; save.textContent = 'Save results'; $('ra-qerr').textContent = 'Could not reach the secure channel.'; });
    };
  }
