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
