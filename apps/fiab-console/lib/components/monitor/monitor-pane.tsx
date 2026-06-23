'use client';

/**
 * MonitorPane — the CSA Loom observability surface. "Azure Monitor, but for
 * everything configured in Loom." Six tabs, every one backed by a real
 * Azure REST call via the /api/monitor/* BFF routes:
 *
 *   Overview   — resource inventory + health roll-up (KPI cards + health donut)
 *   Metrics    — Azure Monitor metric time-series per resource (SVG charts)
 *   Logs       — Log Analytics KQL (presets + ad-hoc) → result grid
 *   Activity   — ARM Activity Log (deployments / role changes / scale ops)
 *   Items      — Cosmos-backed item activity feed (who deployed/edited what)
 *   Alerts     — Azure Monitor metric-alert rules
 *
 * PERF: only the active tab mounts (so its fetch only fires when shown), and
 * each tab's panels fetch in parallel. The Overview tab renders its resource
 * grid the instant the (fast) inventory call returns and fetches Resource
 * Health separately, in parallel — the slow whole-subscription health crawl no
 * longer blocks first paint. Heavy panels (the run-health charts) render only
 * after their data resolves, behind skeletons, so the grid is interactive
 * immediately.
 *
 * Honest gates: when LOOM_LOG_ANALYTICS_WORKSPACE_ID (logs) or the
 * subscription/RGs (inventory/metrics/activity/alerts) aren't configured,
 * the relevant tab shows a Fluent MessageBar naming the exact env var — the
 * full UI still renders.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tab, TabList, Spinner, Badge, Button, Dropdown, Option, Textarea,
  MessageBar, MessageBarBody, MessageBarTitle, Skeleton, SkeletonItem,
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody, Caption1, Subtitle2, Body1,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Tooltip,
  makeStyles, tokens, Text,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Play20Regular, ShieldTask20Regular, Copy20Regular,
  Open16Regular, Dismiss24Regular, Add20Regular, Edit20Regular, Delete20Regular,
  Pause20Regular,
} from '@fluentui/react-icons';
import { MonitorAlertEditor, type ScheduledQueryRuleLite } from '@/lib/monitor/monitor-alert-editor';
import { MonitorConditionsBuilder, freqLabel } from '@/lib/monitor/monitor-conditions-builder';
import { portalLink as defenderPortalLink, portalSteps, powershellScript, canAutoRemediate } from '@/lib/azure/defender-remediation';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { ActivityFeedPane } from '@/lib/components/activity-feed-pane';
import { MonitorHubPane } from '@/lib/panes/monitor-hub';
import { RefreshSummaryPane } from '@/lib/panes/refresh-summary';
import { MetricChart } from '@/lib/components/monitor/metric-chart';
import { KqlChart, type KqlChartType } from '@/lib/components/monitor/kql-chart';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { CopilotUsageInline } from '@/lib/components/admin/copilot-usage';

/**
 * Longer client ceiling for user-triggered Monitor queries / mutations — KQL log
 * & metric queries, ARM diagnostics/alert CRUD and Defender remediation — that
 * can legitimately run past the 6s page-load budget `clientFetch` defaults to.
 * Initial-load reads (inventory, health, cost, activity) keep the fast 6s fail
 * so the page never spins forever; only these explicit actions get the longer,
 * still-bounded budget so a real query isn't aborted at 6s.
 */
const MONITOR_ACTION_TIMEOUT_MS = 60_000;
const actionFetch = (input: string, init?: RequestInit) =>
  clientFetch(input, init, MONITOR_ACTION_TIMEOUT_MS);


// ---- types mirrored from monitor-client ------------------------------------

interface LoomResource {
  id: string; name: string; type: string; location: string; resourceGroup: string; sku?: string;
}
interface HealthEntry { availabilityState: string; summary?: string }
interface MetricResult { name: string; unit: string; aggregation: string; points: { timeStamp: string; value: number | null }[] }
interface ActivityEvent {
  eventTimestamp: string; operationName?: string; status?: string; level?: string;
  resourceGroup?: string; resourceType?: string; caller?: string;
}
interface AlertRule { id: string; name: string; enabled: boolean; severity?: number; description?: string; resourceGroup?: string }
interface ScheduledQueryRule {
  id: string; name: string; enabled: boolean; severity?: number; description?: string;
  query?: string; operator?: string; threshold?: number;
  evaluationFrequency?: string; windowSize?: string; actionGroupIds?: string[]; resourceGroup?: string;
}
interface LogResult { columns: string[]; rows: unknown[][]; rowCount: number }
interface Gate { missing: string[]; message: string }

// ---- styles ----------------------------------------------------------------

const useStyles = makeStyles({
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap', marginBottom: tokens.spacingVerticalL },
  code: {
    width: '100%', maxHeight: '320px', overflow: 'auto', whiteSpace: 'pre',
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
  },
  // KPI stat cards
  stats: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  stat: {
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
  },
  statLabel: { fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' },
  statValue: { fontSize: tokens.fontSizeBase700, fontWeight: 700, lineHeight: 1.1 },
  statAccentSuccess: { color: tokens.colorPaletteGreenForeground1 },
  statAccentWarn: { color: tokens.colorPaletteYellowForeground1 },
  statAccentDanger: { color: tokens.colorPaletteRedForeground1 },
  charts: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: tokens.spacingHorizontalL },
  // health roll-up: a horizontal stacked bar + legend
  healthRow: { display: 'flex', gap: tokens.spacingHorizontalXXL, alignItems: 'center', flexWrap: 'wrap' },
  healthBarWrap: { flex: '1 1 320px', minWidth: '240px', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  healthBar: { display: 'flex', height: '16px', borderRadius: tokens.borderRadiusLarge, overflow: 'hidden', backgroundColor: tokens.colorNeutralBackground3 },
  healthLegend: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
  legendItem: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  swatch: { width: '10px', height: '10px', borderRadius: tokens.borderRadiusSmall, display: 'inline-block' },
  // breakdown bars (resources by type)
  breakdown: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  breakdownRow: { display: 'grid', gridTemplateColumns: '200px 1fr 40px', gap: tokens.spacingHorizontalM, alignItems: 'center', fontSize: tokens.fontSizeBase200 },
  breakdownLabel: { color: tokens.colorNeutralForeground2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  breakdownTrack: { height: '10px', borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3, overflow: 'hidden' },
  breakdownFill: { height: '100%', borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorBrandBackground },
  breakdownCount: { textAlign: 'right', color: tokens.colorNeutralForeground3, fontVariantNumeric: 'tabular-nums' },
  resPicker: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap', marginBottom: tokens.spacingVerticalL },
  kqlBox: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalL },
  gap: { marginBottom: tokens.spacingVerticalM },
  skelGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: tokens.spacingHorizontalL },
  skelCard: { height: '92px', borderRadius: tokens.borderRadiusLarge },
  rowActions: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center' },
});

function healthBadge(state: string) {
  const s = (state || 'Unknown').toLowerCase();
  if (s === 'available') return <Badge color="success" appearance="filled">Available</Badge>;
  if (s === 'unavailable') return <Badge color="danger" appearance="filled">Unavailable</Badge>;
  if (s === 'degraded') return <Badge color="warning" appearance="filled">Degraded</Badge>;
  return <Badge color="subtle" appearance="outline">{state || 'Unknown'}</Badge>;
}

function GateBar({ gate, subject }: { gate: Gate; subject: string }) {
  return (
    <MessageBar intent="warning" className="loom-monitor-gate">
      <MessageBarBody>
        <MessageBarTitle>{subject} not configured</MessageBarTitle>
        This deployment hasn&apos;t set <strong>{gate.missing.join(', ')}</strong>. Set it on the
        Console container app (admin-plane bicep <code>apps[]</code> env list) to light up {subject.toLowerCase()}.
        The rest of Monitor still works.
      </MessageBarBody>
    </MessageBar>
  );
}

function StatCardSkeleton() {
  const styles = useStyles();
  return (
    <Skeleton aria-label="Loading metrics">
      <div className={styles.skelGrid}>
        {[0, 1, 2, 3].map((i) => <SkeletonItem key={i} className={styles.skelCard} />)}
      </div>
    </Skeleton>
  );
}

type TabKey = 'overview' | 'activities' | 'metrics' | 'logs' | 'diagnostics' | 'activity' | 'items' | 'refresh' | 'alerts' | 'cost' | 'security' | 'maintenance';

const TAB_KEYS: TabKey[] = ['overview', 'activities', 'metrics', 'logs', 'diagnostics', 'activity', 'items', 'refresh', 'alerts', 'cost', 'security', 'maintenance'];

export function MonitorPane() {
  const styles = useStyles();
  const [tab, setTab] = useState<TabKey>('overview');
  const [unauth, setUnauth] = useState(false);
  const onUnauth = useCallback(() => setUnauth(true), []);

  // Deep-link support: /monitor?tab=maintenance (used by the Delta-maintenance
  // job toast). Runs once on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t && (TAB_KEYS as string[]).includes(t)) setTab(t as TabKey);
  }, []);

  return (
    <div>
      {unauth && <SignInRequired subject="monitoring telemetry" />}
      <TabList
        selectedValue={tab}
        onTabSelect={(_, d) => setTab(d.value as TabKey)}
        className={styles.gap}
      >
        <Tab value="overview">Overview</Tab>
        <Tab value="activities">Activities</Tab>
        <Tab value="metrics">Metrics</Tab>
        <Tab value="logs">Logs (KQL)</Tab>
        <Tab value="diagnostics">Diagnostics</Tab>
        <Tab value="activity">Activity log</Tab>
        <Tab value="items">Deployed items</Tab>
        <Tab value="refresh">Refresh summary</Tab>
        <Tab value="alerts">Alerts</Tab>
        <Tab value="cost">Cost</Tab>
        <Tab value="security">Security</Tab>
        <Tab value="maintenance">Maintenance</Tab>
      </TabList>

      {/* Only the active tab mounts → its fetch only fires when shown. */}
      {tab === 'overview' && <OverviewTab onUnauth={onUnauth} />}
      {tab === 'activities' && <MonitorHubPane />}
      {tab === 'metrics' && <MetricsTab onUnauth={onUnauth} />}
      {tab === 'logs' && <LogsTab onUnauth={onUnauth} />}
      {tab === 'diagnostics' && <DiagnosticsTab onUnauth={onUnauth} />}
      {tab === 'activity' && <ActivityTab onUnauth={onUnauth} />}
      {tab === 'items' && <ActivityFeedPane />}
      {tab === 'refresh' && <RefreshSummaryPane />}
      {tab === 'alerts' && <AlertsTab onUnauth={onUnauth} />}
      {tab === 'cost' && <CostTab onUnauth={onUnauth} />}
      {tab === 'security' && <SecurityTab onUnauth={onUnauth} />}
      {tab === 'maintenance' && <MaintenanceTab onUnauth={onUnauth} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview — KPI cards + health roll-up + resource-type breakdown + inventory
// ---------------------------------------------------------------------------

const HEALTH_COLORS = {
  available: tokens.colorPaletteGreenBackground3,
  degraded: tokens.colorPaletteYellowBackground3,
  unavailable: tokens.colorPaletteRedBackground3,
  unknown: tokens.colorNeutralBackground4,
};

function OverviewTab({ onUnauth }: { onUnauth: () => void }) {
  const styles = useStyles();
  // Inventory and Health load INDEPENDENTLY. The grid renders as soon as the
  // (fast) inventory resolves; the slow Resource Health crawl streams in after.
  const [resources, setResources] = useState<LoomResource[] | null>(null);
  const [health, setHealth] = useState<Record<string, HealthEntry> | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setResources(null); setHealth(null); setGate(null); setErr(null);

    // 1) Inventory — fast, first paint.
    clientFetch('/api/monitor/inventory').then(async (r) => {
      if (!alive) return;
      if (r.status === 401 || r.status === 403) { onUnauth(); setResources([]); setHealth({}); return; }
      const j = await r.json();
      if (j.gate) { setGate(j.gate); setResources([]); setHealth({}); return; }
      if (!j.ok) { setErr(j.error || 'Failed to load inventory'); setResources([]); setHealth({}); return; }
      setResources(j.data.resources ?? []);
    }).catch((e) => { if (alive) { setErr(String(e)); setResources([]); setHealth({}); } });

    // 2) Resource Health — slow, parallel, best-effort. Never blocks the grid.
    // Crawls Resource Health across every Loom subscription (admin + DLZ), so
    // give it the longer action budget rather than the 6s first-paint default.
    actionFetch('/api/monitor/health').then(async (r) => {
      if (!alive) return;
      if (r.status === 401 || r.status === 403) { setHealth({}); return; }
      const j = await r.json();
      if (!j.ok || !j.data?.statuses) { setHealth({}); return; }
      const map: Record<string, HealthEntry> = {};
      for (const s of j.data.statuses as { resourceId: string; availabilityState: string; summary?: string }[]) {
        map[(s.resourceId || '').toLowerCase()] = { availabilityState: s.availabilityState, summary: s.summary };
      }
      setHealth(map);
    }).catch(() => { if (alive) setHealth({}); });

    return () => { alive = false; };
  }, [tick, onUnauth]);

  const res = resources ?? [];
  const healthReady = health !== null;

  const stats = useMemo(() => {
    const states = Object.values(health ?? {}).map((h) => h.availabilityState?.toLowerCase());
    const available = states.filter((s) => s === 'available').length;
    const unhealthy = states.filter((s) => s === 'unavailable' || s === 'degraded').length;
    const types = new Set(res.map((r) => r.type)).size;
    return [
      { label: 'Resources', value: res.length, accent: undefined as string | undefined },
      { label: 'Resource types', value: types, accent: undefined },
      { label: 'Available', value: available, accent: styles.statAccentSuccess, pending: !healthReady },
      { label: 'Degraded / down', value: unhealthy, accent: unhealthy > 0 ? styles.statAccentDanger : undefined, pending: !healthReady },
    ];
  }, [res, health, healthReady, styles]);

  // Health donut-style stacked bar segments.
  const healthSegments = useMemo(() => {
    const states = Object.values(health ?? {}).map((h) => (h.availabilityState || 'Unknown').toLowerCase());
    const counts = {
      available: states.filter((s) => s === 'available').length,
      degraded: states.filter((s) => s === 'degraded').length,
      unavailable: states.filter((s) => s === 'unavailable').length,
      unknown: states.filter((s) => s !== 'available' && s !== 'degraded' && s !== 'unavailable').length,
    };
    const total = counts.available + counts.degraded + counts.unavailable + counts.unknown;
    return { counts, total };
  }, [health]);

  // Resource-type breakdown (top 8 types by count).
  const typeBreakdown = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of res) {
      const t = r.type.replace(/^Microsoft\./, '');
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    const arr = Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const max = arr[0]?.[1] ?? 1;
    return { arr, max };
  }, [res]);

  const columns: LoomColumn<LoomResource>[] = useMemo(() => [
    { key: 'name', label: 'Name', width: 240, render: (r) => <strong>{r.name}</strong> },
    { key: 'type', label: 'Type', width: 220, getValue: (r) => r.type.replace(/^Microsoft\./, ''), render: (r) => r.type.replace(/^Microsoft\./, '') },
    { key: 'resourceGroup', label: 'Resource group', width: 200 },
    { key: 'location', label: 'Location', width: 130 },
    {
      key: 'health', label: 'Health', width: 130, filterable: false,
      getValue: (r) => health?.[r.id?.toLowerCase()]?.availabilityState ?? '',
      render: (r) => {
        if (!healthReady) return <Spinner size="extra-tiny" aria-label="Loading health" />;
        const h = health?.[r.id?.toLowerCase()];
        return h ? healthBadge(h.availabilityState) : <Text size={200}>—</Text>;
      },
    },
  ], [health, healthReady]);

  return (
    <div>
      <Section
        title="Health overview"
        actions={<Button appearance="primary" icon={<ArrowSync20Regular />} onClick={() => setTick((t) => t + 1)}>Refresh</Button>}
      >
        {gate && <GateBar gate={gate} subject="Resource inventory" />}
        {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}

        {resources === null ? (
          <StatCardSkeleton />
        ) : (
          <div className={styles.stats}>
            {stats.map((s) => (
              <div key={s.label} className={styles.stat}>
                <span className={styles.statLabel}>{s.label}</span>
                <span className={`${styles.statValue} ${s.accent ?? ''}`}>
                  {s.pending ? <Spinner size="tiny" aria-label="Loading" /> : s.value}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {resources !== null && res.length > 0 && (
        <Section title="Availability roll-up">
          <div className={styles.healthRow}>
            <div className={styles.healthBarWrap}>
              {!healthReady ? (
                <Skeleton aria-label="Loading health roll-up"><SkeletonItem style={{ height: 16, borderRadius: tokens.borderRadiusMedium }} /></Skeleton>
              ) : healthSegments.total === 0 ? (
                <Text size={200}>Resource Health reports no monitored resources yet.</Text>
              ) : (
                <div className={styles.healthBar} role="img" aria-label="Availability distribution">
                  {(['available', 'degraded', 'unavailable', 'unknown'] as const).map((k) => {
                    const pct = (healthSegments.counts[k] / healthSegments.total) * 100;
                    return pct > 0 ? (
                      <div key={k} style={{ width: `${pct}%`, backgroundColor: HEALTH_COLORS[k] }} title={`${k}: ${healthSegments.counts[k]}`} />
                    ) : null;
                  })}
                </div>
              )}
              {healthReady && healthSegments.total > 0 && (
                <div className={styles.healthLegend}>
                  {(['available', 'degraded', 'unavailable', 'unknown'] as const).map((k) => (
                    <span key={k} className={styles.legendItem}>
                      <span className={styles.swatch} style={{ backgroundColor: HEALTH_COLORS[k] }} />
                      {k.charAt(0).toUpperCase() + k.slice(1)} ({healthSegments.counts[k]})
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className={styles.healthBarWrap}>
              <Text weight="semibold" size={200}>Resources by type</Text>
              <div className={styles.breakdown}>
                {typeBreakdown.arr.map(([t, n]) => (
                  <div key={t} className={styles.breakdownRow}>
                    <span className={styles.breakdownLabel} title={t}>{t}</span>
                    <span className={styles.breakdownTrack}>
                      <span className={styles.breakdownFill} style={{ width: `${(n / typeBreakdown.max) * 100}%` }} />
                    </span>
                    <span className={styles.breakdownCount}>{n}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Section>
      )}

      <Section title="Resource inventory">
        <LoomDataTable
          columns={columns}
          rows={res}
          getRowId={(r) => r.id}
          loading={resources === null}
          empty={gate ? 'Configure the Loom subscription to list resources.' : 'No Loom resources found in the configured resource groups.'}
          ariaLabel="Loom resource inventory"
        />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metrics — pick a resource, render its catalog metrics as SVG charts
// ---------------------------------------------------------------------------

const METRIC_CATALOG: Record<string, { metric: string; aggregation: string; label: string }[]> = {
  'microsoft.app/containerapps': [
    { metric: 'UsageNanoCores', aggregation: 'Average', label: 'CPU (nanocores)' },
    { metric: 'WorkingSetBytes', aggregation: 'Average', label: 'Memory (bytes)' },
    { metric: 'Requests', aggregation: 'Total', label: 'Requests' },
    { metric: 'Replicas', aggregation: 'Maximum', label: 'Replicas' },
  ],
  'microsoft.documentdb/databaseaccounts': [
    { metric: 'TotalRequestUnits', aggregation: 'Total', label: 'Request Units' },
    { metric: 'TotalRequests', aggregation: 'Count', label: 'Requests' },
    { metric: 'ServerSideLatency', aggregation: 'Average', label: 'Server latency (ms)' },
  ],
  'microsoft.search/searchservices': [
    { metric: 'SearchLatency', aggregation: 'Average', label: 'Search latency (s)' },
    { metric: 'SearchQueriesPerSecond', aggregation: 'Average', label: 'Queries / sec' },
    { metric: 'ThrottledSearchQueriesPercentage', aggregation: 'Average', label: 'Throttled %' },
  ],
  'microsoft.kusto/clusters': [
    { metric: 'CPU', aggregation: 'Average', label: 'CPU %' },
    { metric: 'IngestionUtilization', aggregation: 'Average', label: 'Ingestion util %' },
  ],
  'microsoft.datafactory/factories': [
    { metric: 'PipelineSucceededRuns', aggregation: 'Total', label: 'Pipeline runs succeeded' },
    { metric: 'PipelineFailedRuns', aggregation: 'Total', label: 'Pipeline runs failed' },
  ],
  'microsoft.apimanagement/service': [
    { metric: 'Requests', aggregation: 'Total', label: 'Requests' },
    { metric: 'Duration', aggregation: 'Average', label: 'Duration (ms)' },
  ],
  'microsoft.insights/components': [
    { metric: 'requests/count', aggregation: 'Count', label: 'Requests' },
    { metric: 'requests/failed', aggregation: 'Count', label: 'Failed requests' },
    { metric: 'requests/duration', aggregation: 'Average', label: 'Server response (ms)' },
  ],
  'microsoft.fabric/capacities': [
    { metric: 'cu_percentage', aggregation: 'Average', label: 'CU %' },
  ],
  'microsoft.cognitiveservices/accounts': [
    { metric: 'TotalCalls', aggregation: 'Total', label: 'Total calls' },
    { metric: 'TotalTokens', aggregation: 'Total', label: 'Total tokens' },
  ],
};

const TIMESPANS = [
  { key: 'PT1H', label: 'Last hour', interval: 'PT5M' },
  { key: 'PT6H', label: 'Last 6 hours', interval: 'PT15M' },
  { key: 'P1D', label: 'Last 24 hours', interval: 'PT1H' },
  { key: 'P7D', label: 'Last 7 days', interval: 'PT6H' },
];

function MetricsTab({ onUnauth }: { onUnauth: () => void }) {
  const styles = useStyles();
  const [resources, setResources] = useState<LoomResource[] | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [span, setSpan] = useState(TIMESPANS[1]);
  const [results, setResults] = useState<MetricResult[] | null>(null);
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Resources that have a metric catalog entry are pickable.
  useEffect(() => {
    let alive = true;
    clientFetch('/api/monitor/inventory').then(async (r) => {
      if (!alive) return;
      if (r.status === 401 || r.status === 403) { onUnauth(); setResources([]); return; }
      const j = await r.json();
      if (j.gate) { setGate(j.gate); setResources([]); return; }
      const monitorable = (j.data?.resources ?? []).filter((res: LoomResource) => METRIC_CATALOG[res.type?.toLowerCase()]);
      setResources(monitorable);
      if (monitorable[0]) setSelected(monitorable[0].id);
    }).catch(() => { if (alive) setResources([]); });
    return () => { alive = false; };
  }, [onUnauth]);

  const selectedRes = resources?.find((r) => r.id === selected);
  const catalog = selectedRes ? METRIC_CATALOG[selectedRes.type.toLowerCase()] || [] : [];

  const loadMetrics = useCallback(async () => {
    if (!selectedRes || catalog.length === 0) return;
    setLoadingMetrics(true); setErr(null); setResults(null);
    try {
      const r = await actionFetch('/api/monitor/metrics', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceId: selectedRes.id,
          metricNames: catalog.map((c) => c.metric),
          aggregation: catalog[0].aggregation,
          timespan: span.key,
          interval: span.interval,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || 'Failed to load metrics'); setResults([]); return; }
      setResults(j.data.results);
    } catch (e) { setErr(String(e)); setResults([]); }
    finally { setLoadingMetrics(false); }
  }, [selectedRes, catalog, span]);

  useEffect(() => { if (selectedRes) loadMetrics(); }, [selectedRes?.id, span.key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (resources === null) return <Spinner label="Loading metric-capable resources…" />;

  return (
    <Section title="Platform metrics">
      {gate && <GateBar gate={gate} subject="Metrics" />}
      <div className={styles.resPicker}>
        <Dropdown
          aria-label="Resource"
          placeholder="Select a resource"
          value={selectedRes ? `${selectedRes.name} (${selectedRes.type.replace(/^Microsoft\./, '')})` : ''}
          selectedOptions={selected ? [selected] : []}
          onOptionSelect={(_, d) => d.optionValue && setSelected(d.optionValue)}
          style={{ minWidth: 320 }}
        >
          {resources.map((r) => (
            <Option key={r.id} value={r.id} text={r.name}>
              {r.name} ({r.type.replace(/^Microsoft\./, '')})
            </Option>
          ))}
        </Dropdown>
        <Dropdown
          aria-label="Time range"
          value={span.label}
          selectedOptions={[span.key]}
          onOptionSelect={(_, d) => { const t = TIMESPANS.find((x) => x.key === d.optionValue); if (t) setSpan(t); }}
        >
          {TIMESPANS.map((t) => <Option key={t.key} value={t.key}>{t.label}</Option>)}
        </Dropdown>
        <Button appearance="primary" icon={<ArrowSync20Regular />} onClick={loadMetrics}>Refresh</Button>
      </div>
      {resources.length === 0 && !gate && (
        <Text>No metric-capable resources found in the Loom resource groups.</Text>
      )}
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      {loadingMetrics ? (
        <div className={styles.charts}>
          {(catalog.length ? catalog : [0, 1, 2]).map((_, i) => (
            <Skeleton key={i} aria-label="Loading metric"><SkeletonItem style={{ height: 132, borderRadius: tokens.borderRadiusLarge }} /></Skeleton>
          ))}
        </div>
      ) : results && results.length > 0 ? (
        <div className={styles.charts}>
          {results.map((m) => {
            const label = catalog.find((c) => c.metric.toLowerCase() === m.name.toLowerCase())?.label || m.name;
            return <MetricChart key={m.name} title={label} unit={m.unit} points={m.points} />;
          })}
        </div>
      ) : results && results.length === 0 && !err ? (
        <Text>No metric data returned for this resource in the selected window.</Text>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Logs — Log Analytics KQL
// ---------------------------------------------------------------------------

interface KqlPreset {
  id: string; label: string; query: string; description?: string;
  category?: string; service?: string; chart?: KqlChartType | 'table';
}

function LogsTab({ onUnauth }: { onUnauth: () => void }) {
  const styles = useStyles();
  const [presets, setPresets] = useState<KqlPreset[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [category, setCategory] = useState<string>('');
  const [presetId, setPresetId] = useState<string>('');
  const [query, setQuery] = useState('AzureActivity\n| summarize count() by Category\n| order by count_ desc');
  const [span, setSpan] = useState('P1D');
  const [result, setResult] = useState<LogResult | null>(null);
  // chart hint for the *result* currently shown (captured at run time).
  const [resultChart, setResultChart] = useState<KqlChartType | 'table'>('table');
  const [gate, setGate] = useState<Gate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let alive = true;
    clientFetch('/api/monitor/logs').then(async (r) => {
      if (!alive) return;
      if (r.status === 401 || r.status === 403) { onUnauth(); return; }
      const j = await r.json();
      if (j.ok) {
        setPresets(j.data.presets || []);
        setCategories(j.data.categories || []);
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, [onUnauth]);

  // Queries visible in the picker, filtered by the chosen category.
  const visiblePresets = useMemo(
    () => (category ? presets.filter((p) => p.category === category) : presets),
    [presets, category],
  );
  const selectedPreset = useMemo(() => presets.find((p) => p.id === presetId), [presets, presetId]);

  const applyPreset = useCallback((id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setPresetId(id);
    setQuery(p.query);
  }, [presets]);

  const run = useCallback(async (overrideChart?: KqlChartType | 'table') => {
    setRunning(true); setErr(null); setGate(null); setResult(null);
    try {
      const r = await actionFetch('/api/monitor/logs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, timespan: span }),
      });
      const j = await r.json();
      if (j.gate) { setGate(j.gate); return; }
      if (!j.ok) { setErr(j.error || 'Query failed'); return; }
      setResult(j.data);
      const chart = overrideChart ?? (selectedPreset?.chart as KqlChartType | 'table' | undefined) ?? 'table';
      setResultChart(query === selectedPreset?.query ? chart : 'table');
    } catch (e) { setErr(String(e)); }
    finally { setRunning(false); }
  }, [query, span, selectedPreset]);

  // LoomDataTable rows: map each result row to a keyed object by column name.
  const logColumns: LoomColumn<Record<string, unknown>>[] = useMemo(
    () => (result?.columns ?? []).map((c) => ({
      key: c, label: c, width: 200,
      render: (row) => String(row[c] ?? ''),
      getValue: (row) => String(row[c] ?? ''),
    })),
    [result?.columns],
  );
  const logRows = useMemo(
    () => (result?.rows ?? []).slice(0, 500).map((row, i) => {
      const o: Record<string, unknown> = { __id: String(i) };
      (result?.columns ?? []).forEach((c, j) => { o[c] = row[j]; });
      return o;
    }),
    [result],
  );

  return (
    <Section title="Logs (Log Analytics — KQL)">
      {gate && <GateBar gate={gate} subject="Logs (Log Analytics)" />}
      <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
        Prebuilt query library — {presets.length} curated troubleshooting, performance, audit, cost &amp; per-service
        queries against the Loom Log Analytics workspace. Pick a category, choose a query, then Run (or edit it freely).
      </Text>
      <div className={styles.kqlBox}>
        <div className={styles.toolbar}>
          <Dropdown
            aria-label="Query category"
            placeholder="All categories"
            value={category || 'All categories'}
            selectedOptions={category ? [category] : []}
            onOptionSelect={(_, d) => { setCategory(d.optionValue === '__all' ? '' : (d.optionValue || '')); }}
            style={{ minWidth: 200 }}
          >
            <Option value="__all">All categories</Option>
            {categories.map((c) => <Option key={c} value={c}>{c}</Option>)}
          </Dropdown>
          <Dropdown
            aria-label="Prebuilt query"
            placeholder="Prebuilt queries"
            value={selectedPreset?.label || ''}
            selectedOptions={presetId ? [presetId] : []}
            onOptionSelect={(_, d) => d.optionValue && applyPreset(d.optionValue)}
            style={{ minWidth: 320 }}
          >
            {visiblePresets.map((p) => (
              <Option key={p.id} value={p.id} text={p.label}>
                {p.label}{p.chart && p.chart !== 'table' ? ` · ${p.chart}` : ''}
              </Option>
            ))}
          </Dropdown>
          <Dropdown
            aria-label="Timespan"
            value={span === 'PT1H' ? 'Last hour' : span === 'P1D' ? 'Last 24 hours' : span === 'P7D' ? 'Last 7 days' : span === 'P30D' ? 'Last 30 days' : span}
            selectedOptions={[span]}
            onOptionSelect={(_, d) => d.optionValue && setSpan(d.optionValue)}
          >
            <Option value="PT1H">Last hour</Option>
            <Option value="P1D">Last 24 hours</Option>
            <Option value="P7D">Last 7 days</Option>
            <Option value="P30D">Last 30 days</Option>
          </Dropdown>
          <Button appearance="primary" icon={<Play20Regular />} onClick={() => run()} disabled={running}>Run query</Button>
        </div>
        {selectedPreset?.description && (
          <Text size={200} style={{ color: tokens.colorNeutralForeground2 }}>
            <strong>{selectedPreset.category}{selectedPreset.service ? ` · ${selectedPreset.service}` : ''}:</strong>{' '}
            {selectedPreset.description}
          </Text>
        )}
        <Textarea
          aria-label="KQL query"
          value={query}
          onChange={(_, d) => { setQuery(d.value); }}
          rows={6}
          resize="vertical"
          style={{ fontFamily: 'var(--loom-font-mono, monospace)', fontSize: tokens.fontSizeBase200 }}
        />
      </div>
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      {running ? (
        <Spinner label="Running KQL against Log Analytics…" />
      ) : result ? (
        <>
          <Text size={200}>{result.rowCount} rows{result.rowCount > 500 ? ' (showing first 500)' : ''}</Text>
          {resultChart !== 'table' && result.rowCount > 0 && (
            <KqlChart type={resultChart as KqlChartType} columns={result.columns} rows={result.rows} />
          )}
          <LoomDataTable
            columns={logColumns}
            rows={logRows}
            getRowId={(r) => String(r.__id)}
            empty="Query returned 0 rows."
            ariaLabel="KQL query results"
          />
        </>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Diagnostics — diagnostic-settings coverage ("are all logs ON → Loom LAW?")
// ---------------------------------------------------------------------------

interface DiagItem {
  id: string; name: string; type: string; resourceGroup: string;
  supported: boolean; routesToLoomLaw: boolean; settingNames: string[]; note?: string;
}
interface DiagSummary { total: number; supported: number; covered: number; missing: number; unsupported: number; }

function shortType(t: string): string {
  // 'microsoft.documentdb/databaseaccounts' → 'documentdb/databaseaccounts'
  return t.replace(/^microsoft\./i, '');
}

function DiagnosticsTab({ onUnauth }: { onUnauth: () => void }) {
  const styles = useStyles();
  const [items, setItems] = useState<DiagItem[] | null>(null);
  const [summary, setSummary] = useState<DiagSummary | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // resourceId or '__all'
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null); setGate(null);
    try {
      const r = await clientFetch('/api/monitor/diagnostics');
      if (r.status === 401 || r.status === 403) { onUnauth(); return; }
      const j = await r.json();
      if (j.gate) { setGate(j.gate); setItems([]); return; }
      if (!j.ok) { setErr(j.error || 'Failed to load coverage'); setItems([]); return; }
      setItems(j.data.items); setSummary(j.data.summary);
    } catch (e) { setErr(String(e)); setItems([]); }
  }, [onUnauth]);

  useEffect(() => { load(); }, [load]);

  const enable = useCallback(async (body: object, key: string) => {
    setBusy(key); setMsg(null); setErr(null);
    try {
      const r = await actionFetch('/api/monitor/diagnostics', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.gate) { setGate(j.gate); return; }
      if (!j.ok) { setErr(j.error || 'Enable failed'); return; }
      if (j.data.enabled) {
        setMsg(`Enabled diagnostics on ${j.data.enabled.length} of ${j.data.attempted} resource(s)${j.data.failed?.length ? ` · ${j.data.failed.length} failed` : ''}.`);
      } else {
        setMsg(`Diagnostics enabled (${j.data.mode}).`);
      }
      await load();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(null); }
  }, [load]);

  const columns: LoomColumn<DiagItem>[] = useMemo(() => [
    { key: 'name', label: 'Resource', width: 220, render: (r) => r.name, getValue: (r) => r.name },
    { key: 'type', label: 'Type', width: 240, render: (r) => <Text size={200}>{shortType(r.type)}</Text>, getValue: (r) => r.type },
    { key: 'rg', label: 'Resource group', width: 200, render: (r) => <Text size={200}>{r.resourceGroup}</Text>, getValue: (r) => r.resourceGroup },
    {
      key: 'status', label: 'Logs → Loom LAW', width: 150,
      render: (r) => !r.supported
        ? <Badge color="subtle" appearance="outline">n/a</Badge>
        : r.routesToLoomLaw
          ? <Badge color="success" appearance="filled">On</Badge>
          : <Badge color="warning" appearance="filled">Off</Badge>,
      getValue: (r) => (!r.supported ? 'na' : r.routesToLoomLaw ? 'on' : 'off'),
    },
    {
      key: 'action', label: '', width: 120,
      render: (r) => (r.supported && !r.routesToLoomLaw)
        ? <Button size="small" disabled={busy != null} onClick={() => enable({ resourceId: r.id }, r.id)}>
            {busy === r.id ? 'Enabling…' : 'Enable'}
          </Button>
        : <Text size={200}>—</Text>,
      getValue: () => '',
    },
  ], [busy, enable]);

  const rows = items ?? [];

  return (
    <Section title="Diagnostics — log & metric coverage">
      {gate && <GateBar gate={gate} subject="Diagnostics coverage" />}
      <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
        Every Loom resource should route <strong>all logs + all metrics</strong> to the Loom Log Analytics workspace.
        Deploy-time bicep wires the first-class resources; this audits the live estate and turns diagnostics on for
        anything created at runtime or drifted off — the standardized <code>diag-loom-stdz</code> setting
        (categoryGroup <code>allLogs</code> + <code>AllMetrics</code>).
      </Text>

      {summary && (
        <div className={styles.toolbar}>
          <Badge color="success" appearance="tint">{summary.covered} on</Badge>
          <Badge color={summary.missing ? 'warning' : 'subtle'} appearance="tint">{summary.missing} off</Badge>
          <Badge color="subtle" appearance="tint">{summary.unsupported} n/a</Badge>
          <Button appearance="primary" icon={<ArrowSync20Regular />} disabled={busy != null || !summary.missing}
            onClick={() => enable({ all: true }, '__all')}>
            {busy === '__all' ? 'Enabling all…' : `Turn on all (${summary.missing})`}
          </Button>
          <Button appearance="subtle" icon={<ArrowSync20Regular />} disabled={busy != null} onClick={load}>Refresh</Button>
        </div>
      )}

      {msg && <MessageBar intent="success"><MessageBarBody>{msg}</MessageBarBody></MessageBar>}
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}

      {items == null ? (
        <Spinner label="Auditing diagnostic-settings coverage…" />
      ) : (
        <LoomDataTable
          columns={columns}
          rows={rows}
          getRowId={(r) => r.id}
          empty="No resources found in the Loom resource groups."
          ariaLabel="Diagnostic settings coverage"
        />
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Activity log — ARM control-plane events
// ---------------------------------------------------------------------------

function statusBadge(status?: string) {
  const s = (status || '').toLowerCase();
  if (s === 'succeeded' || s === 'success') return <Badge color="success" appearance="filled">{status}</Badge>;
  if (s === 'failed' || s === 'failure') return <Badge color="danger" appearance="filled">{status}</Badge>;
  if (s === 'started' || s === 'accepted') return <Badge color="informative" appearance="outline">{status}</Badge>;
  return status ? <Badge color="subtle" appearance="outline">{status}</Badge> : <Text size={200}>—</Text>;
}

function ActivityTab({ onUnauth }: { onUnauth: () => void }) {
  const styles = useStyles();
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setEvents(null); setGate(null); setErr(null);
    // The Activity Log crawl paginates control-plane events across every Loom RG
    // (admin + DLZ subs) — heavier than the 6s default, so use the longer action
    // budget (clientFetch relabels a timeout to a clear message).
    actionFetch(`/api/monitor/activity?days=${days}`).then(async (r) => {
      if (!alive) return;
      if (r.status === 401 || r.status === 403) { onUnauth(); setEvents([]); return; }
      const j = await r.json();
      if (j.gate) { setGate(j.gate); setEvents([]); return; }
      if (!j.ok) { setErr(j.error || 'Failed to load activity log'); setEvents([]); return; }
      setEvents(j.data.events);
    }).catch((e) => { if (alive) { setErr(String(e)); setEvents([]); } });
    return () => { alive = false; };
  }, [days, tick, onUnauth]);

  // KPI roll-up of the activity window.
  const kpis = useMemo(() => {
    const e = events ?? [];
    const succeeded = e.filter((x) => /succ/i.test(x.status ?? '')).length;
    const failed = e.filter((x) => /fail/i.test(x.status ?? '')).length;
    const callers = new Set(e.map((x) => x.caller).filter(Boolean)).size;
    return [
      { label: 'Events', value: e.length, accent: undefined as string | undefined },
      { label: 'Succeeded', value: succeeded, accent: styles.statAccentSuccess },
      { label: 'Failed', value: failed, accent: failed > 0 ? styles.statAccentDanger : undefined },
      { label: 'Distinct callers', value: callers, accent: undefined },
    ];
  }, [events, styles]);

  const columns: LoomColumn<ActivityEvent & { __id: string }>[] = useMemo(() => [
    { key: 'eventTimestamp', label: 'Time', width: 180, getValue: (e) => new Date(e.eventTimestamp).getTime(), render: (e) => new Date(e.eventTimestamp).toLocaleString() },
    { key: 'operationName', label: 'Operation', width: 300, render: (e) => e.operationName ?? '—' },
    { key: 'status', label: 'Status', width: 130, filterable: true, render: (e) => statusBadge(e.status) },
    { key: 'resourceGroup', label: 'Resource group', width: 200, render: (e) => e.resourceGroup ?? '—' },
    { key: 'caller', label: 'Caller', width: 220, render: (e) => e.caller ?? '—' },
  ], []);

  const rows = useMemo(() => (events ?? []).map((e, i) => ({ ...e, __id: String(i) })), [events]);

  return (
    <div>
      <Section
        title="Activity log"
        actions={
          <>
            <Dropdown
              aria-label="Window"
              value={days === 1 ? 'Last 24 hours' : `Last ${days} days`}
              selectedOptions={[String(days)]}
              onOptionSelect={(_, d) => d.optionValue && setDays(Number(d.optionValue))}
            >
              <Option value="1">Last 24 hours</Option>
              <Option value="7">Last 7 days</Option>
              <Option value="30">Last 30 days</Option>
              <Option value="90">Last 90 days</Option>
            </Dropdown>
            <Button appearance="primary" icon={<ArrowSync20Regular />} onClick={() => setTick((t) => t + 1)}>Refresh</Button>
          </>
        }
      >
        {gate && <GateBar gate={gate} subject="Activity log" />}
        {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
        {events === null ? (
          <StatCardSkeleton />
        ) : (
          <div className={styles.stats}>
            {kpis.map((s) => (
              <div key={s.label} className={styles.stat}>
                <span className={styles.statLabel}>{s.label}</span>
                <span className={`${styles.statValue} ${s.accent ?? ''}`}>{s.value}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Control-plane events">
        <LoomDataTable
          columns={columns}
          rows={rows}
          getRowId={(r) => r.__id}
          loading={events === null}
          empty={gate ? 'Configure the Loom subscription to read the Activity Log.' : 'No control-plane activity in this window.'}
          ariaLabel="Azure Activity Log"
        />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Maintenance — Delta Lake OPTIMIZE / VACUUM / ZORDER BY jobs (Synapse Spark)
// ---------------------------------------------------------------------------

interface MaintenanceJob {
  id: string;
  container: string;
  tableName: string;
  pool: string;
  ops: string[];
  sessionId: number;
  statementId?: number;
  state: 'starting' | 'submitting' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  detail?: string;
  submittedAt: string;
  updatedAt: string;
  submittedBy: string;
}

function maintBadge(state: string) {
  const s = (state || '').toLowerCase();
  if (s === 'succeeded') return <Badge color="success" appearance="filled">Succeeded</Badge>;
  if (s === 'failed') return <Badge color="danger" appearance="filled">Failed</Badge>;
  if (s === 'running') return <Badge color="brand" appearance="filled">Running</Badge>;
  if (s === 'cancelled') return <Badge color="subtle" appearance="filled">Cancelled</Badge>;
  return <Badge color="informative" appearance="outline">{state || 'starting'}</Badge>;
}

function MaintenanceTab({ onUnauth }: { onUnauth: () => void }) {
  const styles = useStyles();
  const [jobs, setJobs] = useState<MaintenanceJob[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setJobs(null); setErr(null);
    clientFetch('/api/lakehouse/maintenance').then(async (r) => {
      if (!alive) return;
      if (r.status === 401 || r.status === 403) { onUnauth(); setJobs([]); return; }
      const j = await r.json();
      if (!j.ok) { setErr(j.error || 'Failed to load maintenance jobs'); setJobs([]); return; }
      setJobs(j.jobs || []);
    }).catch((e) => { if (alive) { setErr(String(e)); setJobs([]); } });
    return () => { alive = false; };
  }, [tick, onUnauth]);

  const kpis = useMemo(() => {
    const j = jobs ?? [];
    const running = j.filter((x) => x.state === 'running' || x.state === 'starting' || x.state === 'submitting').length;
    const succeeded = j.filter((x) => x.state === 'succeeded').length;
    const failed = j.filter((x) => x.state === 'failed').length;
    return [
      { label: 'Jobs', value: j.length, accent: undefined as string | undefined },
      { label: 'In progress', value: running, accent: undefined },
      { label: 'Succeeded', value: succeeded, accent: styles.statAccentSuccess },
      { label: 'Failed', value: failed, accent: failed > 0 ? styles.statAccentDanger : undefined },
    ];
  }, [jobs, styles]);

  const columns: LoomColumn<MaintenanceJob>[] = useMemo(() => [
    { key: 'tableName', label: 'Table', width: 220, render: (j) => `${j.container}/${j.tableName}` },
    { key: 'ops', label: 'Operations', width: 280, render: (j) => (j.ops || []).join(', ') },
    { key: 'pool', label: 'Spark pool', width: 150, render: (j) => j.pool },
    { key: 'state', label: 'Status', width: 130, filterable: true, render: (j) => maintBadge(j.state) },
    { key: 'submittedAt', label: 'Submitted', width: 180, getValue: (j) => new Date(j.submittedAt).getTime(), render: (j) => new Date(j.submittedAt).toLocaleString() },
    { key: 'submittedBy', label: 'Submitted by', width: 200, render: (j) => j.submittedBy },
    { key: 'detail', label: 'Result', width: 320, render: (j) => j.detail ?? '—' },
  ], []);

  return (
    <div>
      <Section
        title="Delta table maintenance"
        actions={<Button appearance="primary" icon={<ArrowSync20Regular />} onClick={() => setTick((t) => t + 1)}>Refresh</Button>}
      >
        <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginBottom: tokens.spacingVerticalM }}>
          OPTIMIZE / VACUUM / ZORDER BY jobs submitted from a lakehouse editor and run on Synapse Spark. Refreshing
          advances each job by polling its Livy session — a cold Spark pool takes a couple minutes to warm up before
          the statement runs.
        </Caption1>
        {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
        {jobs === null ? (
          <StatCardSkeleton />
        ) : (
          <div className={styles.stats}>
            {kpis.map((k) => (
              <div key={k.label} className={styles.stat}>
                <span className={styles.statLabel}>{k.label}</span>
                <span className={`${styles.statValue} ${k.accent ?? ''}`}>{k.value}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Jobs">
        <LoomDataTable
          columns={columns}
          rows={jobs ?? []}
          getRowId={(r) => r.id}
          loading={jobs === null}
          empty="No Delta maintenance jobs yet. Open a lakehouse, go to the Tables tab, and choose Maintain on a table."
          ariaLabel="Delta maintenance jobs"
        />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Alerts — Azure Monitor metric-alert rules
// ---------------------------------------------------------------------------

function AlertsTab({ onUnauth }: { onUnauth: () => void }) {
  const styles = useStyles();
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // ── Scheduled query rules (the Loom-managed, authorable rules) ──
  const [sqRules, setSqRules] = useState<ScheduledQueryRule[] | null>(null);
  const [sqGate, setSqGate] = useState<{ remediation?: string; reason?: string } | null>(null);
  const [sqErr, setSqErr] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledQueryRuleLite | undefined>(undefined);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ScheduledQueryRule | null>(null);

  useEffect(() => {
    let alive = true;
    setRules(null); setGate(null); setErr(null);
    clientFetch('/api/monitor/alerts').then(async (r) => {
      if (!alive) return;
      if (r.status === 401 || r.status === 403) { onUnauth(); setRules([]); return; }
      const j = await r.json();
      if (j.gate) { setGate(j.gate); setRules([]); return; }
      if (!j.ok) { setErr(j.error || 'Failed to load alert rules'); setRules([]); return; }
      setRules(j.data.rules);
    }).catch((e) => { if (alive) { setErr(String(e)); setRules([]); } });
    return () => { alive = false; };
  }, [tick, onUnauth]);

  // Load the Loom-managed scheduled query rules in parallel.
  useEffect(() => {
    let alive = true;
    setSqRules(null); setSqGate(null); setSqErr(null);
    actionFetch('/api/monitor/alerts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _action: 'list-scheduled' }),
    }).then(async (r) => {
      if (!alive) return;
      if (r.status === 401) { onUnauth(); setSqRules([]); return; }
      const j = await r.json();
      if (j.gate) { setSqGate(j.gate); setSqRules([]); return; }
      if (!j.ok) { setSqErr(j.error || 'Failed to load scheduled query rules'); setSqRules([]); return; }
      setSqRules(j.rules || []);
    }).catch((e) => { if (alive) { setSqErr(String(e)); setSqRules([]); } });
    return () => { alive = false; };
  }, [tick, onUnauth]);

  const kpis = useMemo(() => {
    const metric = rules ?? [];
    const sq = sqRules ?? [];
    const all = [...metric, ...sq];
    const enabled = all.filter((x) => x.enabled).length;
    const sev01 = all.filter((x) => x.severity != null && x.severity <= 1).length;
    return [
      { label: 'Alert rules', value: all.length, accent: undefined as string | undefined },
      { label: 'Enabled', value: enabled, accent: styles.statAccentSuccess },
      { label: 'Disabled', value: all.length - enabled, accent: undefined },
      { label: 'Sev 0–1', value: sev01, accent: sev01 > 0 ? styles.statAccentWarn : undefined },
    ];
  }, [rules, sqRules, styles]);

  const columns: LoomColumn<AlertRule>[] = useMemo(() => [
    { key: 'name', label: 'Name', width: 280, render: (r) => <strong>{r.name}</strong> },
    {
      key: 'enabled', label: 'Enabled', width: 110, getValue: (r) => (r.enabled ? 'On' : 'Off'),
      render: (r) => r.enabled ? <Badge color="success" appearance="filled">On</Badge> : <Badge color="subtle" appearance="outline">Off</Badge>,
    },
    { key: 'severity', label: 'Severity', width: 110, getValue: (r) => (r.severity ?? 99), render: (r) => r.severity != null ? `Sev ${r.severity}` : '—' },
    { key: 'resourceGroup', label: 'Resource group', width: 200, render: (r) => r.resourceGroup ?? '—' },
    { key: 'description', label: 'Description', width: 320, render: (r) => r.description || '—' },
  ], []);

  const openNew = useCallback(() => { setEditing(undefined); setEditorOpen(true); }, []);
  const openEdit = useCallback((r: ScheduledQueryRule) => {
    setEditing({
      id: r.id, name: r.name, enabled: r.enabled, severity: r.severity, description: r.description,
      query: r.query, operator: r.operator, threshold: r.threshold,
      evaluationFrequency: r.evaluationFrequency, windowSize: r.windowSize, actionGroupIds: r.actionGroupIds,
    });
    setEditorOpen(true);
  }, []);

  const toggleEnabled = useCallback(async (r: ScheduledQueryRule) => {
    setBusyName(r.name);
    try {
      const resp = await actionFetch('/api/monitor/alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _action: 'patch', name: r.name, enabled: !r.enabled }),
      });
      const j = await resp.json();
      if (!j.ok) { setSqErr(j.gate?.remediation || j.error || 'Failed to toggle rule'); return; }
      setTick((t) => t + 1);
    } catch (e) {
      setSqErr((e as Error)?.message || String(e));
    } finally {
      setBusyName(null);
    }
  }, []);

  const doDelete = useCallback(async (r: ScheduledQueryRule) => {
    setBusyName(r.name);
    try {
      const resp = await actionFetch('/api/monitor/alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _action: 'delete', name: r.name }),
      });
      const j = await resp.json();
      if (!j.ok) { setSqErr(j.gate?.remediation || j.error || 'Failed to delete rule'); return; }
      setConfirmDelete(null);
      setTick((t) => t + 1);
    } catch (e) {
      setSqErr((e as Error)?.message || String(e));
    } finally {
      setBusyName(null);
    }
  }, []);

  const sqColumns: LoomColumn<ScheduledQueryRule>[] = useMemo(() => [
    { key: 'name', label: 'Name', width: 240, render: (r) => <strong>{r.name}</strong> },
    {
      key: 'enabled', label: 'Enabled', width: 100, getValue: (r) => (r.enabled ? 'On' : 'Off'),
      render: (r) => r.enabled ? <Badge color="success" appearance="filled">On</Badge> : <Badge color="subtle" appearance="outline">Off</Badge>,
    },
    {
      key: 'condition', label: 'Condition', width: 280,
      render: (r) => (
        <MonitorConditionsBuilder
          mode="display"
          operator={r.operator || 'GreaterThan'}
          threshold={r.threshold ?? 0}
          evaluationFrequency={r.evaluationFrequency || 'PT5M'}
          windowSize={r.windowSize || 'PT5M'}
          severity={r.severity ?? 3}
        />
      ),
    },
    { key: 'evaluationFrequency', label: 'Frequency', width: 130, render: (r) => freqLabel(r.evaluationFrequency) },
    {
      key: 'actions', label: 'Actions', width: 180, sortable: false, filterable: false,
      render: (r) => (
        <div className={styles.rowActions}>
          <Tooltip content="Edit rule" relationship="label">
            <Button size="small" appearance="subtle" icon={<Edit20Regular />} aria-label={`Edit ${r.name}`} onClick={() => openEdit(r)} />
          </Tooltip>
          <Tooltip content={r.enabled ? 'Disable rule' : 'Enable rule'} relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={r.enabled ? <Pause20Regular /> : <Play20Regular />}
              aria-label={`${r.enabled ? 'Disable' : 'Enable'} ${r.name}`}
              disabled={busyName === r.name}
              onClick={() => void toggleEnabled(r)}
            />
          </Tooltip>
          <Tooltip content="Delete rule" relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<Delete20Regular />}
              aria-label={`Delete ${r.name}`}
              disabled={busyName === r.name}
              onClick={() => setConfirmDelete(r)}
            />
          </Tooltip>
        </div>
      ),
    },
  ], [busyName, openEdit, toggleEnabled]);

  return (
    <div>
      <Section
        title="Alert rules"
        actions={<Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => setTick((t) => t + 1)}>Refresh</Button>}
      >
        <MessageBar intent="info">
          <MessageBarBody>
            <strong>Scheduled query rules</strong> are the Loom-managed, KQL-evaluated alert rules you can
            create and edit here (Azure Monitor <code>scheduledQueryRules</code> REST). <strong>Metric-alert
            rules</strong> below are a read-only inventory of <code>metricAlerts</code> scoped to the Loom resource
            groups. No Microsoft Fabric required — both are Azure-native.
          </MessageBarBody>
        </MessageBar>
        {gate && <GateBar gate={gate} subject="Alerts" />}
        {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
        {rules === null || sqRules === null ? (
          <StatCardSkeleton />
        ) : (
          <div className={styles.stats}>
            {kpis.map((sc) => (
              <div key={sc.label} className={styles.stat}>
                <span className={styles.statLabel}>{sc.label}</span>
                <span className={`${styles.statValue} ${sc.accent ?? ''}`}>{sc.value}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Scheduled query alert rules"
        actions={<Button appearance="primary" icon={<Add20Regular />} onClick={openNew}>New alert rule</Button>}
      >
        {sqGate && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Authoring not configured</MessageBarTitle>
              {sqGate.remediation || sqGate.reason || 'Set the Loom alert resource group + Log Analytics resource id and grant the Console UAMI Monitoring Contributor.'}
            </MessageBarBody>
          </MessageBar>
        )}
        {sqErr && <MessageBar intent="error"><MessageBarBody>{sqErr}</MessageBarBody></MessageBar>}
        <LoomDataTable
          columns={sqColumns}
          rows={sqRules ?? []}
          getRowId={(r) => r.id}
          loading={sqRules === null}
          empty={sqGate ? 'Configure the alert resource group to author scheduled query rules.' : 'No scheduled query rules yet. Click New alert rule to create one (KQL → condition → schedule → action group).'}
          ariaLabel="Azure Monitor scheduled query alert rules"
        />
      </Section>

      <Section title="Metric-alert rules (read-only inventory)">
        <LoomDataTable
          columns={columns}
          rows={rules ?? []}
          getRowId={(r) => r.id}
          loading={rules === null}
          empty={gate ? 'Configure the Loom subscription to list alert rules.' : 'No metric-alert rules defined for the Loom resource groups.'}
          ariaLabel="Azure Monitor metric-alert rules"
        />
      </Section>

      <MonitorAlertEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        rule={editing}
        onSaved={() => { setEditorOpen(false); setTick((t) => t + 1); }}
      />

      <Dialog open={!!confirmDelete} onOpenChange={(_, d) => { if (!d.open) setConfirmDelete(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete alert rule</DialogTitle>
            <DialogContent>
              Delete <strong>{confirmDelete?.name}</strong>? This removes the Azure Monitor
              scheduled query rule. This cannot be undone.
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button
                appearance="primary"
                icon={busyName === confirmDelete?.name ? <Spinner size="tiny" /> : <Delete20Regular />}
                disabled={busyName === confirmDelete?.name}
                onClick={() => confirmDelete && void doDelete(confirmDelete)}
              >
                Delete
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

// ── Cost (M3: multi-subscription Cost Management spend + forecast + budgets) ──
interface CostBreakdownRow { key: string; cost: number; }
interface CostBudget { name: string; subscription: string; amount: number; currentSpend: number; percentUsed: number; timeGrain: string; scope: string; }
interface CostSummary {
  currency: string;
  timeframe: string;
  monthToDate: number;
  previousPeriod: number | null;
  trendPct: number | null;
  forecast: number;
  byService: CostBreakdownRow[];
  byResourceGroup: CostBreakdownRow[];
  bySubscription: CostBreakdownRow[];
  byResource: CostBreakdownRow[];
  byLocation: CostBreakdownRow[];
  daily: { date: string; cost: number }[];
  budgets: CostBudget[];
  loomResourceGroups: string[];
  subscriptions: string[];
  subscriptionErrors: { subscription: string; error: string }[];
}

const COST_TIMEFRAMES: { value: string; label: string }[] = [
  { value: 'MonthToDate', label: 'Month to date' },
  { value: 'BillingMonthToDate', label: 'Billing month to date' },
  { value: 'TheLastMonth', label: 'Last month' },
  { value: 'Last30Days', label: 'Last 30 days' },
  { value: 'Last7Days', label: 'Last 7 days' },
];

const shortSub = (s: string) => (s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s);

function CostTab({ onUnauth }: { onUnauth: () => void }) {
  const styles = useStyles();
  const [data, setData] = useState<CostSummary | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState('MonthToDate');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setData(null); setGate(null); setErr(null);
    // Cost aggregates Microsoft.CostManagement across every Loom subscription —
    // legitimately heavier than the 6s page-load budget, so use the longer
    // action budget. clientFetch relabels a timeout to a clear message.
    actionFetch(`/api/monitor/cost?timeframe=${encodeURIComponent(timeframe)}`).then(async (r) => {
      if (!alive) return;
      if (r.status === 401 || r.status === 403) { onUnauth(); setData(null); return; }
      // Read text first: a gateway 502/504 returns an HTML error page, not JSON,
      // so r.json() would throw the cryptic "Unexpected token '<'". Surface an
      // honest, actionable message instead.
      const body = await r.text();
      let j: any;
      try { j = JSON.parse(body); }
      catch {
        if (r.status === 504 || r.status === 502 || r.status === 503) {
          setErr('The Cost Management query timed out at the gateway. Azure cost queries can be slow under throttling across multiple subscriptions — wait a moment and retry, or narrow the timeframe (e.g. Last 7 days).');
        } else {
          setErr(`Cost service returned a non-JSON response (HTTP ${r.status}).`);
        }
        setData(null);
        return;
      }
      if (j.gate) { setGate(j.gate); setData(null); return; }
      if (!j.ok) { setErr(j.error || 'Failed to load cost'); setData(null); return; }
      setData(j.data as CostSummary);
    }).catch((e) => { if (alive) { setErr(String(e)); setData(null); } });
    return () => { alive = false; };
  }, [tick, timeframe, onUnauth]);

  const money = (n: number, cur: string) => `${cur === 'USD' ? '$' : ''}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${cur !== 'USD' ? ' ' + cur : ''}`;
  const tfLabel = COST_TIMEFRAMES.find((t) => t.value === timeframe)?.label || timeframe;
  const isMtd = timeframe === 'MonthToDate' || timeframe === 'BillingMonthToDate';

  const kpis = useMemo(() => {
    if (!data) return [];
    const cur = data.currency;
    const trend = data.trendPct;
    const out: { label: string; value: string | number; accent?: string }[] = [
      { label: `Total (${tfLabel})`, value: money(data.monthToDate, cur) },
    ];
    if (isMtd) out.push({ label: 'Forecast (period end)', value: money(data.forecast, cur), accent: styles.statAccentWarn });
    if (trend != null) {
      out.push({
        label: 'Trend vs prior period',
        value: `${trend > 0 ? '▲' : trend < 0 ? '▼' : ''} ${Math.abs(trend)}%`,
        accent: trend > 0 ? styles.statAccentDanger : styles.statAccentSuccess,
      });
    }
    out.push({ label: 'Subscriptions', value: data.subscriptions.length });
    out.push({ label: 'Top service', value: data.byService[0] ? data.byService[0].key.replace(/^Microsoft\.?/, '') : '—' });
    return out;
  }, [data, styles, tfLabel, isMtd]);

  const mkCols = (label: string): LoomColumn<CostBreakdownRow>[] => [
    { key: 'key', label, width: 340, render: (r) => <strong>{r.key}</strong>, getValue: (r) => r.key },
    { key: 'cost', label: `Cost (${tfLabel})`, width: 170, getValue: (r) => r.cost, render: (r) => money(r.cost, data?.currency || 'USD') },
  ];
  const loading = data === null && !gate && !err;

  return (
    <div>
      <Section
        title="Cost"
        actions={
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
            <Dropdown
              aria-label="Timeframe"
              value={tfLabel}
              selectedOptions={[timeframe]}
              onOptionSelect={(_, d) => d.optionValue && setTimeframe(d.optionValue)}
              style={{ minWidth: 200 }}
            >
              {COST_TIMEFRAMES.map((t) => <Option key={t.value} value={t.value}>{t.label}</Option>)}
            </Dropdown>
            <Button appearance="primary" icon={<ArrowSync20Regular />} onClick={() => setTick((t) => t + 1)}>Refresh</Button>
          </div>
        }
      >
        <MessageBar intent="info">
          <MessageBarBody>
            Azure spend across <strong>every CSA Loom subscription</strong> ({data ? data.subscriptions.length : '…'}) and
            resource group (Microsoft.CostManagement query REST), with breakdowns by subscription, service, resource group,
            top resource, and region — plus a run-rate forecast and Consumption budgets.
          </MessageBarBody>
        </MessageBar>
        {gate && <GateBar gate={gate} subject="Cost" />}
        {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
        {data?.subscriptionErrors?.length ? (
          <MessageBar intent="warning">
            <MessageBarBody>
              Some subscriptions couldn&apos;t be queried (grant the Console UAMI <strong>Cost Management Reader</strong> there):{' '}
              {data.subscriptionErrors.map((s) => shortSub(s.subscription)).join(', ')}.
            </MessageBarBody>
          </MessageBar>
        ) : null}
        {loading ? (
          <StatCardSkeleton />
        ) : data ? (
          <div className={styles.stats}>
            {kpis.map((s, i) => (
              <div key={i} className={styles.stat}>
                <span className={styles.statLabel}>{s.label}</span>
                <span className={`${styles.statValue} ${s.accent ?? ''}`}>{s.value}</span>
              </div>
            ))}
          </div>
        ) : null}
      </Section>

      {data && data.daily.length > 0 && (
        <Section title={`Daily spend (${tfLabel})`}>
          <MetricChart title="Daily cost" unit={data.currency}
            points={data.daily.map((d) => ({ timeStamp: d.date, value: d.cost }))} />
        </Section>
      )}

      {data && data.budgets.length > 0 && (
        <Section title="Budgets">
          <div className={styles.breakdown}>
            {data.budgets.map((b) => {
              const pct = Math.min(b.percentUsed, 100);
              const over = b.percentUsed >= 100;
              const near = b.percentUsed >= 80;
              const color = over ? tokens.colorPaletteRedBackground3 : near ? tokens.colorPaletteYellowBackground3 : tokens.colorBrandBackground;
              return (
                <div key={`${b.subscription}-${b.name}`} className={styles.breakdownRow} style={{ gridTemplateColumns: '240px 1fr 120px' }}>
                  <span className={styles.breakdownLabel} title={`${b.name} · ${shortSub(b.subscription)}`}>
                    {b.name} <span style={{ color: tokens.colorNeutralForeground3 }}>· {b.timeGrain}</span>
                  </span>
                  <span className={styles.breakdownTrack}>
                    <span className={styles.breakdownFill} style={{ width: `${pct}%`, backgroundColor: color }} />
                  </span>
                  <span className={styles.breakdownCount}>
                    {money(b.currentSpend, data.currency)} / {money(b.amount, data.currency)} ({b.percentUsed}%)
                  </span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <Section title="Cost by subscription">
        <LoomDataTable columns={mkCols('Subscription')} rows={data?.bySubscription ?? []} getRowId={(r) => r.key}
          loading={loading} empty={gate ? 'Grant Cost Management Reader to see spend by subscription.' : 'No cost recorded.'}
          ariaLabel="Cost by subscription" />
      </Section>

      <Section title="Cost by service">
        <LoomDataTable columns={mkCols('Service')} rows={data?.byService ?? []} getRowId={(r) => r.key}
          loading={loading} empty={gate ? 'Grant Cost Management Reader to see spend by service.' : 'No cost recorded.'}
          ariaLabel="Cost by service" />
      </Section>

      <Section title="Cost by resource group">
        <LoomDataTable columns={mkCols('Resource group')} rows={data?.byResourceGroup ?? []} getRowId={(r) => r.key}
          loading={loading} empty={gate ? 'Grant Cost Management Reader to see spend by resource group.' : 'No cost recorded.'}
          ariaLabel="Cost by resource group" />
      </Section>

      <Section title="Top resources by cost">
        <LoomDataTable columns={mkCols('Resource')} rows={data?.byResource ?? []} getRowId={(r) => r.key}
          loading={loading} empty={gate ? 'Grant Cost Management Reader to see spend by resource.' : 'No cost recorded.'}
          ariaLabel="Top resources by cost" />
      </Section>

      <Section title="Cost by region">
        <LoomDataTable columns={mkCols('Region')} rows={data?.byLocation ?? []} getRowId={(r) => r.key}
          loading={loading} empty={gate ? 'Grant Cost Management Reader to see spend by region.' : 'No cost recorded.'}
          ariaLabel="Cost by region" />
      </Section>

      {/* Copilot token consumption rolls into the cost context — real App
          Insights metering, honest-gated when unconfigured. */}
      <CopilotUsageInline />
    </div>
  );
}

// ── Security (Defender for Cloud — M5 + action-required) ─────────────────────
interface DefenderRec { id: string; name: string; status: string; severity: string; resource?: string; remediation?: string; category?: string; assessmentName?: string; resourceId?: string; policyDefinitionId?: string; portalLink?: string; implementationEffort?: string; userImpact?: string; }
interface DefenderAlertRow { id: string; name: string; severity: string; status: string; description?: string; resource?: string; time?: string; }
interface DefenderData {
  secureScore: { current: number; max: number; percentage: number } | null;
  recommendations: DefenderRec[];
  unhealthyCount: number;
  highSeverityCount: number;
  alerts: DefenderAlertRow[];
  portalUrl: string;
  subscriptionId?: string;
}

function sevBadge(sev: string) {
  const s = (sev || '').toLowerCase();
  if (s === 'high') return <Badge color="danger" appearance="filled">High</Badge>;
  if (s === 'medium') return <Badge color="warning" appearance="filled">Medium</Badge>;
  return <Badge color="subtle" appearance="outline">{sev || 'Low'}</Badge>;
}

function SecurityTab({ onUnauth }: { onUnauth: () => void }) {
  const styles = useStyles();
  const [data, setData] = useState<DefenderData | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // Remediation drawer (Portal steps / PowerShell / Fix via Loom).
  const [remRec, setRemRec] = useState<DefenderRec | null>(null);
  const [remTab, setRemTab] = useState<'portal' | 'powershell' | 'loom'>('portal');
  const [remBusy, setRemBusy] = useState(false);
  const [remResult, setRemResult] = useState<{ ok: boolean; message: string } | null>(null);

  const copy = (t: string) => { try { void navigator.clipboard?.writeText(t); } catch { /* noop */ } };
  const openRemediate = useCallback((rec: DefenderRec) => {
    setRemRec(rec); setRemTab('portal'); setRemResult(null);
  }, []);
  const runLoomFix = useCallback(async (rec: DefenderRec) => {
    setRemBusy(true); setRemResult(null);
    try {
      const r = await actionFetch('/api/monitor/defender/remediate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ policyDefinitionId: rec.policyDefinitionId, resourceId: rec.resourceId, name: rec.name }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.gate) { setRemResult({ ok: false, message: j.gate.message || 'Auto-fix unavailable — use the Portal steps or PowerShell.' }); return; }
      if (!j.ok) { setRemResult({ ok: false, message: j.error || `Remediation failed (HTTP ${r.status}).` }); return; }
      setRemResult({ ok: true, message: j.message || 'Remediation started.' });
    } catch (e: any) { setRemResult({ ok: false, message: e?.message || String(e) }); }
    finally { setRemBusy(false); }
  }, []);

  useEffect(() => {
    let alive = true;
    setData(null); setGate(null); setErr(null);
    // Defender for Cloud aggregates secure-score + recommendations + alerts
    // across the Loom subscriptions — heavier than the 6s default, so use the
    // longer action budget (clientFetch relabels a timeout to a clear message).
    actionFetch('/api/monitor/defender').then(async (r) => {
      if (!alive) return;
      if (r.status === 401 || r.status === 403) { onUnauth(); setData(null); return; }
      const j = await r.json();
      if (j.gate) { setGate(j.gate); setData(null); return; }
      if (!j.ok) { setErr(j.error || 'Failed to load Defender'); setData(null); return; }
      setData(j.data as DefenderData);
    }).catch((e) => { if (alive) { setErr(String(e)); setData(null); } });
    return () => { alive = false; };
  }, [tick, onUnauth]);

  const kpis = useMemo(() => {
    if (!data) return [];
    return [
      { label: 'Secure score', value: data.secureScore ? `${data.secureScore.percentage}%` : '—', accent: data.secureScore && data.secureScore.percentage < 60 ? styles.statAccentWarn : styles.statAccentSuccess },
      { label: 'Action required', value: data.unhealthyCount, accent: data.unhealthyCount > 0 ? styles.statAccentWarn : styles.statAccentSuccess },
      { label: 'High severity', value: data.highSeverityCount, accent: data.highSeverityCount > 0 ? styles.statAccentDanger : undefined },
      { label: 'Active alerts', value: data.alerts.length, accent: data.alerts.length > 0 ? styles.statAccentDanger : undefined },
    ];
  }, [data, styles]);

  const recColumns: LoomColumn<DefenderRec>[] = useMemo(() => [
    { key: 'name', label: 'Recommendation', width: 320, render: (r) => <strong>{r.name}</strong> },
    { key: 'severity', label: 'Severity', width: 110, getValue: (r) => r.severity, render: (r) => sevBadge(r.severity) },
    { key: 'resource', label: 'Resource', width: 180, render: (r) => r.resource || '—' },
    { key: 'remediation', label: 'Action / resolution', width: 340, render: (r) => r.remediation || '—' },
    {
      key: 'fix', label: 'Remediate', width: 130, sortable: false, filterable: false,
      render: (r) => r.status === 'Unhealthy'
        ? <Button size="small" appearance="primary" icon={<ShieldTask20Regular />} onClick={(e) => { e.stopPropagation(); openRemediate(r); }}>Remediate</Button>
        : <Caption1 style={{ color: tokens.colorPaletteGreenForeground1 }}>Healthy</Caption1>,
    },
  ], [openRemediate]);
  const alertColumns: LoomColumn<DefenderAlertRow>[] = useMemo(() => [
    { key: 'name', label: 'Alert', width: 300, render: (r) => <strong>{r.name}</strong> },
    { key: 'severity', label: 'Severity', width: 110, getValue: (r) => r.severity, render: (r) => sevBadge(r.severity) },
    { key: 'resource', label: 'Resource', width: 180, render: (r) => r.resource || '—' },
    { key: 'description', label: 'Description', width: 380, render: (r) => r.description || '—' },
  ], []);

  // Action-required = unhealthy recommendations (already sorted server-side).
  const actionItems = (data?.recommendations || []).filter((r) => r.status === 'Unhealthy');

  return (
    <div>
      <Section
        title="Security (Microsoft Defender for Cloud)"
        actions={<Button appearance="primary" icon={<ArrowSync20Regular />} onClick={() => setTick((t) => t + 1)}>Refresh</Button>}
      >
        <MessageBar intent="info">
          <MessageBarBody>
            Live Defender for Cloud posture for the Loom subscription — secure score, recommendations (each
            <strong> action-required</strong> item carries its resolution), and active security alerts (Microsoft.Security REST).
            {data?.portalUrl && <> Open the <a href={data.portalUrl} target="_blank" rel="noreferrer">Defender portal</a> to remediate.</>}
          </MessageBarBody>
        </MessageBar>
        {gate && <GateBar gate={gate} subject="Security" />}
        {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
        {data === null && !gate && !err ? (
          <StatCardSkeleton />
        ) : data ? (
          <div className={styles.stats}>
            {kpis.map((s) => (
              <div key={s.label} className={styles.stat}>
                <span className={styles.statLabel}>{s.label}</span>
                <span className={`${styles.statValue} ${s.accent ?? ''}`}>{s.value}</span>
              </div>
            ))}
          </div>
        ) : null}
      </Section>

      {actionItems.length > 0 && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>
            <MessageBarTitle>{actionItems.length} action{actionItems.length === 1 ? '' : 's'} required</MessageBarTitle>
            {data?.secureScore ? `Resolving these raises your secure score (currently ${data.secureScore.current}/${data.secureScore.max}).` : 'Resolve the unhealthy recommendations below to improve your security posture.'}
          </MessageBarBody>
        </MessageBar>
      )}

      <Section title="Recommendations (action required first)">
        <LoomDataTable
          columns={recColumns}
          rows={data?.recommendations ?? []}
          getRowId={(r) => r.id}
          loading={data === null && !gate && !err}
          empty={gate ? 'Grant the Console UAMI Security Reader to see Defender recommendations.' : 'No recommendations — posture is healthy.'}
          ariaLabel="Defender recommendations"
        />
      </Section>

      <Section title="Active security alerts">
        <LoomDataTable
          columns={alertColumns}
          rows={data?.alerts ?? []}
          getRowId={(r) => r.id}
          loading={data === null && !gate && !err}
          empty={gate ? 'Grant Security Reader to see alerts.' : 'No active Defender alerts.'}
          ariaLabel="Defender security alerts"
        />
      </Section>

      {/* Remediation drawer — Portal steps / PowerShell / Fix via Loom */}
      <Drawer type="overlay" position="end" open={!!remRec} onOpenChange={(_, d) => { if (!d.open) setRemRec(null); }} style={{ width: '560px', maxWidth: '94vw' }}>
        <DrawerHeader>
          <DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss24Regular />} onClick={() => setRemRec(null)} aria-label="Close" />}>
            Remediate
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          {remRec && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                {sevBadge(remRec.severity)}
                <Subtitle2>{remRec.name}</Subtitle2>
              </div>
              {(remRec.implementationEffort || remRec.userImpact) && (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  {remRec.implementationEffort ? `Effort: ${remRec.implementationEffort}` : ''}
                  {remRec.implementationEffort && remRec.userImpact ? ' · ' : ''}
                  {remRec.userImpact ? `User impact: ${remRec.userImpact}` : ''}
                </Caption1>
              )}

              <TabList selectedValue={remTab} onTabSelect={(_, d) => setRemTab(d.value as 'portal' | 'powershell' | 'loom')}>
                <Tab value="portal">Portal steps</Tab>
                <Tab value="powershell">PowerShell</Tab>
                <Tab value="loom" icon={<ShieldTask20Regular />}>Fix via Loom</Tab>
              </TabList>

              {remTab === 'portal' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                  <ol style={{ margin: 0, paddingLeft: tokens.spacingHorizontalXL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                    {portalSteps({ name: remRec.name, severity: remRec.severity, assessmentName: remRec.assessmentName, remediation: remRec.remediation, portalLink: remRec.portalLink }).map((st, i) => (
                      <li key={i}><Body1>{st}</Body1></li>
                    ))}
                  </ol>
                  <a href={defenderPortalLink({ name: remRec.name, assessmentName: remRec.assessmentName, portalLink: remRec.portalLink })} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
                    Open in the Defender portal <Open16Regular />
                  </a>
                </div>
              )}

              {remTab === 'powershell' && (() => {
                const script = powershellScript({ name: remRec.name, severity: remRec.severity, assessmentName: remRec.assessmentName, resourceId: remRec.resourceId, policyDefinitionId: remRec.policyDefinitionId, remediation: remRec.remediation, subscriptionId: data?.subscriptionId });
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                    <div><Button size="small" icon={<Copy20Regular />} onClick={() => copy(script)}>Copy script</Button></div>
                    <div className={styles.code} role="region" aria-label="PowerShell remediation script">{script}</div>
                  </div>
                );
              })()}

              {remTab === 'loom' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                  {canAutoRemediate({ name: remRec.name, policyDefinitionId: remRec.policyDefinitionId })
                    ? <Body1>This recommendation is policy-backed. Loom can start a real Azure Policy remediation task that re-evaluates compliance and applies the fix to the affected resources.</Body1>
                    : <MessageBar intent="info"><MessageBarBody>This recommendation has no auto-remediation policy. Use the <strong>Portal steps</strong> or run the <strong>PowerShell</strong> — those fully resolve it.</MessageBarBody></MessageBar>}
                  <div>
                    <Button appearance="primary" icon={<ShieldTask20Regular />} disabled={remBusy || !canAutoRemediate({ name: remRec.name, policyDefinitionId: remRec.policyDefinitionId })} onClick={() => runLoomFix(remRec)}>
                      {remBusy ? 'Starting…' : 'Fix via Loom'}
                    </Button>
                  </div>
                  {remResult && <MessageBar intent={remResult.ok ? 'success' : 'warning'}><MessageBarBody>{remResult.message}</MessageBarBody></MessageBar>}
                </div>
              )}
            </div>
          )}
        </DrawerBody>
      </Drawer>
    </div>
  );
}
