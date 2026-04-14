/**
 * Dashboard page — Platform overview with key metrics.
 * Landing page for the CSA-in-a-Box Data Onboarding Portal.
 */

import React from 'react';
import { useStats, useDomainOverview, usePipelines } from '@/hooks/useApi';
import type { PlatformStats, DomainOverview } from '@/types';

function StatCard({
  label,
  value,
  change,
  trend,
}: {
  label: string;
  value: number | string;
  change?: string;
  trend?: 'up' | 'down' | 'neutral';
}) {
  const trendColor =
    trend === 'up'
      ? 'text-green-600'
      : trend === 'down'
        ? 'text-red-600'
        : 'text-gray-500';

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-gray-900">{value}</p>
      {change && (
        <p className={`mt-1 text-sm ${trendColor}`}>{change}</p>
      )}
    </div>
  );
}

function DomainCard({ domain }: { domain: DomainOverview }) {
  const statusColors = {
    healthy: 'bg-green-100 text-green-800',
    warning: 'bg-yellow-100 text-yellow-800',
    critical: 'bg-red-100 text-red-800',
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-gray-900 capitalize">
          {domain.name}
        </h3>
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[domain.status]}`}
        >
          {domain.status}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-gray-500">Sources</span>
          <p className="font-medium">{domain.source_count}</p>
        </div>
        <div>
          <span className="text-gray-500">Pipelines</span>
          <p className="font-medium">{domain.pipeline_count}</p>
        </div>
        <div>
          <span className="text-gray-500">Products</span>
          <p className="font-medium">{domain.data_product_count}</p>
        </div>
        <div>
          <span className="text-gray-500">Quality</span>
          <p className="font-medium">
            {(domain.avg_quality_score * 100).toFixed(0)}%
          </p>
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { data: stats, isLoading: statsLoading } = useStats();
  const { data: domains, isLoading: domainsLoading } = useDomainOverview();
  const { data: pipelines } = usePipelines({ status: 'running' });

  if (statsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
      </div>
    );
  }

  const s = stats as PlatformStats;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Platform Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">
          CSA-in-a-Box Data Platform Overview
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Registered Sources"
          value={s?.registered_sources ?? 0}
          change="+3 this week"
          trend="up"
        />
        <StatCard
          label="Active Pipelines"
          value={s?.active_pipelines ?? 0}
          trend="neutral"
        />
        <StatCard
          label="Data Products"
          value={s?.data_products ?? 0}
          change="+1 this week"
          trend="up"
        />
        <StatCard
          label="Avg Quality Score"
          value={`${((s?.avg_quality_score ?? 0) * 100).toFixed(0)}%`}
          trend="up"
        />
      </div>

      {/* Secondary Stats */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <StatCard
          label="Pipeline Runs (24h)"
          value={s?.last_24h_pipeline_runs ?? 0}
        />
        <StatCard
          label="Data Volume (GB)"
          value={s?.total_data_volume_gb?.toLocaleString() ?? '0'}
        />
        <StatCard
          label="Pending Access Requests"
          value={s?.pending_access_requests ?? 0}
          trend={
            (s?.pending_access_requests ?? 0) > 5 ? 'down' : 'neutral'
          }
        />
      </div>

      {/* Running Pipelines Alert */}
      {pipelines && pipelines.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <h3 className="text-sm font-medium text-blue-800">
            {pipelines.length} Pipeline(s) Currently Running
          </h3>
          <ul className="mt-2 text-sm text-blue-700">
            {pipelines.slice(0, 5).map((p) => (
              <li key={p.id} className="flex items-center gap-2">
                <span className="inline-block w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                {p.name}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Domain Overview */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Data Domains
        </h2>
        {domainsLoading ? (
          <p className="text-gray-500">Loading domains...</p>
        ) : domains && domains.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {domains.map((domain) => (
              <DomainCard key={domain.name} domain={domain} />
            ))}
          </div>
        ) : (
          <div className="text-center py-12 bg-gray-50 rounded-lg">
            <p className="text-gray-500">No data domains configured yet.</p>
            <p className="text-sm text-gray-400 mt-1">
              Register your first data source to get started.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
