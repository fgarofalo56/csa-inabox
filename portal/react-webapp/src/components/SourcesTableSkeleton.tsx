/**
 * SourcesTableSkeleton — CSA-0124(1).
 *
 * Thin wrapper around the shared `TableSkeleton` component (CSA-0124(10))
 * preserving the original sources-specific API (`rows` prop, "Loading
 * sources" accessible label) so downstream tests and imports keep working.
 *
 * New list pages should import `TableSkeleton` directly rather than a
 * per-list wrapper.
 */

import React from 'react';
import { TableSkeleton } from '@/components/TableSkeleton';

const SOURCES_COLUMNS = [
  'Name',
  'Type',
  'Domain',
  'Status',
  'Classification',
  'Updated',
] as const;

export interface SourcesTableSkeletonProps {
  /** Number of placeholder rows to render. Default 5. */
  rows?: number;
}

export function SourcesTableSkeleton({
  rows = 5,
}: SourcesTableSkeletonProps): React.ReactElement {
  return (
    <TableSkeleton
      columns={SOURCES_COLUMNS}
      rows={rows}
      ariaLabel="Loading sources"
    />
  );
}

export default SourcesTableSkeleton;
