/**
 * Lane pf-c: the print agent (tools/print-agent/agent.mjs) end to end against the real
 * PrintService and DevicesService behind a fake HTTP layer: it pairs with a code, pulls its job,
 * renders the template itself in the printer's language, sends the bytes, and answers. A printer
 * error is reported (the server retries and parks), not swallowed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import 'reflect-metadata';
import { ensureSchema, testClient, closeTestClient, principal } from '../../../test-support/db.js';
import { DevicesService } from '../floor-ops/devices.service.js';
import { PrintService } from '../floor-ops/print.service.js';
// @ts-expect-error plain ESM, no types
import * as agent from '../../../../tools/print-agent/agent.mjs';

let devices: DevicesService;
let print: PrintService;
const person = principal({ userId: randomUUID(), permissions: ['platform:print_job:write'] });

/** The three device routes, served by the real services (the controller's logic, inline). */
function fakeFetch() {
  return async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    const token = init.headers['x-device-token'];
    let data: unknown;
    try {
      if (path === '/v1/device-agent/pair') data = await devices.pair(body.code, body.info);
      else if (path === '/v1/device-agent/print-jobs/next') {
        const j = await print.claimNext(await devices.authenticate(token));
        data = { job: j && { printJobId: j.printJobId, language: j.language, template: j.template } };
      } else {
        const m = /^\/v1\/device-agent\/print-jobs\/([^/]+)\/result$/.exec(path)!;
        data = await print.report(await devices.authenticate(token), m[1]!, body);
      }
    } catch (e) {
      return { ok: false, status: 400, json: async () => ({ error: { message: (e as Error).message } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
}

before(async () => {
  await ensureSchema();
  devices = new DevicesService(testClient());
  print = new PrintService(testClient(), devices);
});
after(async () => closeTestClient());

test('pair, pull, render in TSPL, print to the device file, answer printed', async () => {
  const st = `Logistics ${randomUUID().slice(0, 6)}`;
  const r = await devices.create({ kind: 'label_printer', station: st, name: 'TSC TE244', config: { language: 'tspl', size: '100x150' } }, person);
  const f = fakeFetch();
  const cfg = { ...(await agent.pair('https://factory.test', r.pairing.code, f)), printer: 'file:' + join(mkdtempSync(join(tmpdir(), 'pfc-')), 'out.prn') };
  assert.equal(cfg.station, st);
  assert.match(cfg.token, /^rdt_/);
  const job = await print.enqueue({ station: st, labelKind: 'carton', subjectRef: `C-${randomUUID()}`, content: { title: 'CARTON', lines: [['Order', 'SO-77']], code: 'CTN-77-1' } }, person);
  const out = await agent.processOnce(cfg, { fetchImpl: f });
  assert.equal(out.printJobId, job.printJobId);
  assert.equal(out.ok, true);
  assert.equal(out.status, 'printed');
  const printed = readFileSync(cfg.printer.slice(5), 'utf8');
  assert.match(printed, /^SIZE 100 mm,150 mm/);
  assert.match(printed, /"CTN-77-1"/);
  assert.deepEqual(await agent.processOnce(cfg, { fetchImpl: f }), { idle: true });
});

test('a printer error is reported to the server, which schedules the retry', async () => {
  const st = `Pack ${randomUUID().slice(0, 6)}`;
  const r = await devices.create({ kind: 'label_printer', station: st, name: 'Zebra', config: { language: 'zpl' } }, person);
  const f = fakeFetch();
  const cfg = { ...(await agent.pair('https://factory.test', r.pairing.code, f)), printer: 'tcp://127.0.0.1:9' };
  const job = await print.enqueue({ station: st, labelKind: 'customer', subjectRef: `U-${randomUUID()}`, content: { title: 'X', code: 'U' } }, person);
  const out = await agent.processOnce(cfg, { fetchImpl: f, send: async () => { throw new Error('paper out'); } });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'paper out');
  const j = await print.get(job.printJobId);
  assert.equal(j.status, 'failed');
  assert.equal(j.lastError, 'paper out');
});
