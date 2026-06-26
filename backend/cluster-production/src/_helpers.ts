/**
 * production cluster shared helpers — the cursor Page<T> + paginate used by every service,
 * and a small numeric coercion. Kept in one module so the services don't re-declare them.
 */

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Cursor pagination — desc(pk), limit+1 → {items, nextCursor}. */
export function paginate<T>(rows: T[], limit: number, pk: (row: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? pk(last) : null;
  return { items, nextCursor };
}

/** Numeric → DB string (drizzle numeric columns take string). null/undefined pass through. */
export function num(n: number | null | undefined): string | null {
  return n === null || n === undefined ? null : String(n);
}
