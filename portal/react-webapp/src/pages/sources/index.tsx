/**
 * Sources list page — Browse and manage registered data sources.
 */

import React, { useState } from 'react';
import Link from 'next/link';
import { useSources } from '@/hooks/useApi';
import { useDebounce } from '@/hooks/useDebounce';
import ErrorBanner from '@/components/ErrorBanner';
import EmptyState from '@/components/EmptyState';
import { SourcesTableSkeleton } from '@/components/SourcesTableSkeleton';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';
import { StatusBadge } from '@/components/StatusBadge';
import type { SourceRecord } from '@/types';

function SourcesPageContent() {
  const [domainFilter, setDomainFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const debouncedDomain = useDebounce(domainFilter);
  const { data: sources, isLoading, error, refetch } = useSources({
    domain: debouncedDomain || undefined,
    status: statusFilter || undefined,
  });

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
          onChange={(e) => setDomainFilter(e.target.value)}
          placeholder="Filter by domain..."
          aria-label="Filter sources by domain"
          className="px-3 py-2 border border-gray-300 rounded-md text-sm"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
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
        /* Sources Table */
        <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
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
              {(sources ?? []).map((source: SourceRecord) => (
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
