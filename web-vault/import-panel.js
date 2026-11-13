/* RAW AROMA — import-panel.js (IMPORT-RP; the same copy in the Factory and the Vault consoles, like
 * dock.js and ruh.js). One self-contained panel for every bulk import: choose the kind (or the screen
 * fixes it), download the template or what is on file, choose a file, read the preview, import, take
 * the rows to fix, and see the earlier imports.
 *
 *   RaImportPanel.kinds(api)                      -> Promise of the kinds THIS person may run (the server's list)
 *   RaImportPanel.card({ api, kinds, title, onCommitted })   -> a .card element (empty when none is allowed)
 *   RaImportPanel.open({ api, kinds, title, onCommitted })   -> the same panel in a dialog (.xp-scrim/.xp-sheet)
 *
 * `api(path, opts)` is the console's own call: it resolves to the answer's `data` and rejects with an
 * Error whose message is the server's sentence. Nothing here calls fetch(): every byte goes through
 * the console's encrypted channel, a file included (as base64 inside the JSON the channel carries).
 *
 * WHO SEES IT. The server says which kinds a person may run (GET /v1/imports/kinds); a kind that is
 * not in that answer is not drawn at all. The console's own `can()` is not asked, because the access
 * token no longer carries the factory's permissions.
 *
 * THE FILE STAYS IN THE PAGE'S MEMORY for as long as the panel is open and is never written to
 * storage: the commit sends it again (the server refuses one that changed since the preview), and a
 * formula's rows to fix are read from it again because the Vault keeps none of them.
 *
 * Styling is the consoles' own: .card, .card-hd, .btn, .chip, .fld and the type tokens of the visual
 * contract. No colour, face or size is declared here that the contract does not name. */
(function () {
  'use strict';
  /* The channel carries one JSON body of about 1 MB (the server's default, and nginx's). A file is
     base64 inside JSON inside the sealed envelope, so about 550 KB of file is what fits today. Said
     before the upload, in a sentence, instead of failing as "can't connect". */
  var MAX_FILE_BYTES = 550 * 1024;
  var OUTCOME = { create: ['g', 'New'], update: ['g', 'Change'], skip: ['n', 'Already on file'], refuse: ['r', 'Problem'] };
  var cache = [];

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') n[k] = attrs[k];
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function when(iso) {
    var d = new Date(iso); if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function toBase64(buf) {
    var bytes = new Uint8Array(buf), out = '';
    for (var i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(out);
  }
  function save(download) {
    var bin = atob(download.base64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var url = URL.createObjectURL(new Blob([bytes], { type: download.mime }));
    var a = el('a', { href: url, download: download.fileName, style: 'display:none' });
    document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 1000);
  }
  function listOf(v) { return Array.isArray(v) ? v : (v && v.items) || []; }

  /** The kinds this person may run, asked once per console call function. */
  function kinds(api) {
    for (var i = 0; i < cache.length; i++) if (cache[i].api === api) return cache[i].p;
    var p = api('/v1/imports/kinds').then(listOf).catch(function () { return []; });
    cache.push({ api: api, p: p });
    return p;
  }

  function build(opts, root) {
    var api = opts.api, want = opts.kinds || [];
    var st = { specs: [], kind: null, file: null, base64: null, result: null, mode: 'all_or_nothing', busy: false, error: '', done: null, history: [] };
    var body = el('div', { class: 'ra-imp', style: 'display:flex;flex-direction:column;gap:var(--s-snug)' });
    root.appendChild(body);

    function spec() { for (var i = 0; i < st.specs.length; i++) if (st.specs[i].kind === st.kind) return st.specs[i]; return null; }
    function reset() { st.file = null; st.base64 = null; st.result = null; st.error = ''; st.done = null; st.mode = 'all_or_nothing'; }
    function fail(e) { st.busy = false; st.error = (e && e.message) || 'That did not go through. Try again.'; paint(); }
    function get(path, label) {
      return function () {
        st.error = ''; api(path).then(save).catch(function (e) { st.error = label + ': ' + ((e && e.message) || 'it did not download.'); paint(); });
      };
    }
    function loadHistory() {
      api('/v1/imports/history?kind=' + encodeURIComponent(st.kind)).then(function (h) { st.history = listOf(h); paint(); }).catch(function () { st.history = []; });
    }
    function pick(file) {
      reset(); if (!file) { paint(); return; }
      if (file.size > MAX_FILE_BYTES) { st.error = 'This file is ' + Math.ceil(file.size / 1024) + ' KB. A file of up to ' + Math.floor(MAX_FILE_BYTES / 1024) + ' KB can be sent from here today. Split the sheet into smaller files.'; paint(); return; }
      st.file = file; st.busy = true; paint();
      var reader = new FileReader();
      reader.onerror = function () { fail(new Error('The file could not be read from this device.')); };
      reader.onload = function () {
        st.base64 = toBase64(reader.result);
        api('/v1/imports/' + encodeURIComponent(st.kind) + '/preview', { method: 'POST', body: { fileName: file.name, fileBase64: st.base64 } })
          .then(function (r) { st.busy = false; st.result = r; paint(); loadHistory(); }).catch(fail);
      };
      reader.readAsArrayBuffer(file);
    }
    function commit() {
      st.busy = true; st.error = ''; paint();
      api('/v1/imports/jobs/' + st.result.job.importJobId + '/commit', { method: 'POST', body: { fileBase64: st.base64, mode: st.mode } })
        .then(function (r) { st.busy = false; st.done = r; st.result = r; paint(); loadHistory(); if (opts.onCommitted) opts.onCommitted(r.job); }).catch(fail);
    }
    function rowsToFix(format) {
      var s = spec();
      // A formula's rows are not kept with the import: the file is sent again and the sheet is built from it.
      var payload = s && s.secret ? { format: format, fileBase64: st.base64 } : { format: format };
      api('/v1/imports/jobs/' + st.result.job.importJobId + '/problems', { method: 'POST', body: payload }).then(save).catch(fail);
    }

    function count(tone, n, label) { return el('span', { class: 'chip ' + tone, style: 'white-space:nowrap' }, [n + ' ' + label]); }
    function rowCard(r) {
      var o = OUTCOME[r.outcome] || ['n', r.outcome];
      var words = (r.problems || []).concat(r.notes || []);
      return el('li', { class: 'ra-imp-row', 'data-outcome': r.outcome, style: 'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:10px 0;border-top:1px solid var(--line)' }, [
        el('div', { style: 'min-width:0;overflow-wrap:anywhere' }, [
          el('span', { class: 'mono', style: 'color:var(--ink-3)' }, ['Row ' + r.row + '  ']),
          el('b', {}, [r.label || r.naturalKey || '']),
        ]),
        el('span', { class: 'chip ' + o[0], style: 'justify-self:end;white-space:nowrap' }, [o[1]]),
        words.length ? el('ul', { style: 'grid-column:1 / -1;margin:0;padding-left:18px;color:var(--ink-2);overflow-wrap:anywhere' }, words.map(function (w) {
          return el('li', { style: /^Large change/.test(w) ? 'color:var(--ink);font-weight:var(--w-med)' : '' }, [w]);
        })) : null,
      ]);
    }

    function paint() {
      var s = spec();
      body.innerHTML = '';
      if (!s) { body.appendChild(el('p', { class: 'card-note', style: 'margin:0;color:var(--ink-2)' }, ['You may not import anything on this screen.'])); return; }
      if (st.specs.length > 1) {
        body.appendChild(el('div', { role: 'tablist', 'aria-label': 'What to import', style: 'display:flex;gap:6px;flex-wrap:wrap' }, st.specs.map(function (k) {
          return el('button', { type: 'button', role: 'tab', 'aria-selected': k.kind === st.kind ? 'true' : 'false', class: 'btn sm' + (k.kind === st.kind ? ' p' : ''), 'data-kind': k.kind,
            onclick: function () { st.kind = k.kind; reset(); st.history = []; paint(); loadHistory(); } }, [k.title]);
        })));
      }
      // 1. the sheet
      body.appendChild(el('div', { style: 'display:flex;flex-direction:column;gap:6px' }, [
        el('div', { style: 'font-weight:var(--w-med)' }, ['1. Get the sheet']),
        el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, [
          el('button', { type: 'button', class: 'btn sm', 'data-act': 'template-xlsx', onclick: get('/v1/imports/' + s.kind + '/template?format=xlsx', 'The template') }, ['Download the template (Excel)']),
          el('button', { type: 'button', class: 'btn sm', 'data-act': 'template-csv', onclick: get('/v1/imports/' + s.kind + '/template?format=csv', 'The template') }, ['CSV']),
          s.exportable ? el('button', { type: 'button', class: 'btn sm', 'data-act': 'export', onclick: get('/v1/imports/' + s.kind + '/export?format=xlsx', 'The export') }, ['Export what is on file']) : null,
        ]),
        el('p', { class: 'card-note', style: 'margin:0;color:var(--ink-2)' }, [s.exportable
          ? 'The export is this sheet with every record already in it: fill in the empty cells and upload it back. ' + s.rule
          : 'The template has an Instructions sheet and one example row. ' + s.rule]),
      ]));
      // 2. the file
      var input = el('input', { type: 'file', class: 'fld', accept: '.xlsx,.csv,text/csv', 'aria-label': 'Choose the filled-in sheet', 'data-act': 'file', onchange: function (e) { pick(e.target.files && e.target.files[0]); } });
      body.appendChild(el('div', { style: 'display:flex;flex-direction:column;gap:6px' }, [
        el('div', { style: 'font-weight:var(--w-med)' }, ['2. Upload it filled in']),
        input,
        st.file ? el('div', { class: 't-cap', style: 'color:var(--ink-3);overflow-wrap:anywhere' }, [st.file.name + ' · ' + Math.ceil(st.file.size / 1024) + ' KB' + (s.secret ? ' · read on the Vault only; its lines are not kept with the import' : '')]) : null,
      ]));
      if (st.busy) body.appendChild(el('div', { class: 'loading', role: 'status', style: 'color:var(--ink-2)' }, [st.result ? 'Importing…' : 'Reading the file…']));
      if (st.error) body.appendChild(el('div', { role: 'alert', class: 'ra-imp-err', style: 'color:var(--red);font-weight:var(--w-med);overflow-wrap:anywhere' }, [st.error]));

      // 3. the preview
      var r = st.result;
      if (r && !st.busy) {
        var job = r.job, c = st.done ? (job.written || job.counts) : job.counts;
        var box = el('div', { class: 'ra-imp-preview', style: 'display:flex;flex-direction:column;gap:8px' }, []);
        box.appendChild(el('div', { style: 'font-weight:var(--w-med)' }, [st.done ? '3. Imported' : r.alreadyImported ? '3. Already imported' : '3. Check the preview']));
        if (job.status === 'refused') {
          box.appendChild(el('div', { role: 'alert', style: 'color:var(--red);overflow-wrap:anywhere' }, [el('b', {}, ['The file was not read. ']), (job.fileProblems || []).join(' ')]));
        } else {
          if (r.alreadyImported) box.appendChild(el('div', { role: 'status', style: 'overflow-wrap:anywhere' }, ['This very file was imported on ' + when(job.committedDt || job.uploadedDt) + '. Nothing was changed by uploading it again.']));
          if (st.done) box.appendChild(el('div', { role: 'status', class: 'ra-imp-done', style: 'font-weight:var(--w-med)' }, [plural(c.create + c.update, 'row was', 'rows were') + ' imported' + (c.refuse ? ', ' + plural(c.refuse, 'row was', 'rows were') + ' left out' : '') + '.']));
          box.appendChild(el('div', { class: 'ra-imp-counts', style: 'display:flex;gap:6px;flex-wrap:wrap' }, [
            count('g', c.create + c.update, st.done ? 'imported' : 'to import'), count('n', c.skip, 'already on file'), count(c.refuse ? 'r' : 'n', c.refuse, c.refuse === 1 ? 'problem' : 'problems'),
          ]));
          if ((job.ignoredColumns || []).length) box.appendChild(el('div', { class: 't-cap', style: 'color:var(--ink-3);overflow-wrap:anywhere' }, ['Read past (not this sheet\'s columns): ' + job.ignoredColumns.join(', ')]));
          var rows = r.rows || [];
          var large = rows.filter(function (x) { return (x.notes || []).some(function (n) { return /^Large change/.test(n); }); });
          if (large.length && !st.done) {
            box.appendChild(el('div', { class: 'ra-imp-large', style: 'border-left:4px solid var(--amber);padding:6px 0 6px 12px' }, [
              el('b', {}, ['Large changes: ' + plural(large.length, 'row moves', 'rows move') + ' a price by more than the limit. Check each before you import.']),
              el('ul', { style: 'list-style:none;margin:0;padding:0' }, large.map(rowCard)),
            ]));
          }
          // Problems first, then what will be written, then what is already in; a long sheet is capped on screen.
          var order = { refuse: 0, create: 1, update: 1, skip: 2 };
          var sorted = rows.slice().sort(function (a, b) { return (order[a.outcome] - order[b.outcome]) || (a.row - b.row); });
          var CAP = 200;
          box.appendChild(el('ul', { class: 'ra-imp-rows', style: 'list-style:none;margin:0;padding:0;max-height:46vh;overflow:auto' }, sorted.slice(0, CAP).map(rowCard)));
          if (sorted.length > CAP) box.appendChild(el('div', { class: 't-cap', style: 'color:var(--ink-3)' }, ['The first ' + CAP + ' of ' + sorted.length + ' rows are shown, problems first. Every row is in the rows to fix.']));
          if (c.refuse > 0) {
            box.appendChild(el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, [
              el('button', { type: 'button', class: 'btn sm', 'data-act': 'problems-xlsx', onclick: function () { rowsToFix('xlsx'); } }, ['Download the rows to fix (Excel)']),
              el('button', { type: 'button', class: 'btn sm', 'data-act': 'problems-csv', onclick: function () { rowsToFix('csv'); } }, ['CSV']),
            ]));
          }
          if (!st.done && !r.alreadyImported && job.status === 'previewed') {
            var refusal = r.commitRefusal || {};
            var canValid = !refusal.valid_only;
            if (c.refuse > 0 && canValid) {
              box.appendChild(el('fieldset', { style: 'border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:4px' }, [
                el('legend', { class: 't-cap', style: 'color:var(--ink-3);padding:0' }, ['Some rows have a problem']),
                el('label', { style: 'display:flex;gap:8px;align-items:flex-start' }, [el('input', { type: 'radio', name: 'ra-imp-mode', value: 'all_or_nothing', checked: st.mode === 'all_or_nothing', onchange: function () { st.mode = 'all_or_nothing'; paint(); } }), 'All or nothing: fix the rows first']),
                el('label', { style: 'display:flex;gap:8px;align-items:flex-start' }, [el('input', { type: 'radio', name: 'ra-imp-mode', value: 'valid_only', checked: st.mode === 'valid_only', onchange: function () { st.mode = 'valid_only'; paint(); } }), 'Import the ' + plural(c.create + c.update, 'valid row', 'valid rows') + ' only']),
              ]));
            }
            var why = refusal[st.mode] || '';
            box.appendChild(el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, [
              el('button', { type: 'button', class: 'btn p', 'data-act': 'commit', disabled: !!why, onclick: commit }, ['Import ' + plural(c.create + c.update, 'row', 'rows')]),
              why ? el('span', { class: 'ra-imp-why', style: 'color:var(--ink-2);flex:1;min-width:200px;overflow-wrap:anywhere' }, [why]) : null,
            ]));
          }
        }
        body.appendChild(box);
      }

      // earlier imports
      if (st.history.length) {
        body.appendChild(el('details', { class: 'ra-imp-history' }, [
          el('summary', { style: 'cursor:pointer;font-weight:var(--w-med)' }, ['Earlier imports (' + st.history.length + ')']),
          el('ul', { style: 'list-style:none;margin:6px 0 0;padding:0' }, st.history.slice(0, 20).map(function (j) {
            var w = j.written || j.counts;
            var state = j.status === 'committed' ? plural(w.create + w.update, 'row', 'rows') + ' imported' + (w.refuse ? ', ' + w.refuse + ' left out' : '')
              : j.status === 'refused' ? 'not read' : 'previewed, not imported';
            return el('li', { style: 'padding:6px 0;border-top:1px solid var(--line);overflow-wrap:anywhere' }, [
              el('span', {}, [when(j.committedDt || j.uploadedDt) + ' · ']), el('b', {}, [j.fileName || 'a file']), ' · ' + state + (j.uploadedByName ? ' · ' + j.uploadedByName : ''),
            ]);
          })),
        ]));
      }
    }

    body.appendChild(el('div', { class: 'loading', style: 'color:var(--ink-2)' }, ['Loading…']));
    return kinds(api).then(function (all) {
      st.specs = all.filter(function (k) { return want.indexOf(k.kind) >= 0; }).sort(function (a, b) { return want.indexOf(a.kind) - want.indexOf(b.kind); });
      st.kind = st.specs.length ? st.specs[0].kind : null;
      paint(); if (st.kind) loadHistory();
      return st.specs.length;
    });
  }

  /** A card to place on a screen. It removes itself when the person may run none of the kinds. */
  function card(opts) {
    var c = el('div', { class: 'card ra-imp-card', 'data-import-kinds': (opts.kinds || []).join(',') }, [
      el('div', { class: 'card-hd' }, [el('h2', {}, [opts.title || 'Import from a sheet'])]),
    ]);
    build(opts, c).then(function (n) { if (!n && c.parentNode) c.remove(); });
    return c;
  }

  /** The panel in a dialog (the consoles' own .xp-scrim/.xp-sheet). Escape and the cross close it. */
  function open(opts) {
    var scrim = el('div', { class: 'xp-scrim open', id: 'ra-imp-scrim' });
    var bd = el('div', { class: 'xp-sheet-bd' });
    var x = el('button', { type: 'button', class: 'xp', 'aria-label': 'Close' }, []);
    x.innerHTML = (window.RA_CI && window.RA_CI.x) || '&times;';
    var sheet = el('div', { class: 'glass glass-deep xp-sheet open', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || 'Import from a sheet', style: 'max-width:640px;width:100%' }, [
      el('div', { class: 'xp-sheet-hd' }, [el('h2', { class: 't-h1', style: 'flex:1;min-width:0' }, [opts.title || 'Import from a sheet']), x]), bd,
    ]);
    scrim.appendChild(sheet);
    function close() { if (scrim.parentNode) scrim.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    x.onclick = close;
    scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(scrim);
    if (typeof window.setTheme === 'function') window.setTheme();
    build(opts, bd);
    return close;
  }

  window.RaImportPanel = { kinds: kinds, card: card, open: open, MAX_FILE_BYTES: MAX_FILE_BYTES };
})();
