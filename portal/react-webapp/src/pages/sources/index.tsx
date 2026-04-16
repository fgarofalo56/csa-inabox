/**
 * Sources list page — Browse and manage registered data sources.
 */

import React, { useState } from 'react';
import Link from 'next/link';
import { useSources } from '@/hooks/useApi';
import type { SourceRecord, SourceStatus } from '@/types';

const STATUS_BADGES: Record<
  SourceStatus,
  { color: string; label: string }
> = {
  draft: { color: 'bg-gray-100 text-gray-800', label: 'Draft' },
  pending_approval: { color: 'bg-yellow-100 text-yellow-800', label: 'Pending' },
  approved: { color: 'bg-blue-100 text-blue-800', label: 'Approved' },
  provisioning: { color: 'bg-purple-100 text-purple-800', label: 'Provisioning' },
  active: { color: 'bg-green-100 text-green-800', label: 'Active' },
  paused: { color: 'bg-orange-100 text-orange-800', label: 'Paused' },
  decommissioned: { color: 'bg-red-100 text-red-800', label: 'Decommissioned' },
  error: { color: 'bg-red-100 text-red-800', label: 'Error' },
};

export default function SourcesPage() {
  const [domainFilter, setDomainFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const { data: sources, isLoading, error, refetch } = useSources({
    domain: domainFilter || undefined,
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
          className="px-3 py-2 border border-gray-300 rounded-md text-sm"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
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
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <svg className="mx-auto h-10 w-10 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-red-800">Failed to load sources</h3>
          <p className="mt-1 text-sm text-red-600">
            {error instanceof Error ? error.message : 'An unexpected error occurred.'}
          </p>
          <button
            onClick={() => refetch()}
            className="mt-4 inline-flex items-center px-4 py-2 text-sm font-medium text-red-700 bg-red-100 border border-red-300 rounded-md hover:bg-red-200"
          >
            Retry
          </button>
        </div>
      ) : isLoading ? (
        /* Loading State */
        <div className="flex items-center justify-center h-64">
          <div role="status" aria-label="Loading">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
          </div>
        </div>
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
              {sources && sources.length > 0 ? (
                sources.map((source: SourceRecord) => {
                  const badge = STATUS_BADGES[source.status];
                  return (
                    <tr
                      key={source.id}
                      className="hover:bg-gray-50 cursor-pointer"
                    >
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
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${badge.color}`}
                        >
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 uppercase">
                        {source.classification}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {new Date(source.updated_at).toLocaleDateString()}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td
                    colSpan={6}
                    className="px-6 py-12 text-center text-gray-500"
                  >
                    No data sources found. Register your first source to get
                    started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
