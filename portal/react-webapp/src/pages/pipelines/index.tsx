/**
 * Pipelines page — Monitor and manage data pipelines.
 *
 * Lists every pipeline, supports filtering by status / source domain /
 * free-text search, expands a row inline to show recent run history,
 * and supports triggering a pipeline run with a confirmation dialog.
 *
 * CSA-0124-remaining: bulk selection + bulk actions (scope creep).
 * CSA-0124-remaining: CSV export (needs backend endpoint).
 * CSA-0124-remaining: pagination on long lists (needs backend pagination).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import {
  usePipelines,
  usePipelineRuns,
  useTriggerPipeline,
  useSources,
} from '@/hooks/useApi';
import { useDebounce } from '@/hooks/useDebounce';
import { useColumnSort } from '@/hooks/useColumnSort';
import { useToast } from '@/hooks/useToast';
import ErrorBanner from '@/components/ErrorBanner';
import EmptyState from '@/components/EmptyState';
import PageHeader from '@/components/PageHeader';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';
import { StatusBadge } from '@/components/StatusBadge';
import { TableSkeleton } from '@/components/TableSkeleton';
import Button from '@/components/Button';
import { Modal } from '@/components/Modal';
import { Toast } from '@/components/Toast';
import type { PipelineRecord, PipelineRun, SourceRecord } from '@/types';

/** Sortable columns on the pipelines table. */
type PipelineSortKey = 'name' | 'source' | 'pipeline_type' | 'status' | 'last_run_at' | 'schedule_cron';

/** Read a query-string param as a single string (collapsing arrays). */
function readParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function PipelineRunsPanel({ pipelineId }: { pipelineId: string }) {
  const { data: runs, isLoading, error } = usePipelineRuns(pipelineId, 10);

  if (isLoading) {
    return <p className="text-sm text-gray-500">Loading run history…</p>;
  }
  if (error) {
    return <p className="text-sm text-red-600">Failed to load run history.</p>;
  }
  if (!runs || runs.length === 0) {
    return <p className="text-sm text-gray-500">No runs yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead>
          <tr>
            <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Run</th>
            <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Status</th>
            <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Started</th>
            <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Duration</th>
            <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Rows in/out</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {runs.map((run: PipelineRun) => (
            <tr key={run.id}>
              <td className="px-3 py-2 text-xs font-mono text-gray-600">{run.id.substring(0, 8)}</td>
              <td className="px-3 py-2"><StatusBadge status={run.status} /></td>
              <td className="px-3 py-2 text-sm text-gray-700">{formatDate(run.started_at)}</td>
              <td className="px-3 py-2 text-sm text-gray-700">
                {run.duration_seconds != null ? `${run.duration_seconds.toFixed(1)}s` : '—'}
              </td>
              <td className="px-3 py-2 text-sm text-gray-700">
                {run.rows_read ?? '—'} / {run.rows_written ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PipelinesPageContent() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [domainFilter, setDomainFilter] = useState<string>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingTrigger, setPendingTrigger] = useState<PipelineRecord | null>(null);

  // ─── URL-synced filter state (CSA-0124(7)) ───────────────────────────
  // Hydrate from the URL on first ready render; push changes back via
  // router.replace so the current view is deep-linkable.
  useEffect(() => {
    if (!router.isReady) return;
    const q = router.query ?? {};
    const searchValue = readParam(q.search);
    const statusValue = readParam(q.status);
    const domainValue = readParam(q.domain);
    setSearch((prev) => (prev === searchValue ? prev : searchValue));
    setStatusFilter((prev) => (prev === statusValue ? prev : statusValue));
    setDomainFilter((prev) => (prev === domainValue ? prev : domainValue));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, router.query?.search, router.query?.status, router.query?.domain]);

  const pushQuery = useCallback(
    (next: { search?: string; status?: string; domain?: string }) => {
      if (!router.isReady) return;
      const query: Record<string, string> = {};
      if (next.search) query.search = next.search;
      if (next.status) query.status = next.status;
      if (next.domain) query.domain = next.domain;
      void router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
    },
    [router],
  );

  const onChangeSearch = (value: string) => {
    setSearch(value);
    pushQuery({ search: value, status: statusFilter, domain: domainFilter });
  };
  const onChangeStatus = (value: string) => {
    setStatusFilter(value);
    pushQuery({ search, status: value, domain: domainFilter });
  };
  const onChangeDomain = (value: string) => {
    setDomainFilter(value);
    pushQuery({ search, status: statusFilter, domain: value });
  };

  const debouncedSearch = useDebounce(search);

  const {
    data: pipelines,
    isLoading,
    error,
    refetch,
  } = usePipelines(statusFilter ? { status: statusFilter } : undefined);

  // Pull sources so we can resolve source_id -> domain/name for filtering & display.
  const { data: sources } = useSources();
  const sourceById = useMemo(() => {
    const map = new Map<string, SourceRecord>();
    (sources ?? []).forEach((s) => map.set(s.id, s));
    return map;
  }, [sources]);

  const availableDomains = useMemo(() => {
    const set = new Set<string>();
    (sources ?? []).forEach((s) => set.add(s.domain));
    return Array.from(set).sort();
  }, [sources]);

  const triggerMutation = useTriggerPipeline();
  const { toast, showToast, setOpen: setToastOpen } = useToast();

  const filtered = useMemo(() => {
    if (!pipelines) return [];
    const q = debouncedSearch.trim().toLowerCase();
    return pipelines.filter((p) => {
      const src = sourceById.get(p.source_id);
      if (domainFilter && src?.domain !== domainFilter) return false;
      if (q) {
        const haystack = `${p.name} ${p.pipeline_type} ${src?.name ?? ''}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [pipelines, debouncedSearch, domainFilter, sourceById]);

  // Column-sortable wrapper (CSA-0124(5)). Sort is applied AFTER filter so
  // users only re-order what they can see.
  const { setSort, sortedItems, ariaSortFor, sortKey, sortDir } = useColumnSort<
    PipelineRecord,
    PipelineSortKey
  >(filtered, {
    getValue: (row, key) => {
      if (key === 'source') return sourceById.get(row.source_id)?.name ?? '';
      if (key === 'last_run_at') return row.last_run_at ? new Date(row.last_run_at) : null;
      return (row as unknown as Record<string, string | undefined>)[key];
    },
  });
  const sortIndicator = (key: PipelineSortKey): string =>
    sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';

  const confirmTrigger = async () => {
    if (!pendingTrigger) return;
    try {
      await triggerMutation.mutateAsync(pendingTrigger.id);
      showToast(`Triggered run for "${pendingTrigger.name}".`, 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Failed to trigger pipeline run.',
        'error'
      );
    } finally {
      setPendingTrigger(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pipelines"
        description="Monitor and manage data pipelines"
      />

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => onChangeSearch(e.target.value)}
          placeholder="Search pipelines…"
          aria-label="Search pipelines"
          className="flex-1 min-w-[220px] px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-brand-500 focus:border-brand-500"
        />
        <select
          value={statusFilter}
          onChange={(e) => onChangeStatus(e.target.value)}
          aria-label="Filter by status"
          className="px-3 py-2 border border-gray-300 rounded-md text-sm"
        >
          <option value="">All statuses</option>
          <option value="running">Running</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="waiting">Waiting</option>
          <option value="created">Created</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select
          value={domainFilter}
          onChange={(e) => onChangeDomain(e.target.value)}
          aria-label="Filter by source domain"
          className="px-3 py-2 border border-gray-300 rounded-md text-sm"
        >
          <option value="">All domains</option>
          {availableDomains.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>

      {/* Error / loading / content */}
      {error ? (
        <ErrorBanner
          title="Failed to load pipelines"
          message={error instanceof Error ? error.message : 'An unexpected error occurred.'}
          onRetry={() => refetch()}
        />
      ) : isLoading ? (
        /* CSA-0124(10): shared table skeleton for consistent loading feel. */
        <TableSkeleton
          columns={['Name', 'Source', 'Type', 'Status', 'Last run', 'Schedule', 'Actions']}
          rows={5}
          ariaLabel="Loading pipelines"
        />
      ) : filtered.length === 0 ? (
        /* CSA-0124(2): friendly empty state with a CTA rather than a
           plain message. The CTA points at the source-registration flow
           when no pipelines exist at all, and stays out of the way when
           the user is just filtering an existing list. */
        pipelines && pipelines.length > 0 ? (
          <EmptyState
            title="No pipelines found"
            description="Try adjusting your search or filter criteria."
          />
        ) : (
          <EmptyState
            title="No pipelines yet"
            description="Register a data source to create your first pipeline."
            action={{ label: '+ Register Source', href: '/sources/register' }}
          />
        )
      ) : (
        <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {([
                  { key: 'name', label: 'Name' },
                  { key: 'source', label: 'Source' },
                  { key: 'pipeline_type', label: 'Type' },
                  { key: 'status', label: 'Status' },
                  { key: 'last_run_at', label: 'Last run' },
                  { key: 'schedule_cron', label: 'Schedule' },
                ] as ReadonlyArray<{ key: PipelineSortKey; label: string }>).map((col) => (
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
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {sortedItems.map((p) => {
                const src = sourceById.get(p.source_id);
                const expanded = expandedId === p.id;
                return (
                  <React.Fragment key={p.id}>
                    <tr className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setExpandedId(expanded ? null : p.id)}
                          aria-expanded={expanded}
                          aria-controls={`runs-${p.id}`}
                          className="text-sm font-medium text-brand-600 hover:text-brand-800"
                        >
                          {expanded ? '▼ ' : '▶ '}{p.name}
                        </button>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                        {src ? (
                          <a href={`/sources/${src.id}`} className="text-brand-600 hover:text-brand-800">
                            {src.name}
                          </a>
                        ) : (
                          <code className="text-xs text-gray-500">{p.source_id}</code>
                        )}
                        {src && <p className="text-xs text-gray-500 capitalize">{src.domain}</p>}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 capitalize">
                        {p.pipeline_type.replace(/_/g, ' ')}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <StatusBadge status={p.status} dot />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {formatDate(p.last_run_at)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {p.schedule_cron ? <code className="text-xs">{p.schedule_cron}</code> : '—'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={p.status === 'running' || triggerMutation.isPending}
                          loading={triggerMutation.isPending && triggerMutation.variables === p.id}
                          onClick={() => setPendingTrigger(p)}
                        >
                          Trigger run
                        </Button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr id={`runs-${p.id}`}>
                        <td colSpan={7} className="px-6 py-4 bg-gray-50">
                          <PipelineRunsPanel pipelineId={p.id} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={pendingTrigger !== null}
        onOpenChange={(o) => !o && setPendingTrigger(null)}
        title="Trigger pipeline run?"
        description={
          pendingTrigger
            ? `This will start a new run of "${pendingTrigger.name}". Continue?`
            : ''
        }
      >
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setPendingTrigger(null)}
            disabled={triggerMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={confirmTrigger}
            loading={triggerMutation.isPending}
          >
            Trigger run
          </Button>
        </div>
      </Modal>

      <Toast
        open={toast.open}
        onOpenChange={setToastOpen}
        message={toast.message}
        variant={toast.variant}
      />
    </div>
  );
}

/**
 * Route-scoped error boundary (CSA-0124(4)) so render-time exceptions in
 * the pipelines view fall back gracefully instead of tearing down the
 * shell.
 */
export default function PipelinesPage() {
  return (
    <RouteErrorBoundary routeLabel="Pipelines">
      <PipelinesPageContent />
    </RouteErrorBoundary>
  );
}
