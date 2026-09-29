/* RAW AROMA — ws-produce module (lane produce, owner requirement + decisions 2026-09-29):
 * "Factory and every console must get alerts to PRODUCE based on FIFO + high-value orders first,
 * with the formula shown MASKED, QC certification, labelling, rack numbers on the physical shelves,
 * alerts and counters."
 *
 *   Produce next   the ranked production queue (ALEMBIC's priority.rank, then need-by, then arrival),
 *                  counters, one-click "Plan run" (creates or extends a master run from the Vault's
 *                  approved formula — shown as CODE + VERSION only), the coded manufacturing
 *                  instruction for roles that weigh/dispense, and a plain blocking reason when no
 *                  approved formula exists.
 *   Put-away & pick  scan-first: scan a task QR (or type PA-12), then scan the bin. Ready-for-put-away
 *                  FG, open put-aways and picks, orders to pick (FIFO), moves, printed sheets in rack
 *                  walking order (A4 and 80 mm thermal, with QR).
 *   Rack layout    racks entered in the app: one line per rack (zone, rack, shelves, bins), Enter to
 *                  save and move to the next rack; CSV import; walk order; printable bin QR labels.
 *   Shelf display  big type for a TV/tablet at the shelves: what to put away / pick, where, next
 *                  items, lit bins (the pick-to-light simulator), refreshed every 5 s. #shelf=ZONE
 *                  opens it straight away.
 *   Labels         FG label print (browser print / PDF) at label-printer sizes: 100×50 mm,
 *                  100×150 mm (4×6"), 62 mm continuous, and an A4 sheet.
 *   Alerts         the /v1/produce/alerts feed is polled every 20 s: a toast + sound per new alert.
 *
 * Plain classic script (see index.html): uses shell.js's globals (tunnel, $, toast, escHtml, can,
 * kpi, icon, gCard, openSheet, raConfirm, ROLES, ACTIONS, RA_VIEWS, session, st, navTo, loadView,
 * loadAlerts) and qrcode.js's `qrcode`. Everything it shows comes from the server; nothing here
 * decides a permission (the server re-checks every call).
 */
'use strict';
(function () {
  var PV = {}; // this module's state

  function err(res, fallback) { return (res && res.json && res.json.error && res.json.error.message) || fallback; }
  function data(res) { return (res && res.json && res.json.data); }
  function lbl(t) { return '<span style="font:var(--w-med) var(--t-cap)/1 var(--font-ui);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)">' + t + '</span>'; }
  function mono(v) { return '<span style="font-family:var(--font-mono);font-size:var(--t-cap);font-weight:var(--w-med)">' + escHtml(v) + '</span>'; }
  function muted(v) { return '<span style="color:var(--ink-3)">' + escHtml(v) + '</span>'; }
  function chip(tone, text) { return '<span class="chip ' + tone + '"><i class="dot"></i>' + escHtml(text) + '</span>'; }
  function ymd(v) { return v ? String(v).slice(0, 10) : ''; }
  function inr(n) { try { return '₹' + Number(n).toLocaleString('en-IN'); } catch (e) { return '₹' + n; } }
  function num(n) { var x = Number(n); return isFinite(x) ? String(Math.round(x * 1000) / 1000) : String(n); }
  function qrSvg(text, cell) {
    try { var q = qrcode(0, 'M'); q.addData(String(text)); q.make(); return q.createSvgTag(cell || 3, 0); } catch (e) { return ''; }
  }
  function btn(id, label, cls, attrs) { return '<button type="button" ' + (id ? 'id="' + id + '" ' : '') + 'class="btn ' + (cls || 'sm') + '"' + (attrs || '') + '>' + label + '</button>'; }
  function stale(nav) { return st.nav !== nav; }

  /* ── navigation: add the four screens to the roles that do this work ────────────────── */
  var NAV = {
    produce: ['produce', 'Produce next', 'zap', '__produce__'],
    shelftasks: ['shelftasks', 'Put-away & pick', 'boxIn', '__shelftasks__'],
    racklayout: ['racklayout', 'Rack layout', 'layout', '__racklayout__'],
    shelfdisplay: ['shelfdisplay', 'Shelf display', 'monitor', '__shelfdisplay__']
  };
  var BY_ROLE = {
    superadmin: ['produce', 'shelftasks', 'racklayout', 'shelfdisplay'],
    production: ['produce', 'shelftasks', 'shelfdisplay'],
    compounding: ['produce'],
    warehouse: ['shelftasks', 'racklayout', 'shelfdisplay'],
    packaging: ['shelftasks', 'shelfdisplay'],
    sales: ['shelftasks', 'shelfdisplay'],
    filling: ['shelfdisplay']
  };
  Object.keys(BY_ROLE).forEach(function (role) {
    var R = ROLES[role]; if (!R) return;
    var at = R.nav.length && R.nav[0][0] === 'dashboard' ? 1 : 0;
    BY_ROLE[role].forEach(function (k, i) {
      if (R.nav.some(function (n) { return n[0] === k; })) return;
      R.nav.splice(at + i, 0, NAV[k].slice());
    });
  });

  /* ── Produce next ───────────────────────────────────────────────────────────────────── */
  var STAGE = {
    TO_PLAN: ['b', 'To plan'], BLOCKED: ['r', 'Blocked'], UNKNOWN_SKU: ['r', 'Unknown SKU'], PLANNED: ['n', 'Planned'],
    IN_PRODUCTION: ['b', 'In production'], QC_PENDING: ['a', 'QC pending'], QC_FAILED: ['r', 'QC failed'],
    QC_PASSED: ['a', 'QC passed — release'], QC_RELEASED: ['g', 'QC released'], READY_FOR_PUTAWAY: ['a', 'Ready to shelve'],
    ON_SHELF: ['g', 'On the shelf']
  };
  function priorityCell(r) {
    var reason = r.priorityReason;
    var c = r.highValue ? chip('r', 'High value' + (r.orderValueInr != null ? ' · ' + inr(r.orderValueInr) : ''))
      : reason === 'promised_date' ? chip('a', 'Promised date') : reason === 'fifo' ? chip('n', 'FIFO') : chip('n', r.priorityReason || 'Normal');
    return '<div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start">' + c +
      (r.priorityRank != null ? '<span style="font:var(--w-reg) var(--t-cap)/1 var(--font-ui);color:var(--ink-3)">rank ' + escHtml(r.priorityRank) + '</span>' : '') + '</div>';
  }
  function formulaCell(f) {
    if (!f || !f.code) return muted('—');
    return '<span style="display:inline-flex;align-items:center;gap:6px" title="Formula code and version only — the recipe stays in the Vault">' + icon('lock', 12) + mono(f.code + (f.version != null ? ' v' + f.version : '')) + '</span>';
  }

  async function viewProduce(item, V) {
    V.innerHTML = '<div class="loading">Loading…</div>';
    var res;
    try { res = await tunnel('/v1/produce/queue?limit=300'); } catch (e) { V.innerHTML = errBox('Can\'t connect. Try again.'); return; }
    if (stale('produce')) return;
    if (res.status === 403) { V.innerHTML = errBox('Your role doesn\'t see the production queue.'); return; }
    if (res.status >= 400) { V.innerHTML = errBox(err(res, 'The production queue is not available (' + res.status + ').')); return; }
    var d = data(res) || { items: [], counters: {} }, c = d.counters || {};
    var canPlan = can('production:production_plan_items:write') && can('production:production_order:write');
    var canInstr = can('production:manufacturing_instruction:read');
    var canPick = can('location:shelf_task:write');
    var stats = '<div class="stats">' + kpi('activity', String(c.open || 0), 'Open') + kpi('droplet', num(c.kgToProduce || 0) + ' kg', 'To produce') +
      kpi('alert', String(c.overdue || 0), 'Overdue') + kpi('tag', String(c.highValue || 0), 'High value') + kpi('lock', String(c.blocked || 0), 'Blocked') + '</div>';
    var open = (d.items || []).filter(function (r) { return r.lifecycleStatus !== 'CANCELLED'; });
    PV.queue = {}; open.forEach(function (r) { PV.queue[r.alembicRequirementId] = r; });
    var rows = open.map(function (r) {
      var sg = STAGE[r.stage] || ['n', r.stage];
      var acts = [];
      if (canPlan && (r.stage === 'TO_PLAN' || r.stage === 'BLOCKED')) acts.push('<button class="ra-act btn sm p" data-plan="' + r.alembicRequirementId + '">Plan run</button>');
      if (canInstr && r.productionOrderId && String(r.runStatus || '').toUpperCase() === 'INPROGRESS') acts.push('<button class="ra-act btn sm" data-instr="' + r.productionOrderId + '">Coded instruction</button>');
      if (canPick && r.stage === 'ON_SHELF') acts.push('<button class="ra-act btn sm" data-pick="' + r.alembicRequirementId + '">Pick</button>');
      var overdue = r.overdue ? ' style="color:var(--red);font-weight:var(--w-med)"' : '';
      return '<tr>' +
        '<td style="white-space:nowrap">' + mono('#' + r.position) + '</td>' +
        '<td>' + priorityCell(r) + '</td>' +
        '<td style="white-space:nowrap">' + mono(r.sku) + (r.packSize ? '<div style="color:var(--ink-3);font-size:var(--t-cap)">' + escHtml(r.packSize) + '</div>' : '') + '</td>' +
        '<td style="white-space:nowrap">' + mono(r.qtyKg != null ? num(r.qtyKg) + ' kg' : r.qty + ' ' + r.uom) + '</td>' +
        '<td>' + escHtml((r.orderRefs || [r.orderRef]).join(', ')) + '</td>' +
        '<td' + overdue + '><span style="white-space:nowrap">' + escHtml(ymd(r.neededBy)) + '</span>' + (r.overdue ? '<div>overdue</div>' : '') + '</td>' +
        '<td>' + chip(sg[0], sg[1]) + (r.batchNo ? '<div style="color:var(--ink-3);font-size:var(--t-cap);margin-top:4px">batch ' + escHtml(r.batchNo) + (r.rack ? ' · ' + escHtml(r.rack) : '') + '</div>' : '') +
          (r.blockMessage ? '<div style="color:var(--red);font-size:var(--t-cap);margin-top:4px;max-width:280px">' + escHtml(r.blockMessage) + '</div>' : '') + '</td>' +
        '<td>' + formulaCell(r.formula) + '</td>' +
        '<td class="r" style="white-space:nowrap">' + (acts.join(' ') || muted('—')) + '</td></tr>';
    }).join('');
    var note = d.formulaLabels === 'unavailable' ? '<p class="t-cap" style="color:var(--amber);margin:0 0 var(--s-tight)">The Vault did not answer; formula codes are hidden until it does.</p>' : '';
    V.innerHTML = stats + '<div class="card"><div class="card-hd"><h2>Production queue</h2><span class="chip k">Formula codes only</span>' +
      '<span class="n">ranked by ALEMBIC: priority, need-by date, arrival · refreshed ' + new Date().toLocaleTimeString() + '</span></div>' +
      '<div class="card-bd">' + note + (rows ? '<div style="overflow-x:auto"><table><thead><tr><th>#</th><th>Priority</th><th>SKU</th><th>Qty</th><th>Orders</th><th>Needed by</th><th>Stage</th><th>Formula</th><th class="r">Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="empty"><h3>Nothing to produce</h3><p>No open ALEMBIC requirement is waiting on the factory.</p></div>') + '</div></div>';
    [].forEach.call(V.querySelectorAll('[data-plan]'), function (b) { b.onclick = function () { planRun(b, b.getAttribute('data-plan')); }; });
    [].forEach.call(V.querySelectorAll('[data-instr]'), function (b) { b.onclick = function () { showInstruction(b.getAttribute('data-instr')); }; });
    [].forEach.call(V.querySelectorAll('[data-pick]'), function (b) { b.onclick = function () { createPicks(b, b.getAttribute('data-pick')); }; });
    clearTimeout(PV.produceTimer);
    PV.produceTimer = setTimeout(function () { if (st.nav === 'produce' && !document.hidden) viewProduce(item, $('ra-view')); }, 20000);
  }

  function planRun(b, id) {
    var r = PV.queue && PV.queue[id];
    raConfirm('Plan a run for ' + (r ? r.sku + ' · ' + (r.qtyKg != null ? num(r.qtyKg) + ' kg' : r.qty + ' ' + r.uom) : 'this requirement') +
      '? It joins an open run of the same approved formula when there is one, otherwise a new run is created from the Vault\'s approved version.', function () {
      b.disabled = true; b.textContent = 'Planning…';
      tunnel('/v1/produce/requirements/' + id + '/plan', { method: 'POST', body: {} }).then(function (res) {
        if (res.status >= 400) {
          b.disabled = false; b.textContent = 'Plan run';
          toast(err(res, 'Could not plan (' + res.status + ')'), 'bad');
          loadView(); return;
        }
        var p = data(res) || {};
        toast((p.mode === 'extended' ? 'Added to the open run' : 'Run created') + ' · ' + (p.formula && p.formula.code ? p.formula.code + ' v' + p.formula.version : '') + ' · ' + num(p.runQtyKg) + ' kg', 'good');
        loadView();
      }).catch(function () { b.disabled = false; b.textContent = 'Plan run'; toast('Can\'t connect. Try again.', 'bad'); });
    }, { title: 'Plan run', confirmLabel: 'Plan run', tone: 'accent' });
  }

  function showInstruction(orderId) {
    tunnel('/v1/production-orders/' + orderId + '/manufacturing-instruction').then(function (res) {
      if (res.status >= 400) { toast(err(res, 'The coded instruction is not available (' + res.status + ')'), 'bad'); return; }
      var lines = data(res) || [];
      var body = lines.length
        ? '<p class="t-cap" style="margin:0">Floor codes and quantities only. The recipe never leaves the Vault.</p><div style="overflow-x:auto"><table><thead><tr><th>Step</th><th>Floor code</th><th class="r">Quantity</th></tr></thead><tbody>' +
          lines.map(function (l) { return '<tr><td>' + escHtml(l.sequenceNo != null ? l.sequenceNo : '') + '</td><td>' + mono(l.code) + '</td><td class="r">' + mono(num(l.quantity) + ' ' + (l.uom || '')) + '</td></tr>'; }).join('') + '</tbody></table></div>'
        : '<div class="empty"><h3>No instruction yet</h3><p>The run has no approved formula version linked.</p></div>';
      openSheet({ tag: 'div', title: 'Coded manufacturing instruction', meta: 'Run ' + String(orderId).slice(0, 8).toUpperCase(), cls: 'xp-wide', body: body });
    }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
  }

  function createPicks(b, reqId) {
    b.disabled = true;
    tunnel('/v1/shelf/requirements/' + reqId + '/picks', { method: 'POST', body: {} }).then(function (res) {
      b.disabled = false;
      if (res.status >= 400) { toast(err(res, 'Could not create picks (' + res.status + ')'), 'bad'); return; }
      var d = data(res) || {};
      toast((d.tasks || []).length + ' pick(s) created — oldest lot first' + (d.shortKg ? ' · short ' + num(d.shortKg) + ' kg' : ''), 'good');
      loadView();
    }).catch(function () { b.disabled = false; toast('Can\'t connect. Try again.', 'bad'); });
  }

  /* ── Put-away & pick (scan-first) ───────────────────────────────────────────────────── */
  async function viewShelfTasks(item, V) {
    var canWrite = can('location:shelf_task:write');
    V.innerHTML = '<div class="loading">Loading…</div>';
    var rs;
    try {
      rs = await Promise.all([tunnel('/v1/shelf/ready'), tunnel('/v1/shelf/tasks?kind=PUTAWAY'), tunnel('/v1/shelf/requirements'), tunnel('/v1/shelf/tasks?kind=PICK')]);
    } catch (e) { V.innerHTML = errBox('Can\'t connect. Try again.'); return; }
    if (stale('shelftasks')) return;
    if (rs[1].status === 403) { V.innerHTML = errBox('Your role doesn\'t see the shelf tasks.'); return; }
    var ready = data(rs[0]) || [], puts = data(rs[1]) || [], reqs = data(rs[2]) || [], picks = data(rs[3]) || [];
    var unitsPut = puts.reduce(function (s, t) { return s + Number(t.qty || 0); }, 0);
    var unitsPick = picks.reduce(function (s, t) { return s + Number(t.qty || 0); }, 0);
    var stats = '<div class="stats">' + kpi('box', String(ready.length), 'Ready to shelve') + kpi('shelf', String(puts.length), 'Put-aways · ' + num(unitsPut) + ' units') +
      kpi('clipboard', String(reqs.length), 'Orders to pick') + kpi('truck', String(picks.length), 'Picks · ' + num(unitsPick) + ' units') + '</div>';
    var scan = canWrite ? '<div class="card"><div class="card-hd"><h2>Scan</h2><span class="n">Scan a task QR or type PA-12 / PK-7, then scan the bin</span></div><div class="card-bd">' +
      '<form id="pv-scan" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><input id="pv-scan-in" class="fld" autocomplete="off" autofocus placeholder="Task QR / task number" style="flex:1;min-width:220px;font-size:var(--t-h3)">' +
      btn('', 'Go', 'p', ' type="submit"') + '</form><div id="pv-scan-state" style="margin-top:10px"></div></div></div>' : '';
    function taskRows(list, kind) {
      return list.map(function (t) {
        return '<tr><td style="white-space:nowrap">' + mono(t.taskNo) + '</td><td style="white-space:nowrap">' + mono(t.batchNo || '') + '</td><td style="white-space:nowrap">' + mono(t.sku || '') + (t.packSize ? ' ' + muted(t.packSize) : '') + '</td>' +
          '<td>' + mono(num(t.qty) + ' ' + (t.uom || '')) + '</td><td>' + (t.label ? '<span style="font:var(--w-med) var(--t-h3)/1 var(--font-mono)">' + escHtml(t.label) + '</span>' : chip('a', 'bin not assigned')) + '</td>' +
          '<td>' + (t.reference ? escHtml(t.reference) : muted('—')) + '</td><td class="r">' + (canWrite ? '<button class="btn sm p" data-do="' + t.shelfTaskId + '" data-kind="' + kind + '">Confirm</button> <button class="btn sm" data-cancel="' + t.shelfTaskId + '">Cancel</button>' : muted('—')) + '</td></tr>';
      }).join('');
    }
    function sheetBtns(kind) {
      return '<span style="margin-left:auto;display:inline-flex;gap:6px">' + btn('', 'Print A4', 'sm', ' data-sheet="' + kind + '" data-fmt="a4"') + btn('', 'Print 80 mm', 'sm', ' data-sheet="' + kind + '" data-fmt="80mm"') + '</span>';
    }
    var head = '<thead><tr><th>Task</th><th>Batch</th><th>SKU</th><th>Qty</th><th>Location</th><th>For</th><th class="r"></th></tr></thead>';
    var readyCard = '<div class="card"><div class="card-hd"><h2>Ready for put-away</h2><span class="n">QC-released finished goods not yet on a shelf</span></div><div class="card-bd">' +
      (ready.length ? '<div style="overflow-x:auto"><table><thead><tr><th>Batch</th><th>SKU</th><th>Qty</th><th>Released</th><th class="r"></th></tr></thead><tbody>' + ready.map(function (f) {
        return '<tr><td>' + mono(f.batchNo || '') + '</td><td>' + mono(f.sku || '') + (f.packSize ? ' ' + muted(f.packSize) : '') + '</td><td>' + mono(num(Number(f.producedQty) - Number(f.stockedQty || 0)) + ' ' + (f.uom || '')) + '</td>' +
          '<td>' + escHtml(ymd(f.releasedAt)) + '</td><td class="r">' + (f.openTaskId ? chip('b', 'task open') : canWrite ? '<button class="btn sm p" data-assign="' + f.finishedGoodBatchId + '">Assign rack</button>' : muted('—')) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty"><h3>Nothing waiting</h3><p>Every released batch is on a shelf.</p></div>') + '</div></div>';
    var putCard = '<div class="card"><div class="card-hd"><h2>Put-aways</h2><span class="n">walking order</span>' + sheetBtns('PUTAWAY') + '</div><div class="card-bd">' +
      (puts.length ? '<div style="overflow-x:auto"><table>' + head + '<tbody>' + taskRows(puts, 'PUTAWAY') + '</tbody></table></div>' : '<div class="empty"><h3>No put-aways open</h3></div>') + '</div></div>';
    var reqCard = '<div class="card"><div class="card-hd"><h2>Orders to pick</h2><span class="n">ALEMBIC orders with stock on the shelves — oldest lot first (FIFO)</span></div><div class="card-bd">' +
      (reqs.length ? '<div style="overflow-x:auto"><table><thead><tr><th>Orders</th><th>SKU</th><th>Needed</th><th>Picked</th><th>Needed by</th><th class="r"></th></tr></thead><tbody>' + reqs.map(function (r) {
        return '<tr><td>' + escHtml((r.orderRefs || []).join(', ')) + (r.highValue ? ' ' + chip('r', 'High value') : '') + '</td><td>' + mono(r.sku) + '</td><td>' + mono(r.qtyKg != null ? num(r.qtyKg) + ' kg' : '—') + '</td>' +
          '<td>' + mono(num(r.pickedKg) + ' kg') + (r.openPickKg ? ' ' + muted('+' + num(r.openPickKg) + ' open') : '') + '</td><td>' + escHtml(ymd(r.neededBy)) + '</td>' +
          '<td class="r">' + (canWrite ? '<button class="btn sm p" data-picks="' + r.alembicRequirementId + '">Create picks</button>' : muted('—')) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty"><h3>Nothing to pick</h3></div>') + '</div></div>';
    var pickCard = '<div class="card"><div class="card-hd"><h2>Picks</h2><span class="n">walking order</span>' + sheetBtns('PICK') + '</div><div class="card-bd">' +
      (picks.length ? '<div style="overflow-x:auto"><table>' + head + '<tbody>' + taskRows(picks, 'PICK') + '</tbody></table></div>' : '<div class="empty"><h3>No picks open</h3></div>') + '</div></div>';
    var moveCard = canWrite ? '<div class="card"><div class="card-hd"><h2>Move stock</h2><span class="n">scan the bin it is on, pick the batch, scan where it goes</span></div><div class="card-bd">' +
      '<form id="pv-move" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">' +
      '<label style="display:flex;flex-direction:column;gap:5px">' + lbl('From bin') + '<input id="pv-mv-from" class="fld" autocomplete="off" style="width:160px"></label>' +
      '<label style="display:flex;flex-direction:column;gap:5px;flex:1;min-width:200px">' + lbl('Batch') + '<select id="pv-mv-batch" class="fld"><option value="">scan the from-bin first</option></select></label>' +
      '<label style="display:flex;flex-direction:column;gap:5px">' + lbl('Qty (blank = all)') + '<input id="pv-mv-qty" class="fld" type="number" min="0" step="any" style="width:120px"></label>' +
      '<label style="display:flex;flex-direction:column;gap:5px">' + lbl('To bin') + '<input id="pv-mv-to" class="fld" autocomplete="off" style="width:160px"></label>' +
      btn('', 'Move', 'p', ' type="submit"') + '</form></div></div>' : '';
    V.innerHTML = stats + '<div class="stack-base">' + scan + readyCard + putCard + reqCard + pickCard + moveCard + '</div>';

    var si = $('pv-scan-in'); if (si) si.focus();
    var sf = $('pv-scan'); if (sf) sf.onsubmit = function (e) { e.preventDefault(); onScan(si.value.trim()); si.value = ''; };
    [].forEach.call(V.querySelectorAll('[data-assign]'), function (b) { b.onclick = function () { assignRack(b.getAttribute('data-assign')); }; });
    [].forEach.call(V.querySelectorAll('[data-do]'), function (b) { b.onclick = function () { confirmTask(b.getAttribute('data-do'), b.getAttribute('data-kind')); }; });
    [].forEach.call(V.querySelectorAll('[data-cancel]'), function (b) { b.onclick = function () { cancelTask(b.getAttribute('data-cancel')); }; });
    [].forEach.call(V.querySelectorAll('[data-picks]'), function (b) { b.onclick = function () { createPicks(b, b.getAttribute('data-picks')); }; });
    [].forEach.call(V.querySelectorAll('[data-sheet]'), function (b) { b.onclick = function () { printSheet(b.getAttribute('data-sheet'), b.getAttribute('data-fmt')); }; });
    var mf = $('pv-move');
    if (mf) {
      $('pv-mv-from').onchange = function () {
        var code = this.value.trim(); if (!code) return;
        tunnel('/v1/shelf/bin-stock?code=' + encodeURIComponent(code)).then(function (res) {
          var d = data(res); var sel = $('pv-mv-batch');
          if (res.status >= 400 || !d) { sel.innerHTML = '<option value="">' + escHtml(err(res, 'No such bin')) + '</option>'; return; }
          sel.innerHTML = d.items.length ? d.items.map(function (x) { return '<option value="' + x.finishedGoodBatchId + '">' + escHtml((x.batchNo || '') + ' · ' + (x.sku || '') + ' · ' + num(x.qty) + ' ' + (x.uom || '')) + '</option>'; }).join('') : '<option value="">nothing on ' + escHtml(d.bin.label) + '</option>';
          $('pv-mv-to').focus();
        });
      };
      mf.onsubmit = function (e) {
        e.preventDefault();
        var body = { finishedGoodBatchId: $('pv-mv-batch').value, fromBinCode: $('pv-mv-from').value.trim(), toBinCode: $('pv-mv-to').value.trim(), qty: $('pv-mv-qty').value === '' ? null : Number($('pv-mv-qty').value) };
        if (!body.finishedGoodBatchId || !body.toBinCode) { toast('Scan the from-bin, pick the batch and scan the to-bin.', 'bad'); return; }
        tunnel('/v1/shelf/move', { method: 'POST', body: body }).then(function (res) {
          if (res.status >= 400) { toast(err(res, 'Move failed (' + res.status + ')'), 'bad'); return; }
          var d = data(res) || {}; toast('Moved ' + d.from + ' → ' + d.to, 'good'); loadView();
        }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
      };
    }
  }

  // Scan flow: a task code opens the task; the next scan (a bin) confirms it.
  function onScan(code) {
    if (!code) return;
    var state = $('pv-scan-state');
    if (PV.scanTask) { var t = PV.scanTask; PV.scanTask = null; completeTask(t.shelfTaskId, t.kind, code); return; }
    tunnel('/v1/shelf/tasks/scan?code=' + encodeURIComponent(code)).then(function (res) {
      if (res.status >= 400) { toast(err(res, 'Not a task'), 'bad'); return; }
      var t = data(res); if (!t) return;
      if (t.status !== 'OPEN') { toast(t.taskNo + ' is already ' + String(t.status).toLowerCase(), 'bad'); return; }
      PV.scanTask = t;
      if (state) state.innerHTML = '<div class="glass" style="padding:12px;border-radius:var(--r-md);display:flex;gap:16px;align-items:center;flex-wrap:wrap">' +
        chip(t.kind === 'PICK' ? 'g' : 'b', t.kind === 'PICK' ? 'Pick' : 'Put away') + mono(t.taskNo) + '<span>' + escHtml((t.batchNo || '') + ' · ' + (t.sku || '') + ' · ' + num(t.qty) + ' ' + (t.uom || '')) + '</span>' +
        '<span style="font:var(--w-med) var(--t-h1)/1 var(--font-mono)">' + escHtml(t.label || 'any bin') + '</span><span class="t-cap">Now scan the bin</span></div>';
      if (window.RaSound) RaSound.play('notify');
    }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
  }

  function completeTask(id, kind, binCode) {
    var path = '/v1/shelf/tasks/' + id + (kind === 'PICK' ? '/pick' : '/putaway');
    tunnel(path, { method: 'POST', body: { binCode: binCode } }).then(function (res) {
      if (res.status >= 400) { toast(err(res, 'Not confirmed (' + res.status + ')'), 'bad'); return; }
      var d = data(res) || {};
      if (kind === 'PICK') toast('Picked', 'good');
      else toast('Put away on ' + (d.location || binCode) + (d.fgBatchReceived && d.fgBatchReceived.sent ? ' · ALEMBIC told' : d.fgBatchReceived ? ' · ALEMBIC NOT told: ' + (d.fgBatchReceived.problems || []).join('; ') : ''), d.fgBatchReceived && !d.fgBatchReceived.sent ? 'bad' : 'good');
      loadView();
    }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
  }

  function confirmTask(id, kind) {
    var m = openSheet({ tag: 'form', id: 'pv-confirm', style: 'max-width:420px', title: kind === 'PICK' ? 'Confirm pick' : 'Confirm put-away',
      body: '<label style="display:flex;flex-direction:column;gap:5px">' + lbl('Scan or type the bin') + '<input id="pv-cbin" class="fld" autocomplete="off" style="font-size:var(--t-h3)"></label>' +
        '<button type="submit" class="btn p" style="width:100%;justify-content:center">Confirm</button>' });
    m.sheet.onsubmit = function (e) { e.preventDefault(); var v = $('pv-cbin').value.trim(); if (!v) return; m.close(); completeTask(id, kind, v); };
  }

  function cancelTask(id) {
    raConfirm('Cancel this task? Its light goes off; nothing moves.', function () {
      tunnel('/v1/shelf/tasks/' + id + '/cancel', { method: 'POST', body: {} }).then(function (res) {
        if (res.status >= 400) { toast(err(res, 'Not cancelled'), 'bad'); return; }
        toast('Cancelled', 'good'); loadView();
      });
    }, { title: 'Cancel task', confirmLabel: 'Cancel task' });
  }

  function assignRack(fgId) {
    var m = openSheet({ tag: 'form', id: 'pv-assign', style: 'max-width:420px', title: 'Assign a rack',
      body: '<label style="display:flex;flex-direction:column;gap:5px">' + lbl('Bin (blank = suggest one)') + '<input id="pv-abin" class="fld" autocomplete="off"></label>' +
        '<p class="t-cap" style="margin:0">Suggested: a bin already holding this SKU, else the first empty bin in walking order.</p>' +
        '<button type="submit" class="btn p" style="width:100%;justify-content:center">Assign</button>' });
    m.sheet.onsubmit = function (e) {
      e.preventDefault(); var v = $('pv-abin').value.trim(); m.close();
      tunnel('/v1/shelf/putaway', { method: 'POST', body: { finishedGoodBatchId: fgId, binCode: v || null } }).then(function (res) {
        if (res.status >= 400) { toast(err(res, 'Not assigned (' + res.status + ')'), 'bad'); return; }
        var t = data(res) || {}; toast(t.label ? 'Put away on ' + t.label : 'Task open — no free bin yet; add bins on Rack layout', t.label ? 'good' : 'bad'); loadView();
      }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
    };
  }

  /* ── printed sheets (A4 / 80 mm thermal), in walking order, with task QR ─────────────── */
  function printSheet(kind, fmt) {
    tunnel('/v1/shelf/sheet?kind=' + kind).then(function (res) {
      if (res.status >= 400) { toast(err(res, 'No sheet'), 'bad'); return; }
      var d = data(res) || { items: [] };
      var title = kind === 'PICK' ? 'PICK SHEET' : 'PUT-AWAY SHEET';
      var thermal = fmt === '80mm';
      var rows = d.items.map(function (t, i) {
        return thermal
          ? '<div class="t"><div class="loc">' + escHtml(t.label || 'ANY BIN') + '</div><div>' + escHtml(t.taskNo) + ' · ' + escHtml(t.batchNo || '') + '</div><div>' + escHtml(t.sku || '') + '</div><div class="q">' + escHtml(num(t.qty) + ' ' + (t.uom || '')) + '</div>' + qrSvg(t.qr, 3) + '</div>'
          : '<tr><td>' + (i + 1) + '</td><td class="loc">' + escHtml(t.label || 'ANY BIN') + '</td><td>' + escHtml(t.taskNo) + '</td><td>' + escHtml(t.batchNo || '') + '</td><td>' + escHtml((t.sku || '') + (t.packSize ? ' · ' + t.packSize : '')) + '</td><td class="q">' + escHtml(num(t.qty) + ' ' + (t.uom || '')) + '</td><td>' + escHtml(t.reference || '') + '</td><td>' + qrSvg(t.qr, 2) + '</td><td class="tick"></td></tr>';
      }).join('');
      var css = thermal
        ? '@page{size:80mm auto;margin:3mm}body{font-family:Arial,sans-serif;width:74mm;margin:0;color:#000}h1{font-size:14px;margin:0 0 4px}.t{border-bottom:1px dashed #000;padding:6px 0;font-size:12px}.loc{font:700 20px/1.1 Arial}.q{font-weight:700}svg{margin-top:4px}'
        : '@page{size:A4;margin:12mm}body{font-family:Arial,sans-serif;color:#141413}h1{font-size:16px;letter-spacing:.12em;margin:0}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border-bottom:1px solid #ccc;padding:6px;font-size:12px;text-align:left;vertical-align:middle}.loc{font:700 16px Arial}.q{font-weight:700}.tick{width:22px;border:1px solid #000}';
      openPrint(title, '<style>' + css + '@media print{.noprint{display:none}}</style>' +
        '<h1>RAW AROMA CHEM · ' + title + '</h1><div style="font-size:11px;color:#555">' + d.items.length + ' task(s) · rack walking order · ' + new Date().toLocaleString() + '</div>' +
        (thermal ? rows : '<table><thead><tr><th>#</th><th>Location</th><th>Task</th><th>Batch</th><th>SKU</th><th>Qty</th><th>For</th><th>QR</th><th>✓</th></tr></thead><tbody>' + rows + '</tbody></table>'));
    }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
  }

  function openPrint(title, inner) {
    var w = window.open('', '_blank', 'width=820,height=920'); if (!w) { toast('Allow pop-ups to print.', 'bad'); return null; }
    w.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + escHtml(title) + '</title></head><body>' + inner +
      '<div class="noprint" style="margin:20px 0;text-align:center"><button onclick="window.print()" style="padding:10px 26px;background:#E9F260;color:#141413;border:none;border-radius:10px;font-weight:600;cursor:pointer;font-size:14px">Print</button></div></body></html>');
    w.document.close();
    return w;
  }

  /* ── Rack layout (the location master, keyboard-first) ──────────────────────────────── */
  function nextCode(code) {
    var m = /^(.*?)(\d+)$/.exec(code || ''); if (!m) return code;
    var n = String(Number(m[2]) + 1); while (n.length < m[2].length) n = '0' + n;
    return m[1] + n;
  }
  async function viewRackLayout(item, V) {
    var canWrite = can('location:rack_master:write');
    V.innerHTML = '<div class="loading">Loading…</div>';
    var res;
    try { res = await tunnel('/v1/shelf/locations'); } catch (e) { V.innerHTML = errBox('Can\'t connect. Try again.'); return; }
    if (stale('racklayout')) return;
    if (res.status >= 400) { V.innerHTML = errBox(err(res, 'Locations are not available (' + res.status + ').')); return; }
    var bins = data(res) || [];
    var racks = {}, order = [];
    bins.forEach(function (b) {
      var k = b.rackCode || '(no rack)';
      if (!racks[k]) { racks[k] = { rack: k, zone: b.zoneCode, walk: b.walkSeq, bins: 0, stock: 0, tasks: 0, codes: [] }; order.push(k); }
      racks[k].bins++; racks[k].stock += Number(b.stockQty || 0); racks[k].tasks += Number(b.openTasks || 0); racks[k].codes.push(b.label);
    });
    PV.layout = racks;
    var last = order.length ? order[order.length - 1] : '';
    var quick = canWrite ? '<div class="card"><div class="card-hd"><h2>Add a rack</h2><span class="n">one line per rack — Enter saves and moves to the next</span></div><div class="card-bd">' +
      '<form id="pv-rack" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">' +
      '<label style="display:flex;flex-direction:column;gap:5px">' + lbl('Zone') + '<input id="pv-zone" class="fld" style="width:110px" value="' + escHtml(PV.lastZone || (last && racks[last].zone) || 'FG') + '"></label>' +
      '<label style="display:flex;flex-direction:column;gap:5px">' + lbl('Rack code') + '<input id="pv-rackc" class="fld" style="width:120px" value="' + escHtml(PV.nextRack || (last ? nextCode(last) : 'R01')) + '"></label>' +
      '<label style="display:flex;flex-direction:column;gap:5px">' + lbl('Shelves') + '<input id="pv-shelves" class="fld" type="number" min="1" max="30" style="width:90px" value="' + (PV.lastShelves || 4) + '"></label>' +
      '<label style="display:flex;flex-direction:column;gap:5px">' + lbl('Bins / shelf') + '<input id="pv-bins" class="fld" type="number" min="1" max="50" style="width:100px" value="' + (PV.lastBins || 3) + '"></label>' +
      '<label style="display:flex;flex-direction:column;gap:5px">' + lbl('Walk #') + '<input id="pv-walk" class="fld" type="number" style="width:90px" placeholder="next"></label>' +
      btn('', 'Add rack', 'p', ' type="submit"') + '</form>' +
      '<details style="margin-top:12px"><summary class="t-cap" style="cursor:pointer">Import from CSV (optional)</summary>' +
      '<p class="t-cap">One line per bin: zone,rack,shelf,bin[,walk]. Short shelf/bin codes are prefixed with the rack (A01,2,3 → A01-2-3). Lines that exist are left as they are.</p>' +
      '<textarea id="pv-csv" class="fld" rows="5" style="width:100%;font-family:var(--font-mono)" placeholder="zone,rack,shelf,bin,walk\nFG,A01,1,1,10"></textarea>' +
      '<div style="margin-top:8px">' + btn('pv-csv-go', 'Import', 'sm') + '</div></details></div></div>' : '';
    var list = '<div class="card"><div class="card-hd"><h2>Racks</h2><span class="n">' + order.length + ' racks · ' + bins.length + ' bins · walking order</span>' +
      '<span style="margin-left:auto">' + btn('pv-binlabels', 'Print bin QR labels', 'sm') + '</span></div><div class="card-bd">' +
      (order.length ? '<div style="overflow-x:auto"><table><thead><tr><th>Walk #</th><th>Rack</th><th>Zone</th><th>Bins</th><th>Stock (units)</th><th>Open tasks</th><th>First / last bin</th></tr></thead><tbody>' + order.map(function (k) {
        var r = racks[k];
        return '<tr><td>' + (canWrite && k !== '(no rack)' ? '<input class="fld" data-walk="' + escHtml(k) + '" type="number" style="width:90px" value="' + (r.walk != null ? r.walk : '') + '">' : escHtml(r.walk != null ? r.walk : '—')) + '</td>' +
          '<td>' + mono(k) + '</td><td>' + escHtml(r.zone || '—') + '</td><td>' + r.bins + '</td><td>' + mono(num(r.stock)) + '</td><td>' + r.tasks + '</td><td>' + mono(r.codes[0] + ' … ' + r.codes[r.codes.length - 1]) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty"><h3>No racks yet</h3><p>Add the first rack above — zone, rack code, how many shelves and bins.</p></div>') + '</div></div>';
    V.innerHTML = '<div class="stack-base">' + quick + list + '</div>';
    var rc = $('pv-rackc'); if (rc) { rc.focus(); rc.select(); }
    var f = $('pv-rack');
    if (f) f.onsubmit = function (e) {
      e.preventDefault();
      var body = { zoneCode: $('pv-zone').value.trim(), rackCode: $('pv-rackc').value.trim(), shelves: Number($('pv-shelves').value), binsPerShelf: Number($('pv-bins').value), walkSeq: $('pv-walk').value === '' ? null : Number($('pv-walk').value) };
      if (!body.zoneCode || !body.rackCode) { toast('Zone and rack code are needed.', 'bad'); return; }
      tunnel('/v1/shelf/layout/rack', { method: 'POST', body: body }).then(function (res) {
        if (res.status >= 400) { toast(err(res, 'Rack not added (' + res.status + ')'), 'bad'); return; }
        var d = data(res) || {};
        PV.lastZone = body.zoneCode; PV.lastShelves = body.shelves; PV.lastBins = body.binsPerShelf; PV.nextRack = nextCode(body.rackCode);
        toast('Rack ' + d.rackCode + ' · ' + (d.binCodes || []).length + ' bins · walk #' + d.walkSeq, 'good'); loadView();
      }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
    };
    var cg = $('pv-csv-go');
    if (cg) cg.onclick = function () {
      tunnel('/v1/shelf/layout/import', { method: 'POST', body: { csv: $('pv-csv').value } }).then(function (res) {
        if (res.status >= 400) { toast(err(res, 'Import failed'), 'bad'); return; }
        var d = data(res) || {};
        toast(d.created + ' bins added, ' + d.existing + ' already there' + ((d.errors || []).length ? ', ' + d.errors.length + ' line(s) skipped' : ''), (d.errors || []).length ? 'bad' : 'good'); loadView();
      });
    };
    [].forEach.call(V.querySelectorAll('[data-walk]'), function (inp) {
      inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } };
      inp.onchange = function () {
        tunnel('/v1/shelf/racks/' + encodeURIComponent(inp.getAttribute('data-walk')) + '/walk', { method: 'PUT', body: { walkSeq: Number(inp.value) } }).then(function (res) {
          if (res.status >= 400) { toast(err(res, 'Not saved'), 'bad'); return; }
          toast('Walk order saved', 'good');
        });
      };
    });
    var bl = $('pv-binlabels'); if (bl) bl.onclick = function () { printBinLabels(bins); };
  }

  function printBinLabels(bins) {
    var cells = bins.map(function (b) {
      return '<div class="lb"><div class="c">' + escHtml(b.label) + '</div>' + qrSvg(b.binCode, 3) + '<div class="z">' + escHtml((b.zoneCode || '') + (b.walkSeq != null ? ' · walk ' + b.walkSeq : '')) + '</div></div>';
    }).join('');
    openPrint('Bin labels', '<style>@page{size:A4;margin:8mm}body{font-family:Arial,sans-serif;margin:0}.grid{display:flex;flex-wrap:wrap;gap:4mm}.lb{width:60mm;height:32mm;border:1px solid #000;border-radius:2mm;display:flex;flex-direction:column;align-items:center;justify-content:center;page-break-inside:avoid}.c{font:700 18px Arial}.z{font-size:10px;color:#444}@media print{.noprint{display:none}}</style>' +
      '<div class="grid">' + cells + '</div>');
  }

  /* ── Shelf display (TV / tablet at the shelves) ─────────────────────────────────────── */
  // Strong, fixed colours so a TV across the aisle reads put-away (blue) vs pick (green) the same
  // way the pick-to-light bins do; the console palette's muted tones do not carry that far.
  var LIGHT = { blue: '#2563EB', green: '#16A34A', amber: '#D97706', white: '#FFFFFF', red: '#DC2626' };
  async function viewShelfDisplay(item, V, tv) {
    var zone = PV.displayZone || '';
    var res, locs;
    try { res = await Promise.all([tunnel('/v1/shelf/display' + (zone ? '?zone=' + encodeURIComponent(zone) : '')), PV.zones ? null : tunnel('/v1/shelf/locations')]); }
    catch (e) { if (!tv) V.innerHTML = errBox('Can\'t connect. Try again.'); scheduleDisplay(item, tv); return; }
    if (!tv && stale('shelfdisplay')) return;
    if (res[0].status >= 400) { V.innerHTML = errBox(err(res[0], 'The shelf display is not available (' + res[0].status + ').')); return; }
    if (res[1] && res[1].status < 400) { locs = data(res[1]) || []; var z = {}; locs.forEach(function (b) { if (b.zoneCode) z[b.zoneCode] = 1; }); PV.zones = Object.keys(z).sort(); }
    var d = data(res[0]) || { counters: {}, next: [], lit: [] }, c = d.counters || {};
    var total = (c.putawayTasks || 0) + (c.pickTasks || 0);
    if (PV.lastDisplayTotal != null && total > PV.lastDisplayTotal && window.RaSound) RaSound.play('notify');
    PV.lastDisplayTotal = total;
    var big = function (n, l, col) { return '<div style="flex:1;min-width:200px;padding:20px;border-radius:var(--r-md);background:var(--panel-2)"><div style="font:var(--w-med) 18px/1.2 var(--font-ui);text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3)">' + l + '</div><div style="font:600 72px/1.05 var(--font-ui);color:' + col + '">' + n + '</div></div>'; };
    var next = (d.next || []).map(function (t) {
      var col = t.kind === 'PICK' ? LIGHT.green : LIGHT.blue;
      return '<div style="display:flex;gap:18px;align-items:center;padding:14px 16px;border-left:10px solid ' + col + ';background:var(--panel-2);border-radius:var(--r-sm)">' +
        '<div style="font:600 40px/1 var(--font-mono);min-width:260px">' + escHtml(t.label || 'ANY BIN') + '</div>' +
        '<div style="font:var(--w-med) 22px/1.3 var(--font-ui)">' + (t.kind === 'PICK' ? 'PICK ' : 'PUT AWAY ') + escHtml(num(t.qty) + ' ' + (t.uom || '')) + '<div style="font:var(--w-reg) 18px/1.3 var(--font-ui);color:var(--ink-3)">' + escHtml((t.sku || '') + ' · batch ' + (t.batchNo || '') + ' · ' + t.taskNo) + '</div></div></div>';
    }).join('');
    var lit = (d.lit || []).map(function (l) {
      var bg = LIGHT[l.colour] || 'var(--accent)';
      return '<div style="padding:10px 14px;border-radius:var(--r-sm);background:' + bg + ';color:' + (l.colour === 'white' ? '#141413' : '#fff') + ';border:1px solid #141413;font:600 18px/1.2 var(--font-mono)">' + escHtml(l.bin || l.shelf || l.rack) + (l.qty ? ' · ' + num(l.qty) : '') + '</div>';
    }).join('');
    var zones = '<select id="pv-dzone" class="fld" style="max-width:200px"><option value="">All zones</option>' + (PV.zones || []).map(function (z) { return '<option' + (z === zone ? ' selected' : '') + '>' + escHtml(z) + '</option>'; }).join('') + '</select>';
    var html = '<div id="pv-display" style="display:flex;flex-direction:column;gap:18px">' +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h2 style="font:600 28px/1 var(--font-ui);margin:0">Shelves' + (zone ? ' · zone ' + escHtml(zone) : '') + '</h2>' + zones +
      (tv ? btn('pv-tv-exit', 'Exit (Esc)', 'sm') : btn('pv-tv', 'TV mode', 'sm')) + '<span class="t-cap" style="margin-left:auto">updated ' + new Date().toLocaleTimeString() + '</span></div>' +
      '<div style="display:flex;gap:14px;flex-wrap:wrap">' + big(c.putawayTasks || 0, 'To put away · ' + num(c.putawayUnits || 0) + ' units', LIGHT.blue) + big(c.pickTasks || 0, 'To pick · ' + num(c.pickUnits || 0) + ' units', LIGHT.green) +
      (c.unassignedPutaways ? big(c.unassignedPutaways, 'Need a bin', LIGHT.amber) : '') + '</div>' +
      '<div><div style="font:var(--w-med) 16px/1 var(--font-ui);text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3);margin-bottom:8px">Next, in walking order</div><div style="display:flex;flex-direction:column;gap:8px">' + (next || '<div style="font:var(--w-med) 26px/1.3 var(--font-ui);color:var(--ink-3)">Nothing to do at these shelves.</div>') + '</div></div>' +
      (lit ? '<div><div style="font:var(--w-med) 16px/1 var(--font-ui);text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3);margin-bottom:8px">Lit bins (pick-to-light)</div><div style="display:flex;gap:8px;flex-wrap:wrap">' + lit + '</div></div>' : '') +
      '</div>';
    var host = tv ? PV.tvHost : V;
    if (!host) return;
    host.innerHTML = tv ? '<div style="padding:24px">' + html + '</div>' : html;
    var zs = host.querySelector('#pv-dzone'); if (zs) zs.onchange = function () { PV.displayZone = zs.value; viewShelfDisplay(item, V, tv); };
    var tb = host.querySelector('#pv-tv'); if (tb) tb.onclick = function () { enterTv(item); };
    var te = host.querySelector('#pv-tv-exit'); if (te) te.onclick = exitTv;
    scheduleDisplay(item, tv);
  }
  function scheduleDisplay(item, tv) {
    clearTimeout(PV.displayTimer);
    PV.displayTimer = setTimeout(function () {
      if (tv ? !!PV.tvHost : st.nav === 'shelfdisplay') viewShelfDisplay(item, $('ra-view'), tv);
    }, 5000);
  }
  function enterTv(item) {
    if (PV.tvHost) return;
    var h = document.createElement('div');
    h.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:var(--bg,#EDEDEB);overflow:auto';
    document.body.appendChild(h); PV.tvHost = h;
    try { var fs = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); if (fs && fs.catch) fs.catch(function () { /* not allowed without a gesture: the overlay still fills the window */ }); } catch (e) { /* ignore */ }
    PV.tvKey = function (e) { if (e.key === 'Escape') exitTv(); };
    document.addEventListener('keydown', PV.tvKey);
    viewShelfDisplay(item || NAV.shelfdisplay, null, true);
  }
  function exitTv() {
    if (!PV.tvHost) return;
    PV.tvHost.remove(); PV.tvHost = null; clearTimeout(PV.displayTimer);
    document.removeEventListener('keydown', PV.tvKey);
    try { var ex = document.fullscreenElement && document.exitFullscreen && document.exitFullscreen(); if (ex && ex.catch) ex.catch(function () {}); } catch (e) { /* ignore */ }
    if (st.nav === 'shelfdisplay') loadView();
  }

  window.RA.registerViews({
    __produce__: viewProduce,
    __shelftasks__: viewShelfTasks,
    __racklayout__: viewRackLayout,
    __shelfdisplay__: function (item, V) { return viewShelfDisplay(item, V, false); }
  });

  // #shelf=ZONE (a TV/tablet at the shelves): once signed in, open the display in TV mode.
  (function () {
    var m = /(?:^|[#&])shelf=([^&]*)/.exec(location.hash); if (!m) return;
    PV.displayZone = decodeURIComponent(m[1] || '');
    var tries = 0;
    var t = setInterval(function () {
      if (++tries > 120) { clearInterval(t); return; }
      if (!session || !st.role) return;
      clearInterval(t);
      var R = ROLES[st.role];
      if (R && R.nav.some(function (n) { return n[0] === 'shelfdisplay'; })) { navTo('shelfdisplay'); enterTv(NAV.shelfdisplay); }
    }, 500);
  })();

  /* ── labels: print at label-printer sizes ───────────────────────────────────────────── */
  var SIZES = {
    '100x50': { name: '100 × 50 mm', page: '100mm 50mm', w: '96mm', h: '46mm', small: true },
    '100x150': { name: '100 × 150 mm (4×6")', page: '100mm 150mm', w: '94mm', h: '144mm' },
    '62mm': { name: '62 mm continuous', page: '62mm 100mm', w: '58mm', h: '96mm', small: true },
    'a4': { name: 'A4 sheet (4 labels)', page: 'A4', w: '95mm', h: '135mm', sheet: 4 }
  };
  function labelHtml(c, size) {
    var s = SIZES[size];
    var dg = c.dg ? '<div class="dg"><b>' + escHtml([c.dg.unNumber ? (/^UN/i.test(c.dg.unNumber) ? c.dg.unNumber : 'UN' + c.dg.unNumber) : '', c.dg.dgClass ? 'Class ' + c.dg.dgClass : '', c.dg.packingGroup ? 'PG ' + c.dg.packingGroup : ''].filter(Boolean).join(' · ')) + '</b>' +
      (c.dg.properShippingName ? '<div>' + escHtml(c.dg.properShippingName) + '</div>' : '') + (c.dg.signalWord ? '<div class="sw">' + escHtml(c.dg.signalWord.toUpperCase()) + '</div>' : '') + (c.dg.hazardStatements && !s.small ? '<div>' + escHtml(c.dg.hazardStatements) + '</div>' : '') + '</div>' : '';
    return '<div class="lbl" style="width:' + s.w + ';height:' + s.h + '">' +
      '<div class="top"><div><div class="pn">' + escHtml(c.productName || c.productCode || c.skuCode) + '</div><div class="sm">' + escHtml((c.productCode ? c.productCode + ' · ' : '') + c.skuCode + (c.packSize ? ' · ' + c.packSize : '')) + '</div></div>' + qrSvg(c.batchNumber, s.small ? 2 : 3) + '</div>' +
      '<div class="row"><span>Batch</span><b class="big">' + escHtml(c.batchNumber) + '</b></div>' +
      '<div class="row"><span>Net qty</span><b>' + escHtml(c.netQuantity + (c.unit ? ' ' + c.unit : '')) + (c.packSize ? ' × ' + escHtml(c.packSize) : '') + '</b></div>' +
      '<div class="row"><span>Mfg</span><b>' + escHtml(c.manufacturingDate) + '</b><span>Exp</span><b>' + escHtml(c.expiryDate) + '</b></div>' +
      '<div class="row"><span>QC</span><b class="qc">' + escHtml(c.qcStatus) + '</b>' + (c.qcReleasedAt ? '<span>' + escHtml(String(c.qcReleasedAt).slice(0, 10)) + '</span>' : '') + '</div>' +
      dg + '<div class="rack"><span>RACK</span><b>' + escHtml(c.rack || '—') + '</b></div></div>';
  }
  function printLabel(fgId, size) {
    tunnel('/v1/finished-good-batches/' + fgId + '/label').then(function (res) {
      if (res.status >= 400) { toast(err(res, 'This batch cannot be labelled (' + res.status + ')'), 'bad'); return; }
      var c = data(res); if (!c) return;
      var s = SIZES[size] || SIZES['100x50'];
      var n = s.sheet || 1, body = '';
      for (var i = 0; i < n; i++) body += labelHtml(c, size);
      openPrint('Label ' + c.batchNumber, '<style>@page{size:' + s.page + ';margin:' + (s.sheet ? '8mm' : '2mm') + '}body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#000}' +
        '.wrap{display:flex;flex-wrap:wrap;gap:4mm}.lbl{box-sizing:border-box;border:1px solid #000;border-radius:2mm;padding:2.5mm;display:flex;flex-direction:column;gap:1.2mm;page-break-inside:avoid;overflow:hidden}' +
        '.top{display:flex;justify-content:space-between;gap:2mm}.pn{font-weight:700;font-size:' + (s.small ? '12px' : '18px') + '}.sm{font-size:' + (s.small ? '8px' : '11px') + '}' +
        '.row{display:flex;gap:2mm;align-items:baseline;font-size:' + (s.small ? '8px' : '12px') + '}.row span{color:#333}.big{font-size:' + (s.small ? '12px' : '20px') + '}.qc{border:1px solid #000;padding:0 1mm}' +
        '.dg{border:1.5px solid #000;padding:1mm;font-size:' + (s.small ? '7px' : '10px') + '}.sw{font-weight:700}.rack{margin-top:auto;display:flex;gap:2mm;align-items:baseline;border-top:1px solid #000;padding-top:1mm}.rack b{font-size:' + (s.small ? '14px' : '26px') + '}' +
        '@media print{.noprint{display:none}}</style><div class="wrap">' + body + '</div>');
    }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
  }
  function chooseLabelSize(fgId) {
    var m = openSheet({ tag: 'div', style: 'max-width:420px', title: 'Print label', meta: 'Browser print or save as PDF',
      body: Object.keys(SIZES).map(function (k) { return '<button type="button" class="btn" data-size="' + k + '" style="width:100%;justify-content:center">' + escHtml(SIZES[k].name) + '</button>'; }).join('') });
    [].forEach.call(m.sheet.querySelectorAll('[data-size]'), function (b) { b.onclick = function () { m.close(); printLabel(fgId, b.getAttribute('data-size')); }; });
  }

  // "Apply labels" records how many labels went on (the server composes them, QC-gated, and
  // assigns the rack) and then offers to print them.
  window.applyFgLabels = applyFgLabels = function (row) {
    var m = openSheet({ tag: 'form', style: 'max-width:420px', title: 'Apply labels', meta: 'Batch ' + (row.batchNumber || ''),
      body: '<label style="display:flex;flex-direction:column;gap:5px">' + lbl('How many labels were applied?') + '<input id="pv-lcount" class="fld" type="number" min="1" step="1" required></label>' +
        '<p class="t-cap" style="margin:0">Only a QC-released batch can be labelled. The rack is assigned now and printed on the label.</p>' +
        '<button type="submit" class="btn p" style="width:100%;justify-content:center">Record and print</button>' });
    m.sheet.onsubmit = function (e) {
      e.preventDefault(); var n = Number($('pv-lcount').value); if (!(n > 0)) return; m.close();
      tunnel('/v1/finished-good-batches/' + row.finishedGoodBatchId + '/labels', { method: 'POST', body: { labelCount: n } }).then(function (res) {
        if (res.status >= 400) { toast(err(res, 'Labels not recorded (' + res.status + ')'), 'bad'); return; }
        var l = data(res) || {}; var c = l.labelContent || {};
        toast('Labels recorded' + (c.rack ? ' · rack ' + c.rack : ''), 'good');
        chooseLabelSize(row.finishedGoodBatchId); loadView();
      }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
    };
  };

  /* ── row actions on existing screens ────────────────────────────────────────────────── */
  function addAction(endpoint, a) { (ACTIONS[endpoint] = ACTIONS[endpoint] || []).push(a); }
  addAction('/v1/finished-good-batches', { label: 'Print label', perm: 'packaging:finished_good_batch_master:read', when: function () { return true; }, run: function (r) { chooseLabelSize(r.finishedGoodBatchId); } });
  addAction('/v1/finished-good-batches', { label: 'Put away', perm: 'location:shelf_task:write', when: function () { return true; }, run: function (r) { assignRack(r.finishedGoodBatchId); } });
  addAction('/v1/fg-labels', { label: 'Print label', perm: 'packaging:finished_good_batch_master:read', when: function () { return true; }, run: function (r) { chooseLabelSize(r.finishedGoodBatchId); } });
  addAction('/v1/batch-coas', { label: 'Reject', perm: 'production:batch_coa:release', tone: 'bad', when: function (r) { return String(r.status || '').toUpperCase() === 'TESTED'; }, run: function (r) { rejectCoa(r); } });
  addAction('/v1/products', { label: 'DG / hazard', perm: 'packaging:product_master:write', when: function () { return true; }, run: function (r) { editDg(r); } });

  function rejectCoa(row) {
    var m = openSheet({ tag: 'form', style: 'max-width:440px', title: 'Reject batch ' + (row.batchNumber || ''),
      meta: 'QC\'s FAIL verdict: ALEMBIC is told the batch failed, labelling is blocked, production and packaging are alerted.',
      body: '<label style="display:flex;flex-direction:column;gap:5px">' + lbl('Reason *') + '<textarea id="pv-rj" class="fld" rows="3" required minlength="3"></textarea></label>' +
        '<button type="submit" class="btn r" style="width:100%;justify-content:center">Reject batch</button>' });
    m.sheet.onsubmit = function (e) {
      e.preventDefault(); var reason = $('pv-rj').value.trim(); if (reason.length < 3) return; m.close();
      tunnel('/v1/batch-coas/' + row.batchCoaId + '/reject', { method: 'POST', body: { reason: reason } }).then(function (res) {
        if (res.status >= 400) { toast(err(res, 'Not rejected (' + res.status + ')'), 'bad'); return; }
        toast('Rejected — ALEMBIC told, labelling blocked', 'bad'); loadView();
      }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
    };
  }

  function editDg(row) {
    tunnel('/v1/products/' + row.productId + '/dg-info').then(function (res) {
      var d = data(res) || {};
      var f = function (id, label, v, ph) { return '<label style="display:flex;flex-direction:column;gap:5px">' + lbl(label) + '<input id="' + id + '" class="fld" value="' + escHtml(v || '') + '" placeholder="' + escHtml(ph || '') + '"></label>'; };
      var m = openSheet({ tag: 'form', style: 'max-width:520px', title: 'DG / hazard · ' + (row.productCode || ''), meta: 'From the product\'s SDS. Printed on its labels; leave blank what does not apply.',
        body: '<div style="display:flex;gap:10px">' + f('pv-un', 'UN number', d.unNumber, 'UN1197') + f('pv-cls', 'Class', d.dgClass, '3') + f('pv-pg', 'Packing group', d.packingGroup, 'III') + '</div>' +
          f('pv-psn', 'Proper shipping name', d.properShippingName, 'Extracts, flavouring, liquid') + f('pv-sw', 'Signal word', d.signalWord, 'Warning') +
          '<label style="display:flex;flex-direction:column;gap:5px">' + lbl('Hazard statements') + '<textarea id="pv-hs" class="fld" rows="3">' + escHtml(d.hazardStatements || '') + '</textarea></label>' +
          '<button type="submit" class="btn p" style="width:100%;justify-content:center">Save</button>' });
      m.sheet.onsubmit = function (e) {
        e.preventDefault();
        var body = { unNumber: $('pv-un').value, dgClass: $('pv-cls').value, packingGroup: $('pv-pg').value, properShippingName: $('pv-psn').value, signalWord: $('pv-sw').value, hazardStatements: $('pv-hs').value };
        tunnel('/v1/products/' + row.productId + '/dg-info', { method: 'PUT', body: body }).then(function (r2) {
          if (r2.status >= 400) { toast(err(r2, 'Not saved (' + r2.status + ')'), 'bad'); return; }
          m.close(); toast('DG / hazard saved', 'good');
        });
      };
    }).catch(function () { toast('Can\'t connect. Try again.', 'bad'); });
  }

  /* ── dashboard strip: "Produce next" / "At the shelves" ─────────────────────────────── */
  (window.RA_DASH_HOOKS = window.RA_DASH_HOOKS || []).push(function (V, role) {
    var R = ROLES[role]; if (!R) return;
    var hasProduce = R.nav.some(function (n) { return n[0] === 'produce'; }) && can('production:production_order:read');
    var hasShelf = R.nav.some(function (n) { return n[0] === 'shelfdisplay'; }) && can('location:shelf_task:read');
    if (!hasProduce && !hasShelf) return;
    var host = document.createElement('div'); host.className = 'gwrap strip'; host.style.marginBottom = 'var(--gr-gap)';
    V.insertBefore(host, V.firstChild);
    var parts = [];
    var p1 = hasProduce ? tunnel('/v1/produce/queue?limit=300').then(function (res) {
      var c = (data(res) || {}).counters; if (!c) return;
      parts.push('<button type="button" class="work-tile" data-pnav="produce" style="flex:2;min-width:260px;text-align:left;border-radius:var(--r-md);padding:var(--s-snug)"><div class="t-cap" style="text-transform:uppercase;letter-spacing:.06em">Produce next</div>' +
        '<div style="display:flex;gap:18px;margin-top:6px;flex-wrap:wrap">' + [[c.open, 'open'], [num(c.kgToProduce) + ' kg', 'to produce'], [c.overdue, 'overdue', 'var(--red)'], [c.highValue, 'high value', 'var(--red)'], [c.blocked, 'blocked', 'var(--amber)']].map(function (x) {
          return '<span><b style="font:var(--w-med) var(--t-h1)/1 var(--font-ui);color:' + (x[2] && Number(x[0]) > 0 ? x[2] : 'var(--ink)') + '">' + escHtml(x[0]) + '</b> <span class="t-cap">' + x[1] + '</span></span>'; }).join('') + '</div></button>');
    }) : Promise.resolve();
    var p2 = hasShelf ? tunnel('/v1/shelf/display').then(function (res) {
      var c = (data(res) || {}).counters; if (!c) return;
      parts.push('<button type="button" class="work-tile" data-pnav="shelftasks" style="flex:1;min-width:220px;text-align:left;border-radius:var(--r-md);padding:var(--s-snug)"><div class="t-cap" style="text-transform:uppercase;letter-spacing:.06em">At the shelves</div>' +
        '<div style="display:flex;gap:18px;margin-top:6px"><span><b style="font:var(--w-med) var(--t-h1)/1 var(--font-ui)">' + c.putawayTasks + '</b> <span class="t-cap">to put away</span></span><span><b style="font:var(--w-med) var(--t-h1)/1 var(--font-ui)">' + c.pickTasks + '</b> <span class="t-cap">to pick</span></span></div></button>');
    }) : Promise.resolve();
    Promise.all([p1, p2]).then(function () {
      if (!parts.length) { host.remove(); return; }
      host.innerHTML = gCard({ title: 'Production', span: 'c12', expand: false, body: '<div style="display:flex;gap:var(--s-snug);flex-wrap:wrap">' + parts.join('') + '</div>' });
      [].forEach.call(host.querySelectorAll('[data-pnav]'), function (b) { b.onclick = function () { var k = b.getAttribute('data-pnav'); if (ROLES[st.role].nav.some(function (n) { return n[0] === k; })) navTo(k); else navTo('shelfdisplay'); }; });
    }).catch(function () { host.remove(); });
  });

  /* ── live alerts: toast + sound for every new produce alert ─────────────────────────── */
  function pollAlerts() {
    if (!session || document.hidden) return;
    var first = PV.alertSeq == null;
    tunnel('/v1/produce/alerts' + (first ? '?limit=1' : '?after=' + PV.alertSeq)).then(function (res) {
      if (res.status >= 400) return;
      var d = data(res) || {};
      var items = d.items || [];
      if (d.lastSeq != null) PV.alertSeq = d.lastSeq; else if (first) PV.alertSeq = 0;
      if (first) return; // what was already there is not news
      items.slice(-3).forEach(function (a) { toast(a.title + (a.detail ? ' — ' + a.detail : ''), a.severity === 'high' ? 'bad' : ''); });
      if (items.length > 3) toast('+' + (items.length - 3) + ' more production alerts', '');
      if (items.length && typeof loadAlerts === 'function') loadAlerts();
      if (items.length && st.nav === 'produce') loadView();
    }).catch(function () { /* next round */ });
  }
  setInterval(pollAlerts, 20000);
  setTimeout(pollAlerts, 4000);
})();
