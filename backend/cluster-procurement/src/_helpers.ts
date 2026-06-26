/**
 * Internal CRUD helpers shared by the procurement feature services — the same
 * `paginate`/`ensure` shape every @ra cluster inlines, factored here because this cluster
 * spans six feature services over twenty tables.
 */
import type { Page } from './cluster-procurement.dtos.js';

/** Slice the `limit+1` window into a page + the next cursor (the last kept row's id). */
export function paginate<T>(rows: T[], limit: number, idOf: (row: T) => string): Page<T> {
  const items = rows.slice(0, limit);
  const nextCursor =
    rows.length > limit && items.length > 0 ? idOf(items[items.length - 1]!) : null;
  return { items, nextCursor };
}

/** Guard an INSERT … RETURNING result that the type system marks optional. */
export function ensure<T>(row: T | undefined): T {
  if (!row) throw new Error('insert returned no row');
  return row;
}
