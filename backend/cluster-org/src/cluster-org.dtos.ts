/**
 * Shared DTOs for the org cluster. The generic list/cursor query is reused by every
 * controller; per-table create bodies live next to their feature service.
 */
import { z } from 'zod';

/** Cursor-paginated list query: `?cursor=&limit=` (limit coerced 1..100, default 20). */
export const listQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListQuery = z.infer<typeof listQuery>;

/** A page of rows + the cursor to fetch the next page (null when exhausted). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
