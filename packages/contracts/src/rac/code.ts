/* RAC-CODES-2: the RAC product and variant code grammar.
 *
 *   product  RAC FF / NNNN                    RAC 27 / 1150
 *   variant  RAC FF / NNNN / PACK / GRADE     RAC 27 / 1150 / 1K / ALIKE
 *   formula  RAC FF / NNNN / GRADE / F{n}     RAC 27 / 1150 / ALIKE / F3
 *
 * Source of truth: docs/design-brief/data/rac/RAC_CODE_RULES.md. The codes are
 * the owner's and final; nothing here MINTS one. This file parses, formats,
 * and normalises, so that every surface (storefront, consoles, RawProd) agrees
 * on what "the same code" means.
 *
 * Pure: no I/O, no clock, no randomness.
 */

export type RacGrade = "RESEMBLE" | "ALIKE" | "CLOSE" | "MATERIAL";

export interface RacGradeInfo {
  readonly grade: RacGrade;
  readonly pct: number | null;
  /* Old words. Consoles and policy pages only; never on the storefront. Each
     stays a search alias forever. */
  readonly old: readonly string[];
  readonly letter: string;
}

export const RAC_GRADES: readonly RacGradeInfo[] = [
  { grade: "RESEMBLE", pct: 90, old: ["INSPIRED", "INTERPRETATION", "INT"], letter: "R" },
  { grade: "ALIKE", pct: 95, old: ["IDENTICAL", "REFERENCE", "REF"], letter: "A" },
  { grade: "CLOSE", pct: 99, old: ["KLONE", "CLONE", "FIDELITY", "FID"], letter: "C" },
  { grade: "MATERIAL", pct: null, old: [], letter: "M" },
];

export const gradeInfo = (g: string): RacGradeInfo | undefined => RAC_GRADES.find((x) => x.grade === g);

/* "ALIKE 95%". MATERIAL is ungraded, so it prints the word alone. */
export function gradeLabel(g: string): string {
  const i = gradeInfo(g);
  if (!i) return "";
  return i.pct === null ? i.grade : `${i.grade} ${i.pct}%`;
}

/* Strip spaces, slashes, dots, middle dots and hyphens; upper-case. The same
   rule as the database's rac_normalise() (0495), extended with the middle dot
   so the old display form `RAC / 40 · 01437` equals `RAC40-01437`. */
export const normaliseCode = (s: unknown): string =>
  String(s ?? "").replace(/[\s/.\-·_]+/g, "").toUpperCase();

const PRODUCT_RE = /^RAC (\d{2}) \/ (\d{4})$/;
const VARIANT_RE = /^RAC (\d{2}) \/ (\d{4}) \/ ([A-Z0-9]+) \/ (RESEMBLE|ALIKE|CLOSE|MATERIAL)$/;
const FORMULA_RE = /^RAC (\d{2}) \/ (\d{4}) \/ (RESEMBLE|ALIKE|CLOSE) \/ F([1-9]\d*)$/;

export interface ParsedRacCode {
  readonly family: string;
  readonly number: string;
  readonly product: string;
  readonly pack?: string;
  readonly grade?: RacGrade;
  readonly version?: number;
}

export function parseRacCode(s: string): ParsedRacCode | null {
  const t = String(s ?? "").trim();
  let m = PRODUCT_RE.exec(t);
  if (m) return { family: m[1]!, number: m[2]!, product: t };
  m = VARIANT_RE.exec(t);
  if (m) return { family: m[1]!, number: m[2]!, product: `RAC ${m[1]} / ${m[2]}`, pack: m[3]!, grade: m[4] as RacGrade };
  m = FORMULA_RE.exec(t);
  if (m) return { family: m[1]!, number: m[2]!, product: `RAC ${m[1]} / ${m[2]}`, grade: m[3] as RacGrade, version: Number(m[4]) };
  return null;
}

export const isRacProductCode = (s: string): boolean => PRODUCT_RE.test(String(s ?? "").trim());
export const isRacVariantCode = (s: string): boolean => VARIANT_RE.test(String(s ?? "").trim());

/* The formula id: product code + grade + F{version}. MATERIAL has no formula. */
export function formulaId(productCode: string, grade: RacGrade, version: number): string | null {
  if (!isRacProductCode(productCode) || grade === "MATERIAL" || !Number.isSafeInteger(version) || version < 1) return null;
  return `${productCode} / ${grade} / F${version}`;
}

/* Barcode / QR payload. RawProd's label code must match
   /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/ (web/label-render.js OPAQUE_RE), which a
   space or a slash fails. `RAC 27 / 1150 / 1K / ALIKE` -> `RAC-27-1150-1K-ALIKE`. */
export function scanCode(code: string): string {
  return String(code ?? "").split("/").map((x) => x.trim().replace(/\s+/g, "-")).filter(Boolean).join("-");
}
