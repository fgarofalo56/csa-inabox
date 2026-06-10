'use client';

/**
 * MonitorHubPane — the Fabric Monitor-hub "Activities" feed, Azure-native.
 *
 * Parity target: Fabric Monitor hub → Activities list (one row per pipeline /
 * job / refresh run, with status, start, duration, submitter, and per-column
 * sort + filter).
 *
 * Source: GET /api/monitor/activities — REAL Log Analytics run history
 * (ADFPipelineRun + optionally SynapseIntegrationPipelineRuns via isfuzzy
 * union). No sample/mock data anywhere in this component.
 *
 * Honest gate: when Log Analytics isn't configured the route returns a `gate`
 * and this pane renders a Fluent MessageBar naming LOOM_LOG_ANALYTICS_WORKSPACE_ID
 * — the filter bar + table chrome still render so the surface is never empty.
 *
 * The Fabric "Schedule failures" tab is intentionally NOT reproduced here: it
 * surfaces Power BI / Fabric scheduled-refresh failure notifications, a
 * Fabric-family feature with no Azure-native analog. The Azure-native
 * equivalent (scheduled pipeline-failure alerts) lives on the Alerts tab via
 * Azure Monitor scheduled-query rules. No dead tab is shipped.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Dropdown, Option, Caption1, Text,
  MessageBar, MessageBarBody, MessageBarTitle,
  Input, Skeleton, SkeletonItem,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowClockwise20Regular, Search20Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { SignInRequired } from '@/lib/components/sign-in-required';

interface ActivityRow {
  timeGenerated: string;
  name: string;
  runId?: string;
  itemType: string;
  status?: string;
  start?: string;
  end?: string;
  durationMs?: number;
  submitter?: string;
  errorCode?: string;
  errorMessage?: string;
  source: 'adf' | 'synapse' | 'arm';
}

interface Gate { missing: string[]; message: string }

interface ApiResponse {
  ok: boolean;
  gate?: Gate;
  error?: string;
  days?: number;
  synapseIncluded?: boolean;
  total?: number;
  rows?: ActivityRow[];
}

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalM, display: 'block' },
  caption: { color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalS, display: 'block' },
  filters: {
    display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center',
    flexWrap: 'wrap', marginBottom: tokens.spacingVerticalM,
  },
  search: { flex: 1, minWidth: '220px' },
  windowLabel: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  // KPI stat cards — same visual language as the other Monitor tabs.
  stats: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
    gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalL,
  },
  stat: {
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
  },
  statLabel: {
    fontSize: '11px', color: tokens.colorNeutralForeground3, fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.05em',
  },
  statValue: { fontSize: '26px', fontWeight: 700, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' },
  statAccentSuccess: { color: tokens.colorPaletteGreenForeground1 },
  statAccentBrand: { color: tokens.colorBrandForeground1 },
  statAccentDanger: { color: tokens.colorPaletteRedForeground1 },
  skel: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
    gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalL,
  },
  skelCard: { height: '84px', borderRadius: tokens.borderRadiusLarge },
});

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
  if (s === 'inprogress' || s === 'queued' || s === 'inqueue' || s === 'running') return <Badge appearance="filled" color="brand">{status}</Badge>;
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

export function MonitorHubPane() {
  const styles = useStyles();
  const [data, setData] = useState<ApiResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [days, setDays] = useState('30');
  const [q, setQ] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setData(null); setErr(null);
    const params = new URLSearchParams({ days });
    fetch(`/api/monitor/activities?${params.toString()}`)
      .then(async (r) => {
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setUnauth(true); setData({ ok: false }); return; }
        const j: ApiResponse = await r.json();
        if (!j.ok && !j.gate) setErr(j.error || 'Failed to load activities');
        setData(j);
      })
      .catch((e) => { if (alive) { setErr(String(e)); setData({ ok: false }); } });
    return () => { alive = false; };
  }, [days, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const rows = useMemo(() => data?.rows ?? [], [data]);

  // Client-side free-text search across Name + Submitter (the Fabric search box).
  const searched = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (r) => r.name.toLowerCase().includes(needle)
        || (r.submitter || '').toLowerCase().includes(needle),
    );
  }, [rows, q]);

  // KPI roll-up of the run window (over the full result set, not the search
  // filter) — same stat-card language as the other Monitor tabs.
  const kpis = useMemo(() => {
    const succeeded = rows.filter((r) => /succ/i.test(r.status ?? '')).length;
    const failed = rows.filter((r) => /fail/i.test(r.status ?? '')).length;
    const inProgress = rows.filter(
      (r) => /inprogress|queued|inqueue|running/i.test(r.status ?? ''),
    ).length;
    return [
      { label: 'Runs', value: rows.length, accent: undefined as string | undefined },
      { label: 'Succeeded', value: succeeded, accent: styles.statAccentSuccess },
      { label: 'In progress', value: inProgress, accent: inProgress > 0 ? styles.statAccentBrand : undefined },
      { label: 'Failed', value: failed, accent: failed > 0 ? styles.statAccentDanger : undefined },
    ];
  }, [rows, styles]);

  const columns: LoomColumn<ActivityRow & { __id: string }>[] = useMemo(() => [
    {
      key: 'name', label: 'Name', width: 280, filterable: true, filterType: 'text',
      getValue: (r) => r.name,
      render: (r) => (
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Text weight="semibold" truncate wrap={false}>{r.name}</Text>
          {r.errorMessage && (
            <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }} truncate wrap={false}>
              {r.errorCode ? `${r.errorCode}: ` : ''}{r.errorMessage}
            </Caption1>
          )}
        </div>
      ),
    },
    {
      key: 'itemType', label: 'Item type', width: 160, filterable: true, filterType: 'select',
      getValue: (r) => r.itemType,
      render: (r) => <Text size={200}>{r.itemType}</Text>,
    },
    {
      key: 'status', label: 'Status', width: 130, filterable: true, filterType: 'select',
      getValue: (r) => r.status || '',
      render: (r) => <span title={r.errorMessage || undefined}>{statusBadge(r.status)}</span>,
    },
    {
      key: 'start', label: 'Started', width: 180, filterType: 'date',
      getValue: (r) => (r.start ? new Date(r.start).getTime() : 0),
      render: (r) => <Text size={200}>{fmtTime(r.start)}</Text>,
    },
    {
      key: 'durationMs', label: 'Duration', width: 120, filterable: false,
      getValue: (r) => r.durationMs ?? 0,
      render: (r) => <Text size={200}>{fmtDuration(r.durationMs)}</Text>,
    },
    {
      key: 'submitter', label: 'Submitter', width: 200, filterable: true, filterType: 'text',
      getValue: (r) => r.submitter || '',
      render: (r) => <Text size={200}>{r.submitter || '—'}</Text>,
    },
  ], []);

  const tableRows = useMemo(
    () => searched.map((r, i) => ({ ...r, __id: `${r.source}:${r.runId ?? r.name}:${i}` })),
    [searched],
  );

  const gate = data?.gate ?? null;
  const loading = data === null;

  return (
    <div>
      {unauth && <SignInRequired subject="activity history" />}

      <Caption1 className={styles.intro}>
        Every pipeline and job run across the platform — name, status, start time, duration, and who
        submitted it. Run history reads live from Log Analytics (Azure Data Factory pipeline runs,
        and Synapse pipeline runs where deployed). Click a column to sort; use the per-column filters
        for status, item type, and date range.
      </Caption1>

      <div className={styles.filters}>
        <Input
          className={styles.search}
          contentBefore={<Search20Regular />}
          placeholder="Search by name or submitter"
          value={q}
          onChange={(_, d) => setQ(d.value)}
        />
        <Caption1 className={styles.windowLabel}>Window:</Caption1>
        <Dropdown
          aria-label="Time window"
          value={DAYS_OPTIONS.find((d) => d.value === days)?.label || days}
          selectedOptions={[days]}
          onOptionSelect={(_, d) => d.optionValue && setDays(d.optionValue)}
        >
          {DAYS_OPTIONS.map((d) => <Option key={d.value} value={d.value}>{d.label}</Option>)}
        </Dropdown>
        <Button appearance="primary" icon={<ArrowClockwise20Regular />} onClick={refresh}>Refresh</Button>
      </div>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Activity feed unavailable — Log Analytics not configured</MessageBarTitle>
            {gate.message} Missing: <strong>{gate.missing.join(', ')}</strong>. Set it on the Console
            container app (admin-plane bicep <code>apps[]</code> env list); the Monitoring Reader and
            Log Analytics Reader grants are already in place.
          </MessageBarBody>
        </MessageBar>
      )}

      {err && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Couldn&apos;t load activity history</MessageBarTitle>
            {err}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* KPI roll-up — skeleton while loading, suppressed behind the honest gate. */}
      {!gate && (
        loading ? (
          <Skeleton aria-label="Loading run summary" className={styles.skel}>
            {[0, 1, 2, 3].map((i) => <SkeletonItem key={i} className={styles.skelCard} />)}
          </Skeleton>
        ) : (
          <div className={styles.stats}>
            {kpis.map((s) => (
              <div key={s.label} className={styles.stat}>
                <span className={styles.statLabel}>{s.label}</span>
                <span className={`${styles.statValue} ${s.accent ?? ''}`}>{s.value}</span>
              </div>
            ))}
          </div>
        )
      )}

      <Section title="Activities">
        <LoomDataTable
          columns={columns}
          rows={tableRows}
          getRowId={(r) => r.__id}
          loading={loading}
          empty={gate
            ? 'Configure Log Analytics to read pipeline and job run history.'
            : 'No pipeline or job runs in this window.'}
          ariaLabel="Activity feed"
        />
        {!loading && !gate && (
          <Caption1 className={styles.caption}>
            {tableRows.length} of {rows.length} run{rows.length === 1 ? '' : 's'} · run history from
            Log Analytics{data?.synapseIncluded ? ' (ADF + Synapse)' : ' (ADF)'} · last{' '}
            {days === '1' ? '24 hours' : `${days} days`}
          </Caption1>
        )}
      </Section>
    </div>
  );
}
