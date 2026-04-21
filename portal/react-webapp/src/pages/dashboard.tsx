/**
 * Minimal platform dashboard — CSA-0121.
 *
 * Renders four KPIs sourced from the existing backend endpoints:
 *   1. Total sources by domain        — `GET /api/v1/stats` +
 *                                       `GET /api/v1/domains`
 *   2. Pipeline success rate (24h)    — computed from `PlatformStats.
 *                                       last_24h_pipeline_runs` and the
 *                                       current pipelines list
 *   3. Pending access requests count  — `PlatformStats.pending_access_requests`
 *   4. Top 5 marketplace products     — ranked by `quality_score` from
 *                                       `GET /api/v1/marketplace/products`
 *
 * The pre-existing `pages/index.tsx` is the full "Platform Dashboard"
 * with stat cards and domain health. This `/dashboard` route is the
 * minimal, Jest-testable surface that CSA-0121 called out; it reuses
 * only existing hooks and primitives — no new design system.
 *
 * Accessibility notes:
 *   - Each KPI card uses `role="group"` + `aria-labelledby` so screen
 *     readers announce the metric label together with its value.
 *   - The loading state is announced via an `aria-live="polite"` region.
 *   - The top-products table uses a real `<table>` with `scope="col"`
 *     headers rather than a grid of divs.
 */

import React from 'react';
import {
  useStats,
  useDomainOverview,
  usePipelines,
  useDataProducts,
} from '@/hooks/useApi';
import ErrorBanner from '@/components/ErrorBanner';
import EmptyState from '@/components/EmptyState';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';
import { ActivityFeed } from '@/components/ActivityFeed';
import type { DataProduct, DomainOverview, PlatformStats } from '@/types';

interface KpiCardProps {
  id: string;
  label: string;
  value: string | number;
  hint?: string;
}

function KpiCard({ id, label, value, hint }: KpiCardProps) {
  const labelId = `${id}-label`;
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="bg-white rounded-lg shadow-sm border border-gray-200 p-6"
    >
      <p id={labelId} className="text-sm font-medium text-gray-500">
        {label}
      </p>
      <p className="mt-2 text-3xl font-semibold text-gray-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  );
}

/**
 * Compute pipeline success rate over the last 24h.
 *
 * Source of truth is `PlatformStats.last_24h_pipeline_runs` (total runs in
 * the last day). We derive successes from the current pipelines list
 * filtered by `status === 'succeeded'`. This is an approximation — the
 * backend does not expose a dedicated `last_24h_success_count`, and
 * adding a new endpoint is out of scope for CSA-0121. The UI labels
 * this explicitly as "approx." so operators know not to use it as the
 * sole SLA signal.
 */
function computeSuccessRate(
  stats: PlatformStats | undefined,
  pipelines: readonly { status: string }[] | undefined
): { display: string; hint: string } {
  const total = stats?.last_24h_pipeline_runs ?? 0;
  if (!total || !pipelines) {
    return { display: '—', hint: 'No runs in the last 24h' };
  }
  const succeeded = pipelines.filter((p) => p.status === 'succeeded').length;
  const pct = Math.min(100, Math.round((succeeded / total) * 100));
  return {
    display: `${pct}%`,
    hint: `approx. ${succeeded} of ${total} pipelines succeeded (24h)`,
  };
}

function SourcesByDomainTable({
  domains,
}: {
  domains: DomainOverview[] | undefined;
}) {
  if (!domains || domains.length === 0) {
    return (
      <EmptyState
        title="No domains yet"
        description="Register a data source to populate domain counts."
      />
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <caption className="sr-only">
          Total sources broken down by data domain
        </caption>
        <thead className="bg-gray-50">
          <tr>
            <th
              scope="col"
              className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase"
            >
              Domain
            </th>
            <th
              scope="col"
              className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase"
            >
              Sources
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-100">
          {domains.map((d) => (
            <tr key={d.name}>
              <td className="px-4 py-2 text-sm capitalize text-gray-700">
                {d.name}
              </td>
              <td className="px-4 py-2 text-sm text-right text-gray-900 font-medium">
                {d.source_count}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopProductsTable({
  products,
}: {
  products: DataProduct[] | undefined;
}) {
  const top = React.useMemo(() => {
    if (!products) return [];
    // Copy then sort — never mutate the react-query cache.
    return [...products]
      .sort((a, b) => b.quality_score - a.quality_score)
      .slice(0, 5);
  }, [products]);

  if (top.length === 0) {
    return (
      <EmptyState
        title="No data products yet"
        description="Publish a data product to see it ranked here."
      />
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <caption className="sr-only">
          Top five marketplace data products ranked by quality score
        </caption>
        <thead className="bg-gray-50">
          <tr>
            <th
              scope="col"
              className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase"
            >
              Product
            </th>
            <th
              scope="col"
              className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase"
            >
              Domain
            </th>
            <th
              scope="col"
              className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase"
            >
              Quality
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-100">
          {top.map((p) => (
            <tr key={p.id}>
              <td className="px-4 py-2 text-sm text-gray-900 font-medium">
                {p.name}
              </td>
              <td className="px-4 py-2 text-sm text-gray-600 capitalize">
                {p.domain}
              </td>
              <td className="px-4 py-2 text-sm text-right text-gray-900 font-semibold">
                {Math.round(p.quality_score * 100)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DashboardContent() {
  const { data: stats, isLoading: statsLoading, error: statsError, refetch: refetchStats } = useStats();
  const { data: domains, isLoading: domainsLoading, error: domainsError } = useDomainOverview();
  const { data: pipelines } = usePipelines();
  const { data: products, isLoading: productsLoading } = useDataProducts();

  // Global loading — show a skeleton only while the two KPI primary
  // fetches are both in flight. Sub-sections handle their own loading.
  const loading = statsLoading && domainsLoading;

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label="Loading dashboard"
        className="space-y-8"
      >
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 animate-pulse"
            >
              <div className="h-4 w-24 bg-gray-200 rounded" />
              <div className="mt-3 h-8 w-16 bg-gray-200 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (statsError) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        </header>
        <ErrorBanner
          title="Failed to load dashboard"
          message={
            statsError instanceof Error
              ? statsError.message
              : 'An unexpected error occurred.'
          }
          onRetry={() => refetchStats()}
        />
      </div>
    );
  }

  const totalSources = stats?.registered_sources ?? 0;
  const pendingAccess = stats?.pending_access_requests ?? 0;
  const successRate = computeSuccessRate(stats, pipelines);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">
          A minimal platform snapshot pulled from <code className="text-xs">/api/v1/stats</code>{' '}
          and <code className="text-xs">/api/v1/marketplace/stats</code>.
        </p>
      </header>

      {/* KPI row */}
      <section aria-labelledby="kpis-heading" className="space-y-3">
        <h2 id="kpis-heading" className="sr-only">
          Key performance indicators
        </h2>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <KpiCard
            id="kpi-total-sources"
            label="Total sources"
            value={totalSources}
            hint="across all domains"
          />
          <KpiCard
            id="kpi-success-rate"
            label="Pipeline success (24h)"
            value={successRate.display}
            hint={successRate.hint}
          />
          <KpiCard
            id="kpi-pending-access"
            label="Pending access requests"
            value={pendingAccess}
            hint={
              pendingAccess === 0
                ? 'queue is clear'
                : 'awaiting reviewer action'
            }
          />
        </div>
      </section>

      {/* Sources by domain */}
      <section
        aria-labelledby="domains-heading"
        className="bg-white rounded-lg shadow-sm border border-gray-200 p-6"
      >
        <h2
          id="domains-heading"
          className="text-lg font-semibold text-gray-900 mb-4"
        >
          Sources by domain
        </h2>
        {domainsError ? (
          <p className="text-sm text-red-600">Failed to load domain data.</p>
        ) : (
          <SourcesByDomainTable domains={domains} />
        )}
      </section>

      {/* Top products */}
      <section
        aria-labelledby="top-products-heading"
        className="bg-white rounded-lg shadow-sm border border-gray-200 p-6"
      >
        <h2
          id="top-products-heading"
          className="text-lg font-semibold text-gray-900 mb-4"
        >
          Top 5 data products by quality score
        </h2>
        {productsLoading ? (
          <p className="text-sm text-gray-500">Loading products…</p>
        ) : (
          <TopProductsTable products={products} />
        )}
      </section>

      {/* Recent activity — CSA-0124(14). Pulls live pipeline-run + pending
          access-request data via existing hooks; no new endpoints. */}
      <ActivityFeed limit={10} />
    </div>
  );
}

export default function DashboardPage() {
  return (
    <RouteErrorBoundary routeLabel="Dashboard">
      <DashboardContent />
    </RouteErrorBoundary>
  );
}
