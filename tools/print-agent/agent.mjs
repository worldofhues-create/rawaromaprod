#!/usr/bin/env node
/**
 * RawProd print agent (lane pf-c, production-floor plan section 2 and 12.4).
 *
 * A small service on a PC or Raspberry Pi next to a label printer. It pairs like any device,
 * pulls its printer's jobs from RawProd, renders each job's ONE template definition in the
 * printer's language with web/label-render.js (the same file the browser fallback uses), sends it
 * to the printer, and answers printed / failed. Retries, backoff and parking are the server's:
 * the agent just reports what happened, so a job never prints twice because two agents guessed.
 *
 *   node tools/print-agent/agent.mjs pair --api https://rawfactory.example.com --code 123456
 *   node tools/print-agent/agent.mjs run  [--printer tcp://10.0.0.20:9100 | --printer lp:Zebra_ZD421 | --printer file:/dev/usb/lp0]
 *   node tools/print-agent/agent.mjs test  (prints a test label)
 *
 * Printer transports:
 *   tcp://host:9100   raw socket (Zebra, TSC, Honeywell, Godex, TVS, Epson network models)
 *   lp:<queue>        the OS print queue (CUPS `lp -o raw`); PDF jobs go through the same queue
 *   file:<path>       a device file (/dev/usb/lp0) or a file, for a USB printer or a dry run
 *
 * The device token is kept in ~/.rawprod-print-agent.json (mode 600) and never printed. No
 * dependencies: Node 22 only. Run it from a checkout of the repository (it loads
 * ../../web/label-render.js), under systemd or a Windows service wrapper.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));

/** The shared renderer, loaded as the page loads it. */
export function loadRenderer(path = join(here, '..', '..', 'web', 'label-render.js')) {
  const sandbox = { Buffer };
  // SCAN-1: the QR encoder sits next to the renderer and loads first, as on the page.
  runInNewContext(readFileSync(join(dirname(path), 'qrcode.js'), 'utf8'), sandbox);
  // FONT-RP-5: the Manrope subset that label PDFs embed.
  runInNewContext(readFileSync(join(dirname(path), 'label-pdf-font.js'), 'utf8'), sandbox);
  runInNewContext(readFileSync(path, 'utf8'), sandbox);
  return sandbox.RaLabel;
}

export const CONFIG_PATH = join(homedir(), '.rawprod-print-agent.json');
export function readConfig(path = CONFIG_PATH) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}
export function writeConfig(cfg, path = CONFIG_PATH) {
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  chmodSync(path, 0o600);
}

async function call(cfg, method, path, body, fetchImpl = fetch) {
  const res = await fetchImpl(cfg.api.replace(/\/+$/, '') + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cfg.token ? { 'x-device-token': cfg.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json && json.error && json.error.message) || `HTTP ${res.status}`);
  return json && json.data !== undefined ? json.data : json;
}

/** Sends bytes to the printer. Resolves when the printer (or the queue) accepted them. */
export function sendToPrinter(printer, bytes, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!printer) return reject(new Error('no printer configured (--printer)'));
    if (printer.startsWith('tcp://')) {
      const u = new URL(printer);
      const sock = connect({ host: u.hostname, port: Number(u.port || 9100) });
      const t = setTimeout(() => { sock.destroy(); reject(new Error('printer did not answer')); }, timeoutMs);
      sock.on('error', (e) => { clearTimeout(t); reject(e); });
      sock.on('connect', () => sock.end(bytes, () => { clearTimeout(t); resolve(); }));
    } else if (printer.startsWith('lp:')) {
      const lp = spawn('lp', ['-d', printer.slice(3), '-o', 'raw']);
      lp.on('error', reject);
      lp.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`lp exited ${code}`))));
      lp.stdin.end(bytes);
    } else if (printer.startsWith('file:')) {
      try { writeFileSync(printer.slice(5), bytes); resolve(); } catch (e) { reject(e); }
    } else reject(new Error(`unknown printer transport ${printer}`));
  });
}

/** One pull: take the next job, render, print, answer. Returns what happened (for logs and tests). */
export async function processOnce(cfg, { renderer, fetchImpl = fetch, send = sendToPrinter } = {}) {
  const L = renderer ?? loadRenderer();
  const { job } = await call(cfg, 'POST', '/v1/device-agent/print-jobs/next', {}, fetchImpl);
  if (!job) return { idle: true };
  let ok = true, error = null;
  try {
    const out = L.render(job.template, job.language, { dpi: cfg.dpi || 203 });
    const bytes = out.encoding === 'base64' ? Buffer.from(out.body, 'base64') : Buffer.from(out.body, 'utf8');
    await send(cfg.printer, bytes);
  } catch (e) {
    ok = false;
    error = String((e && e.message) || e).slice(0, 300);
  }
  const res = await call(cfg, 'POST', `/v1/device-agent/print-jobs/${job.printJobId}/result`, ok ? { ok: true } : { ok: false, error }, fetchImpl);
  return { printJobId: job.printJobId, ok, error, status: res.status };
}

export async function pair(api, code, fetchImpl = fetch) {
  const r = await call({ api }, 'POST', '/v1/device-agent/pair', { code, info: { agent: 'rawprod-print-agent', node: process.version } }, fetchImpl);
  return { api, token: r.token, deviceId: r.device.deviceId, station: r.device.station, name: r.device.name };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'pair') {
    const api = arg('api'), code = arg('code');
    if (!api || !code) throw new Error('usage: agent.mjs pair --api <url> --code <6 digits>');
    const cfg = { ...readConfig(), ...(await pair(api, code)) };
    if (arg('printer')) cfg.printer = arg('printer');
    writeConfig(cfg);
    console.log(`Paired as "${cfg.name}" at ${cfg.station}. Token saved to ${CONFIG_PATH}.`);
    return;
  }
  const cfg = readConfig();
  if (arg('printer')) cfg.printer = arg('printer');
  if (!cfg.token) throw new Error('not paired: run `agent.mjs pair --api <url> --code <code>` first');
  const renderer = loadRenderer();
  if (cmd === 'test') {
    const t = renderer.build({ brand: 'RAW AROMA CHEM', title: 'TEST PRINT', lines: [['Station', cfg.station], ['Printer', cfg.name]], code: 'TEST-' + Date.now() }, arg('size') || '100x50');
    const out = renderer.render(t, arg('language') || 'zpl');
    await sendToPrinter(cfg.printer, out.encoding === 'base64' ? Buffer.from(out.body, 'base64') : Buffer.from(out.body));
    console.log('Test label sent.');
    return;
  }
  if (cmd !== 'run') throw new Error('usage: agent.mjs pair|run|test');
  const beat = async () => { try { await call(cfg, 'POST', '/v1/device-agent/heartbeat', {}); } catch (e) { console.error('heartbeat:', e.message); } };
  await beat();
  setInterval(beat, 20_000); // FLOOR-FIX-6: well inside the 60 s offline window
  for (;;) {
    try {
      const r = await processOnce(cfg, { renderer });
      if (!r.idle) console.log(new Date().toISOString(), r.printJobId, r.ok ? 'printed' : `failed: ${r.error} (${r.status})`);
      if (r.idle) await new Promise((s) => setTimeout(s, 2000));
    } catch (e) {
      console.error('pull:', e.message);
      await new Promise((s) => setTimeout(s, 5000));
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
