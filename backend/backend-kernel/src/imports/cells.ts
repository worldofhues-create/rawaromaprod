/**
 * IMPORT-RP — what a person typed in a cell, read once, and nothing guessed.
 *
 * DATES are day first, as Indian paperwork is: 03/04/2026 is the 3rd of April. ISO (2026-04-03),
 * 03-Apr-2026 and the serial number a real spreadsheet date cell holds are read too. A month-first
 * date is never guessed at: 13/02/2026 can only be day first, 02/13/2026 is refused.
 *
 * QUANTITIES are decimal TEXT, never a double: "12.5" is the digits 1, 2, 5 and a scale, so a
 * conversion (kg to g) is exact. A quantity without a unit is not a quantity.
 */
export type Cell<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };
const ok = <T>(value: T): Cell<T> => ({ ok: true, value });
const bad = (problem: string): Cell<never> => ({ ok: false, problem });

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
function ymd(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d > last ? null : `${y}-${pad(m)}-${pad(d)}`;
}

/** A calendar day as YYYY-MM-DD, or null when the text is not a date this can read. */
export function parseDay(text: string): string | null {
  const t = text.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) return ymd(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})[ /-]([A-Za-z]{3,9})[ /-](\d{4})$/.exec(t);
  if (m) {
    const month = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    return month < 0 ? null : ymd(Number(m[3]), month + 1, Number(m[1]));
  }
  // Excel's 1900 date system: serial 1 is 1 January 1900, and it counts a 29 February 1900 that
  // never was, so serials from 61 on are one day ahead of the true count. 25569 is 1 January 1970.
  if (/^\d{4,6}(\.0+)?$/.test(t)) {
    const serial = Math.floor(Number(t));
    if (serial < 61 || serial > 110000) return null;
    return new Date((serial - 25569) * 86_400_000).toISOString().slice(0, 10);
  }
  return null;
}

/** A calendar day. Blank is null; the caller decides if that is allowed. */
export function cellDate(text: string, header: string): Cell<string | null> {
  if (text.trim() === '') return ok(null);
  const iso = parseDay(text);
  if (!iso) return bad(`"${header}": "${text}" is not a date this can read. Write it day first, like 22/09/2026, or as 2026-09-22.`);
  return ok(iso);
}

/** A whole number, one or more by default. Grouping commas are a person's. */
export function cellWhole(text: string, header: string, min = 1): Cell<number | null> {
  const t = text.trim().replace(/,/g, '');
  if (t === '') return ok(null);
  if (!/^\d+$/.test(t) || !Number.isSafeInteger(Number(t))) return bad(`"${header}": "${text}" must be a whole number.`);
  if (Number(t) < min) return bad(`"${header}": "${text}" must be ${min} or more.`);
  return ok(Number(t));
}

/** An exact decimal: the digits as an integer and how many of them are after the point. */
export interface Decimal { readonly negative: boolean; readonly digits: bigint; readonly scale: number }

export function parseDecimal(text: string, maxScale = 6): Decimal | null {
  const t = text.trim().replace(/,/g, '');
  const m = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(t) ?? /^([+-]?)()\.(\d+)$/.exec(t);
  if (!m) return null;
  const frac = (m[3] ?? '').replace(/0+$/, '');
  if (frac.length > maxScale) return null;
  return { negative: m[1] === '-', digits: BigInt((m[2] || '0') + frac), scale: frac.length };
}
/** The decimal as text, e.g. for a numeric(18,4) column: no exponent, no double. */
export function decimalText(d: Decimal): string {
  const s = d.digits.toString().padStart(d.scale + 1, '0');
  const body = d.scale ? `${s.slice(0, -d.scale)}.${s.slice(-d.scale)}` : s;
  return (d.negative && d.digits !== 0n ? '-' : '') + body;
}

/** A quantity greater than zero. */
export function cellQuantity(text: string, header: string, maxScale = 4): Cell<Decimal | null> {
  if (text.trim() === '') return ok(null);
  const d = parseDecimal(text, maxScale);
  if (!d) return bad(`"${header}": "${text}" must be a number with at most ${maxScale} decimals, like 12.5.`);
  if (d.negative || d.digits === 0n) return bad(`"${header}": "${text}" must be more than zero.`);
  return ok(d);
}

/** A signed change: a minus sign for a decrease. Zero changes nothing and is refused. */
export function cellSigned(text: string, header: string, maxScale = 4): Cell<Decimal | null> {
  if (text.trim() === '') return ok(null);
  const d = parseDecimal(text, maxScale);
  if (!d) return bad(`"${header}": "${text}" must be a number, with a minus sign for a decrease (like -2.5 or 3).`);
  if (d.digits === 0n) return bad(`"${header}": a change of zero changes nothing. Remove the row.`);
  return ok(d);
}

const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);
/** Yes or no. Blank is null, and it is the caller that says what a blank means. */
export function cellYesNo(text: string, header: string): Cell<boolean | null> {
  const t = text.trim().toLowerCase();
  if (t === '') return ok(null);
  if (YES.has(t)) return ok(true);
  if (NO.has(t)) return ok(false);
  return bad(`"${header}": "${text}" must be yes or no.`);
}

/** CAS Registry Number: digits-digits-check, the check digit verified. */
export function casValid(cas: string): boolean {
  const m = /^(\d{2,7})-(\d{2})-(\d)$/.exec(cas.trim());
  if (!m) return false;
  const digits = (m[1]! + m[2]!).split('').reverse();
  return digits.reduce((a, d, i) => a + Number(d) * (i + 1), 0) % 10 === Number(m[3]);
}

/**
 * Rupees as a person types them ("1,250.50", "₹ 500", "Rs 80") into INTEGER PAISE, once. Blank is
 * null, and the caller says what a blank means (for a price it is "no change", never zero). More than
 * two decimals is refused, not rounded: there is no such thing as a fraction of a paisa to store.
 */
export function cellRupees(text: string, header: string): Cell<bigint | null> {
  const t = text.trim().replace(/^(₹|rs\.?|inr)\s*/i, '').replace(/,/g, '').trim();
  if (t === '') return ok(null);
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) {
    return /^-/.test(t)
      ? bad(`"${header}": "${text}" is below zero.`)
      : bad(`"${header}": "${text}" is not an amount in rupees and paise. Write it like 1250 or 1,250.50 (two decimals at most).`);
  }
  return ok(BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0')));
}

/** A percentage with at most two decimals ("12.5", "18%") as basis points (hundredths of a percent). */
export function cellPercentBps(text: string, header: string): Cell<number | null> {
  const t = text.trim().replace(/%$/, '').trim();
  if (t === '') return ok(null);
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return bad(`"${header}": "${text}" must be a percentage with at most two decimals, like 12.5.`);
  return ok(Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')));
}
