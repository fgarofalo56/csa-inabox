/**
 * Source detail page — /sources/[id]
 *
 * Shows all metadata for a registered source: ingestion config, schema,
 * quality rules, associated pipelines, and lifecycle action buttons
 * (provision / scan / decommission) gated by current status.
 */

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  useSource,
  usePipelines,
  useProvisionSource,
  useScanSource,
  useDecommissionSource,
} from '@/hooks/useApi';
import { useToast } from '@/hooks/useToast';
import ErrorBanner from '@/components/ErrorBanner';
import PageHeader from '@/components/PageHeader';
import { StatusBadge } from '@/components/StatusBadge';
import Button from '@/components/Button';
import { Modal } from '@/components/Modal';
import { Toast } from '@/components/Toast';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import type { PipelineRecord, ColumnDefinition, DataQualityRule } from '@/types';

type ActionKind = 'provision' | 'scan' | 'decommission' | null;

function SkeletonBlock({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-gray-200 ${className}`} />;
}

function Section({
  title,
  children,
  actions,
}: {
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">
          {title}
        </h2>
        {actions}
      </div>
      <div className="px-6 py-4">{children}</div>
    </section>
  );
}

function KeyValue({ label, value }: { label: string; value?: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-1 text-sm text-gray-900 break-words">
        {value ?? <span className="text-gray-400">—</span>}
      </dd>
    </div>
  );
}

export default function SourceDetailPage() {
  const router = useRouter();
  const rawId = router.query.id;
  const id = typeof rawId === 'string' ? rawId : '';

  const {
    data: source,
    isLoading: sourceLoading,
    error: sourceError,
    refetch: refetchSource,
  } = useSource(id);

  const {
    data: pipelines,
    isLoading: pipelinesLoading,
    error: pipelinesError,
  } = usePipelines(id ? { source_id: id } : undefined);

  const provision = useProvisionSource();
  const scan = useScanSource();
  const decommission = useDecommissionSource();

  const { toast, showToast, setOpen: setToastOpen } = useToast();
  const [pendingAction, setPendingAction] = useState<ActionKind>(null);

  // ─── Loading skeleton ──────────────────────────────────────────────────
  if (router.isReady && !id) {
    return (
      <div className="space-y-6">
        <ErrorBanner
          title="Source not found"
          message="No source id was provided in the URL."
        />
        <Link href="/sources" className="text-sm text-brand-600 hover:text-brand-800">
          &larr; Back to sources
        </Link>
      </div>
    );
  }

  if (sourceLoading || !router.isReady) {
    return (
      <div className="space-y-6" data-testid="source-detail-loading">
        <SkeletonBlock className="h-10 w-1/3" />
        <SkeletonBlock className="h-24 w-full" />
        <SkeletonBlock className="h-48 w-full" />
        <SkeletonBlock className="h-48 w-full" />
      </div>
    );
  }

  if (sourceError) {
    const status = (sourceError as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      return (
        <div className="space-y-6">
          <ErrorBanner
            title="Source not found"
            message={`No source exists with id "${id}".`}
          />
          <Link href="/sources" className="text-sm text-brand-600 hover:text-brand-800">
            &larr; Back to sources
          </Link>
        </div>
      );
    }
    return (
      <div className="space-y-6">
        <ErrorBanner
          title="Failed to load source"
          message={sourceError instanceof Error ? sourceError.message : 'An unexpected error occurred.'}
          onRetry={() => refetchSource()}
        />
        <Link href="/sources" className="text-sm text-brand-600 hover:text-brand-800">
          &larr; Back to sources
        </Link>
      </div>
    );
  }

  if (!source) return null;

  // ─── Derived state ─────────────────────────────────────────────────────
  const canProvision =
    source.status === 'draft' ||
    source.status === 'approved' ||
    source.status === 'error';
  const canScan = source.status === 'active';
  const canDecommission =
    source.status === 'active' ||
    source.status === 'paused' ||
    source.status === 'error';

  // ─── Action handlers ───────────────────────────────────────────────────
  const confirmLabels: Record<Exclude<ActionKind, null>, { title: string; body: string; cta: string }> = {
    provision: {
      title: 'Provision source?',
      body: 'This will trigger Azure Data Factory pipeline provisioning. Are you sure?',
      cta: 'Provision',
    },
    scan: {
      title: 'Scan source?',
      body: 'This will trigger a Microsoft Purview scan to refresh the data catalog.',
      cta: 'Scan',
    },
    decommission: {
      title: 'Decommission source?',
      body: 'This stops all pipelines and marks the source as decommissioned. This action cannot be undone easily.',
      cta: 'Decommission',
    },
  };

  const runAction = async () => {
    if (!pendingAction || !source) return;
    try {
      if (pendingAction === 'provision') {
        await provision.mutateAsync(source.id);
        showToast('Source provisioning started.', 'success');
      } else if (pendingAction === 'scan') {
        await scan.mutateAsync(source.id);
        showToast('Purview scan triggered.', 'success');
      } else if (pendingAction === 'decommission') {
        await decommission.mutateAsync(source.id);
        showToast('Source decommissioned.', 'success');
      }
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Action failed. Please try again.',
        'error'
      );
    } finally {
      setPendingAction(null);
    }
  };

  const mutationInFlight =
    provision.isPending || scan.isPending || decommission.isPending;

  // ─── Render ────────────────────────────────────────────────────────────
  const columns: ColumnDefinition[] = source.schema_definition?.columns ?? [];
  const rules: DataQualityRule[] = source.quality_rules ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={
          /* CSA-0124(9): real breadcrumb trail replaces the single
             back-link. Builds Home → Sources → <source name> so the user
             can jump to either parent in one click. */
          <Breadcrumbs
            items={[
              { label: 'Home', href: '/' },
              { label: 'Sources', href: '/sources' },
              { label: source.name },
            ]}
          />
        }
        title={source.name}
        description={source.description}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={source.status} dot />
            <span className="text-xs text-gray-500 capitalize bg-gray-100 px-2 py-1 rounded">
              {source.domain}
            </span>
            <span className="text-xs text-gray-500 uppercase bg-blue-50 px-2 py-1 rounded text-blue-700">
              {source.classification}
            </span>
          </div>
        }
      />

      {/* Action bar */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={!canProvision || mutationInFlight}
          loading={provision.isPending}
          onClick={() => setPendingAction('provision')}
        >
          Provision
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!canScan || mutationInFlight}
          loading={scan.isPending}
          onClick={() => setPendingAction('scan')}
        >
          Trigger Purview scan
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={!canDecommission || mutationInFlight}
          loading={decommission.isPending}
          onClick={() => setPendingAction('decommission')}
        >
          Decommission
        </Button>
      </div>

      {/* Overview & Owner */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Overview">
          <dl className="grid grid-cols-2 gap-4">
            <KeyValue label="Source type" value={<span className="capitalize">{source.source_type.replace(/_/g, ' ')}</span>} />
            <KeyValue label="Source id" value={<code className="text-xs">{source.id}</code>} />
            <KeyValue label="Created" value={new Date(source.created_at).toLocaleString()} />
            <KeyValue label="Updated" value={new Date(source.updated_at).toLocaleString()} />
            {source.provisioned_at && (
              <KeyValue label="Provisioned" value={new Date(source.provisioned_at).toLocaleString()} />
            )}
            {source.purview_scan_id && (
              <KeyValue label="Last Purview scan" value={<code className="text-xs">{source.purview_scan_id}</code>} />
            )}
          </dl>
        </Section>

        <Section title="Owner">
          <dl className="grid grid-cols-2 gap-4">
            <KeyValue label="Name" value={source.owner.name} />
            <KeyValue label="Email" value={<a href={`mailto:${source.owner.email}`} className="text-brand-600 hover:text-brand-800">{source.owner.email}</a>} />
            <KeyValue label="Team" value={source.owner.team} />
            {source.owner.cost_center && (
              <KeyValue label="Cost center" value={source.owner.cost_center} />
            )}
          </dl>
        </Section>
      </div>

      {/* Ingestion config */}
      <Section title="Ingestion">
        <dl className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <KeyValue label="Mode" value={<span className="capitalize">{source.ingestion.mode}</span>} />
          <KeyValue label="Schedule" value={source.ingestion.schedule_cron ? <code className="text-xs">{source.ingestion.schedule_cron}</code> : undefined} />
          <KeyValue label="Batch size" value={source.ingestion.batch_size} />
          <KeyValue label="Parallelism" value={source.ingestion.parallelism} />
          <KeyValue label="Max retries" value={source.ingestion.max_retry_count} />
          <KeyValue label="Timeout (min)" value={source.ingestion.timeout_minutes} />
          <KeyValue label="Target format" value={<span className="uppercase">{source.target.format}</span>} />
          <KeyValue label="Target path" value={<code className="text-xs">{source.target.container}/{source.target.path_pattern}</code>} />
        </dl>
      </Section>

      {/* Schema */}
      <Section
        title="Schema"
        actions={
          source.schema_definition?.table_name ? (
            <span className="text-xs text-gray-500">
              Table: <code>{source.schema_definition.table_name}</code>
            </span>
          ) : null
        }
      >
        {columns.length === 0 ? (
          <p className="text-sm text-gray-500">
            {source.schema_definition?.auto_detect
              ? 'Schema will be auto-detected on first scan.'
              : 'No columns defined.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead>
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Column</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Type</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Nullable</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">PII</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {columns.map((col) => (
                  <tr key={col.name}>
                    <td className="px-3 py-2 text-sm font-medium text-gray-900">{col.name}</td>
                    <td className="px-3 py-2 text-sm text-gray-700">{col.data_type}</td>
                    <td className="px-3 py-2 text-sm text-gray-700">{col.nullable ? 'yes' : 'no'}</td>
                    <td className="px-3 py-2 text-sm text-gray-700">{col.is_pii ? 'yes' : 'no'}</td>
                    <td className="px-3 py-2 text-sm text-gray-500">{col.description ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {source.schema_definition?.primary_key && source.schema_definition.primary_key.length > 0 && (
          <p className="mt-4 text-xs text-gray-500">
            Primary key: <code>{source.schema_definition.primary_key.join(', ')}</code>
          </p>
        )}
      </Section>

      {/* Quality rules */}
      <Section title="Data quality rules">
        {rules.length === 0 ? (
          <p className="text-sm text-gray-500">No quality rules defined.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {rules.map((rule, idx) => (
              <li key={`${rule.rule_name}-${idx}`} className="flex items-start justify-between py-3">
                <div>
                  <p className="text-sm font-medium text-gray-900">{rule.rule_name}</p>
                  <p className="text-xs text-gray-500">
                    {rule.rule_type}
                    {rule.column ? ` on ${rule.column}` : ''}
                  </p>
                </div>
                <StatusBadge status={rule.severity || 'info'} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Associated pipelines */}
      <Section
        title="Pipelines"
        actions={
          <Link href="/pipelines" className="text-sm text-brand-600 hover:text-brand-800">
            View all pipelines &rarr;
          </Link>
        }
      >
        {pipelinesLoading ? (
          <SkeletonBlock className="h-16 w-full" />
        ) : pipelinesError ? (
          <p className="text-sm text-red-600">Failed to load pipelines.</p>
        ) : !pipelines || pipelines.length === 0 ? (
          <p className="text-sm text-gray-500">
            No pipelines are associated with this source yet.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {pipelines.map((p: PipelineRecord) => (
              <li key={p.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm font-medium text-gray-900">{p.name}</p>
                  <p className="text-xs text-gray-500 capitalize">
                    {p.pipeline_type.replace(/_/g, ' ')}
                    {p.last_run_at ? ` · last run ${new Date(p.last_run_at).toLocaleString()}` : ''}
                  </p>
                </div>
                <StatusBadge status={p.status} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Confirmation modal */}
      <Modal
        open={pendingAction !== null}
        onOpenChange={(o) => !o && setPendingAction(null)}
        title={pendingAction ? confirmLabels[pendingAction].title : ''}
        description={pendingAction ? confirmLabels[pendingAction].body : ''}
      >
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setPendingAction(null)}
            disabled={mutationInFlight}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={pendingAction === 'decommission' ? 'danger' : 'primary'}
            onClick={runAction}
            loading={mutationInFlight}
          >
            {pendingAction ? confirmLabels[pendingAction].cta : 'Confirm'}
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
