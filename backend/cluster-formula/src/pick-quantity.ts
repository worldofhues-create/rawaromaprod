/**
 * The required quantity of one production-order ingredient, computed INSIDE the Vault (the only
 * place the percentage exists in plaintext) and handed to the main app box as a decimal string.
 *
 * It must be byte-for-byte what the main box used to store when it computed the line itself:
 * `PlanningService` wrote `String((orderQty * percentage) / 100)` into
 * `production.production_order_ingredients.required_qty numeric(18,4)`, and Postgres rounded that
 * text to 4 decimals, half away from zero. `pickLineRequiredQty` does the SAME arithmetic on the
 * same JavaScript number, then the same rounding Postgres applied, on the same text — so the stored
 * value is identical, and the Vault never sends more precision than the column ever kept
 * (`pick-quantity.test.ts` checks it against Postgres's own cast).
 */

/** Scale of `production.production_order_ingredients.required_qty` (numeric(18,4)). */
export const PICK_QUANTITY_SCALE = 4;

/**
 * Round a finite JavaScript number's shortest decimal text (`String(n)`, which may use exponent
 * notation) to `scale` decimals, half away from zero, exactly as Postgres rounds a numeric input
 * into a numeric(p, scale) column. Returns a plain decimal string with `scale` digits after the point.
 */
export function roundDecimalHalfAwayFromZero(value: number, scale: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
  if (!Number.isInteger(scale) || scale < 0) throw new RangeError(`bad scale: ${scale}`);
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!m) throw new RangeError(`unexpected number text: ${String(value)}`);
  const [, sign, intPart, frac = '', exp = '0'] = m;
  const digits = BigInt(`${intPart}${frac}`);
  // value = digits * 10^(exp - frac.length); scaled = value * 10^scale, rounded half away from zero.
  const shift = Number(exp) - frac.length + scale;
  let scaled: bigint;
  if (shift >= 0) {
    scaled = digits * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    scaled = digits / divisor;
    if ((digits % divisor) * 2n >= divisor) scaled += 1n;
  }
  const text = scaled.toString().padStart(scale + 1, '0');
  const body = scale > 0 ? `${text.slice(0, -scale)}.${text.slice(-scale)}` : text;
  return scaled === 0n ? body : `${sign}${body}`;
}

/** The required quantity of one ingredient at `percentage` % of an order of `orderQty`. */
export function pickLineRequiredQty(orderQty: number, percentage: number): string {
  return roundDecimalHalfAwayFromZero((orderQty * percentage) / 100, PICK_QUANTITY_SCALE);
}

/**
 * The quantity of one coded manufacturing-instruction line (§109.7): kg for this batch, rounded to
 * 3 decimals. Shared by `resolveManufacturingInstruction` and `resolveManufacturingLines` so both
 * shapes of the instruction always carry the same number.
 */
export function instructionQuantity(percentage: number, permittedBatchQuantity: number): number {
  return Math.round((percentage / 100) * permittedBatchQuantity * 1000) / 1000;
}
