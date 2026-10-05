/**
 * Formula setup (lane vaultsetup) — the module's database handle and its classification seam.
 *
 * FORMULA_SETUP_DB: a schema-less Drizzle client over the shared PG_CLIENT pool (the shelf
 * module's idiom), for the cross-schema reads (packaging products + SKUs, masterdata materials)
 * and the product -> formula link writes, in Drizzle transactions.
 *
 * PRODUCT_KIND_SOURCE — WHERE THE CATALOGUE'S CLASSIFICATION PLUGS IN. The ALEMBIC -> RawProd
 * catalogue sync (lane catalogue-rp) classifies each product as `single_chemical` or `blend` and
 * stores it per catalogue item in `bridge.catalogue_item` (classification, classification_basis,
 * material_id, product_id). formula-setup.module.ts provides CatalogueProductKindSource
 * (catalogue-kind.source.ts) under this token. A product the catalogue does not hold has no
 * classification: the owner chooses its kind on the setup screen. Without a provider (unit tests)
 * every product is unclassified.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import type { ShellKind } from '@ra/cluster-formula';

export const FORMULA_SETUP_DB = Symbol('FORMULA_SETUP_DB');
export type FormulaSetupDb = PostgresJsDatabase<Record<string, never>>;

export function formulaSetupDb(client: Sql): FormulaSetupDb {
  return drizzle(client);
}

/** The catalogue's classification of one product. */
export interface ProductClassification {
  kind: ShellKind;
  /** ALEMBIC's plain-words reason for the kind (e.g. "CAS number 24851-98-7 on file"). */
  basis: string | null;
  /** single_chemical only: the product's own material, as the catalogue sync created/linked it. */
  materialId: string | null;
}

/** Reads the catalogue's single_chemical/blend classification for products (absent = unknown). */
export interface ProductKindSource {
  classify(productIds: string[]): Promise<Map<string, ProductClassification>>;
}

export const PRODUCT_KIND_SOURCE = Symbol('PRODUCT_KIND_SOURCE');
