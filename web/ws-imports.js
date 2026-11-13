/* RAW AROMA — ws-imports module (IMPORT-RP; owner, 13 Nov 2026: "an excel/spreadsheet template must
 * be there in the system so that users can download it fill it and upload it").
 *
 * Mounts the shared import panel (import-panel.js) where each list's single-record screen lives:
 *
 *   Materials        ingredients, dilutions, material purchase prices (+ "Record a purchase price")
 *   Suppliers        suppliers
 *   Goods receipt    supplier lots (they land in quarantine; QC releases them)
 *   Batches          opening raw stock (lands in quarantine)
 *   Adjustments      raw stock adjustments
 *   Packaging BOM    packaging materials (the factory has no packaging-materials list of its own)
 *
 * Plain classic script, loaded after shell.js: uses its globals (tunnel, st, loadView, toast, escHtml,
 * setTheme). NOTHING HERE DECIDES A PERMISSION. The button is drawn only for the kinds the server says
 * this person may run (GET /v1/imports/kinds), and the server checks every call again.
 */
'use strict';
(function () {
  var SCREENS = {
    '/v1/materials': { kinds: ['ingredients', 'dilutions', 'material-purchase-prices'], title: 'Import ingredients, dilutions and purchase prices' },
    '/v1/vendors': { kinds: ['suppliers'], title: 'Import suppliers' },
    '/v1/grns': { kinds: ['supplier-lots'], title: 'Import supplier lots' },
    '/v1/rm-batches': { kinds: ['raw-stock-opening'], title: 'Import opening raw stock' },
    '/v1/stock-adjustments': { kinds: ['raw-stock-adjustment'], title: 'Import stock adjustments' },
    '/v1/packaging-boms': { kinds: ['packaging-materials'], title: 'Import packaging materials' },
  };

  /** The console's call as the panel wants it: the answer's data, or an Error with the server's sentence. */
  function api(path, opts) {
    return tunnel(path, opts).then(function (res) {
      if (res.status >= 400) throw new Error((res.json && res.json.error && res.json.error.message) || (res.status === 403 ? 'Your role does not allow this.' : 'That did not go through. Try again in a minute.'));
      return res.json ? res.json.data : null;
    }, function () { throw new Error('Can\'t connect. Try again.'); });
  }

  /** One purchase price, typed: the same judgement and the same writer as a row of the sheet. */
  function openPrice() {
    var f = function (id, label, attrs) { return '<label style="display:flex;flex-direction:column;gap:5px"><span class="t-cap" style="color:var(--ink-3)">' + label + '</span><input class="fld" id="' + id + '" ' + (attrs || '') + '></label>'; };
    var scrim = document.createElement('div');
    scrim.className = 'xp-scrim open'; scrim.id = 'ra-price-scrim';
    scrim.innerHTML = '<form id="ra-price-form" class="glass glass-deep xp-sheet open" style="max-width:420px" role="dialog" aria-modal="true" aria-label="Record a purchase price">' +
      '<div class="xp-sheet-hd"><h2 class="t-h1" style="flex:1;min-width:0">Record a purchase price</h2><button type="button" class="xp" id="ra-price-x" aria-label="Close">' + ((window.RA_CI && window.RA_CI.x) || '&times;') + '</button></div>' +
      '<div class="xp-sheet-bd form">' +
      f('ra-price-code', 'Material code', 'required autocomplete="off"') +
      f('ra-price-list', 'List purchase price (Rs per unit)', 'required inputmode="decimal" placeholder="1250.00"') +
      f('ra-price-disc', 'Purchase discount %', 'inputmode="decimal" placeholder="0"') +
      f('ra-price-unit', 'Unit (empty: the material\'s own)', 'placeholder="kg"') +
      f('ra-price-sup', 'Supplier code (optional)', 'autocomplete="off"') +
      f('ra-price-gst', 'GST rate % (only if you hold it)', 'inputmode="decimal"') +
      f('ra-price-hsn', 'HSN code (only if you hold it)', 'inputmode="numeric"') +
      f('ra-price-from', 'Effective from', 'type="date" required') +
      f('ra-price-note', 'Note', '') +
      '<div id="ra-price-err" role="alert" style="min-height:16px;color:var(--red);font-weight:var(--w-med);overflow-wrap:anywhere"></div>' +
      '<button type="submit" class="btn p" id="ra-price-save" style="width:100%;justify-content:center">Record the price</button>' +
      '<div class="t-cap" style="color:var(--ink-3);text-align:center">A price on file is never rewritten: a later date supersedes it. Books receives each price as it is recorded.</div>' +
      '</div></form>';
    document.body.appendChild(scrim); if (typeof setTheme === 'function') setTheme();
    function close() { if (scrim.parentNode) scrim.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    document.getElementById('ra-price-x').onclick = close;
    scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
    var v = function (id) { return document.getElementById(id).value.trim(); };
    document.getElementById('ra-price-form').onsubmit = function (e) {
      e.preventDefault();
      var save = document.getElementById('ra-price-save'), err = document.getElementById('ra-price-err');
      save.disabled = true; err.textContent = '';
      api('/v1/material-purchase-prices', { method: 'POST', body: { materialCode: v('ra-price-code'), listPrice: v('ra-price-list'), discountPercent: v('ra-price-disc'), unit: v('ra-price-unit'),
        supplier: v('ra-price-sup'), gstRate: v('ra-price-gst'), hsn: v('ra-price-hsn'), effectiveFrom: v('ra-price-from'), note: v('ra-price-note') } })
        .then(function (r) { close(); toast(r && r.recorded ? 'Price recorded: net Rs ' + r.netPrice : (r && r.message) || 'Nothing changed', r && r.recorded ? 'good' : undefined); })
        .catch(function (x) { save.disabled = false; err.textContent = x.message; });
    };
    document.getElementById('ra-price-code').focus();
  }

  function mount(endpoint, view) {
    var screen = SCREENS[endpoint];
    if (!screen || !window.RaImportPanel || !view) return;
    var nav = st.nav;
    RaImportPanel.kinds(api).then(function (all) {
      if (st.nav !== nav || !document.body.contains(view) || view.querySelector('#ra-import')) return; // the person moved on, or it is already there
      var mine = screen.kinds.filter(function (k) { return all.some(function (a) { return a.kind === k; }); });
      if (!mine.length) return;
      var host = view.querySelector('.card-hd') || view.querySelector('.card.empty');
      if (!host) return;
      var b = document.createElement('button');
      b.type = 'button'; b.id = 'ra-import'; b.className = 'btn'; b.textContent = 'Import from a sheet';
      b.onclick = function () { RaImportPanel.open({ api: api, kinds: mine, title: screen.title, onCommitted: function () { if (st.nav === nav) loadView(); } }); };
      var price = null;
      if (mine.indexOf('material-purchase-prices') >= 0) {
        price = document.createElement('button');
        price.type = 'button'; price.id = 'ra-price'; price.className = 'btn'; price.textContent = 'Record a purchase price';
        price.onclick = openPrice;
      }
      var before = host.querySelector('#ra-new');
      if (host.classList.contains('empty')) { var row = document.createElement('div'); row.style.cssText = 'margin-top:var(--s-snug);display:flex;gap:8px;justify-content:center;flex-wrap:wrap'; row.appendChild(b); if (price) row.appendChild(price); host.appendChild(row); }
      else if (before) { host.insertBefore(b, before); if (price) host.insertBefore(price, before); }
      else { host.appendChild(b); if (price) host.appendChild(price); }
    });
  }

  window.RaImports = { mount: mount, api: api, screens: SCREENS };
})();
