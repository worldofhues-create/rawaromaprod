/**
 * Injection token + typed Drizzle client for the org cluster (iam schema).
 *
 * Unlike the @core clusters (which receive `IAM_DB` from the kernel's DrizzleModule),
 * the @ra org cluster mints its OWN client off the shared `PG_CLIENT` pool, bound to the
 * `@ra/data-org` schema barrel. The boundary rule still holds: this cluster only ever
 * receives a client typed to its own schema.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as orgSchema from '@ra/data-org';

/** DI token → `OrgDb`. Inject with `@Inject(ORG_DB)`. */
export const ORG_DB = Symbol('ORG_DB');

/** Drizzle client bound to the `@ra/data-org` (iam) schema barrel. */
export type OrgDb = PostgresJsDatabase<typeof orgSchema>;

export { orgSchema, drizzle };
