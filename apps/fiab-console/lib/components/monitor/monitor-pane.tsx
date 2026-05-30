'use client';

/**
 * MonitorPane — the CSA Loom observability surface. "Azure Monitor, but for
 * everything configured in Loom." Six tabs, every one backed by a real
 * Azure REST call via the /api/monitor/* BFF routes:
 *
 *   Overview   — resource inventory + health roll-up
 *   Metrics    — Azure Monitor metric time-series per resource (SVG charts)
 *   Logs       — Log Analytics KQL (presets + ad-hoc) → result grid
 *   Activity   — ARM Activity Log (deployments / role changes / scale ops)
 *   Items      — Cosmos-backed item activity feed (who deployed/edited what)
 *   Alerts     — Azure Monitor metric-alert rules
 *
 * Honest gates: when LOOM_LOG_ANALYTICS_WORKSPACE_ID (logs) or the
 * subscription/RGs (inventory/metrics/activity/alerts) aren't configured,
 * the relevant tab shows a Fluent MessageBar naming the exact env var — the
 * full UI still renders.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tab, TabList, Spinner, Badge, Button, Dropdown, Option, Textarea,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens, Text,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Play20Regular,
} from '@fluentui/react-icons';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { ActivityFeedPane } from '@/lib/components/activity-feed-pane';
import { MetricChart } from '@/lib/components/monitor/metric-chart';

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
  stats: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: '14px', marginBottom: '20px',
  },
  stat: {
    padding: '16px', borderRadius: '10px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: '4px',
  },
  statLabel: { fontSize: '11px', color: tokens.colorNeutralForeground3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' },
  statValue: { fontSize: '26px', fontWeight: 700, lineHeight: 1.1 },
  charts: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '14px' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
  th: {
    textAlign: 'left', padding: '8px 10px', borderBottom: `2px solid ${tokens.colorNeutralStroke2}`,
    fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em', color: tokens.colorNeutralForeground3,
    position: 'sticky', top: 0, backgroundColor: tokens.colorNeutralBackground1,
  },
  td: { padding: '8px 10px', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, verticalAlign: 'top', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '320px' },
  tableWrap: { maxHeight: '520px', overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '8px' },
  empty: {
    padding: '32px', borderRadius: '12px', border: `1px dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2, color: tokens.colorNeutralForeground2,
    fontSize: '14px', textAlign: 'center', lineHeight: 1.6,
  },
  section: { display: 'flex', flexDirection: 'column', gap: '12px' },
  resPicker: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '16px' },
  metricGroup: { marginBottom: '24px' },
  metricGroupTitle: { fontSize: '15px', fontWeight: 600, marginBottom: '8px' },
  kqlBox: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' },
  gap: { marginBottom: '12px' },
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
        This deployment hasn't set <strong>{gate.missing.join(', ')}</strong>. Set it on the
        Console container app (admin-plane bicep <code>apps[]</code> env list) to light up {subject.toLowerCase()}.
        The rest of Monitor still works.
      </MessageBarBody>
    </MessageBar>
  );
}

type TabKey = 'overview' | 'metrics' | 'logs' | 'activity' | 'items' | 'alerts';

export function MonitorPane() {
  const styles = useStyles();
  const [tab, setTab] = useState<TabKey>('overview');
  const [unauth, setUnauth] = useState(false);

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
        <Tab value="activity">Activity log</Tab>
        <Tab value="items">Deployed items</Tab>
        <Tab value="alerts">Alerts</Tab>
      </TabList>

      {tab === 'overview' && <OverviewTab onUnauth={() => setUnauth(true)} />}
      {tab === 'metrics' && <MetricsTab onUnauth={() => setUnauth(true)} />}
      {tab === 'logs' && <LogsTab onUnauth={() => setUnauth(true)} />}
      {tab === 'activity' && <ActivityTab onUnauth={() => setUnauth(true)} />}
      {tab === 'items' && <ActivityFeedPane />}
      {tab === 'alerts' && <AlertsTab onUnauth={() => setUnauth(true)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview — inventory + health
// ---------------------------------------------------------------------------

function OverviewTab({ onUnauth }: { onUnauth: () => void }) {
  const styles = useStyles();
  const [data, setData] = useState<{ resources: LoomResource[]; health: Record<string, HealthEntry> } | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setData(null); setGate(null); setErr(null);
    fetch('/api/monitor/inventory').then(async (r) => {
      if (r.status === 401 || r.status === 403) { onUnauth(); setData({ resources: [], health: {} }); return; }
      const j = await r.json();
      if (j.gate) { setGate(j.gate); setData({ resources: [], health: {} }); return; }
      if (!j.ok) { setErr(j.error || 'Failed to load inventory'); setData({ resources: [], health: {} }); return; }
      setData(j.data);
    }).catch((e) => { setErr(String(e)); setData({ resources: [], health: {} }); });
  }, [tick, onUnauth]);

  const stats = useMemo(() => {
    const res = data?.resources ?? [];
    const health = data?.health ?? {};
    const states = Object.values(health).map((h) => h.availabilityState?.toLowerCase());
    const available = states.filter((s) => s === 'available').length;
    const unhealthy = states.filter((s) => s === 'unavailable' || s === 'degraded').length;
    const types = new Set(res.map((r) => r.type)).size;
    return [
      { label: 'Resources', value: res.length },
      { label: 'Resource types', value: types },
      { label: 'Available', value: available },
      { label: 'Degraded / down', value: unhealthy },
    ];
  }, [data]);

  if (data === null) return <Spinner label="Loading resource inventory…" />;

  return (
    <div className={styles.section}>
      <div className={styles.toolbar}>
        <Button appearance="primary" icon={<ArrowSync20Regular />} onClick={() => setTick((t) => t + 1)}>Refresh</Button>
      </div>
      {gate && <GateBar gate={gate} subject="Resource inventory" />}
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      <div className={styles.stats}>
        {stats.map((s) => (
          <div key={s.label} className={styles.stat}>
            <span className={styles.statLabel}>{s.label}</span>
            <span className={styles.statValue}>{s.value}</span>
          </div>
        ))}
      </div>
      {data.resources.length === 0 && !gate ? (
        <div className={styles.empty}>No Loom resources found in the configured resource groups.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Name</th>
                <th className={styles.th}>Type</th>
                <th className={styles.th}>Resource group</th>
                <th className={styles.th}>Location</th>
                <th className={styles.th}>Health</th>
              </tr>
            </thead>
            <tbody>
              {data.resources.map((r) => {
                const h = data.health[r.id?.toLowerCase()];
                return (
                  <tr key={r.id}>
                    <td className={styles.td} title={r.name}>{r.name}</td>
                    <td className={styles.td} title={r.type}>{r.type.replace(/^Microsoft\./, '')}</td>
                    <td className={styles.td}>{r.resourceGroup}</td>
                    <td className={styles.td}>{r.location}</td>
                    <td className={styles.td}>{h ? healthBadge(h.availabilityState) : <Text size={200}>—</Text>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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
    fetch('/api/monitor/inventory').then(async (r) => {
      if (r.status === 401 || r.status === 403) { onUnauth(); setResources([]); return; }
      const j = await r.json();
      if (j.gate) { setGate(j.gate); setResources([]); return; }
      const monitorable = (j.data?.resources ?? []).filter((res: LoomResource) => METRIC_CATALOG[res.type?.toLowerCase()]);
      setResources(monitorable);
      if (monitorable[0]) setSelected(monitorable[0].id);
    }).catch(() => setResources([]));
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
    <div className={styles.section}>
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
        <div className={styles.empty}>No metric-capable resources found in the Loom resource groups.</div>
      )}
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      {loadingMetrics ? (
        <Spinner label="Querying Azure Monitor metrics…" />
      ) : results && results.length > 0 ? (
        <div className={styles.charts}>
          {results.map((m) => {
            const label = catalog.find((c) => c.metric.toLowerCase() === m.name.toLowerCase())?.label || m.name;
            return <MetricChart key={m.name} title={label} unit={m.unit} points={m.points} />;
          })}
        </div>
      ) : results && results.length === 0 && !err ? (
        <div className={styles.empty}>No metric data returned for this resource in the selected window.</div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Logs — Log Analytics KQL
// ---------------------------------------------------------------------------

function LogsTab({ onUnauth }: { onUnauth: () => void }) {
  const styles = useStyles();
  const [presets, setPresets] = useState<{ id: string; label: string; query: string }[]>([]);
  const [query, setQuery] = useState('AzureActivity\n| summarize count() by Category\n| order by count_ desc');
  const [span, setSpan] = useState('P1D');
  const [result, setResult] = useState<LogResult | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    fetch('/api/monitor/logs').then(async (r) => {
      if (r.status === 401 || r.status === 403) { onUnauth(); return; }
      const j = await r.json();
      if (j.ok) setPresets(j.data.presets);
    }).catch(() => {});
  }, [onUnauth]);

  const run = useCallback(async () => {
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
    } catch (e) { setErr(String(e)); }
    finally { setRunning(false); }
  }, [query, span]);

  return (
    <div className={styles.section}>
      {gate && <GateBar gate={gate} subject="Logs (Log Analytics)" />}
      <div className={styles.kqlBox}>
        <div className={styles.toolbar}>
          <Dropdown
            aria-label="Preset query"
            placeholder="Preset queries"
            onOptionSelect={(_, d) => {
              const p = presets.find((x) => x.id === d.optionValue);
              if (p) setQuery(p.query);
            }}
            style={{ minWidth: 280 }}
          >
            {presets.map((p) => <Option key={p.id} value={p.id}>{p.label}</Option>)}
          </Dropdown>
          <Dropdown
            aria-label="Timespan"
            value={span === 'PT1H' ? 'Last hour' : span === 'P1D' ? 'Last 24 hours' : span === 'P7D' ? 'Last 7 days' : span}
            selectedOptions={[span]}
            onOptionSelect={(_, d) => d.optionValue && setSpan(d.optionValue)}
          >
            <Option value="PT1H">Last hour</Option>
            <Option value="P1D">Last 24 hours</Option>
            <Option value="P7D">Last 7 days</Option>
          </Dropdown>
          <Button appearance="primary" icon={<Play20Regular />} onClick={run} disabled={running}>Run query</Button>
        </div>
        <Textarea
          aria-label="KQL query"
          value={query}
          onChange={(_, d) => setQuery(d.value)}
          rows={6}
          resize="vertical"
          style={{ fontFamily: 'var(--loom-font-mono, monospace)', fontSize: 13 }}
        />
      </div>
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      {running ? (
        <Spinner label="Running KQL against Log Analytics…" />
      ) : result ? (
        result.rowCount === 0 ? (
          <div className={styles.empty}>Query returned 0 rows.</div>
        ) : (
          <>
            <Text size={200}>{result.rowCount} rows</Text>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>{result.columns.map((c) => <th key={c} className={styles.th}>{c}</th>)}</tr>
                </thead>
                <tbody>
                  {result.rows.slice(0, 500).map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j} className={styles.td} title={String(cell ?? '')}>{String(cell ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity log — ARM control-plane events
// ---------------------------------------------------------------------------

function ActivityTab({ onUnauth }: { onUnauth: () => void }) {
  const styles = useStyles();
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setEvents(null); setGate(null); setErr(null);
    fetch(`/api/monitor/activity?days=${days}`).then(async (r) => {
      if (r.status === 401 || r.status === 403) { onUnauth(); setEvents([]); return; }
      const j = await r.json();
      if (j.gate) { setGate(j.gate); setEvents([]); return; }
      if (!j.ok) { setErr(j.error || 'Failed to load activity log'); setEvents([]); return; }
      setEvents(j.data.events);
    }).catch((e) => { setErr(String(e)); setEvents([]); });
  }, [days, tick, onUnauth]);

  if (events === null) return <Spinner label="Loading Azure Activity Log…" />;

  return (
    <div className={styles.section}>
      <div className={styles.toolbar}>
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
      </div>
      {gate && <GateBar gate={gate} subject="Activity log" />}
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      {events.length === 0 && !gate ? (
        <div className={styles.empty}>No control-plane activity in this window.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Time</th>
                <th className={styles.th}>Operation</th>
                <th className={styles.th}>Status</th>
                <th className={styles.th}>Resource group</th>
                <th className={styles.th}>Caller</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i}>
                  <td className={styles.td}>{new Date(e.eventTimestamp).toLocaleString()}</td>
                  <td className={styles.td} title={e.operationName}>{e.operationName}</td>
                  <td className={styles.td}>{e.status}</td>
                  <td className={styles.td}>{e.resourceGroup}</td>
                  <td className={styles.td} title={e.caller}>{e.caller}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
    setRules(null); setGate(null); setErr(null);
    fetch('/api/monitor/alerts').then(async (r) => {
      if (r.status === 401 || r.status === 403) { onUnauth(); setRules([]); return; }
      const j = await r.json();
      if (j.gate) { setGate(j.gate); setRules([]); return; }
      if (!j.ok) { setErr(j.error || 'Failed to load alert rules'); setRules([]); return; }
      setRules(j.data.rules);
    }).catch((e) => { setErr(String(e)); setRules([]); });
  }, [tick, onUnauth]);

  if (rules === null) return <Spinner label="Loading Azure Monitor alert rules…" />;

  return (
    <div className={styles.section}>
      <div className={styles.toolbar}>
        <Button appearance="primary" icon={<ArrowSync20Regular />} onClick={() => setTick((t) => t + 1)}>Refresh</Button>
      </div>
      <MessageBar intent="info">
        <MessageBarBody>
          Lists metric-alert rules scoped to the Loom resource groups (Azure Monitor <code>metricAlerts</code> REST).
          Rule authoring (create/edit) is not yet wired — manage rules in the Azure portal for now.
        </MessageBarBody>
      </MessageBar>
      {gate && <GateBar gate={gate} subject="Alerts" />}
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      {rules.length === 0 && !gate ? (
        <div className={styles.empty}>No metric-alert rules defined for the Loom resource groups.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Name</th>
                <th className={styles.th}>Enabled</th>
                <th className={styles.th}>Severity</th>
                <th className={styles.th}>Resource group</th>
                <th className={styles.th}>Description</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td className={styles.td} title={r.name}>{r.name}</td>
                  <td className={styles.td}>
                    {r.enabled ? <Badge color="success" appearance="filled">On</Badge> : <Badge color="subtle" appearance="outline">Off</Badge>}
                  </td>
                  <td className={styles.td}>{r.severity != null ? `Sev ${r.severity}` : '—'}</td>
                  <td className={styles.td}>{r.resourceGroup}</td>
                  <td className={styles.td} title={r.description}>{r.description || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
