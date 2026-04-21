/**
 * TableSkeleton — CSA-0124(1)/(10).
 *
 * Generalized, column-aware shimmer skeleton used by every list page in
 * the portal (sources, pipelines, access). Extracted from the original
 * `SourcesTableSkeleton` so all three lists share one implementation and
 * one accessibility contract.
 *
 * Accessibility:
 *   - `role="status"` + `aria-label` so AT announces the loading state.
 *   - A visually hidden label mirrors the previous spinner's `aria-label`
 *     string so existing tests that query `getByRole('status', { name })`
 *     continue to match.
 *
 * Pure Tailwind utilities; no inline styles, no additional CSS.
 */

import React from 'react';

/**
 * A deterministic pool of Tailwind width utilities used to stagger the
 * width of the first cell so the skeleton doesn't look perfectly
 * rectangular. Cycles by row index.
 */
const PRIMARY_WIDTHS = ['w-28', 'w-36', 'w-32', 'w-40', 'w-24'] as const;
const SECONDARY_WIDTHS = ['w-48', 'w-56', 'w-44', 'w-52', 'w-60'] as const;

export interface TableSkeletonProps {
  /** Column header labels. Length controls how many `<th>`/cells render. */
  columns: readonly string[];
  /** Number of placeholder rows. Default 5. */
  rows?: number;
  /**
   * Accessible label for the whole skeleton. Defaults to "Loading…"; list
   * pages pass "Loading sources", "Loading pipelines", etc. so SR users
   * hear the context.
   */
  ariaLabel?: string;
  /** Optional outer classes (e.g. extra margin). */
  className?: string;
}

function SkeletonRow({
  id,
  columnCount,
}: {
  id: number;
  columnCount: number;
}): React.ReactElement {
  const primary = PRIMARY_WIDTHS[id % PRIMARY_WIDTHS.length];
  const secondary = SECONDARY_WIDTHS[id % SECONDARY_WIDTHS.length];
  return (
    <tr className="animate-pulse">
      {Array.from({ length: columnCount }, (_, colIdx) => (
        <td key={colIdx} className="px-6 py-4">
          {colIdx === 0 ? (
            <>
              <div className={`h-4 bg-gray-200 rounded ${primary}`} />
              <div className={`mt-2 h-3 bg-gray-100 rounded ${secondary}`} />
            </>
          ) : (
            <div className="h-4 w-20 bg-gray-200 rounded" />
          )}
        </td>
      ))}
    </tr>
  );
}

export function TableSkeleton({
  columns,
  rows = 5,
  ariaLabel = 'Loading…',
  className,
}: TableSkeletonProps): React.ReactElement {
  const rowIds = React.useMemo(
    () => Array.from({ length: rows }, (_, i) => i),
    [rows],
  );
  const wrapperClass = [
    'bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden',
    className ?? '',
  ]
    .join(' ')
    .trim();
  return (
    <div role="status" aria-label={ariaLabel} className={wrapperClass}>
      <span className="sr-only">{ariaLabel}</span>
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            {columns.map((label) => (
              <th
                key={label}
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {rowIds.map((id) => (
            <SkeletonRow key={id} id={id} columnCount={columns.length} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default TableSkeleton;
