/* RAW AROMA — ws-vault module: formulas, formula-versions, formula-access-audit views.
 * Lane U4 will move these out to a separate non-PWA Formula Vault console; this file only
 * isolates them for now. Depends on globals defined in shell.js (loaded first): tunnel, $,
 * fStyle, toast, setTheme, loadView, guessId. Mechanical extract — no behaviour change. */
'use strict';
  /* attach an IFRA (or IFRA conformity) certificate to a formula — one-click from the formula row.
   * Generated externally from the composition; stored + expiry-tracked here, linked to the formula. */
  function openAttachIfra(formula) {
    var fid = formula.formulaId != null ? formula.formulaId : guessId(formula);
    var fname = formula.formulaName || formula.formulaCode || 'formula';
    var fields = [
      { n: 'referenceNo', l: 'Certificate no.', t: 'text', req: true },
      { n: 'sourceUrl', l: 'Certificate link (URL / drive)', t: 'text' },
      { n: 'issueDate', l: 'Issue date', t: 'date' }, { n: 'expiryDate', l: 'Valid until', t: 'date' },
      { n: 'notes', l: 'Notes (category, IFRA amendment…)', t: 'textarea' }
    ];
    var rows = fields.map(function (f) {
      var ctrl = f.t === 'textarea' ? '<textarea data-name="' + f.n + '" rows="2" style="' + fStyle() + ';resize:vertical"></textarea>' : '<input data-name="' + f.n + '" type="' + (f.t === 'date' ? 'date' : 'text') + '" style="' + fStyle() + '">';
      return '<div style="margin-bottom:13px"><label style="display:block;font-size:12px;font-weight:700;color:var(--t2);margin-bottom:6px">' + f.l + (f.req ? ' <span style="color:var(--red)">*</span>' : '') + '</label>' + ctrl + '</div>';
    }).join('');
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:250;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = '<form id="ra-iform" style="width:100%;max-width:440px;max-height:88vh;overflow:auto;background:var(--surface);border:1px solid var(--cbord);backdrop-filter:var(--cblur);border-radius:var(--r-xl);box-shadow:var(--rai);padding:24px 26px">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px"><div style="font-weight:800;font-size:17px;flex:1">Attach IFRA certificate</div><button type="button" id="ra-iclose" style="border:none;background:var(--well);box-shadow:var(--ins-sm);color:var(--t2);width:32px;height:32px;border-radius:var(--r-sm);cursor:pointer;font-size:17px">&times;</button></div>' +
      '<div style="font-size:12.5px;color:var(--t3);margin-bottom:16px">Formula: ' + fname + '</div>' + rows +
      '<div id="ra-ierr" style="min-height:16px;font-size:12.5px;color:var(--red);font-weight:600;margin:2px 0 10px"></div>' +
      '<button type="submit" id="ra-isave" style="width:100%;padding:13px;border:none;border-radius:var(--r-md);background:var(--accent);color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:var(--rai-sm)">Attach certificate</button></form>';
    document.body.appendChild(ov); setTheme();
    function close() { if (ov.parentNode) ov.remove(); }
    $('ra-iclose').onclick = close; ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    $('ra-iform').onsubmit = function (e) {
      e.preventDefault();
      var body = { title: 'IFRA Certificate — ' + fname, documentType: 'IFRA Certificate', entityType: 'formula', entityId: fid };
      var err = '';
      fields.forEach(function (f) { var el = ov.querySelector('[data-name="' + f.n + '"]'); var v = el ? String(el.value).trim() : ''; if (f.req && !v) err = err || (f.l + ' is required.'); if (v) body[f.n] = v; });
      if (err) { $('ra-ierr').textContent = err; return; }
      var save = $('ra-isave'); save.disabled = true; save.textContent = 'Attaching…';
      tunnel('/v1/document-registry', { method: 'POST', body: body }).then(function (res) {
        if (res.status >= 400) { save.disabled = false; save.textContent = 'Attach certificate'; $('ra-ierr').textContent = (res.json && res.json.error && res.json.error.message) || ('Failed (' + res.status + ')'); return; }
        close(); toast('IFRA certificate attached ✓', 'good');
      }).catch(function () { save.disabled = false; save.textContent = 'Attach certificate'; $('ra-ierr').textContent = 'Could not reach the secure channel.'; });
    };
  }
  /* seal ingredients into a formula version (material + percentage) — the actual/alias mapping.
   * The sensitive pair (real materialId + %) lives only in this request; the vault encrypts it. */
  function openAddIngredients(version) {
    var vid = version.formulaVersionId != null ? version.formulaVersionId : guessId(version);
    var mats = [];
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:250;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = '<form id="ra-gform" style="width:100%;max-width:520px;max-height:90vh;overflow:auto;background:var(--surface);border:1px solid var(--cbord);backdrop-filter:var(--cblur);border-radius:var(--r-xl);box-shadow:var(--rai);padding:24px 26px">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px"><div style="font-weight:800;font-size:17px;flex:1">Seal ingredients</div><button type="button" id="ra-gclose" style="border:none;background:var(--well);box-shadow:var(--ins-sm);color:var(--t2);width:32px;height:32px;border-radius:var(--r-sm);cursor:pointer;font-size:17px">&times;</button></div>' +
      '<div style="font-size:12.5px;color:var(--t3);margin-bottom:14px">Formula version · real material + % (encrypted into the vault)</div>' +
      '<div id="ra-glines"></div><button type="button" id="ra-gadd" style="padding:6px 12px;border:none;border-radius:var(--r-sm);background:var(--well);box-shadow:var(--ins-sm);color:var(--accent);font-size:12px;font-weight:700;cursor:pointer;margin-top:4px">+ Add ingredient</button>' +
      '<div id="ra-gerr" style="min-height:16px;font-size:12.5px;color:var(--red);font-weight:600;margin:10px 0"></div>' +
      '<button type="submit" id="ra-gsave" style="width:100%;padding:13px;border:none;border-radius:var(--r-md);background:var(--accent);color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:var(--rai-sm)">Seal into vault</button></form>';
    document.body.appendChild(ov); setTheme();
    var linesEl = ov.querySelector('#ra-glines');
    function matOptions() { return '<option value="">Select material…</option>' + mats.map(function (m) { var v = m.materialId != null ? m.materialId : guessId(m); return v ? '<option value="' + v + '">' + (m.materialCode || m.materialName || String(v).slice(0, 8)) + '</option>' : ''; }).join(''); }
    function addLine() {
      var row = document.createElement('div'); row.className = 'ra-gline'; row.style.cssText = 'display:flex;gap:7px;align-items:center;margin-bottom:8px';
      row.innerHTML = '<div style="flex:2"><select data-mat style="' + fStyle() + '">' + matOptions() + '</select></div><div style="flex:1"><input data-pct type="number" step="0.01" placeholder="%" style="' + fStyle() + '"></div><button type="button" class="ra-grm" style="border:none;background:var(--well);box-shadow:var(--ins-sm);color:var(--red);width:30px;height:30px;border-radius:var(--r-sm);cursor:pointer;flex:none">&times;</button>';
      linesEl.appendChild(row); row.querySelector('.ra-grm').onclick = function () { row.remove(); };
    }
    tunnel('/v1/materials?limit=100').then(function (res) { mats = (res.json && res.json.data) || []; [].forEach.call(linesEl.querySelectorAll('[data-mat]'), function (s) { s.innerHTML = matOptions(); }); });
    addLine();
    function close() { if (ov.parentNode) ov.remove(); }
    $('ra-gclose').onclick = close; ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    $('ra-gadd').onclick = addLine;
    $('ra-gform').onsubmit = function (e) {
      e.preventDefault(); var ings = [], err = '', seq = 1;
      [].forEach.call(ov.querySelectorAll('.ra-gline'), function (row) {
        var mid = row.querySelector('[data-mat]').value; var pct = Number(row.querySelector('[data-pct]').value);
        if (mid && pct > 0) ings.push({ materialId: mid, percentage: pct, sequenceNo: seq++ });
        else if (mid || row.querySelector('[data-pct]').value) err = 'Each ingredient needs a material and a % > 0.';
      });
      if (!ings.length) err = err || 'Add at least one ingredient.';
      if (err) { $('ra-gerr').textContent = err; return; }
      var save = $('ra-gsave'); save.disabled = true; save.textContent = 'Sealing…';
      tunnel('/v1/formula-versions/' + vid + '/ingredients', { method: 'POST', body: { ingredients: ings } }).then(function (res) {
        if (res.status >= 400) { save.disabled = false; save.textContent = 'Seal into vault'; $('ra-gerr').textContent = (res.json && res.json.error && res.json.error.message) || ('Failed (' + res.status + ')'); return; }
        close(); toast('Ingredients sealed ✓', 'good'); loadView();
      }).catch(function () { save.disabled = false; save.textContent = 'Seal into vault'; $('ra-gerr').textContent = 'Could not reach the secure channel.'; });
    };
  }
