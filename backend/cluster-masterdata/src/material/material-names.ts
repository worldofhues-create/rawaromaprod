/**
 * STOCK-FIX-RP (STK-18): one material, one name. The rehearsal's sheet held 208 spellings of 196
 * materials (case and spaces only, "HEDIONE HC" three ways), the master took the same name twice
 * (201), and the loader's first pass made a material called "TOTAL (g)" out of the sheet's total row.
 *
 * A name is compared in `materialMatchKey`'s form (trimmed, inner whitespace collapsed, lower-case),
 * which the SQL below reproduces for the rows already on file; a no-break space counts as a space.
 * Cross-language and one-letter variants ("CITRONELLAL" / "CITRONELAL") are not the same key: the
 * import flags them for a person to decide, it never merges them.
 */
import { sql } from 'drizzle-orm';
import { materialMatchKey } from '../public-api.js';

export const materialNameKey = materialMatchKey;

/** The same key over `masterdata.material.material_name`, for the duplicate check. */
export const MATERIAL_NAME_KEY_SQL = sql`lower(regexp_replace(btrim(replace(material_name, chr(160), ' ')), '[[:space:]]+', ' ', 'g'))`;
export const MATERIAL_NAME_KEY_TEXT = `lower(regexp_replace(btrim(replace(material_name, chr(160), ' ')), '[[:space:]]+', ' ', 'g'))`;

/** A sheet's total row ("TOTAL (g)", "Total", "Grand total:", "Subtotal"): never a material. A real
 *  ingredient whose name only BEGINS with "Total" is not this (the rehearsal's F5 row 262). */
const TOTAL_ROW = /^(grand\s+|sub\s*-?\s*)?total[\s:]*(\([^)]*\))?[\s:]*$/i;
export function isTotalRow(name: string | null | undefined): boolean {
  return TOTAL_ROW.test(String(name ?? '').trim());
}

/** The advisory-lock key that serialises two creates of one name. */
export function nameLockKey(name: string): string {
  return `masterdata.material.name:${materialNameKey(name)}`;
}

/** UN dangerous-goods classes (and NOT_REGULATED), as the master stores them. */
export const HAZARD_CLASSES = ['1', '2.1', '2.2', '2.3', '3', '4.1', '4.2', '4.3', '5.1', '5.2', '6.1', '6.2', '7', '8', '9', 'NOT_REGULATED'] as const;
