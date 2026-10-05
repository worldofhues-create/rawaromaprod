/**
 * Formula setup (lane vaultsetup) — the module's database handle and its classification seam.
 *
 * FORMULA_SETUP_DB: a schema-less Drizzle client over the shared PG_CLIENT pool (the shelf
 * module's idiom), for the cross-schema reads (packaging products + SKUs, masterdata materials)
 * and the product -> formula link writes, in Drizzle transactions.
 *
 * PRODUCT_KIND_SOURCE — WHERE THE CATALOGUE'S CLASSIFICATION PLUGS IN. The ALEMBIC -> RawProd
 * catalogue sync (lane catalogue-rp) classifies each product as `single_chemical` or `blend`;
 * where it stores that is not decided yet. Until it is, nothing is provided under this token and
 * every product's kind is chosen on the setup screen (and always accepted as an explicit input by
 * POST /v1/formula-setup/shells). To wire it: provide a `ProductKindSource` that reads the
 * catalogue's field for the given product ids — one provider line in formula-setup.module.ts.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import type { ShellKind } from '@ra/cluster-formula';

export const FORMULA_SETUP_DB = Symbol('FORMULA_SETUP_DB');
export type FormulaSetupDb = PostgresJsDatabase<Record<string, never>>;

export function formulaSetupDb(client: Sql): FormulaSetupDb {
  return drizzle(client);
}

/** Reads the catalogue's single_chemical/blend classification for products (absent = unknown). */
export interface ProductKindSource {
  kindsFor(productIds: string[]): Promise<Map<string, ShellKind>>;
}

export const PRODUCT_KIND_SOURCE = Symbol('PRODUCT_KIND_SOURCE');
