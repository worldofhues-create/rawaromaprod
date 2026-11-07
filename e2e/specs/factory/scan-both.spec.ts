/* SCAN-6 (owner: "Product scanning: we need both QR and barcode"). The labels the renderer generates
 * are decoded back to their payload by a real decoder (Chromium's BarcodeDetector), both symbologies,
 * at every 12.4 size; and the one scan field reads a wedge scanner of either symbology (with AIM
 * prefixes and Enter/Tab suffixes) and the camera, resolving through scan-resolve under the
 * scanner's permissions. The camera is fed the label itself as its video, so nothing is stubbed on
 * the detection side. */
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { must } from '../../harness/chain';
import { openNav, signIn, sql, uniq } from '../../harness/walk';

const letters = () => Array.from({ length: 7 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

async function codedLot(info: Parameters<Parameters<typeof test>[1]>[1]) {
  const fam = uniq('fam', info).toLowerCase();
  await must('admin', 'PUT', `/v1/floor/families/${fam}`, { familyName: 'Scan family', colourName: 'Tone' + letters(), colourHex: '#E8C547' });
  const mat = randomUUID();
  sql(`insert into masterdata.material (material_id, material_code, material_name, status) values ('${mat}', '${uniq('MS', info)}', 'Scan oil', 'ACTIVE')`);
  const fc = (await must('procurement', 'POST', '/v1/floor/codes', { materialId: mat, familyCode: fam })) as { code: string };
  sql(`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values ('${randomUUID()}', 'g', 'gram', 'ACTIVE') on conflict do nothing`);
  const g = sql(`select uom_id from platform.uom_master where uom_code='g'`);
  const rb = randomUUID(), ib = randomUUID(), bin = randomUUID(), binCode = (uniq('BS', info) + letters()).toUpperCase();
  sql(`insert into location.bin_master (bin_id, bin_code, status) values ('${bin}', '${binCode}', 'ACTIVE')`);
  sql(`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, expiry_date, status) values ('${rb}', '${mat}', '${uniq('RMS', info)}', '2099-01-01', 'ACTIVE')`);
  sql(`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result) values ('${randomUUID()}', '${rb}', 'ACCEPT')`);
  sql(`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, storage_location_id, quantity_on_hand, uom_id, status) values ('${ib}', '${rb}', '${mat}', '${bin}', 1000, '${g}', 'ACTIVE')`);
  const r = (await must('warehouse', 'POST', `/v1/floor/lots/${ib}/barcode`)) as { barcode: string };
  return { barcode: r.barcode, floorCode: fc.code, bin: binCode };
}

/** Draw every generated code symbol (QR and Code 128) on a white canvas and decode it for real. */
async function decodeLabel(page: Page, payload: string, size: string) {
  return page.evaluate(async ({ payload, size }) => {
    const L = (window as unknown as { RaLabel: any }).RaLabel; // eslint-disable-line @typescript-eslint/no-explicit-any
    const t = L.build({ title: 'PICKED', lines: [['Order', 'SO-1']], code: payload }, size);
    const host = document.createElement('div');
    host.innerHTML = L.render(t, 'html').body;
    const det = new (window as unknown as { BarcodeDetector: any }).BarcodeDetector({ formats: ['qr_code', 'code_128'] }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const out: Array<{ kind: string; format: string | null; value: string | null }> = [];
    const PX = 12; // px per mm: about a 300 dpi print
    for (const svg of Array.from(host.querySelectorAll('svg'))) {
      const el = t.elements.find((e: { t: string; d: string }) => (svg.hasAttribute('data-qr') ? e.t === 'qr' : e.t === 'code128'));
      const w = Math.round(el.w * PX), h = Math.round(el.h * PX), pad = Math.round((svg.hasAttribute('data-qr') ? 4 * el.m : 10 * el.m) * PX);
      const clone = svg.cloneNode(true) as SVGElement;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', String(w)); clone.setAttribute('height', String(h)); clone.removeAttribute('style');
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(clone.outerHTML);
      await img.decode();
      const c = document.createElement('canvas');
      c.width = w + 2 * pad; c.height = h + 2 * pad;
      const g = c.getContext('2d')!;
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, pad, pad, w, h);
      const found = await det.detect(c);
      out.push({ kind: svg.hasAttribute('data-qr') ? 'qr' : 'code128', format: found[0]?.format ?? null, value: found[0]?.rawValue ?? null });
    }
    return { out, codes: t.codes };
  }, { payload, size });
}

test('every generated label decodes back to its opaque payload: QR and Code 128, every 12.4 size (38x25: QR only, recorded)', async ({ page }, info) => {
  const lot = await codedLot(info);
  await signIn(page, 'factory', 'warehouse');
  for (const size of ['38x25', '50x25', '75x50', '100x50', '100x100', '100x150', '62mm', 'a4']) {
    for (const payload of [lot.barcode, lot.bin, 'CTN-41-2', 'T-12']) {
      const r = await decodeLabel(page, payload, size);
      const qr = r.out.find((o) => o.kind === 'qr'), bar = r.out.find((o) => o.kind === 'code128');
      expect(qr, `${size} ${payload} QR present`).toBeTruthy();
      expect(qr!.value, `${size} ${payload} QR decodes`).toBe(payload);
      expect(qr!.format).toBe('qr_code');
      // 38x25: a Code 128 at the 0.25 mm floor fits only payloads of 8 characters or fewer
      // (11*(n+3)+2 modules + quiet zones <= 38 mm); a lot's L- code (9) gets QR + text, recorded.
      if (size === '38x25' && payload === lot.barcode) expect(r.codes.code128, 'a lot code is too long for Code 128 at 38x25').toBe(false);
      if (size !== '38x25' && payload === lot.barcode) expect(r.codes.code128, `${size} lot code carries both`).toBe(true);
      // Only the vial sizes may drop the Code 128, and only for a payload too long for it at 0.25 mm
      // (38x25: over 8 characters; 50x25: over 13; 62 mm continuous: over 17, a bar cannot wrap).
      // 75 mm wide and up carries both for anything the floor prints (75x50: up to 22 characters).
      if (!r.codes.code128) expect(['38x25', '50x25', '62mm'], `${size} ${payload} dropped Code 128`).toContain(size);
      if (!r.codes.code128) {
        expect(bar, '38x25 has no Code 128 for a long payload').toBeUndefined();
        expect(r.codes.code128).toBe(false);
        expect(r.codes.note).toMatch(/Code 128 .* needs .* mm/);
      } else {
        expect(bar?.value, `${size} ${payload} Code 128 decodes (${JSON.stringify(r)})`).toBe(payload);
        expect(bar!.format).toBe('code_128');
      }
    }
  }
});

test('the shared scan field: wedge QR (]Q1 + Enter) and wedge Code 128 (]C0 + Tab) resolve the same lot; typed works too', async ({ page }, info) => {
  const lot = await codedLot(info);
  await signIn(page, 'factory', 'warehouse');
  await openNav(page, 'Scan a lot');
  const field = page.locator('#fl-sci');
  await expect(page.locator('[data-scan-camera="fl-sci"]')).toBeVisible();
  // A wedge scanner types a whole code in a few ms per key, then its suffix.
  await field.focus();
  await page.keyboard.type(`]Q1${lot.barcode}`, { delay: 4 });
  await page.keyboard.press('Enter');
  await expect(page.locator('#fl-sco')).toContainText(lot.floorCode);
  await expect(field).toHaveValue(lot.barcode);
  await expect(field).toHaveAttribute('data-scan-symbology', 'qr_code');
  // Warehouse holds masterdata:material:reveal by design; a floor role scanning the same label does not.
  await expect(page.locator('#fl-sco')).toContainText('Scan oil');
  const asPicker = (await must('picker', 'GET', `/v1/floor/scan?code=${encodeURIComponent(']Q1' + lot.barcode)}`)) as Record<string, unknown>;
  expect(asPicker.floorCode).toBe(lot.floorCode);
  expect(asPicker.materialName).toBeUndefined();
  await page.evaluate(() => { document.getElementById('fl-sco')!.innerHTML = ''; });
  await field.fill('');
  await field.focus();
  await page.keyboard.type(`]C0${lot.barcode}`, { delay: 4 });
  await page.keyboard.press('Tab');
  await expect(page.locator('#fl-sco')).toContainText(lot.floorCode);
  await expect(field).toBeFocused(); // a scanner's Tab does not move the kiosk off its field
  await expect(field).toHaveAttribute('data-scan-source', 'wedge');
  await page.evaluate(() => { document.getElementById('fl-sco')!.innerHTML = ''; });
  await field.fill('');
  await field.pressSequentially(lot.barcode.toLowerCase(), { delay: 90 });
  await page.keyboard.press('Enter');
  await expect(page.locator('#fl-sco')).toContainText(lot.floorCode);
});

test('camera scanning: the permission prompt, then the printed label read off the camera resolves; no detector says so', async ({ page }, info) => {
  const lot = await codedLot(info);
  // The "camera" shows the label the renderer printed (QR + Code 128) — real decoding, fake lens.
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    md.getUserMedia = async () => {
      const L = (window as unknown as { RaLabel: any }).RaLabel; // eslint-disable-line @typescript-eslint/no-explicit-any
      const code = (window as unknown as { __camCode: string }).__camCode;
      const host = document.createElement('div');
      host.innerHTML = L.codesHtml(code, { maxWidthMm: 90 }).html;
      const svg = host.querySelector('svg[data-qr]')!.cloneNode(true) as SVGElement;
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); svg.setAttribute('width', '300'); svg.setAttribute('height', '300'); svg.removeAttribute('style');
      const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.outerHTML); await img.decode();
      const c = document.createElement('canvas'); c.width = 480; c.height = 480;
      const g = c.getContext('2d')!;
      const draw = () => { g.fillStyle = '#fff'; g.fillRect(0, 0, 480, 480); g.drawImage(img, 90, 90, 300, 300); };
      draw(); setInterval(draw, 100);
      return c.captureStream(10);
    };
  });
  await signIn(page, 'factory', 'warehouse');
  await openNav(page, 'Scan a lot');
  await page.evaluate((c) => { (window as unknown as { __camCode: string }).__camCode = c; }, lot.barcode);
  await page.locator('[data-scan-camera="fl-sci"]').click();
  await expect(page.locator('.ra-scan-overlay [data-scan-prompt]')).toContainText('ask to use the camera');
  await expect(page.locator('.ra-scan-overlay')).toHaveCount(0, { timeout: 20_000 }); // read, closed
  await expect(page.locator('#fl-sco')).toContainText(lot.floorCode);
  await expect(page.locator('#fl-sci')).toHaveAttribute('data-scan-source', 'camera');
  // A browser without BarcodeDetector: a clear fallback, and typing still works.
  await page.evaluate(() => { delete (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector; });
  await page.locator('[data-scan-camera="fl-sci"]').click();
  await expect(page.locator('[data-scan-fallback]')).toContainText('Use the scanner or type the code');
  await page.locator('[data-scan-close]').click();
  await expect(page.locator('#fl-sci')).toBeFocused();
});

test('a camera permission refusal says how to allow it', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  });
  await signIn(page, 'factory', 'warehouse');
  await openNav(page, 'Scan a lot');
  await page.locator('[data-scan-camera="fl-sci"]').click();
  await expect(page.locator('[data-scan-status]')).toContainText('Camera permission was refused');
});

test('Devices: the admin records a scanner per station with its symbologies; it needs no pairing code', async ({ page }, info) => {
  await signIn(page, 'factory', 'admin');
  await openNav(page, 'Devices');
  const st = uniq('Picker bay', info);
  await page.locator('#fo-kind').selectOption('scanner');
  await page.locator('#fo-station').fill(st);
  await page.locator('#fo-name').fill('Honeywell 1472g');
  await page.locator('#fo-add button[type="submit"]').click();
  await expect(page.locator('#ra-view')).toContainText('Barcode scanner');
  const row = page.locator('tr', { hasText: st });
  await expect(row).toContainText('QR, Code 128');
  await expect(row).toContainText('Recorded');
  await expect(row.locator('[data-code]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
