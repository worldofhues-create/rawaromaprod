import { z } from 'zod';

/** All public ids are UUIDv7 (time-sortable, non-enumerable). Stored/serialized as uuid strings. */
export const uuid = z.string().uuid();
export type Uuid = z.infer<typeof uuid>;

/** Branded id helper — documents which entity an id points at without changing the runtime type. */
export const idOf = (entity: string) => uuid.describe(`${entity} id (uuidv7)`);

/** Human-readable reference code (e.g. invoice no.) — separate from the PK, never enumerable as the id. */
export const refCode = z.string().min(1).max(64);
