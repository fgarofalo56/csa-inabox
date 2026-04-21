/**
 * Sources list page — Browse and manage registered data sources.
 *
 * CSA-0124-remaining: bulk selection + bulk actions (scope creep — multi-file).
 * CSA-0124-remaining: CSV export (requires new backend endpoint).
 * CSA-0124-remaining: pagination (requires backend pagination support).
 */

import React, { useCallback, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSources } from '@/hooks/useApi';
import { useDebounce } from '@/hooks/useDebounce';
import { useColumnSort } from '@/hooks/useColumnSort';
import ErrorBanner from '@/components/ErrorBanner';
import EmptyState from '@/components/EmptyState';
import { SourcesTableSkeleton } from '@/components/SourcesTableSkeleton';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';
import { StatusBadge } from '@/components/StatusBadge';
import type { SourceRecord } from '@/types';

/** Keys we support sorting on — matches `<th>` columns 1:1. */
type SortKey = 'name' | 'source_type' | 'domain' | 'status' | 'classification' | 'updated_at';

/** Columns rendered in the sources table. Keep in lockstep with the thead. */
const COLUMNS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'source_type', label: 'Type' },
  { key: 'domain', label: 'Domain' },
  { key: 'status', label: 'Status' },
  { key: 'classification', label: 'Classification' },
  { key: 'updated_at', label: 'Updated' },
];

/** Read a query-string param as a trimmed string, ignoring arrays. */
function readParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function SourcesPageContent() {
  const router = useRouter();

  // ─── URL-synced filter state (CSA-0124(7)) ───────────────────────────
  // On mount (after router is ready) we hydrate from the URL so deep links
  // land on the same filtered view the sharer saw. Subsequent typing calls
  // router.replace() so the URL stays in sync without adding history entries.
  const [domainFilter, setDomainFilter] = React.useState<string>('');
  const [statusFilter, setStatusFilter] = React.useState<string>('');

  useEffect(() => {
    if (!router.isReady) return;
    const q = router.query ?? {};
    const d = readParam(q.domain);
    const s = readParam(q.status);
    // Only set when the source-of-truth (router) differs from local state.
    // Without this guard, the effect would loop every render.
    setDomainFilter((prev) => (prev === d ? prev : d));
    setStatusFilter((prev) => (prev === s ? prev : s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, router.query?.domain, router.query?.status]);

  const pushQuery = useCallback(
    (next: { domain?: string; status?: string }) => {
      if (!router.isReady) return;
      const query: Record<string, string> = {};
      if (next.domain) query.domain = next.domain;
      if (next.status) query.status = next.status;
      // shallow: true avoids re-running getServerSideProps-equivalents; we
      // just want the URL in sync with local state.
      void router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
    },
    [router],
  );

  const onChangeDomain = (value: string) => {
    setDomainFilter(value);
    pushQuery({ domain: value, status: statusFilter });
  };
  const onChangeStatus = (value: string) => {
    setStatusFilter(value);
    pushQuery({ domain: domainFilter, status: value });
  };

  const debouncedDomain = useDebounce(domainFilter);
  const { data: sources, isLoading, error, refetch } = useSources({
    domain: debouncedDomain || undefined,
    status: statusFilter || undefined,
  });

  // ─── Column-sortable table (CSA-0124(5)) ─────────────────────────────
  const { sortKey, sortDir, setSort, sortedItems, ariaSortFor } = useColumnSort<
    SourceRecord,
    SortKey
  >(sources, {
    getValue: (row, key) => {
      if (key === 'updated_at') {
        const ts = row.updated_at ? new Date(row.updated_at) : null;
        return ts;
      }
      // All other keys are top-level string scalars on SourceRecord.
      return (row as unknown as Record<string, string | undefined>)[key];
    },
  });

  const sortIndicator = (key: SortKey): string => {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  };

  const rows = useMemo(() => sortedItems, [sortedItems]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Data Sources</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage registered data sources and their pipelines
          </p>
        </div>
        <Link
          href="/sources/register"
          className="inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-md hover:bg-brand-700"
        >
          + Register Source
        </Link>
      </div>

      {/* Filters */}
      <div className="flex gap-4">
        <input
          type="text"
          value={domainFilter}
          onChange={(e) => onChangeDomain(e.target.value)}
          placeholder="Filter by domain..."
          aria-label="Filter sources by domain"
          className="px-3 py-2 border border-gray-300 rounded-md text-sm"
        />
        <select
          value={statusFilter}
          onChange={(e) => onChangeStatus(e.target.value)}
          aria-label="Filter sources by status"
          className="px-3 py-2 border border-gray-300 rounded-md text-sm"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="pending_approval">Pending Approval</option>
          <option value="provisioning">Provisioning</option>
          <option value="error">Error</option>
          <option value="paused">Paused</option>
        </select>
      </div>

      {/* Error State */}
      {error ? (
        <ErrorBanner
          title="Failed to load sources"
          message={error instanceof Error ? error.message : 'An unexpected error occurred.'}
          onRetry={() => refetch()}
        />
      ) : isLoading ? (
        /* Loading State — CSA-0124(1): full table skeleton replaces the
           generic spinner so layout does not reflow when data resolves. */
        <SourcesTableSkeleton rows={5} />
      ) : sources && sources.length === 0 ? (
        /* Empty State — CSA-0124(2). The copy intentionally preserves the
           "No data sources found" phrase that downstream tests grep for. */
        <EmptyState
          title="No data sources found"
          description="Register your first data source to get started."
          action={{ label: '+ Register Source', href: '/sources/register' }}
        />
      ) : (
        /* Sources Table — CSA-0124(5) sortable headers. */
        <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={ariaSortFor(col.key)}
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase"
                  >
                    <button
                      type="button"
                      onClick={() => setSort(col.key)}
                      aria-label={`Sort by ${col.label}`}
                      className="inline-flex items-center gap-1 font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 rounded"
                    >
                      <span>{col.label}</span>
                      <span aria-hidden="true">{sortIndicator(col.key)}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {rows.map((source: SourceRecord) => (
                <tr key={source.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <Link
                      href={`/sources/${source.id}`}
                      className="text-sm font-medium text-brand-600 hover:text-brand-800"
                    >
                      {source.name}
                    </Link>
                    <p className="text-xs text-gray-500">
                      {source.description?.substring(0, 60)}
                    </p>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {source.source_type.replace(/_/g, ' ')}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 capitalize">
                    {source.domain}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <StatusBadge status={source.status} />
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 uppercase">
                    {source.classification}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {new Date(source.updated_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Default export wraps the page in a route-scoped error boundary so a
 * render-time bug here does not take down the surrounding shell
 * (CSA-0124(4)).
 */
export default function SourcesPage() {
  return (
    <RouteErrorBoundary routeLabel="Sources">
      <SourcesPageContent />
    </RouteErrorBoundary>
  );
}
