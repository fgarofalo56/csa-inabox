/**
 * SourcesTableSkeleton — CSA-0124(1).
 *
 * Full-fidelity shimmer skeleton for the Data Sources list table. Replaces
 * the generic spinner so the layout does not jump when data resolves.
 * Pure Tailwind + `animate-pulse`; no inline styles, no extra deps.
 *
 * Accessibility:
 *   - Wrapped in `role="status"` with an `aria-label` so assistive tech
 *     announces the loading state once and then quiets down.
 *   - A visually hidden `Loading sources` string gives SR users the
 *     equivalent of the previous spinner's `aria-label`.
 */

import React from 'react';

/**
 * A small, deterministic set of Tailwind width utilities used to add
 * visual variation to the shimmer rows without resorting to inline
 * `style` attributes. The pattern cycles through the array by row
 * index so renders are stable across mount/unmount.
 */
const NAME_WIDTHS = ['w-28', 'w-36', 'w-32', 'w-40', 'w-24'] as const;
const DESCRIPTION_WIDTHS = ['w-48', 'w-56', 'w-44', 'w-52', 'w-60'] as const;

function SkeletonRow({ id }: { id: number }): React.ReactElement {
  const nameWidth = NAME_WIDTHS[id % NAME_WIDTHS.length];
  const descriptionWidth = DESCRIPTION_WIDTHS[id % DESCRIPTION_WIDTHS.length];
  return (
    <tr className="animate-pulse">
      <td className="px-6 py-4">
        <div className={`h-4 bg-gray-200 rounded ${nameWidth}`} />
        <div className={`mt-2 h-3 bg-gray-100 rounded ${descriptionWidth}`} />
      </td>
      <td className="px-6 py-4">
        <div className="h-4 w-20 bg-gray-200 rounded" />
      </td>
      <td className="px-6 py-4">
        <div className="h-4 w-16 bg-gray-200 rounded" />
      </td>
      <td className="px-6 py-4">
        <div className="h-6 w-20 bg-gray-100 rounded-full" />
      </td>
      <td className="px-6 py-4">
        <div className="h-4 w-20 bg-gray-200 rounded" />
      </td>
      <td className="px-6 py-4">
        <div className="h-4 w-24 bg-gray-200 rounded" />
      </td>
    </tr>
  );
}

export interface SourcesTableSkeletonProps {
  /** Number of placeholder rows to render. Default 5. */
  rows?: number;
}

export function SourcesTableSkeleton({
  rows = 5,
}: SourcesTableSkeletonProps): React.ReactElement {
  const rowIds = React.useMemo(
    () => Array.from({ length: rows }, (_, i) => i),
    [rows]
  );
  return (
    <div
      role="status"
      aria-label="Loading sources"
      className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden"
    >
      <span className="sr-only">Loading sources…</span>
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Name
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Type
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Domain
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Status
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Classification
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Updated
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {rowIds.map((id) => (
            <SkeletonRow key={id} id={id} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default SourcesTableSkeleton;
