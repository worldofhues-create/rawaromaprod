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

/**
 * STOCK-FIX-RP (STK-7): a batch's lines in integer milligrams, whose total is ALWAYS the batch.
 *
 * `pickLineRequiredQty` rounds each line on its own to 4 decimals of the ORDER's unit, so the lines
 * do not add up to the order: the rehearsal's F1 at 5 kg, ordered in kg, carried 5,000,100 mg of
 * targets (two lines rounded up 50 mg each), and the same batch ordered in g was exact. Here every
 * line is computed from the formula's share in exact integer arithmetic (a percentage is held to 6
 * decimals, VAULT.md / recipe-csv.ts, so a share is a whole number of micro-percent), each line is
 * floored to a whole mg, and the milligrams the floors leave over are handed out one at a time to the
 * lines with the largest remainders (the largest-remainder or Hamilton method; a tie goes to the
 * earlier line). Each line is then within 1 mg of its exact share, and the lines total
 * `orderMg x (sum of shares) / 100` rounded half up, which is `orderMg` itself for a recipe at 100 %.
 * `percentages` are in the recipe's own order; the result is in the same order.
 */
export function pickLinesMg(orderMg: number, percentages: number[]): number[] {
  if (!Number.isSafeInteger(orderMg) || orderMg <= 0) throw new RangeError(`not a whole number of mg: ${orderMg}`);
  const micro = percentages.map((p) => {
    if (!Number.isFinite(p) || p < 0) throw new RangeError(`not a share: ${p}`);
    return BigInt(Math.round(p * 1_000_000));
  });
  const SCALE = 100_000_000n; // 100 % in micro-percent
  const order = BigInt(orderMg);
  const exact = micro.map((m) => order * m);
  const floors = exact.map((e) => e / SCALE);
  const sum = micro.reduce((a, m) => a + m, 0n);
  const target = (order * sum * 2n + SCALE) / (2n * SCALE); // half up
  let left = target - floors.reduce((a, f) => a + f, 0n);
  const byRemainder = exact.map((e, i) => ({ i, r: e % SCALE })).sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  const out = floors.map((f) => f);
  for (const { i } of byRemainder) {
    if (left <= 0n) break;
    out[i] = out[i]! + 1n;
    left -= 1n;
  }
  return out.map((v) => Number(v));
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
