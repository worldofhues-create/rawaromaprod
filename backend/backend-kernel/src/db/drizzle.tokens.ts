/**
 * Injection tokens + types for the per-schema Drizzle clients.
 *
 * The boundary rule (doc 01 §0): each cluster touches ONLY its own schema. We enforce
 * it by handing every cluster a Drizzle client typed to its schema barrel — `trust`
 * code physically cannot reference an `iam` table because it never receives that client.
 * One underlying postgres-js connection is shared (one pool); the schema split is at the
 * Drizzle generic, not the socket.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as iamSchema from '@core/data-iam';
import * as platformSchema from '@core/data-platform';

/** Drizzle client bound to the `iam` schema barrel. */
export type IamDb = PostgresJsDatabase<typeof iamSchema>;
/** Drizzle client bound to the `platform` schema barrel. */
export type PlatformDb = PostgresJsDatabase<typeof platformSchema>;

/** DI token → `IamDb`. Inject with `@Inject(IAM_DB)`. */
export const IAM_DB = Symbol('IAM_DB');
/** DI token → `PlatformDb`. Inject with `@Inject(PLATFORM_DB)`. */
export const PLATFORM_DB = Symbol('PLATFORM_DB');

/** The raw postgres-js sql tag (for health pings / advisory locks). */
export const PG_CLIENT = Symbol('PG_CLIENT');

/** Re-export the schema barrels so callers type their queries without a second import. */
export { iamSchema, platformSchema };
export type { PostgresJsDatabase };
export { drizzle };
