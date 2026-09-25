/**
 * Bridge quantity normalisation. ALEMBIC raises a requirement in its own base unit (mass in
 * `mg`, see ProductionRequirementCreated) while its goods receipt reports what was received in
 * the unit the receipt was keyed in (`kg`). Comparing the two raw numbers made a 1 kg receipt
 * against a 1 000 000 mg requirement read as "cumulative 1 of 1000000" and the requirement never
 * completed. Every quantity the importer compares is first converted into the requirement's own
 * unit here. A unit pair that cannot be converted (unknown unit, mass vs volume) yields null, and
 * the caller refuses to complete on it rather than guessing.
 */
const FACTORS: Readonly<Record<string, { dim: 'mass' | 'volume' | 'count'; toBase: number }>> = {
  mg: { dim: 'mass', toBase: 1 },
  g: { dim: 'mass', toBase: 1_000 },
  kg: { dim: 'mass', toBase: 1_000_000 },
  t: { dim: 'mass', toBase: 1_000_000_000 },
  ml: { dim: 'volume', toBase: 1 },
  l: { dim: 'volume', toBase: 1_000 },
  pcs: { dim: 'count', toBase: 1 },
  nos: { dim: 'count', toBase: 1 },
  ea: { dim: 'count', toBase: 1 },
};

function unit(u: string): string {
  return u.trim().toLowerCase();
}

/** `qty` expressed in `from`, converted into `to`; null when the pair is not convertible. */
export function convertQty(qty: number, from: string, to: string): number | null {
  if (!Number.isFinite(qty)) return null;
  const f = unit(from);
  const t = unit(to);
  if (f === t) return qty;
  const a = FACTORS[f];
  const b = FACTORS[t];
  if (!a || !b || a.dim !== b.dim) return null;
  return (qty * a.toBase) / b.toBase;
}
