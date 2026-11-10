/**
 * The label renderer, server side (lane pf-c). There is ONE implementation of label layout and
 * printer languages: web/label-render.js, a classic script the page, the print agent and this
 * module all load. The API runs from a full checkout (DEPLOY.md §3), so it reads the same file
 * and runs it in a vm, exactly as the tests do. Never fork it.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

export interface LabelElement { t: 'text' | 'code128' | 'qr' | 'line'; x: number; y: number; w?: number; h?: number; s?: string; b?: boolean; d?: string; m?: number }
export interface LabelTemplate { v: 1; size: string; w: number; h: number; reprint: boolean; elements: LabelElement[]; src?: LabelContent; codes?: { code128: boolean; qr: boolean; note: string | null } }
export interface LabelContent { brand?: string; title?: string; lines?: Array<[string, string | number | null]>; code?: string; footer?: string; reprint?: boolean }
interface RaLabel {
  SIZES: Record<string, { w: number; h: number | null; continuous?: boolean; name: string }>;
  LANGUAGES: string[];
  build(content: LabelContent, size: string): LabelTemplate;
  render(t: LabelTemplate, language: string, opts?: { dpi?: number; copies?: number }): { language: string; encoding: 'utf8' | 'base64'; body: string };
}

let loaded: RaLabel | undefined;
export function label(): RaLabel {
  if (!loaded) {
    const sandbox: Record<string, unknown> = { Buffer };
    // SCAN-1: the QR encoder first, exactly as the page loads it (qrcode.js before label-render.js).
    runInNewContext(readFileSync(new URL('../../../../web/qrcode.js', import.meta.url), 'utf8'), sandbox);
    // FONT-RP-5: the Manrope subset label PDFs embed (the page loads it on demand; the server always).
    runInNewContext(readFileSync(new URL('../../../../web/label-pdf-font.js', import.meta.url), 'utf8'), sandbox);
    runInNewContext(readFileSync(new URL('../../../../web/brand-marks.js', import.meta.url), 'utf8'), sandbox); // BRAND-6
    runInNewContext(readFileSync(new URL('../../../../web/label-render.js', import.meta.url), 'utf8'), sandbox);
    loaded = sandbox.RaLabel as RaLabel;
  }
  return loaded;
}
