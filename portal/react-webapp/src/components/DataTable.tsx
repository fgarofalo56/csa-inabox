/**
 * Sortable, filterable data table with pagination.
 * Designed for listing sources, pipelines, access requests, etc.
 */

import React, { useState, useMemo } from 'react';
import { clsx } from 'clsx';

export interface Column<T> {
  key: string;
  header: string;
  sortable?: boolean;
  render?: (row: T) => React.ReactNode;
}

export interface DataTableProps<T extends Record<string, unknown>> {
  columns: Column<T>[];
  data: T[];
  /** Number of rows per page. Defaults to 10. */
  pageSize?: number;
  /** Optional search filter function. */
  filterFn?: (row: T, query: string) => boolean;
  /** Placeholder text for the search input. */
  searchPlaceholder?: string;
  /** Key field used for React list keys. Defaults to 'id'. */
  rowKey?: string;
}

type SortDir = 'asc' | 'desc';

export function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  pageSize = 10,
  filterFn,
  searchPlaceholder = 'Search...',
  rowKey = 'id',
}: DataTableProps<T>) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    if (!search || !filterFn) return data;
    return data.filter((row) => filterFn(row, search));
  }, [data, search, filterFn]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    return [...filtered].sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      const cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.ceil(sorted.length / pageSize);
  const pageData = sorted.slice(page * pageSize, (page + 1) * pageSize);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
    setPage(0);
  };

  return (
    <div className="space-y-4">
      {filterFn && (
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          placeholder={searchPlaceholder}
          className="w-full max-w-sm rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={clsx(
                    'px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500',
                    col.sortable && 'cursor-pointer select-none hover:text-gray-700'
                  )}
                  onClick={() => col.sortable && handleSort(col.key)}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.header}
                    {col.sortable && sortKey === col.key && (
                      <span>{sortDir === 'asc' ? '\u2191' : '\u2193'}</span>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {pageData.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center text-sm text-gray-500">
                  No data available.
                </td>
              </tr>
            ) : (
              pageData.map((row) => (
                <tr key={String(row[rowKey] ?? Math.random())} className="hover:bg-gray-50">
                  {columns.map((col) => (
                    <td key={col.key} className="whitespace-nowrap px-4 py-3 text-sm text-gray-700">
                      {col.render ? col.render(row) : String(row[col.key] ?? '')}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>
            Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, sorted.length)} of{' '}
            {sorted.length}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="rounded border border-gray-300 px-3 py-1 disabled:opacity-50"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="rounded border border-gray-300 px-3 py-1 disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default DataTable;
