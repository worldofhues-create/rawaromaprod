'use client';

import * as React from 'react';
import { ChevronDown, ChevronsUpDown, ChevronUp } from 'lucide-react';
import { cn } from '../lib/cn.js';
import { Button } from './button.js';

/**
 * Headless, fully GENERIC data table — columns, sorting, pagination, row selection.
 * No domain types: it is parameterized over an arbitrary row type `TRow` and a stable
 * row id. A domain feature (Tier 2) supplies typed columns; this component never names
 * a domain entity, so it ships verbatim in every project (a graduation candidate per
 * docs/01 §8).
 */

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  columnId: string;
  direction: SortDirection;
}

export interface ColumnDef<TRow> {
  /** Stable identifier — also the sort key. */
  id: string;
  header: React.ReactNode;
  /** Cell renderer. */
  cell: (row: TRow) => React.ReactNode;
  /** Enable click-to-sort on this column's header. */
  sortable?: boolean;
  /**
   * Comparator used when this column is the active sort. If omitted, a default
   * comparator over the row's value is used via `sortAccessor`.
   */
  sortFn?: (a: TRow, b: TRow) => number;
  /** Value used by the default comparator when `sortFn` is absent. */
  sortAccessor?: (row: TRow) => string | number | boolean | null | undefined;
  className?: string;
  headerClassName?: string;
}

export interface DataTableProps<TRow> {
  data: readonly TRow[];
  columns: ReadonlyArray<ColumnDef<TRow>>;
  /** Stable, unique row id — required for selection + React keys. */
  getRowId: (row: TRow) => string;
  /** Controlled or initial page size. */
  pageSize?: number;
  /** Enable the checkbox selection column. */
  enableSelection?: boolean;
  /** Notified whenever the selected id set changes. */
  onSelectionChange?: (selectedIds: string[]) => void;
  /** Row click handler (ignores clicks on the selection checkbox). */
  onRowClick?: (row: TRow) => void;
  emptyState?: React.ReactNode;
  className?: string;
}

function defaultCompare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

export function DataTable<TRow>({
  data,
  columns,
  getRowId,
  pageSize = 10,
  enableSelection = false,
  onSelectionChange,
  onRowClick,
  emptyState,
  className,
}: DataTableProps<TRow>) {
  const [sort, setSort] = React.useState<SortState | null>(null);
  const [page, setPage] = React.useState(0);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set());

  const toggleSort = React.useCallback((columnId: string) => {
    setSort((prev) => {
      if (!prev || prev.columnId !== columnId) return { columnId, direction: 'asc' };
      if (prev.direction === 'asc') return { columnId, direction: 'desc' };
      return null;
    });
  }, []);

  const sortedData = React.useMemo(() => {
    if (!sort) return [...data];
    const col = columns.find((c) => c.id === sort.columnId);
    if (!col) return [...data];
    const cmp =
      col.sortFn ??
      ((a: TRow, b: TRow) =>
        defaultCompare(col.sortAccessor?.(a), col.sortAccessor?.(b)));
    const out = [...data].sort(cmp);
    return sort.direction === 'desc' ? out.reverse() : out;
  }, [data, columns, sort]);

  const pageCount = Math.max(1, Math.ceil(sortedData.length / pageSize));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageRows = React.useMemo(
    () => sortedData.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize),
    [sortedData, clampedPage, pageSize],
  );

  const emitSelection = React.useCallback(
    (next: ReadonlySet<string>) => {
      setSelected(next);
      onSelectionChange?.([...next]);
    },
    [onSelectionChange],
  );

  const toggleRow = React.useCallback(
    (id: string) => {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      emitSelection(next);
    },
    [selected, emitSelection],
  );

  const pageIds = React.useMemo(() => pageRows.map(getRowId), [pageRows, getRowId]);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const toggleAllOnPage = React.useCallback(() => {
    const next = new Set(selected);
    if (allOnPageSelected) for (const id of pageIds) next.delete(id);
    else for (const id of pageIds) next.add(id);
    emitSelection(next);
  }, [selected, allOnPageSelected, pageIds, emitSelection]);

  const colCount = columns.length + (enableSelection ? 1 : 0);

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full caption-bottom text-sm">
          <thead className="border-b border-border bg-surface-muted">
            <tr>
              {enableSelection ? (
                <th className="w-10 px-3 py-2.5 text-left align-middle">
                  <input
                    type="checkbox"
                    aria-label="Select all rows on this page"
                    checked={allOnPageSelected}
                    onChange={toggleAllOnPage}
                    className="size-4 accent-[var(--color-accent)]"
                  />
                </th>
              ) : null}
              {columns.map((col) => {
                // `&&` narrows `sort` to non-null in the active branch (strictNullChecks-safe).
                const activeSort = sort && sort.columnId === col.id ? sort : null;
                return (
                  <th
                    key={col.id}
                    className={cn(
                      'px-3 py-2.5 text-left align-middle font-medium text-text-muted',
                      col.headerClassName,
                    )}
                    aria-sort={
                      activeSort
                        ? activeSort.direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : undefined
                    }
                  >
                    {col.sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(col.id)}
                        className="inline-flex items-center gap-1 hover:text-text"
                      >
                        {col.header}
                        {!activeSort ? (
                          <ChevronsUpDown className="size-3.5 opacity-60" />
                        ) : activeSort.direction === 'asc' ? (
                          <ChevronUp className="size-3.5" />
                        ) : (
                          <ChevronDown className="size-3.5" />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="px-3 py-10 text-center text-text-muted">
                  {emptyState ?? 'No results.'}
                </td>
              </tr>
            ) : (
              pageRows.map((row) => {
                const id = getRowId(row);
                const isSelected = selected.has(id);
                return (
                  <tr
                    key={id}
                    data-selected={isSelected || undefined}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn(
                      'border-b border-border last:border-0 transition-colors',
                      'hover:bg-surface-muted/60 data-[selected]:bg-accent/10',
                      onRowClick && 'cursor-pointer',
                    )}
                  >
                    {enableSelection ? (
                      <td className="px-3 py-2.5 align-middle" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label="Select row"
                          checked={isSelected}
                          onChange={() => toggleRow(id)}
                          className="size-4 accent-[var(--color-accent)]"
                        />
                      </td>
                    ) : null}
                    {columns.map((col) => (
                      <td key={col.id} className={cn('px-3 py-2.5 align-middle text-text', col.className)}>
                        {col.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-4 text-sm text-text-muted">
        <span>
          {enableSelection && selected.size > 0
            ? `${selected.size} selected`
            : `${sortedData.length} row${sortedData.length === 1 ? '' : 's'}`}
        </span>
        <div className="flex items-center gap-2">
          <span>
            Page {clampedPage + 1} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={clampedPage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={clampedPage >= pageCount - 1}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
