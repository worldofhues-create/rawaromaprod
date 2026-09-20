/**
 * packaging cluster shared helpers — the cursor Page<T> shape, the `paginate` helper, and the
 * numeric-to-string coercion used at insert. Page<T> + paginate are EXPORTED here (and only
 * here) so any controller method returning Page<T> has an exported declared return type
 * (tsconfig declaration emit → non-exported return types fail TS4053).
 */

/** Cursor page envelope — a slice of items + the next cursor (last pk) or null. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Shared cursor pagination — desc(pk), limit+1 → {items, nextCursor}. */
export function paginate<T>(rows: T[], limit: number, pk: (row: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? pk(last) : null;
  return { items, nextCursor };
}

/** Numeric → string at insert (drizzle numeric columns take strings); null when absent. */
export function num(n: number | null | undefined): string | null {
  return n === undefined || n === null ? null : String(n);
}
