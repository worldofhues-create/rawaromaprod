/* RAW AROMA — device pairing page logic (web/pair.html), lane pf-c. External so a strict CSP
 * (script-src 'self') never blocks it. */
  'use strict';
  (function () {
    var KEY = 'ra.device';
    function store() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
    function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* private mode */ } }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function msg(t, cls) { var m = document.getElementById('msg'); m.textContent = t; m.className = 'msg ' + (cls || ''); }
    async function api(method, path, body, token) {
      var r = await fetch(path, { method: method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { 'x-device-token': token } : {}), body: body ? JSON.stringify(body) : undefined });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error((j && j.error && j.error.message) || ('Error ' + r.status));
      return j && j.data !== undefined ? j.data : j;
    }
    var SCREEN = { packing: 'Packing station', logistics: 'Logistics station', maceration: 'Maceration', printq: 'Print queue', floorboard: 'Floor board' };

    function showPaired(dev) {
      document.getElementById('form-panel').style.display = 'none';
      var p = document.getElementById('paired'); p.style.display = 'block';
      if (dev.kind === 'kiosk') {
        var screen = (dev.config && dev.config.screen) || 'packing';
        try { localStorage.setItem('ra.kiosk', JSON.stringify({ station: dev.station, screen: screen, deviceId: dev.deviceId })); } catch (e) { /* private mode */ }
        p.innerHTML = '<h2>Kiosk paired</h2><div>' + esc(dev.name) + ' · <b>' + esc(dev.station) + '</b></div><div class="t-cap">Locked to ' + esc(SCREEN[screen] || screen) + '. A person signs in to act; every action names them.</div><button id="go">Open the station</button><button class="ghost" id="forget">Forget this pairing</button>';
        document.getElementById('go').onclick = function () { location.href = '/'; };
      } else if (dev.kind === 'display') {
        p.innerHTML = '<h2>Display paired</h2><div>' + esc(dev.name) + ' · <b>' + esc(dev.station) + '</b></div><button id="go">Show the floor board</button><button class="ghost" id="forget">Forget this pairing</button>';
        document.getElementById('go').onclick = startBoard;
      } else {
        p.innerHTML = '<h2>Paired</h2><div>' + esc(dev.name) + ' · <b>' + esc(dev.station) + '</b></div><div class="t-cap">A ' + esc(dev.kind.replace('_', ' ')) + ' sends its work through the print agent or its reader, not this page.</div><button class="ghost" id="forget">Forget this pairing</button>';
      }
      document.getElementById('forget').onclick = function () { try { localStorage.removeItem(KEY); localStorage.removeItem('ra.kiosk'); } catch (e) { /* ignore */ } location.hash = ''; location.reload(); };
    }

    function row(a, b, c) { return '<div class="row"><b class="mono">' + esc(a) + '</b><span>' + esc(b) + '</span>' + (c ? '<span class="t-cap">' + esc(c) + '</span>' : '') + '</div>'; }
    async function tick() {
      var d = store(); if (!d) return;
      document.getElementById('net').style.display = navigator.onLine ? 'none' : 'block';
      try {
        await api('POST', '/v1/device-agent/heartbeat', {}, d.token);
        var b = await api('GET', '/v1/device-agent/display', null, d.token);
        var B = document.getElementById('board');
        var STAGE = { PICK: 'Pick', VERIFY: 'Verify', MIX: 'Mix' };
        var qb = b.qcBacklog || {}, q2 = qb.qc2Ready || [], pq = qb.packagingQc || [];
        var at = new Date(b.at), atText = isNaN(at) ? '' : at.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        B.innerHTML = '<div class="grid">' +
          '<div class="panel"><h2>Floor queue</h2>' + ((b.queue || []).map(function (j) { return row(j.jobNo, STAGE[j.stage] || j.stage, (j.orderRef || '') + (j.expedite ? ' · URGENT' : '')); }).join('') || '<div class="t-cap">Queue empty.</div>') + '</div>' +
          '<div class="panel"><h2>Maceration</h2>' + ((b.maceration || []).map(function (r) { return row(r.batchNumber || '', r.label, r.overMax ? 'PAST MAXIMUM' : r.readyForQc2 ? 'Ready for QC 2' : ''); }).join('') || '<div class="t-cap">Nothing macerating.</div>') + '</div>' +
          '<div class="panel"><h2>QC backlog</h2>' + row('QC 2 ready', String(q2.length), q2.slice(0, 6).join(', ')) + row('Packaging QC', String(pq.length), pq.slice(0, 6).join(', ')) + '</div>' +
          ((b.alerts || []).length ? '<div class="panel" style="grid-column:1/-1"><h2>Alerts · ' + esc(b.station || '') + '</h2>' + b.alerts.map(function (a) { return row(a.title, '', a.body || ''); }).join('') + '</div>' : '') +
          '</div><div class="t-cap" style="margin-top:10px">' + esc(d.station) + ' · updated ' + esc(atText) + '</div>';
      } catch (e) {
        if (/revoked|not recognised|not paired/i.test(e.message)) { try { localStorage.removeItem(KEY); } catch (x) { /* ignore */ } location.reload(); return; }
        // A failed read said nothing: the TV kept a board of unknown age, or stayed blank.
        var Bd = document.getElementById('board'), old = document.getElementById('stale'); if (old) old.remove();
        Bd.insertAdjacentHTML('afterbegin', '<div id="stale" role="alert" class="panel bad" style="font-size:22px;font-weight:600;margin:0 0 16px">The floor board did not update' + (Bd.querySelector('.grid') ? '; showing the last one' : '') + '. Trying again every 15 seconds.</div>');
      }
    }
    function startBoard() {
      document.getElementById('pair').style.display = 'none';
      document.getElementById('board').style.display = 'block';
      try { var fs = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); if (fs && fs.catch) fs.catch(function () {}); } catch (e) { /* needs a gesture */ }
      tick(); setInterval(tick, 15000);
    }
    window.addEventListener('online', tick); window.addEventListener('offline', tick);

    document.getElementById('f').addEventListener('submit', async function (e) {
      e.preventDefault();
      var code = document.getElementById('code').value.trim();
      if (!/^\d{6}$/.test(code)) { msg('The code is 6 digits.', 'bad'); return; }
      msg('Pairing…');
      try {
        var r = await api('POST', '/v1/device-agent/pair', { code: code, info: { ua: navigator.userAgent.slice(0, 120) } });
        save({ token: r.token, deviceId: r.device.deviceId, kind: r.device.kind, station: r.device.station, name: r.device.name });
        history.replaceState(null, '', '/pair.html');
        msg('Paired.', 'ok');
        showPaired(r.device);
        if (r.device.kind === 'display') startBoard();
      } catch (err) { msg(err.message, 'bad'); }
    });

    var m = /(?:^|[#&])code=(\d{6})/.exec(location.hash);
    var saved = store();
    if (m && !saved) { document.getElementById('code').value = m[1]; }
    else if (saved) {
      api('GET', '/v1/device-agent/me', null, saved.token).then(function (dev) {
        showPaired(dev);
        if (dev.kind === 'display') startBoard();
      }).catch(function () { try { localStorage.removeItem(KEY); localStorage.removeItem('ra.kiosk'); } catch (e) { /* ignore */ } msg('This device was unpaired. Enter a new code.', 'bad'); });
    }
  })();
