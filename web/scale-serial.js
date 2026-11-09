/* RAW AROMA — a physical scale on the kiosk (web/scale-serial.js), FLOOR-FIX-16.
 * Before this nothing read a real scale: weights reached RawProd only as HTTP lines the emulator
 * sent. This reads an RS-232 / USB-serial scale through the browser's Web Serial API (Chrome and
 * Edge on desktop and Android; no new dependency) and posts each STABLE line through the existing
 * paired-scale route (POST /v1/device-agent/scale-readings with the scale's own device token), where
 * the server parses it again and stores it in integer mg. Pure apart from connect(): it runs in a
 * `vm` against a fake port in backend/api/src/__tests__/floor-fix-scale-serial.test.ts.
 *
 *   PROTOCOLS            per protocol: the serial defaults and the command that starts a stream
 *   parseLine(p, line)   -> { mg, stable, unit } or null; the same rules as the server's parseScaleLine
 *                        (Mettler SICS "S S"/"S D", A&D "ST,"/"US,"/"OL,", Ohaus "?", Sartorius
 *                        no-unit-when-unstable, generic). Negative, overload and sub-mg are null.
 *   createReader(o)      { run(), stop() } over o.port; posts a stable weight when it changes, and
 *                        the same weight again every 10 s so the server always has a fresh one.
 *   connect(o)           the kiosk: pick or reuse the port, read until stopped.
 */
(function (g) {
  'use strict';
  var FACTOR = { mg: 1, g: 1000, kg: 1000000 };
  var BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
  function serial(baudRate, dataBits, parity, stopBits) { return { baudRate: baudRate, dataBits: dataBits, stopBits: stopBits, parity: parity, flowControl: 'none' }; }
  var PROTOCOLS = {
    generic:   { name: 'Generic (continuous, "125.47 g")', serial: serial(9600, 8, 'none', 1), start: null },
    sics:      { name: 'Mettler Toledo MT-SICS', serial: serial(9600, 8, 'none', 1), start: 'SIR\r\n' },
    and:       { name: 'A&D (ST/US/OL)', serial: serial(2400, 7, 'even', 1), start: null },
    ohaus:     { name: 'Ohaus (continuous print)', serial: serial(9600, 8, 'none', 1), start: null },
    sartorius: { name: 'Sartorius SBI', serial: serial(9600, 7, 'odd', 1), start: null },
  };
  var REPOST_MS = 10000;

  function decimalToMg(num, unit) {
    var f = FACTOR[unit]; if (!f) return null;
    var parts = num.split('.'), int = parts[0], frac = (parts[1] || '').replace(/0+$/, '');
    var places = String(f).length - 1;
    if (frac.length > places) return null;
    while (frac.length < places) frac += '0';
    var mg = Number(int) * f + (places ? Number(frac) : 0);
    return Number.isSafeInteger(mg) ? mg : null;
  }

  function parseLine(_protocol, raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s || /^(OL|S\s+[+-]|S\s+I)\b/i.test(s) || /^OL,/i.test(s)) return null;
    var stable = !(/^S\s+D\b/i.test(s) || /^US,/i.test(s) || /\?/.test(s));
    var m = /([+-])?\s*(\d+(?:\.\d+)?)\s*(mg|kg|g)\b/i.exec(s);
    if (!m || m[1] === '-') return null;
    var unit = m[3].toLowerCase(), mg = decimalToMg(m[2], unit);
    return mg === null ? null : { mg: mg, stable: stable, unit: unit };
  }

  function settingsFor(protocol, over) {
    var p = PROTOCOLS[protocol] || PROTOCOLS.generic, o = over || {}, b = p.serial;
    return serial(BAUDS.indexOf(Number(o.baudRate)) >= 0 ? Number(o.baudRate) : b.baudRate,
      o.dataBits === 7 || o.dataBits === 8 ? o.dataBits : b.dataBits,
      ['none', 'even', 'odd'].indexOf(o.parity) >= 0 ? o.parity : b.parity,
      o.stopBits === 1 || o.stopBits === 2 ? o.stopBits : b.stopBits);
  }

  function createReader(o) {
    var protocol = PROTOCOLS[o.protocol] ? o.protocol : 'generic';
    var now = o.now || function () { return Date.now(); };
    var reader = null, stopped = false, lastMg = null, lastAt = -Infinity;
    async function handle(line) {
      var r = parseLine(protocol, line);
      if (!r) return;
      if (o.onReading) o.onReading({ mg: r.mg, stable: r.stable, unit: r.unit, raw: line });
      if (!r.stable) return;
      var t = now();
      if (r.mg === lastMg && t - lastAt < REPOST_MS) return;
      lastMg = r.mg; lastAt = t;
      try { await o.post(line.trim()); } catch (e) { if (o.onError) o.onError(e); }
    }
    return {
      run: async function () {
        await o.port.open(settingsFor(protocol, o.settings));
        try {
          var start = PROTOCOLS[protocol].start;
          if (start && o.port.writable) { var w = o.port.writable.getWriter(); await w.write(new TextEncoder().encode(start)); w.releaseLock(); }
          var dec = new TextDecoder(), buf = '';
          reader = o.port.readable.getReader();
          while (!stopped) {
            var c = await reader.read();
            if (c.done) break;
            buf += dec.decode(c.value, { stream: true });
            var lines = buf.split(/\r\n|\r|\n/); buf = lines.pop();
            for (var i = 0; i < lines.length; i++) if (lines[i].trim()) await handle(lines[i]);
          }
          if (buf.trim()) await handle(buf);
        } finally {
          try { if (reader) reader.releaseLock(); } catch (e) { /* already released */ }
          await o.port.close();
        }
      },
      stop: function () { stopped = true; if (reader) reader.cancel().catch(function () {}); },
    };
  }

  /** The kiosk: `token` is the SCALE's device token; `config` its Admin settings (protocol, baudRate). */
  async function connect(o) {
    var nav = g.navigator;
    if (!nav || !nav.serial) throw new Error('This browser cannot read a serial scale. Use Chrome or Edge, or type the weight (a second person signs it).');
    var ports = await nav.serial.getPorts();
    var port = ports[0] || await nav.serial.requestPort();
    var cfg = o.config || {};
    var r = createReader({
      port: port, protocol: cfg.protocol, settings: { baudRate: cfg.baudRate, dataBits: cfg.dataBits, parity: cfg.parity, stopBits: cfg.stopBits },
      onReading: o.onReading, onError: o.onError,
      post: function (raw) {
        return g.fetch('/v1/device-agent/scale-readings', { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-token': o.token }, body: JSON.stringify({ raw: raw }) })
          .then(function (res) { if (!res.ok) throw new Error('The server refused the scale reading (' + res.status + ').'); });
      },
    });
    r.run().catch(function (e) { if (o.onError) o.onError(e); });
    return r;
  }

  g.RaScaleSerial = { PROTOCOLS: PROTOCOLS, BAUDS: BAUDS, parseLine: parseLine, settingsFor: settingsFor, createReader: createReader, connect: connect };
})(typeof window !== 'undefined' ? window : globalThis);
