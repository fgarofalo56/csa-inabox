'use client';

/**
 * RefreshSummaryPane (F20) — scheduled-refresh overview.
 *
 * Parity target: Fabric Monitor hub → "Refresh history" + per-item Refresh
 * schedule. One row per pipeline/dataflow showing last run, status, duration,
 * and the next scheduled run.
 *
 * Source: GET /api/admin/refresh-summary — REAL Log Analytics run history
 * (ADFPipelineRun / SynapseIntegrationPipelineRuns) joined with REAL ADF
 * trigger schedules. No sample/mock data anywhere in this component.
 *
 * Honest gate: when Log Analytics isn't configured the route returns a `gate`
 * and this pane renders a Fluent MessageBar naming LOOM_LOG_ANALYTICS_WORKSPACE_ID
 * — the filter bar + table chrome still render so the surface is never empty.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Dropdown, Option, Caption1, Text,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogContent, DialogBody, DialogActions, DialogTrigger,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync20Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { SignInRequired } from '@/lib/components/sign-in-required';

interface RefreshRow {
  pipelineName: string;
  displayName: string;
  workspaceId?: string;
  workspaceName?: string;
  itemType: string;
  source: 'adf' | 'synapse';
  lastRunId?: string;
  lastRunAt?: string;
  lastRunEnd?: string;
  lastRunStatus?: string;
  lastRunDurationMs?: number;
  lastRunError?: string;
  nextRunAt?: string;
  triggerName?: string;
  triggerType?: string;
  triggerState?: string;
  recurrenceDesc?: string;
}

interface Gate { missing: string[]; message: string }

interface ApiResponse {
  ok: boolean;
  gate?: Gate;
  error?: string;
  adfConfigured?: boolean;
  synapseConfigured?: boolean;
  days?: number;
  total?: number;
  workspaces?: string[];
  rows?: RefreshRow[];
}

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalM },
  caption: { color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalS, display: 'block' },
  filters: {
    display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center',
    flexWrap: 'wrap', marginBottom: tokens.spacingVerticalM,
  },
});

const STATUS_OPTIONS = ['(All)', 'Succeeded', 'Failed', 'InProgress', 'Queued', 'Cancelled'];
const DAYS_OPTIONS: { value: string; label: string }[] = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
];

function statusBadge(status?: string) {
  const s = (status || '').toLowerCase();
  if (s === 'succeeded' || s === 'success') return <Badge appearance="filled" color="success">{status}</Badge>;
  if (s === 'failed' || s === 'failure') return <Badge appearance="filled" color="danger">{status}</Badge>;
  if (s === 'inprogress' || s === 'queued' || s === 'inqueue') return <Badge appearance="filled" color="brand">{status}</Badge>;
  if (s === 'cancelled' || s === 'canceled') return <Badge appearance="outline" color="subtle">{status}</Badge>;
  return status ? <Badge appearance="outline" color="informative">{status}</Badge> : <Text size={200}>—</Text>;
}

function fmtDuration(ms?: number): string {
  if (!ms || ms <= 0) return '—';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function RefreshSummaryPane() {
  const styles = useStyles();
  const [data, setData] = useState<ApiResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [days, setDays] = useState('7');
  const [status, setStatus] = useState('(All)');
  const [workspace, setWorkspace] = useState('(All)');
  const [tick, setTick] = useState(0);
  // Row → status-detail dialog (the "clickable rows" parity with Fabric's
  // refresh-history drill-in). Uses the data already fetched — no new backend.
  const [detail, setDetail] = useState<RefreshRow | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null); setErr(null);
    const params = new URLSearchParams({ days });
    if (status !== '(All)') params.set('status', status);
    if (workspace !== '(All)') params.set('workspace', workspace);
    fetch(`/api/admin/refresh-summary?${params.toString()}`)
      .then(async (r) => {
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setUnauth(true); setData({ ok: false }); return; }
        const j: ApiResponse = await r.json();
        if (!j.ok && !j.gate) { setErr(j.error || 'Failed to load refresh summary'); }
        setData(j);
      })
      .catch((e) => { if (alive) { setErr(String(e)); setData({ ok: false }); } });
    return () => { alive = false; };
  }, [days, status, workspace, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  // Workspace dropdown options derive from whatever the server returned for the
  // current (server-filtered) result, plus any active selection so it's visible.
  const workspaceOptions = useMemo(() => {
    const set = new Set<string>(data?.workspaces ?? []);
    if (workspace !== '(All)') set.add(workspace);
    return ['(All)', ...Array.from(set).sort()];
  }, [data, workspace]);

  const columns: LoomColumn<RefreshRow & { __id: string }>[] = useMemo(() => [
    {
      key: 'displayName', label: 'Item', width: 240, filterable: true, filterType: 'text',
      getValue: (r) => r.displayName,
      render: (r) => (
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Text weight="semibold" truncate wrap={false}>{r.displayName}</Text>
          {r.workspaceName && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{r.workspaceName}</Caption1>
          )}
        </div>
      ),
    },
    {
      key: 'itemType', label: 'Type', width: 150, filterable: true, filterType: 'select',
      getValue: (r) => r.itemType,
      render: (r) => <Text size={200}>{r.itemType}</Text>,
    },
    {
      key: 'lastRunAt', label: 'Last run', width: 170, filterType: 'date',
      getValue: (r) => (r.lastRunAt ? new Date(r.lastRunAt).getTime() : 0),
      render: (r) => <Text size={200}>{fmtTime(r.lastRunAt)}</Text>,
    },
    {
      key: 'lastRunStatus', label: 'Status', width: 130, filterable: true, filterType: 'select',
      getValue: (r) => r.lastRunStatus || '',
      render: (r) => (
        <span title={r.lastRunError || undefined}>{statusBadge(r.lastRunStatus)}</span>
      ),
    },
    {
      key: 'lastRunDurationMs', label: 'Duration', width: 110, filterable: false,
      getValue: (r) => r.lastRunDurationMs ?? 0,
      render: (r) => <Text size={200}>{fmtDuration(r.lastRunDurationMs)}</Text>,
    },
    {
      key: 'nextRunAt', label: 'Next run', width: 200, filterType: 'date',
      getValue: (r) => (r.nextRunAt ? new Date(r.nextRunAt).getTime() : 0),
      render: (r) => (
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Text size={200}>{fmtTime(r.nextRunAt)}</Text>
          {r.recurrenceDesc && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{r.recurrenceDesc}</Caption1>
          )}
        </div>
      ),
    },
  ], []);

  const tableRows = useMemo(
    () => rows.map((r, i) => ({ ...r, __id: `${r.source}:${r.pipelineName}:${i}` })),
    [rows],
  );

  const gate = data?.gate ?? null;
  const loading = data === null;

  return (
    <div>
      {unauth && <SignInRequired subject="refresh history" />}

      <Caption1 className={styles.intro}>
        Scheduled-refresh overview for every pipeline and dataflow — last run, outcome, and the next
        scheduled run. Run history reads live from Log Analytics; next-run reflects the item&apos;s real
        Azure Data Factory trigger schedule.
      </Caption1>

      <div className={styles.filters}>
        <Caption1>Window:</Caption1>
        <Dropdown
          aria-label="Time window"
          value={DAYS_OPTIONS.find((d) => d.value === days)?.label || days}
          selectedOptions={[days]}
          onOptionSelect={(_, d) => d.optionValue && setDays(d.optionValue)}
        >
          {DAYS_OPTIONS.map((d) => <Option key={d.value} value={d.value}>{d.label}</Option>)}
        </Dropdown>

        <Caption1>Status:</Caption1>
        <Dropdown
          aria-label="Status filter"
          value={status}
          selectedOptions={[status]}
          onOptionSelect={(_, d) => setStatus(d.optionValue ?? status)}
        >
          {STATUS_OPTIONS.map((x) => <Option key={x} value={x}>{x}</Option>)}
        </Dropdown>

        <Caption1>Workspace:</Caption1>
        <Dropdown
          aria-label="Workspace filter"
          value={workspace}
          selectedOptions={[workspace]}
          onOptionSelect={(_, d) => setWorkspace(d.optionValue ?? workspace)}
        >
          {workspaceOptions.map((x) => <Option key={x} value={x}>{x}</Option>)}
        </Dropdown>

        <Button appearance="primary" icon={<ArrowSync20Regular />} onClick={refresh}>Refresh</Button>
      </div>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Refresh history unavailable — Log Analytics not configured</MessageBarTitle>
            {gate.message} Missing: <strong>{gate.missing.join(', ')}</strong>. Set it on the Console
            container app (admin-plane bicep <code>apps[]</code> env list); the Monitoring Reader and
            Log Analytics Reader grants are already in place.
          </MessageBarBody>
        </MessageBar>
      )}

      {err && (
        <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>
      )}

      {!gate && data?.adfConfigured === false && (
        <MessageBar intent="info">
          <MessageBarBody>
            Run history is shown below, but next-run is unavailable — Azure Data Factory isn&apos;t
            configured. Set <code>LOOM_SUBSCRIPTION_ID</code>, <code>LOOM_DLZ_RG</code> and{' '}
            <code>LOOM_ADF_NAME</code> to surface scheduled-trigger next-run times.
          </MessageBarBody>
        </MessageBar>
      )}

      <Section title="Refresh summary">
        <LoomDataTable
          columns={columns}
          rows={tableRows}
          getRowId={(r) => r.__id}
          loading={loading}
          onRowClick={(r) => setDetail(r)}
          empty={gate
            ? 'Configure Log Analytics to read pipeline and dataflow run history.'
            : 'No pipeline or dataflow runs in this window.'}
          ariaLabel="Scheduled refresh summary"
        />
        {!loading && !gate && (
          <Caption1 className={styles.caption}>
            {tableRows.length} item{tableRows.length === 1 ? '' : 's'} · run history from Log Analytics
            {data?.synapseConfigured ? ' (ADF + Synapse)' : ' (ADF)'} · last {days === '1' ? '24 hours' : `${days} days`}
          </Caption1>
        )}
      </Section>

      {/* Status detail — click a row to drill into its last run + schedule. */}
      <Dialog open={detail != null} onOpenChange={(_, d) => { if (!d.open) setDetail(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{detail?.displayName || detail?.pipelineName || 'Run detail'}</DialogTitle>
            <DialogContent>
              {detail && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0, maxHeight: '60vh', overflow: 'auto' }}>
                  <div><Caption1>Item type</Caption1><div><Text>{detail.itemType}</Text></div></div>
                  {detail.workspaceName && (
                    <div><Caption1>Workspace</Caption1><div><Text>{detail.workspaceName}</Text></div></div>
                  )}
                  <div><Caption1>Last run status</Caption1><div>{statusBadge(detail.lastRunStatus)}</div></div>
                  <div><Caption1>Last run</Caption1><div><Text>{fmtTime(detail.lastRunAt)}</Text></div></div>
                  <div><Caption1>Duration</Caption1><div><Text>{fmtDuration(detail.lastRunDurationMs)}</Text></div></div>
                  {detail.lastRunError && (
                    <MessageBar intent="error">
                      <MessageBarBody style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{detail.lastRunError}</MessageBarBody>
                    </MessageBar>
                  )}
                  <div><Caption1>Next scheduled run</Caption1><div><Text>{fmtTime(detail.nextRunAt)}</Text></div></div>
                  {detail.recurrenceDesc && (
                    <div><Caption1>Recurrence</Caption1><div><Text>{detail.recurrenceDesc}</Text></div></div>
                  )}
                  {detail.triggerName && (
                    <div>
                      <Caption1>Trigger</Caption1>
                      <div><Text>{detail.triggerName}{detail.triggerType ? ` (${detail.triggerType})` : ''}{detail.triggerState ? ` · ${detail.triggerState}` : ''}</Text></div>
                    </div>
                  )}
                  {detail.lastRunId && (
                    <div><Caption1>Run id</Caption1><div style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}><Text>{detail.lastRunId}</Text></div></div>
                  )}
                </div>
              )}
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Close</Button>
              </DialogTrigger>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
