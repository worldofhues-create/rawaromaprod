/* SCAN-13: what the flow walks assert about a printed label. A label exists (a print job, or the
 * browser label window), it carries Code 128 AND QR of the opaque id, both decode back to that id
 * with a real decoder (Chromium's BarcodeDetector), and a reprint says REPRINT with its reason. */
import { expect, type Page } from '@playwright/test';
import { sql } from './walk';

type El = { t: string; d?: string; s?: string };

/** The newest print job of this kind for this code: printed (browser fallback), both codes on it. */
export async function printedJob(kind: string, code: string, opts: { reprint?: boolean } = {}) {
  const q = `select status || '|' || (reprint_of is not null) || '|' || coalesce(reprint_reason, '') || '|' || template::text from platform.print_job
              where label_kind = '${kind}' and subject_ref = '${code.replace(/'/g, "''")}' order by created_at desc limit 1`;
  await expect.poll(() => sql(q).split('|')[0], { message: `${kind} ${code} printed` }).toBe('printed');
  const [status, isReprint, reason, ...rest] = sql(q).split('|');
  const t = JSON.parse(rest.join('|')) as { elements: El[]; codes?: { code128: boolean }; reprint: boolean };
  expect(t.elements.some((e) => e.t === 'qr' && e.d === code), `${kind}: QR of ${code}`).toBe(true);
  if (t.codes?.code128 !== false) expect(t.elements.some((e) => e.t === 'code128' && e.d === code), `${kind}: Code 128 of ${code}`).toBe(true);
  if (opts.reprint) {
    expect(isReprint, `${kind} is a reprint`).toBe('true');
    expect(reason.length, `${kind} reprint has a reason`).toBeGreaterThan(0);
    expect(t.elements.some((e) => e.t === 'text' && e.s === 'REPRINT'), `${kind} says REPRINT`).toBe(true);
  }
  return { status, template: t };
}

/** Collect every label window the page opens (the browser fallback), closing it. */
export function labelWindows(page: Page) {
  const html: string[] = [];
  page.on('popup', async (p) => { try { await p.waitForLoadState(); html.push(await p.content()); } catch { /* closed */ } await p.close().catch(() => {}); });
  return html;
}

/** Decode every QR / Code 128 svg in some label HTML with the page's BarcodeDetector. */
export async function decode(page: Page, html: string) {
  return page.evaluate(async (h) => {
    const host = document.createElement('div'); host.innerHTML = h;
    const det = new (window as unknown as { BarcodeDetector: any }).BarcodeDetector({ formats: ['qr_code', 'code_128'] }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const out: Array<{ format: string | null; value: string | null }> = [];
    for (const svg of Array.from(host.querySelectorAll('svg[data-qr],svg[data-code128]'))) {
      const qr = svg.hasAttribute('data-qr'), vb = (svg.getAttribute('viewBox') || '0 0 1 1').split(/\s+/).map(Number);
      const w = qr ? 300 : Math.max(600, vb[2] * 4), hgt = qr ? 300 : 120, pad = qr ? 40 : 60;
      const c2 = svg.cloneNode(true) as SVGElement;
      c2.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); c2.setAttribute('width', String(w)); c2.setAttribute('height', String(hgt)); c2.removeAttribute('style');
      const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(c2.outerHTML); await img.decode();
      const c = document.createElement('canvas'); c.width = w + 2 * pad; c.height = hgt + 2 * pad;
      const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, pad, pad, w, hgt);
      const f = await det.detect(c);
      out.push({ format: f[0]?.format ?? null, value: f[0]?.rawValue ?? null });
    }
    return out;
  }, html);
}

/** A label window's codes decode to `code`, as QR and as Code 128. */
export async function windowDecodes(page: Page, html: string, code: string) {
  const d = await decode(page, html);
  expect(d.find((x) => x.format === 'qr_code')?.value, `QR decodes to ${code}`).toBe(code);
  expect(d.find((x) => x.format === 'code_128')?.value, `Code 128 decodes to ${code}`).toBe(code);
}

/** A print job's template, rendered in the page, decodes to `code` (both symbologies). */
export async function jobDecodes(page: Page, template: unknown, code: string) {
  const html = await page.evaluate((t) => (window as unknown as { RaLabel: any }).RaLabel.render(t, 'html').body, template); // eslint-disable-line @typescript-eslint/no-explicit-any
  await windowDecodes(page, html, code);
}

/** A keyboard-wedge scan: AIM prefix, the code a few ms per key, then the suffix. */
export async function wedge(page: Page, selector: string, code: string, aim = ']C0', suffix: 'Enter' | 'Tab' = 'Enter') {
  await page.locator(selector).fill('');
  await page.locator(selector).focus();
  await page.keyboard.type(aim + code, { delay: 4 });
  await page.keyboard.press(suffix);
}

/** Reprint through the in-page reason sheet. */
export async function reprintWithReason(page: Page, buttonSelector: string, reason: string) {
  await page.locator(buttonSelector).first().click();
  await page.locator('[data-ask="reason"]').fill(reason);
  await page.getByRole('button', { name: 'Reprint', exact: true }).last().click();
}
