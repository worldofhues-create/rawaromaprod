/**
 * STOCK-UNITS: one exact conversion between the units a lot and a pick list are kept in.
 *
 * Stock quantities are numeric(18,4) text in whatever unit the row names. Mass moves through integer
 * milligrams, volume through integer microlitres, in BigInt, so there is no float anywhere and no
 * rounding: a quantity that does not land exactly is refused and says why. Mass and volume do not
 * convert into each other: that takes a density, and nothing on file holds one per lot.
 */
type Dimension = 'mass' | 'volume';

const UNITS: Record<string, [Dimension, number]> = {};
const add = (d: Dimension, base: number, names: string[]) => { for (const n of names) UNITS[n] = [d, base]; };
add('mass', 1_000_000, ['kg', 'kgs', 'kilogram', 'kilograms']);
add('mass', 1_000, ['g', 'gm', 'gms', 'gram', 'grams']);
add('mass', 1, ['mg', 'milligram', 'milligrams']);
add('volume', 1_000_000, ['l', 'lt', 'ltr', 'ltrs', 'litre', 'litres', 'liter', 'liters']);
add('volume', 1_000, ['ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters']);

const norm = (code: string | null | undefined) => String(code ?? '').trim().toLowerCase();

/** mg in one of this unit, or null when it is not a mass unit. */
export function massFactorMg(uomCode: string | null | undefined): number | null {
  const u = UNITS[norm(uomCode)];
  return u && u[0] === 'mass' ? u[1] : null;
}

/** A decimal as an exact numerator over 10^scale, or null when it is not a plain decimal. */
function parse(qty: string | number | null | undefined): { n: bigint; scale: number } | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(qty ?? '').trim());
  if (!m) return null;
  const frac = m[3] ?? '';
  const n = BigInt(m[2]! + frac);
  return { n: m[1] ? -n : n, scale: frac.length };
}

/** Base units (mg, µL) from a quantity, or null unless it is a whole number of them. */
function toBase(p: { n: bigint; scale: number }, factor: number): bigint | null {
  const num = p.n * BigInt(factor), den = 10n ** BigInt(p.scale);
  return num % den === 0n ? num / den : null;
}

/** Base units as numeric(18,4) text in a unit worth `factor` of them, or null when four places cannot hold it. */
function fromBase(base: bigint, factor: number): string | null {
  const scaled = base * 10000n;
  if (scaled % BigInt(factor) !== 0n) return null;
  const t = scaled / BigInt(factor), neg = t < 0n, a = neg ? -t : t;
  return `${neg ? '-' : ''}${a / 10000n}.${String(a % 10000n).padStart(4, '0')}`;
}

/** Exact mg of a mass quantity; null for a non-mass unit, a non-number, or a part of a mg. */
export function qtyToMgExact(qty: string | number | null | undefined, uomCode: string | null | undefined): number | null {
  const f = massFactorMg(uomCode), p = parse(qty);
  if (f === null || !p) return null;
  const mg = toBase(p, f);
  return mg === null || mg > BigInt(Number.MAX_SAFE_INTEGER) || mg < -BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(mg);
}

/** Integer mg as the exact numeric(18,4) text in a mass unit, or null when that unit cannot hold it. */
export function mgToQty(mg: number, uomCode: string | null | undefined): string | null {
  const f = massFactorMg(uomCode);
  if (f === null || !Number.isSafeInteger(mg) || mg < 0) return null;
  return fromBase(BigInt(mg), f);
}

export type Converted = { qty: string } | { refused: string };

/** `qty` of `from` as numeric(18,4) text of `to`, exactly, or the reason it cannot be. Never a guess. */
export function convertQty(qty: string | number | null | undefined, from: string | null | undefined, to: string | null | undefined): Converted {
  const p = parse(qty);
  if (!p) return { refused: `${String(qty)} is not a quantity.` };
  const f = norm(from), t = norm(to);
  if (!f || !t) return { refused: `${!f ? 'The pick line' : 'The lot'} has no unit on file${!f && !t ? ', and neither does the other side' : ''}, so the quantity cannot be read.` };
  const a = UNITS[f], b = UNITS[t];
  if (f === t || (a && b && a[0] === b[0] && a[1] === b[1])) {
    const tenThousandths = toBase(p, 10000); // numeric(18,4) already: this only normalises the text
    return tenThousandths === null ? { refused: `${String(qty)} ${from} is finer than four places, which the stock ledger cannot hold.` } : { qty: fromBase(tenThousandths, 10000)! };
  }
  if (!a || !b) return { refused: `${from} and ${to} do not convert.` };
  if (a[0] !== b[0]) return { refused: `${from} and ${to} do not convert without a density, and none is on file.` };
  const base = toBase(p, a[1]);
  if (base === null) return { refused: `${String(qty)} ${from} is not a whole mg, so it cannot be moved to ${to} exactly.` };
  const out = fromBase(base, b[1]);
  return out === null ? { refused: `A lot kept in ${to} cannot hold ${String(qty)} ${from} exactly (four places).` } : { qty: out };
}

/* ── STOCK2-3: adding and comparing across units ─────────────────────────────────────────── */

export interface QtyPart { qty: string | number | null | undefined; uom: string | null | undefined }
export type Netted = { qty: string; uom: string } | { refused: string; units: string[] };

/** Ten places under the base unit: any numeric(18,4) in any unit above lands on a whole number here. */
const FINE = 10;

function fine(p: { n: bigint; scale: number }, factor: number): bigint | null {
  return p.scale > FINE ? null : p.n * BigInt(factor) * 10n ** BigInt(FINE - p.scale);
}

/** Exact plain decimal of a fine value in a unit worth `factor`, trailing zeros off. */
function fineText(v: bigint, factor: number): string {
  const places = FINE + String(factor).length - 1; // every factor is a power of ten
  const neg = v < 0n, a = (neg ? -v : v).toString().padStart(places + 1, '0');
  const frac = a.slice(a.length - places).replace(/0+$/, '');
  return `${neg ? '-' : ''}${a.slice(0, a.length - places)}${frac ? `.${frac}` : ''}`;
}

/**
 * plus − minus, exactly, in `uom`. Mass adds to mass and volume to volume; a unit nothing knows adds
 * only to itself. Anything else is not a total: the answer names the units and why, and the caller
 * shows that instead of a figure. A nil or zero quantity carries no unit worth refusing over. The
 * result is not bound to four places: it is for reading and comparing, and storing it is the
 * caller's own decision.
 */
export function netQty(plus: QtyPart[], minus: QtyPart[], uom: string | null | undefined): Netted {
  const target = norm(uom), t = UNITS[target];
  const seen = new Map<string, string>([[target, String(uom ?? '')]]);
  let total = 0n, bad: string | null = null;
  for (const [sign, parts] of [[1n, plus], [-1n, minus]] as const) {
    for (const part of parts) {
      const p = parse(part.qty);
      if (part.qty == null || (p && p.n === 0n)) continue;
      if (!p) { bad = `${String(part.qty)} is not a quantity.`; continue; }
      const u = norm(part.uom), a = UNITS[u];
      if (!seen.has(u)) seen.set(u, String(part.uom ?? ''));
      const sameKind = u === target || (a && t && a[0] === t[0]);
      if (!sameKind) { bad ??= !u || !target ? 'Part of this has no unit on file.' : a && t ? 'They do not convert without a density, and none is on file.' : 'They do not convert.'; continue; }
      const v = fine(p, a?.[1] ?? 1);
      if (v === null) { bad = `${String(part.qty)} is finer than this can add exactly.`; continue; }
      total += sign * v;
    }
  }
  if (bad) return { refused: bad, units: [...seen.values()].filter(Boolean) };
  return { qty: fineText(total, t?.[1] ?? 1), uom: String(uom ?? '') };
}

/** The sign of a − b, once they are in one unit. */
export function signOf(qty: string): -1 | 0 | 1 {
  return qty.startsWith('-') ? -1 : /[1-9]/.test(qty) ? 1 : 0;
}

/** "kg and L: not totalled. They do not convert…": what a screen prints in place of a figure. */
export function notTotalled(n: { refused: string; units: string[] }): string {
  return `${n.units.join(' and ') || 'No unit'}: not totalled. ${n.refused}`;
}
