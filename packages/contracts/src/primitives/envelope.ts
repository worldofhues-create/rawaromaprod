import { z } from 'zod';
import { errorCode } from '../registries/error-codes.js';

/** Normalized error shape returned by the edge layer. */
export const apiError = z.object({
  code: errorCode,
  message: z.string(),
  /** Field-level validation issues, keyed by dotted path. */
  details: z.record(z.array(z.string())).optional(),
  requestId: z.string(),
});
export type ApiError = z.infer<typeof apiError>;

/** Response meta — cursor for paginated lists, echoed request id. */
export const apiMeta = z
  .object({
    cursor: z.string().nullable().optional(),
    requestId: z.string().optional(),
  })
  .partial();
export type ApiMeta = z.infer<typeof apiMeta>;

/**
 * The universal response envelope: `{ data, meta, error }`.
 * Exactly one of `data` / `error` is populated. Use `envelope(schema)` per endpoint.
 */
export const envelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    data: data.nullable(),
    meta: apiMeta.nullable().default(null),
    error: apiError.nullable().default(null),
  });

export type Envelope<T> = { data: T | null; meta: ApiMeta | null; error: ApiError | null };
