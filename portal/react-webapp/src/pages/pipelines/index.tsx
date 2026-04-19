/**
 * Pipelines page — Monitor and manage data pipelines.
 *
 * Lists every pipeline, supports filtering by status / source domain /
 * free-text search, expands a row inline to show recent run history,
 * and supports triggering a pipeline run with a confirmation dialog.
 */

import React, { useMemo, useState } from 'react';
import {
  usePipelines,
  usePipelineRuns,
  useTriggerPipeline,
  useSources,
} from '@/hooks/useApi';
import { useDebounce } from '@/hooks/useDebounce';
import { useToast } from '@/hooks/useToast';
import ErrorBanner from '@/components/ErrorBanner';
import PageHeader from '@/components/PageHeader';
import { StatusBadge } from '@/components/StatusBadge';
import Button from '@/components/Button';
import { Modal } from '@/components/Modal';
import { Toast } from '@/components/Toast';
import type { PipelineRecord, PipelineRun, SourceRecord } from '@/types';

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

export default function PipelinesPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [domainFilter, setDomainFilter] = useState<string>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingTrigger, setPendingTrigger] = useState<PipelineRecord | null>(null);

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
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search pipelines…"
          aria-label="Search pipelines"
          className="flex-1 min-w-[220px] px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-brand-500 focus:border-brand-500"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
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
          onChange={(e) => setDomainFilter(e.target.value)}
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
        <div className="flex items-center justify-center h-64">
          <div role="status" aria-label="Loading">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 bg-gray-50 rounded-lg">
          <p className="text-gray-500">No pipelines found.</p>
          <p className="text-sm text-gray-400 mt-1">
            {pipelines && pipelines.length > 0
              ? 'Try adjusting your search or filter criteria.'
              : 'Register a data source to create your first pipeline.'}
          </p>
        </div>
      ) : (
        <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Source</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last run</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Schedule</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filtered.map((p) => {
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
