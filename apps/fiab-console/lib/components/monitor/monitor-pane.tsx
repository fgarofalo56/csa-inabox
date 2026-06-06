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

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tab, TabList, Spinner, Badge, Button, Dropdown, Option, Textarea,
  MessageBar, MessageBarBody, MessageBarTitle, Skeleton, SkeletonItem,
  makeStyles, tokens, Text,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Play20Regular,
} from '@fluentui/react-icons';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { ActivityFeedPane } from '@/lib/components/activity-feed-pane';
import { MetricChart } from '@/lib/components/monitor/metric-chart';
import { KqlChart, type KqlChartType } from '@/lib/components/monitor/kql-chart';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

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
interface LogResult { columns: string[]; rows: unknown[][]; rowCount: number }
interface Gate { missing: string[]; message: string }

// ---- styles ----------------------------------------------------------------

const useStyles = makeStyles({
  toolbar: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '16px' },
  // KPI stat cards
  stats: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: '14px',
  },
  stat: {
    padding: '16px', borderRadius: '10px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: '4px',
  },
  statLabel: { fontSize: '11px', color: tokens.colorNeutralForeground3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' },
  statValue: { fontSize: '26px', fontWeight: 700, lineHeight: 1.1 },
  statAccentSuccess: { color: tokens.colorPaletteGreenForeground1 },
  statAccentWarn: { color: tokens.colorPaletteYellowForeground1 },
  statAccentDanger: { color: tokens.colorPaletteRedForeground1 },
  charts: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '14px' },
  // health roll-up: a horizontal stacked bar + legend
  healthRow: { display: 'flex', gap: '24px', alignItems: 'center', flexWrap: 'wrap' },
  healthBarWrap: { flex: '1 1 320px', minWidth: '240px', display: 'flex', flexDirection: 'column', gap: '8px' },
  healthBar: { display: 'flex', height: '16px', borderRadius: '8px', overflow: 'hidden', backgroundColor: tokens.colorNeutralBackground3 },
  healthLegend: { display: 'flex', gap: '16px', flexWrap: 'wrap' },
  legendItem: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: tokens.colorNeutralForeground2 },
  swatch: { width: '10px', height: '10px', borderRadius: '3px', display: 'inline-block' },
  // breakdown bars (resources by type)
  breakdown: { display: 'flex', flexDirection: 'column', gap: '10px' },
  breakdownRow: { display: 'grid', gridTemplateColumns: '200px 1fr 40px', gap: '12px', alignItems: 'center', fontSize: '12px' },
  breakdownLabel: { color: tokens.colorNeutralForeground2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  breakdownTrack: { height: '10px', borderRadius: '5px', backgroundColor: tokens.colorNeutralBackground3, overflow: 'hidden' },
  breakdownFill: { height: '100%', borderRadius: '5px', backgroundColor: tokens.colorBrandBackground },
  breakdownCount: { textAlign: 'right', color: tokens.colorNeutralForeground3, fontVariantNumeric: 'tabular-nums' },
  resPicker: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '16px' },
  kqlBox: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' },
  gap: { marginBottom: '12px' },
  skelGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '14px' },
  skelCard: { height: '92px', borderRadius: '10px' },
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

type TabKey = 'overview' | 'metrics' | 'logs' | 'diagnostics' | 'activity' | 'items' | 'alerts' | 'cost' | 'security';

export function MonitorPane() {
  const styles = useStyles();
  const [tab, setTab] = useState<TabKey>('overview');
  const [unauth, setUnauth] = useState(false);
  const onUnauth = useCallback(() => setUnauth(true), []);

  return (
    <div>
      {unauth && <SignInRequired subject="monitoring telemetry" />}
      <TabList
        selectedValue={tab}
        onTabSelect={(_, d) => setTab(d.value as TabKey)}
        className={styles.gap}
      >
        <Tab value="overview">Overview</Tab>
        <Tab value="metrics">Metrics</Tab>
        <Tab value="logs">Logs (KQL)</Tab>
        <Tab value="diagnostics">Diagnostics</Tab>
        <Tab value="activity">Activity log</Tab>
        <Tab value="items">Deployed items</Tab>
        <Tab value="alerts">Alerts</Tab>
        <Tab value="cost">Cost</Tab>
        <Tab value="security">Security</Tab>
      </TabList>

      {/* Only the active tab mounts → its fetch only fires when shown. */}
      {tab === 'overview' && <OverviewTab onUnauth={onUnauth} />}
      {tab === 'metrics' && <MetricsTab onUnauth={onUnauth} />}
      {tab === 'logs' && <LogsTab onUnauth={onUnauth} />}
      {tab === 'diagnostics' && <DiagnosticsTab onUnauth={onUnauth} />}
      {tab === 'activity' && <ActivityTab onUnauth={onUnauth} />}
      {tab === 'items' && <ActivityFeedPane />}
      {tab === 'alerts' && <AlertsTab onUnauth={onUnauth} />}
      {tab === 'cost' && <CostTab onUnauth={onUnauth} />}
      {tab === 'security' && <SecurityTab onUnauth={onUnauth} />}
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
    fetch('/api/monitor/inventory').then(async (r) => {
      if (!alive) return;
      if (r.status === 401 || r.status === 403) { onUnauth(); setResources([]); setHealth({}); return; }
      const j = await r.json();
      if (j.gate) { setGate(j.gate); setResources([]); setHealth({}); return; }
      if (!j.ok) { setErr(j.error || 'Failed to load inventory'); setResources([]); setHealth({}); return; }
      setResources(j.data.resources ?? []);
    }).catch((e) => { if (alive) { setErr(String(e)); setResources([]); setHealth({}); } });

    // 2) Resource Health — slow, parallel, best-effort. Never blocks the grid.
    fetch('/api/monitor/health').then(async (r) => {
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
                <Skeleton aria-label="Loading health roll-up"><SkeletonItem style={{ height: 16, borderRadius: 8 }} /></Skeleton>
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
    fetch('/api/monitor/inventory').then(async (r) => {
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
      const r = await fetch('/api/monitor/metrics', {
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
            <Skeleton key={i} aria-label="Loading metric"><SkeletonItem style={{ height: 132, borderRadius: 10 }} /></Skeleton>
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
    fetch('/api/monitor/logs').then(async (r) => {
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
      const r = await fetch('/api/monitor/logs', {
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
          style={{ fontFamily: 'var(--loom-font-mono, monospace)', fontSize: 13 }}
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
      const r = await fetch('/api/monitor/diagnostics');
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
      const r = await fetch('/api/monitor/diagnostics', {
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
    fetch(`/api/monitor/activity?days=${days}`).then(async (r) => {
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
// Alerts — Azure Monitor metric-alert rules
// ---------------------------------------------------------------------------

function AlertsTab({ onUnauth }: { onUnauth: () => void }) {
  const styles = useStyles();
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setRules(null); setGate(null); setErr(null);
    fetch('/api/monitor/alerts').then(async (r) => {
      if (!alive) return;
      if (r.status === 401 || r.status === 403) { onUnauth(); setRules([]); return; }
      const j = await r.json();
      if (j.gate) { setGate(j.gate); setRules([]); return; }
      if (!j.ok) { setErr(j.error || 'Failed to load alert rules'); setRules([]); return; }
      setRules(j.data.rules);
    }).catch((e) => { if (alive) { setErr(String(e)); setRules([]); } });
    return () => { alive = false; };
  }, [tick, onUnauth]);

  const kpis = useMemo(() => {
    const r = rules ?? [];
    const enabled = r.filter((x) => x.enabled).length;
    const sev01 = r.filter((x) => x.severity != null && x.severity <= 1).length;
    return [
      { label: 'Alert rules', value: r.length, accent: undefined as string | undefined },
      { label: 'Enabled', value: enabled, accent: styles.statAccentSuccess },
      { label: 'Disabled', value: r.length - enabled, accent: undefined },
      { label: 'Sev 0–1', value: sev01, accent: sev01 > 0 ? styles.statAccentWarn : undefined },
    ];
  }, [rules, styles]);

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

  return (
    <div>
      <Section
        title="Alert rules"
        actions={<Button appearance="primary" icon={<ArrowSync20Regular />} onClick={() => setTick((t) => t + 1)}>Refresh</Button>}
      >
        <MessageBar intent="info">
          <MessageBarBody>
            Lists metric-alert rules scoped to the Loom resource groups (Azure Monitor <code>metricAlerts</code> REST).
            Rule authoring (create/edit) is not yet wired — manage rules in the Azure portal for now.
          </MessageBarBody>
        </MessageBar>
        {gate && <GateBar gate={gate} subject="Alerts" />}
        {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
        {rules === null ? (
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

      <Section title="Metric-alert rules">
        <LoomDataTable
          columns={columns}
          rows={rules ?? []}
          getRowId={(r) => r.id}
          loading={rules === null}
          empty={gate ? 'Configure the Loom subscription to list alert rules.' : 'No metric-alert rules defined for the Loom resource groups.'}
          ariaLabel="Azure Monitor alert rules"
        />
      </Section>
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
    fetch(`/api/monitor/cost?timeframe=${encodeURIComponent(timeframe)}`).then(async (r) => {
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
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
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
    </div>
  );
}

// ── Security (Defender for Cloud — M5 + action-required) ─────────────────────
interface DefenderRec { id: string; name: string; status: string; severity: string; resource?: string; remediation?: string; category?: string; }
interface DefenderAlertRow { id: string; name: string; severity: string; status: string; description?: string; resource?: string; time?: string; }
interface DefenderData {
  secureScore: { current: number; max: number; percentage: number } | null;
  recommendations: DefenderRec[];
  unhealthyCount: number;
  highSeverityCount: number;
  alerts: DefenderAlertRow[];
  portalUrl: string;
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

  useEffect(() => {
    let alive = true;
    setData(null); setGate(null); setErr(null);
    fetch('/api/monitor/defender').then(async (r) => {
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
    { key: 'remediation', label: 'Action / resolution', width: 420, render: (r) => r.remediation || '—' },
  ], []);
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
        <MessageBar intent="warning" style={{ marginBottom: 12 }}>
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
    </div>
  );
}
