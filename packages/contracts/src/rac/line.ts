/* RAC-CODES-3: the product line, the same five lines on every surface.
 *
 *   RAC Noir Epices
 *   Reference fragrance: Frederic Malle Noir Epices     (cleared only)
 *   Amber                                               (accords, up to 3)
 *   RAC 27 / 1150
 *   ALIKE 95%
 *
 * THE REFERENCE LINE IS A THIRD-PARTY TRADEMARK. "Reference fragrance: <x>"
 * (owner wording, 2026-11-10; replaces "Inspired by") shows ONLY where a
 * clearance is in force for this product and market (rac_reference_clearance,
 * 0500). `referenceCleared` absent means not cleared -- fail closed. Where not
 * cleared, a product whose export reference IS "RAW Original" says so; every
 * other product omits the line. On a pack or label (`surface: "label"`) the
 * line never appears, cleared or not: 0500 has one scope, 'digital'.
 *
 * LEGACY KEYS. Old RAC code, Shopify SKU and old grade words are returned
 * only for `surface: "console"`. The storefront and labels never get them,
 * so a renderer cannot print what it was never handed.
 */
import { gradeLabel, gradeInfo, type RacGrade } from "./code.ts";
import type { RacSearchProduct } from "./search.ts";

export type RacSurface = "storefront" | "console" | "label";

export interface RacProductLine {
  readonly name: string;
  /* "Reference fragrance: Creed Aventus", "RAW Original", or null (omitted). */
  readonly reference: string | null;
  readonly accords: readonly string[];
  readonly code: string;
  readonly variantCode: string | null;
  readonly grade: string | null;
  readonly legacy?: {
    readonly oldCode: string | null;
    readonly oldPrimary: string | null;
    readonly shopifyHandle: string | null;
    readonly shopifySku: string | null;
    readonly oldRacSku: string | null;
    readonly oldGrade: string | null;
  };
}

export const RAW_ORIGINAL = "RAW Original";
/* Materials (and other non-oil categories) carry no reference at all. */
const REFERENCE_CATEGORIES = new Set(["Oil", "RAW Original", "Attar", "Application oil"]);

export interface RacLineOptions {
  readonly surface: RacSurface;
  readonly referenceCleared?: boolean;
  /* A variant code; defaults to the product's default (largest pack). */
  readonly variant?: string;
  /* A grade to show when no variant is named (e.g. the grade a search asked for). */
  readonly grade?: RacGrade;
}

type LineProduct = RacSearchProduct & {
  readonly default_variant?: string | null;
  readonly variants?: readonly (NonNullable<RacSearchProduct["variants"]>[number] & { readonly default?: boolean })[];
};

export function racProductLine(p: LineProduct, opts: RacLineOptions): RacProductLine {
  const variants = p.variants ?? [];
  const v = (opts.variant ? variants.find((x) => x.code === opts.variant) : undefined)
    ?? (opts.grade ? variants.find((x) => x.grade === opts.grade && x.pack === variants.find((y) => y.code === p.default_variant)?.pack) ?? variants.find((x) => x.grade === opts.grade) : undefined)
    ?? variants.find((x) => x.code === p.default_variant)
    ?? variants.find((x) => x.default)
    ?? variants[0];

  let reference: string | null = null;
  const ref = (p.reference_fragrance ?? "").trim();
  if (opts.surface !== "label" && REFERENCE_CATEGORIES.has(p.category) && ref) {
    if (ref === RAW_ORIGINAL) reference = RAW_ORIGINAL;
    else if (opts.referenceCleared === true && !ref.endsWith(" -")) reference = `Reference fragrance: ${ref}`;
  }

  const accords = [...(p.accords ?? []), ...(p.accords_unverified ?? [])].filter((a, i, a2) => a && a2.indexOf(a) === i).slice(0, 3);
  const grade = v ? gradeLabel(v.grade) || null : opts.grade ? gradeLabel(opts.grade) : null;
  const line: RacProductLine = {
    name: p.name,
    reference,
    accords,
    code: p.code,
    variantCode: v?.code ?? null,
    grade,
  };
  if (opts.surface !== "console") return line;
  return {
    ...line,
    legacy: {
      oldCode: p.old_rac_code ?? null,
      oldPrimary: p.old_primary ?? null,
      shopifyHandle: p.shopify_handle ?? null,
      shopifySku: v?.shopify_sku ?? null,
      oldRacSku: v?.old_rac_sku ?? null,
      oldGrade: v?.old_grade ?? (v ? gradeInfo(v.grade)?.old[0] ?? null : null),
    },
  };
}

/* schema.org Product. brand = RAC, always; the benchmark house is never a
   brand. `sku` = variant code, `mpn` = product code. No offers here: prices
   come from the server's quote, never from this file. */
export function racStructuredData(p: LineProduct, opts: { referenceCleared?: boolean; variant?: string } = {}): Record<string, unknown> {
  const line = racProductLine(p, { surface: "storefront", ...opts });
  const description = [line.reference, line.accords.join(" "), line.grade].filter(Boolean).join(" · ");
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: line.name,
    brand: { "@type": "Brand", name: "RAC" },
    mpn: line.code,
    ...(line.variantCode ? { sku: line.variantCode } : {}),
    category: p.category,
    ...(description ? { description } : {}),
  };
}
