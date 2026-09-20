/**
 * sales cluster shared helpers — cursor pagination + the numeric coercion used at insert.
 * `Page<T>` is exported (and used as a controller method return type) so the emitted .d.ts
 * names a public type (tsconfig declaration:true → TS4053 if it were local).
 */

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

/** numeric column helper — number|undefined|null → string|null for drizzle numeric insert. */
export function num(n: number | undefined | null): string | null {
  return n === undefined || n === null ? null : String(n);
}
