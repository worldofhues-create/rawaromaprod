/**
 * FAVICON-FLUKE: the favicon and app icons of Factory, Platform and Vault are the Shell Fluke.
 *
 * Until this lane every RawProd host served the old multicolour "RAW" swirl as /favicon.ico, the three
 * favicon PNGs, /apple-touch-icon.png and the manifest icons, while every header on the same page already
 * drew the Shell Fluke (BRAND-8). The handoff icons are transparent and one flat colour, so the ink one
 * vanishes on a dark browser tab and the white one on a light tab: the family is therefore the WHITE fluke
 * on a solid KON NAVY tile (tools/brand/favicon-fluke.py).
 *
 * Static, like console-focus-mode.test.ts: the PNGs are decoded here with node:zlib (no image dependency)
 * and held to what a person would check by eye:
 *   - one family, byte for byte, in all three console roots;
 *   - favicon.ico carries exactly the 16, 32 and 48 px PNGs;
 *   - only two colours, Kon Navy and white (the old swirl was four hues on white: this is the assertion
 *     that fails on it);
 *   - the tile is there (a favicon with clear corners, opaque for iOS and for a maskable icon);
 *   - the mark IS the handoff artwork, compared pixel by pixel with web/logo/rac-icon-shell-fluke-white.png;
 *   - the maskable mark stays inside the 80 % safe zone;
 *   - every page, manifest and service worker names this family and nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const bytes = (p: string) => readFileSync(join(ROOT, p));
const text = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const DIRS = ['web', 'web-platform', 'web-vault'] as const;
const NAVY = [0x12, 0x1a, 0x33] as const; // Kon Navy, handoff/brand/README.md "Colour"

/** name, side in px, tile: 'rounded' has clear corners, 'bleed' is opaque edge to edge. */
const FAMILY = [
  { name: 'favicon-16.png', size: 16, tile: 'rounded' },
  { name: 'favicon-32.png', size: 32, tile: 'rounded' },
  { name: 'favicon-48.png', size: 48, tile: 'rounded' },
  { name: 'icon-192.png', size: 192, tile: 'rounded' },
  { name: 'icon-512.png', size: 512, tile: 'rounded' },
  { name: 'apple-touch-icon.png', size: 180, tile: 'bleed' },
  { name: 'icon-maskable-192.png', size: 192, tile: 'bleed' },
  { name: 'icon-maskable-512.png', size: 512, tile: 'bleed' },
] as const;
const FILES = ['favicon.ico', ...FAMILY.map((f) => f.name)];

// ── a PNG reader: 8-bit truecolour, truecolour + alpha and palette, not interlaced ──────────────────────────────

interface Bitmap { w: number; h: number; px: Uint8Array } // px = RGBA, row by row

function decodePng(b: Buffer, label: string): Bitmap {
  assert.equal(b.subarray(0, 8).toString('latin1'), '\x89PNG\r\n\x1a\n', `${label} is not a PNG`);
  let w = 0; let h = 0; let type = -1; let plte: Buffer | null = null; let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  for (let o = 8; o < b.length;) {
    const len = b.readUInt32BE(o); const name = b.subarray(o + 4, o + 8).toString('latin1'); const data = b.subarray(o + 8, o + 8 + len);
    if (name === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9]!;
      assert.equal(data[8], 8, `${label}: only 8-bit PNGs are read here`);
      assert.equal(data[12], 0, `${label}: interlaced PNGs are not read here`);
    } else if (name === 'PLTE') plte = data; else if (name === 'tRNS') trns = data; else if (name === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const bpp = ({ 2: 3, 3: 1, 6: 4 } as Record<number, number>)[type];
  assert.ok(bpp, `${label}: PNG colour type ${type} is not read here`);
  const raw = inflateSync(Buffer.concat(idat)); const stride = w * bpp!;
  const cur = new Uint8Array(stride); const prev = new Uint8Array(stride); const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!; const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp! ? cur[i - bpp!]! : 0; const up = prev[i]!; const c = i >= bpp! ? prev[i - bpp!]! : 0;
      let pred = 0;
      if (f === 1) pred = a; else if (f === 2) pred = up; else if (f === 3) pred = (a + up) >> 1;
      else if (f === 4) { const p = a + up - c; const pa = Math.abs(p - a); const pb = Math.abs(p - up); const pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      cur[i] = (line[i]! + pred) & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (type === 3) { const i = cur[x]!; px[o] = plte![i * 3]!; px[o + 1] = plte![i * 3 + 1]!; px[o + 2] = plte![i * 3 + 2]!; px[o + 3] = trns && i < trns.length ? trns[i]! : 255; }
      else { px[o] = cur[x * bpp!]!; px[o + 1] = cur[x * bpp! + 1]!; px[o + 2] = cur[x * bpp! + 2]!; px[o + 3] = bpp === 4 ? cur[x * 4 + 3]! : 255; }
    }
    prev.set(cur);
  }
  return { w, h, px };
}

const icon = (name: string) => decodePng(bytes(`web/${name}`), `web/${name}`);
/** How white a pixel is, 0 = Kon Navy, 1 = white, read off the red channel (the widest of the three). */
const whiteness = (m: Bitmap, x: number, y: number) => (m.px[(y * m.w + x) * 4]! - NAVY[0]) / (255 - NAVY[0]);
const alphaAt = (m: Bitmap, x: number, y: number) => m.px[(y * m.w + x) * 4 + 3]!;

// ── one family ───────────────────────────────────────────────────────────────────────────────────────────────────

test('Factory, Platform and Vault serve one icon family, byte for byte', () => {
  for (const f of FILES) {
    const master = bytes(`web/${f}`);
    for (const d of DIRS) assert.deepEqual(bytes(`${d}/${f}`), master, `${d}/${f} differs from web/${f}`);
  }
});

test('every icon is the size its name and its link tag say', () => {
  for (const f of FAMILY) {
    const m = icon(f.name);
    assert.deepEqual([m.w, m.h], [f.size, f.size], f.name);
  }
});

test('favicon.ico carries exactly the 16, 32 and 48 px PNGs', () => {
  const ico = bytes('web/favicon.ico');
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, 3], 'an icon file with three images');
  const seen: number[] = [];
  for (let i = 0; i < 3; i++) {
    const e = 6 + i * 16; const size = ico[e]!; seen.push(size);
    assert.equal(ico[e + 1], size, 'square');
    const body = ico.subarray(ico.readUInt32LE(e + 12), ico.readUInt32LE(e + 12) + ico.readUInt32LE(e + 8));
    // The entry IS the PNG file, so a bare /favicon.ico request and the sized <link> can never show two marks.
    assert.deepEqual(body, bytes(`web/favicon-${size}.png`), `favicon.ico's ${size} px image is not favicon-${size}.png`);
  }
  assert.deepEqual(seen, [16, 32, 48]);
});

// ── two colours, on a tile ───────────────────────────────────────────────────────────────────────────────────────

test('every visible pixel is Kon Navy, white or a blend of the two: no third colour', () => {
  for (const f of FAMILY) {
    const m = icon(f.name);
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      if (alphaAt(m, x, y) === 0) continue;
      const o = (y * m.w + x) * 4; const t = whiteness(m, x, y);
      assert.ok(t >= 0 && t <= 1, `${f.name} (${x},${y}): red ${m.px[o]} is outside Kon Navy..white`);
      for (const ch of [1, 2]) {
        const want = NAVY[ch]! + (255 - NAVY[ch]!) * t;
        assert.ok(Math.abs(m.px[o + ch]! - want) <= 2, `${f.name} (${x},${y}): rgb(${m.px[o]},${m.px[o + 1]},${m.px[o + 2]}) is not on the Kon Navy-to-white line`);
      }
    }
  }
});

test('the tile: a favicon has clear rounded corners, an iOS or maskable icon is opaque Kon Navy to the edge', () => {
  for (const f of FAMILY) {
    const m = icon(f.name); const s = f.size; const corners = [[0, 0], [s - 1, 0], [0, s - 1], [s - 1, s - 1]] as const;
    const mids = [[s >> 1, 0], [0, s >> 1], [s - 1, s >> 1], [s >> 1, s - 1]] as const;
    for (const [x, y] of mids) {
      assert.equal(alphaAt(m, x, y), 255, `${f.name}: the tile does not reach the edge at (${x},${y})`);
      assert.ok(whiteness(m, x, y) < 0.02, `${f.name}: the tile edge at (${x},${y}) is not Kon Navy`);
    }
    let opaque = 0;
    for (let i = 3; i < m.px.length; i += 4) if (m.px[i] === 255) opaque++;
    if (f.tile === 'rounded') {
      for (const [x, y] of corners) assert.ok(alphaAt(m, x, y) < 16, `${f.name}: corner (${x},${y}) is not clear`);
      // A 0.19 to 0.22 radius leaves about 96 % of the square; under 90 % it is no longer a tile that fills the tab slot.
      assert.ok(opaque / (s * s) > 0.9, `${f.name}: only ${(100 * opaque / (s * s)).toFixed(1)} % of the square is tile`);
    } else {
      // iOS paints transparency black, and a launcher crops a maskable icon to its own shape.
      assert.equal(opaque, s * s, `${f.name}: ${s * s - opaque} pixels are not opaque`);
      for (const [x, y] of corners) assert.ok(whiteness(m, x, y) < 0.02, `${f.name}: corner (${x},${y}) is not Kon Navy`);
    }
  }
});

// ── the mark is the handoff's Shell Fluke ────────────────────────────────────────────────────────────────────────

/** The handoff artwork's coverage (alpha), cropped to the mark's own bounds. */
function artwork() {
  const a = decodePng(bytes('web/logo/rac-icon-shell-fluke-white.png'), 'the handoff icon');
  let x0 = a.w; let y0 = a.h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) if (alphaAt(a, x, y) > 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { a, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Bounds of the white mark in an icon, and how far its pixels agree with the artwork laid over those bounds. */
function compareWithArtwork(m: Bitmap) {
  const art = artwork();
  let x0 = m.w; let y0 = m.h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (alphaAt(m, x, y) > 0 && whiteness(m, x, y) >= 0.25) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const w = x1 - x0 + 1; const h = y1 - y0 + 1; let same = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ax = art.x0 + Math.min(art.w - 1, Math.floor((x + 0.5) * art.w / w)); const ay = art.y0 + Math.min(art.h - 1, Math.floor((y + 0.5) * art.h / h));
    if ((alphaAt(art.a, ax, ay) >= 128) === (whiteness(m, x0 + x, y0 + y) >= 0.5)) same++;
  }
  return { x0, y0, w, h, agree: w > 0 && h > 0 ? same / (w * h) : 0, aspect: w / h, artAspect: art.w / art.h };
}

test('the artwork is the owner\'s brand handoff file, unaltered', () => {
  // sha256 of handoff/brand/logo/rac-icon-shell-fluke-white.png; every icon below is measured against it.
  const sha = createHash('sha256').update(bytes('web/logo/rac-icon-shell-fluke-white.png')).digest('hex');
  assert.equal(sha, '6e10fed7627c981ec65a6f13615c8f3fe54681d8530ede63799bb1b8af16dadc');
});

test('the mark on every icon is the Shell Fluke, centred on its tile', () => {
  for (const f of FAMILY) {
    const m = icon(f.name); const c = compareWithArtwork(m);
    assert.ok(c.w > 0, `${f.name}: no white mark on the tile`);
    // Shape: laid over the mark's bounds, the handoff artwork and the icon agree pixel for pixel. A favicon
    // has only a few hundred pixels and each one straddles a feather, so its floor is lower.
    const floor = f.size >= 180 ? 0.95 : f.size >= 32 ? 0.85 : 0.75;
    assert.ok(c.agree >= floor, `${f.name}: ${(100 * c.agree).toFixed(1)} % of the mark matches the Shell Fluke artwork, floor ${100 * floor} %`);
    const slack = f.size >= 180 ? 0.03 : 0.12;
    assert.ok(Math.abs(c.aspect / c.artAspect - 1) <= slack, `${f.name}: the mark is ${c.aspect.toFixed(3)} wide per high, the artwork ${c.artAspect.toFixed(3)}: stretched`);
    const off = Math.max(Math.abs(c.x0 + c.w / 2 - f.size / 2), Math.abs(c.y0 + c.h / 2 - f.size / 2));
    assert.ok(off <= Math.max(1, f.size * 0.01), `${f.name}: the mark sits ${off} px off the tile's centre`);
  }
});

test('at 16 px the fluke is white on navy, not a grey smudge', () => {
  // The feather channels are thinner than a pixel at this size and average the mark towards grey; the
  // generator's gain is what keeps it white. Counted, because "legible" is otherwise an opinion.
  const m = icon('favicon-16.png'); let white = 0; let navy = 0;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (alphaAt(m, x, y) < 255) continue;
    const t = whiteness(m, x, y);
    if (t >= 0.85) white++; else if (t <= 0.1) navy++;
  }
  assert.ok(white >= 30, `only ${white} of 256 pixels are white`);
  assert.ok(navy >= 100, `only ${navy} of 256 pixels are plain Kon Navy: the mark has no ground to stand on`);
});

test('a maskable icon keeps the whole fluke inside the 80 % safe zone', () => {
  for (const f of FAMILY.filter((i) => i.name.startsWith('icon-maskable'))) {
    const m = icon(f.name); const c = (f.size - 1) / 2; const r = 0.4 * f.size;
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      if (whiteness(m, x, y) < 0.05) continue;
      assert.ok(Math.hypot(x - c, y - c) <= r, `${f.name}: the mark reaches (${x},${y}), outside the safe zone a launcher may crop to`);
    }
  }
});

// ── every page, manifest and service worker names the family ─────────────────────────────────────────────────────

const PAGES = ['web/index.html', 'web/pair.html', 'web-platform/index.html', 'web-vault/index.html'];
const LINKS = [
  '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">',
  '<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">',
  '<link rel="icon" href="/favicon-16.png" sizes="16x16" type="image/png">',
  '<link rel="icon" href="/favicon-48.png" sizes="48x48" type="image/png">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">',
];

test('every page links the whole family and no other icon', () => {
  for (const p of PAGES) {
    const html = text(p);
    for (const l of LINKS) assert.ok(html.includes(l), `${p} lacks ${l}`);
    const tags = html.match(/<link\b[^>]*\brel="[^"]*icon[^"]*"[^>]*>/g) ?? [];
    assert.deepEqual([...tags].sort(), [...LINKS].sort(), `${p} links an icon outside the family`);
  }
});

test('every manifest lists the four app icons of the family and no other', () => {
  for (const d of DIRS) {
    const m = JSON.parse(text(`${d}/manifest.webmanifest`)) as { icons: { src: string; sizes: string; purpose: string; type: string }[] };
    assert.deepEqual(m.icons.map((i) => `${i.src} ${i.sizes} ${i.purpose} ${i.type}`).sort(), [
      '/icon-192.png 192x192 any image/png',
      '/icon-512.png 512x512 any image/png',
      '/icon-maskable-192.png 192x192 maskable image/png',
      '/icon-maskable-512.png 512x512 maskable image/png',
    ], `${d}/manifest.webmanifest`);
  }
});

test('each service worker precaches the whole family', () => {
  for (const d of ['web', 'web-platform']) {
    const sw = text(`${d}/sw.js`);
    for (const f of FILES) assert.ok(sw.includes(`'/${f}'`), `${d}/sw.js does not precache /${f}`);
  }
});
