'use client';

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdminShell } from '@/lib/components/admin-shell';
import {
  Body1, Caption1, Badge, Spinner, Dropdown, Option, Text, Tooltip, Button,
  MessageBar, MessageBarBody, MessageBarTitle,
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Open16Regular, Dismiss24Regular, ArrowClockwise16Regular,
  Server20Regular, CloudCube20Regular, Money20Regular,
} from '@fluentui/react-icons';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { useAdminTabStyles } from '@/lib/components/ui/admin-tab-styles';
import { SectionExplainer, LearnPopover } from '@/lib/components/ui/learn-popover';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { ScaleManagePanel } from '@/lib/components/admin/scale-manage-panel';
import { MetricChart } from '@/lib/components/monitor/metric-chart';
import { OpsCopilotPane } from '@/lib/components/admin/ops-copilot-pane';

function portalUrl(id: string): string {
  // Azure portal deep-link to the resource Overview blade.
  return `https://portal.azure.com/#@/resource${id}/overview`;
}

/**
 * /admin/capacity — Live inventory of Azure resources Loom orchestrates, with
 * real cost + utilization (F5).
 *
 * Inventory: /api/admin/azure-resources (ARM via the BFF UAMI token).
 * Cost:      /api/admin/capacity/cost   (Microsoft.CostManagement per resource).
 * Util:      /api/admin/capacity/utilization (Azure Monitor metrics per type).
 *
 * No hardcoded names, costs, or "Healthy" badges — every value is real or an
 * honest gate ("⚠ No access" / "—"). Gov cloud, where Cost Management offers or
 * Fabric capacity metrics may be unavailable, falls through to honest gates and
 * the inline Monitor charts — never a blank cell (per no-vaporware.md).
 */

interface AzureRes {
  id: string;
  name: string;
  type: string;
  location: string;
  resourceGroup: string;
  sku?: string;
  kind?: string;
  provisioningState?: string;
}

interface Response {
  ok: boolean;
  subscription?: string;
  resourceGroups?: string[];
  totalResources?: number;
  byProvider?: Record<string, number>;
  resources?: AzureRes[];
  errors?: string[];
  error?: string;
  hint?: string;
}

// --- cost + utilization shared state (module-level cache + concurrency limit) -

type CostResult =
  | { status: 'loading' }
  | { status: 'ok'; cost: number; currency: string }
  | { status: 'gate'; message: string }
  | { status: 'error'; message: string };

interface MetricSeries { metricName: string; label: string; unit: string; aggregation: string; points: { timeStamp: string; value: number | null }[] }
type UtilResult =
  | { status: 'loading' }
  | { status: 'metric'; metric: MetricSeries }
  | { status: 'none' }            // no catalog metrics, or no data in window
  | { status: 'gate'; message: string }
  | { status: 'error'; message: string };

// Cache by resourceId so re-mounts (filter changes) don't refetch.
const costCache = new Map<string, CostResult>();
const utilCache = new Map<string, UtilResult>();
const detailCache = new Map<string, MetricSeries[]>();

/** Tiny concurrency limiter — Cost Management QPU quota is small (12/10s). */
function makeLimiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const pump = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const job = queue.shift()!;
    job();
  };
  return <T,>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => { active -= 1; pump(); });
      });
      pump();
    });
}
const costLimit = makeLimiter(3);
const utilLimit = makeLimiter(5);

function fmtCurrency(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${currency || '$'} ${n.toFixed(2)}`;
  }
}

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground2, lineHeight: 1.55, marginBottom: tokens.spacingVerticalL },
  explainer: { marginBottom: tokens.spacingVerticalL },
  explainerList: { marginTop: tokens.spacingVerticalS, marginBottom: 0, paddingLeft: tokens.spacingHorizontalXL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  stat: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow, transform',
    transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16, transform: 'translateY(-2px)' },
  },
  statIcon: {
    flexShrink: 0,
    width: '40px',
    height: '40px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  statBody: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  statLabel: {
    fontSize: tokens.fontSizeBase100, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3, fontWeight: 600,
  },
  statValue: { fontSize: tokens.fontSizeBase600, fontWeight: 700, marginTop: tokens.spacingVerticalXXS, lineHeight: 1.1 },
  resName: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  resIcon: {
    flexShrink: 0, width: '28px', height: '28px', borderRadius: tokens.borderRadiusMedium,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  portalLink: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontSize: tokens.fontSizeBase200 },
  costCell: { fontVariantNumeric: 'tabular-nums', fontWeight: 600 },
  spark: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  sparkSvg: { flexShrink: 0 },
  sparkVal: { fontSize: tokens.fontSizeBase200, fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  dim: { color: tokens.colorNeutralForeground3 },
  totalBar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
    marginTop: tokens.spacingVerticalM, padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
  },
  totalIcon: {
    flexShrink: 0,
    width: '36px',
    height: '36px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  totalVal: { fontSize: tokens.fontSizeBase500, fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
  detailMeta: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`, marginBottom: tokens.spacingVerticalL, fontSize: tokens.fontSizeBase300 },
  detailKey: { color: tokens.colorNeutralForeground3, fontWeight: 600 },
  detailVal: { minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  chartGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: tokens.spacingHorizontalM },
  vizLinks: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', marginBottom: tokens.spacingVerticalL },
});

/** Map an ARM resource type to an item-type slug we have a visual for. */
function resourceTypeToSlug(type: string): string {
  const t = type.toLowerCase();
  if (t.includes('sql/servers/databases')) return 'azure-sql-database';
  if (t.includes('sql/servers')) return 'azure-sql-server';
  if (t.includes('documentdb') || t.includes('cosmos')) return 'azure-cosmos-account';
  if (t.includes('eventhub')) return 'azure-eventhub';
  if (t.includes('datafactory')) return 'adf-pipeline';
  if (t.includes('databricks')) return 'databricks-cluster';
  if (t.includes('synapse')) return 'synapse-pipeline';
  if (t.includes('kusto')) return 'kql-database';
  if (t.includes('search')) return 'ai-search-index';
  if (t.includes('apimanagement')) return 'apim-api';
  if (t.includes('streamanalytics')) return 'stream-analytics-job';
  return 'environment';
}

// --- compact inline sparkline (cell-sized; the detail pane uses MetricChart) --
const SPARK_W = 110;
const SPARK_H = 26;
function MiniSpark({ points }: { points: { value: number | null }[] }) {
  const styles = useStyles();
  const vals = points.map((p) => (typeof p.value === 'number' ? p.value : null));
  const present = vals.filter((v): v is number => v != null);
  if (present.length === 0) return null;
  const lo = Math.min(...present);
  const hi = Math.max(...present);
  const span = hi - lo || 1;
  const n = vals.length;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * SPARK_W);
  const y = (v: number) => SPARK_H - 2 - ((v - lo) / span) * (SPARK_H - 4);
  let d = '';
  vals.forEach((v, i) => { if (v == null) return; const px = x(i); const py = y(v); d += d === '' ? `M ${px} ${py}` : ` L ${px} ${py}`; });
  return (
    <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} width={SPARK_W} height={SPARK_H} preserveAspectRatio="none" role="img" aria-label="utilization sparkline" className={styles.sparkSvg}>
      {d ? <path d={d} fill="none" stroke={tokens.colorBrandStroke1} strokeWidth={1.5} /> : null}
    </svg>
  );
}

function fmtNum(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}

function CostCell({ resourceId, onCost }: { resourceId: string; onCost: (id: string, cost: number, currency: string) => void }) {
  const styles = useStyles();
  const [state, setState] = useState<CostResult>(() => costCache.get(resourceId) || { status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const cached = costCache.get(resourceId);
    if (cached) {
      setState(cached);
      if (cached.status === 'ok') onCost(resourceId, cached.cost, cached.currency);
      return;
    }
    costLimit(() => clientFetch(`/api/admin/capacity/cost?resourceId=${encodeURIComponent(resourceId)}`, { cache: 'no-store' }).then((r) => r.json()))
      .then((j: any) => {
        let result: CostResult;
        if (j?.ok) result = { status: 'ok', cost: Number(j.cost) || 0, currency: j.currency || 'USD' };
        else if (j?.gate) result = { status: 'gate', message: j.gate.message || 'No access' };
        else result = { status: 'error', message: j?.error || 'error' };
        costCache.set(resourceId, result);
        if (cancelled) return;
        setState(result);
        if (result.status === 'ok') onCost(resourceId, result.cost, result.currency);
      })
      .catch((e) => { if (!cancelled) setState({ status: 'error', message: String(e) }); });
    return () => { cancelled = true; };
  }, [resourceId, onCost]);

  if (state.status === 'loading') return <Spinner size="extra-tiny" aria-label="Loading cost" />;
  if (state.status === 'ok') return <span className={styles.costCell}>{fmtCurrency(state.cost, state.currency)}</span>;
  if (state.status === 'gate') return (
    <Tooltip content={state.message} relationship="description">
      <Badge appearance="outline" color="warning" size="small">No access</Badge>
    </Tooltip>
  );
  return (
    <Tooltip content={state.message} relationship="description">
      <Caption1 className={styles.dim}>—</Caption1>
    </Tooltip>
  );
}

function UtilizationSparkCell({ res }: { res: AzureRes }) {
  const styles = useStyles();
  const [state, setState] = useState<UtilResult>(() => utilCache.get(res.id) || { status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const cached = utilCache.get(res.id);
    if (cached) { setState(cached); return; }
    utilLimit(() => clientFetch('/api/admin/capacity/utilization', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceId: res.id, resourceType: res.type, timespan: 'P1D', interval: 'PT15M' }),
      cache: 'no-store',
    }).then((r) => r.json()))
      .then((j: any) => {
        let result: UtilResult;
        if (j?.ok && j.data?.gate === 'no_metrics_for_type') result = { status: 'none' };
        else if (j?.ok && j.data?.metric) {
          const m: MetricSeries = j.data.metric;
          const hasData = (m.points || []).some((p) => typeof p.value === 'number');
          result = hasData ? { status: 'metric', metric: m } : { status: 'none' };
        } else if (j?.gate) result = { status: 'gate', message: j.gate.message || 'No access' };
        else if (j?.ok) result = { status: 'none' };
        else result = { status: 'error', message: j?.error || 'error' };
        utilCache.set(res.id, result);
        if (!cancelled) setState(result);
      })
      .catch((e) => { if (!cancelled) setState({ status: 'error', message: String(e) }); });
    return () => { cancelled = true; };
  }, [res.id, res.type]);

  if (state.status === 'loading') return <Spinner size="extra-tiny" aria-label="Loading utilization" />;
  if (state.status === 'gate') return (
    <Tooltip content={state.message} relationship="description">
      <Badge appearance="outline" color="warning" size="small">No access</Badge>
    </Tooltip>
  );
  if (state.status === 'none' || state.status === 'error') return <Caption1 className={styles.dim}>—</Caption1>;
  // metric
  const pts = state.metric.points || [];
  const last = [...pts].reverse().find((p) => typeof p.value === 'number')?.value ?? null;
  const isPct = /%|percent/i.test(`${state.metric.label} ${state.metric.unit}`);
  return (
    <Tooltip content={`${state.metric.label}${state.metric.unit ? ` (${state.metric.unit})` : ''} · ${state.metric.aggregation}`} relationship="description">
      <span className={styles.spark}>
        <MiniSpark points={pts} />
        {last != null ? <span className={styles.sparkVal}>{fmtNum(last)}{isPct ? '%' : ''}</span> : null}
      </span>
    </Tooltip>
  );
}

interface VizConfig {
  isGov: boolean;
  grafana: { endpoint: string; dashboardUid: string | null } | null;
  powerbi: { host: string; workspaceId: string; reportId: string } | null;
}

function DetailPane({ res, viz, onClose }: { res: AzureRes; viz: VizConfig | null; onClose: () => void }) {
  const styles = useStyles();
  const [metrics, setMetrics] = useState<MetricSeries[] | null>(() => detailCache.get(res.id) || null);
  const [gate, setGate] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null); setGate(null);
    clientFetch('/api/admin/capacity/utilization', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceId: res.id, resourceType: res.type, allMetrics: true, timespan: 'P1D', interval: 'PT15M' }),
      cache: 'no-store',
    }).then((r) => r.json()).then((j: any) => {
      if (j?.ok && Array.isArray(j.data?.metrics)) {
        detailCache.set(res.id, j.data.metrics);
        setMetrics(j.data.metrics);
      } else if (j?.ok && j.data?.gate === 'no_metrics_for_type') {
        setMetrics([]);
      } else if (j?.gate) {
        setGate(j.gate.message || 'No access to Azure Monitor');
      } else {
        setErr(j?.error || 'Failed to load metrics');
      }
    }).catch((e) => setErr(String(e)));
  }, [res.id, res.type]);

  useEffect(() => { if (!detailCache.has(res.id)) load(); }, [res.id, load]);

  const grafanaUrl = viz?.grafana
    ? `${viz.grafana.endpoint}${viz.grafana.dashboardUid ? `/d/${encodeURIComponent(viz.grafana.dashboardUid)}` : ''}?orgId=1&var-resource=${encodeURIComponent(res.name)}`
    : null;
  const pbiUrl = viz?.powerbi
    ? `https://app.powerbi.com/groups/${encodeURIComponent(viz.powerbi.workspaceId)}/reports/${encodeURIComponent(viz.powerbi.reportId)}?filter=Resource/Name eq '${encodeURIComponent(res.name)}'`
    : null;

  const hasMetrics = metrics && metrics.some((m) => (m.points || []).some((p) => typeof p.value === 'number'));

  return (
    <Drawer open position="end" size="large" onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DrawerHeader>
        <DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss24Regular />} onClick={onClose} aria-label="Close" />}>
          {res.name}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={styles.detailMeta}>
          <span className={styles.detailKey}>Type</span><span className={styles.detailVal}>{res.type}</span>
          <span className={styles.detailKey}>Resource group</span><span className={styles.detailVal}>{res.resourceGroup}</span>
          <span className={styles.detailKey}>Region</span><span className={styles.detailVal}>{res.location}</span>
          {res.sku || res.kind ? <><span className={styles.detailKey}>SKU / Kind</span><span className={styles.detailVal}>{res.sku || res.kind}</span></> : null}
          {res.provisioningState ? <><span className={styles.detailKey}>State</span><span className={styles.detailVal}>{res.provisioningState}</span></> : null}
        </div>

        <div className={styles.vizLinks}>
          <Button as="a" size="small" appearance="primary" icon={<Open16Regular />}
            href={portalUrl(res.id)} target="_blank" rel="noreferrer">Azure portal</Button>
          {grafanaUrl && (
            <Button as="a" size="small" icon={<Open16Regular />} href={grafanaUrl} target="_blank" rel="noreferrer">
              View in Managed Grafana
            </Button>
          )}
          {pbiUrl && (
            <Button as="a" size="small" icon={<Open16Regular />} href={pbiUrl} target="_blank" rel="noreferrer">
              View in Power BI
            </Button>
          )}
          <Button size="small" appearance="subtle" icon={<ArrowClockwise16Regular />} onClick={() => { detailCache.delete(res.id); load(); }}>
            Refresh
          </Button>
        </div>

        {gate && (
          <MessageBar intent="warning">
            <MessageBarTitle>Azure Monitor access required</MessageBarTitle>
            <MessageBarBody>{gate}</MessageBarBody>
          </MessageBar>
        )}
        {err && (
          <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>
        )}
        {!gate && !err && metrics === null && <Spinner label="Loading metrics…" />}
        {!gate && !err && metrics !== null && metrics.length === 0 && (
          <MessageBar intent="info">
            <MessageBarBody>
              Azure Monitor has no platform metrics catalogued for {res.type}. Open the
              resource in the Azure portal for its full metrics blade.
            </MessageBarBody>
          </MessageBar>
        )}
        {!gate && !err && metrics !== null && metrics.length > 0 && !hasMetrics && (
          <MessageBar intent="info">
            <MessageBarBody>
              No metric data points in the last 24h (the resource may be paused or
              idle). Charts populate once it emits telemetry.
            </MessageBarBody>
          </MessageBar>
        )}
        {!gate && !err && metrics !== null && metrics.length > 0 && (
          <div className={styles.chartGrid}>
            {metrics.map((m) => (
              <MetricChart key={m.metricName} title={m.label} unit={m.unit} points={m.points} />
            ))}
          </div>
        )}
      </DrawerBody>
    </Drawer>
  );
}

export default function CapacityPage() {
  const styles = useStyles();
  const a = useAdminTabStyles();
  const [data, setData] = useState<Response | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [q, setQ] = useState('');
  const [provider, setProvider] = useState('');
  const [selected, setSelected] = useState<AzureRes | null>(null);
  const [viz, setViz] = useState<VizConfig | null>(null);

  // Running cost total across loaded rows (for the footer sum).
  const [costTotals, setCostTotals] = useState<Record<string, number>>({});
  const currencyRef = useRef<string>('USD');
  const onCost = useCallback((id: string, cost: number, currency: string) => {
    currencyRef.current = currency || currencyRef.current;
    setCostTotals((prev) => (prev[id] === cost ? prev : { ...prev, [id]: cost }));
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    clientFetch('/api/admin/azure-resources', { signal: ctrl.signal, cache: 'no-store' }).then(r => {
      if (r.status === 401 || r.status === 403) { setUnauth(true); return null; }
      return r.json();
    }).then(d => { if (d) setData(d); })
      .catch((e) => setData({ ok: false, error: e?.name === 'AbortError' ? 'Azure resource query timed out (15s). Reload to retry.' : String(e) }))
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, []);

  // Load the rich-viz (Grafana / Power BI) deep-link config once.
  useEffect(() => {
    clientFetch('/api/admin/capacity/viz-config', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j?.ok) setViz({ isGov: j.isGov, grafana: j.grafana, powerbi: j.powerbi }); })
      .catch(() => { /* viz links are optional */ });
  }, []);

  const visibleResources = useMemo(() => {
    const all = data?.resources || [];
    const f = q.toLowerCase().trim();
    return all.filter((r) => {
      if (provider && !r.type.toLowerCase().includes(provider.toLowerCase())) return false;
      if (!f) return true;
      return (
        r.name.toLowerCase().includes(f) ||
        r.type.toLowerCase().includes(f) ||
        r.resourceGroup.toLowerCase().includes(f) ||
        (r.sku || '').toLowerCase().includes(f) ||
        (r.kind || '').toLowerCase().includes(f)
      );
    });
  }, [data, q, provider]);

  const costSum = useMemo(() => Object.values(costTotals).reduce((a, b) => a + b, 0), [costTotals]);
  const costCount = Object.keys(costTotals).length;

  const columns: LoomColumn<AzureRes>[] = useMemo(() => [
    {
      key: 'name', label: 'Name', width: 240,
      render: (r) => {
        const v = itemVisual(resourceTypeToSlug(r.type));
        const Icon = v.icon;
        return (
          <span className={styles.resName}>
            {/* dynamic: resource icon tint derives from itemVisual color */}
            <span className={styles.resIcon} style={{ backgroundColor: `${v.color}1f`, color: v.color }} aria-hidden>
              {/* dynamic: glyph color derives from itemVisual color */}
              <Icon className={a.iconSm} style={{ color: v.color }} />
            </span>
            <strong title={r.name} className={a.ellipsis}>{r.name}</strong>
          </span>
        );
      },
    },
    { key: 'type', label: 'Type', width: 200, getValue: (r) => r.type.replace('Microsoft.', ''),
      render: (r) => <Caption1>{r.type.replace('Microsoft.', '')}</Caption1> },
    { key: 'location', label: 'Region', width: 120, render: (r) => <Caption1>{r.location}</Caption1> },
    { key: 'resourceGroup', label: 'Resource group', width: 180, render: (r) => <Caption1>{r.resourceGroup}</Caption1> },
    { key: 'sku', label: 'SKU / Kind', width: 140, getValue: (r) => r.sku || r.kind || '',
      render: (r) => <Caption1>{r.sku || r.kind || '—'}</Caption1> },
    {
      key: 'cost', label: '$/mo', width: 120, filterable: false,
      getValue: (r) => costTotals[r.id] ?? -1,
      render: (r) => <CostCell resourceId={r.id} onCost={onCost} />,
    },
    {
      key: 'utilization', label: 'Utilization (24h)', width: 170, sortable: false, filterable: false,
      render: (r) => <UtilizationSparkCell res={r} />,
    },
    {
      key: 'provisioningState', label: 'State', width: 120,
      getValue: (r) => r.provisioningState || '',
      render: (r) => r.provisioningState
        ? <Badge appearance="outline" color={r.provisioningState === 'Succeeded' ? 'success' : 'warning'}>{r.provisioningState}</Badge>
        : <Caption1>—</Caption1>,
    },
    {
      key: 'portal', label: 'Portal', width: 120, sortable: false, filterable: false,
      render: (r) => (
        <a href={portalUrl(r.id)} target="_blank" rel="noreferrer" className={styles.portalLink}
           onClick={(e) => e.stopPropagation()}>
          Azure portal <Open16Regular />
        </a>
      ),
    },
  ], [styles, a, costTotals, onCost]);

  return (
    <AdminShell sectionTitle="Capacity & compute">
      <Body1 className={styles.intro}>
        Underlying Azure services Loom orchestrates. Live inventory from Azure
        Resource Manager, month-to-date cost from Cost Management, and 24h
        utilization from Azure Monitor — no hardcoded counts or numbers. Select a
        row for full metric charts. Where Cost Management or a platform metric is
        unavailable (e.g. some Azure Government offers), the cell shows an honest
        gate, never a fake value.
      </Body1>

      <div className={styles.explainer}>
        <SectionExplainer>
          A <strong>capacity</strong> here is the pool of Azure compute + storage that backs your Loom workloads — the resources listed below are what actually run your lakehouses, warehouses, pipelines, and analytics. Loom is Azure-native, so a "capacity" is one or more of these services rather than a single Microsoft Fabric SKU.
          <ul className={styles.explainerList}>
            <li>
              <strong>SKUs &amp; equivalents</strong> — where Fabric uses one F-SKU dial (F2–F2048), Loom sizes each service on its own scale: Synapse <strong>DWU</strong>, ADX vCore tiers, Databricks cluster sizes, AI Search replicas/partitions. Roughly, an F64 of Fabric compute maps to a mid-tier Synapse pool plus an ADX cluster.{' '}
              <LearnPopover
                title="Capacity &amp; SKU equivalents"
                content="Fabric bundles all engines under one capacity SKU. Loom exposes each Azure engine's native SKU so you pay only for what a workload needs — a Synapse DWU level for the warehouse, an ADX tier for real-time, Databricks node sizes for Spark, and AI Search units for retrieval."
                learnMoreHref="https://learn.microsoft.com/fabric/enterprise/licenses"
              />
            </li>
            <li>
              <strong>Pause / resume &amp; cost</strong> — most engines can pause (Synapse dedicated pools, ADX, Databricks auto-terminate) so idle compute stops billing while data persists. Month-to-date cost per resource comes live from Azure Cost Management; 24h utilization comes from Azure Monitor.{' '}
              <LearnPopover
                title="Pause, resume, and cost"
                content="Pausing a dedicated SQL pool or ADX cluster stops compute charges — you keep paying only for stored data. Resume on demand (a dedicated pool takes ~60–90s to come online). The $/mo column is real Cost Management data; where an offer has no cost or metric feed (e.g. some Azure Government offers) the cell shows an honest gate."
                tips={['Pause idle pools to pay storage only', 'Resume is on-demand (~60–90s for a dedicated pool)', 'Use "Scale & manage" below to change SKU / pause / resume in place']}
                learnMoreHref="https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/pause-and-resume-compute-portal"
              />
            </li>
          </ul>
        </SectionExplainer>
      </div>

      {unauth && <SignInRequired subject="Azure resource inventory" />}

      {!unauth && data === null && (
        <Section><Spinner label="Querying ARM…" /></Section>
      )}

      {data && !data.ok && (
        <MessageBar intent="warning">
          <MessageBarTitle>Inventory unavailable</MessageBarTitle>
          <MessageBarBody>
            {data.error}{data.hint ? ` — ${data.hint}` : ''}
          </MessageBarBody>
        </MessageBar>
      )}

      {data && data.ok && (
        <>
          <Section title="Inventory summary">
            <div className={styles.stats}>
              <div className={styles.stat}>
                <span className={styles.statIcon} aria-hidden><Server20Regular /></span>
                <div className={styles.statBody}>
                  <div className={styles.statLabel}>Total resources</div>
                  <div className={styles.statValue}>{data.totalResources}</div>
                </div>
              </div>
              {Object.entries(data.byProvider || {}).slice(0, 5).map(([p, n]) => (
                <div className={styles.stat} key={p}>
                  <span className={styles.statIcon} aria-hidden><CloudCube20Regular /></span>
                  <div className={styles.statBody}>
                    <div className={styles.statLabel}>{p}</div>
                    <div className={styles.statValue}>{n}</div>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {data.errors && data.errors.length > 0 && (
            <MessageBar intent="warning" className={a.messageBar}>
              <MessageBarBody>
                Partial result — could not list some RGs: {data.errors.join(' · ')}
              </MessageBarBody>
            </MessageBar>
          )}

          <Section
            title="Scale & manage"
            actions={
              <>
                <Caption1 className={a.muted}>
                  Change SKUs, pause / resume, scale — live Azure-native compute
                </Caption1>
                <LearnPopover
                  title="Scale & manage"
                  content="Change a service's SKU, pause or resume it, and scale replicas — applied in place via a real Azure REST call, no portal hand-off. Scale changes on Fabric capacity, APIM, and ADX are asynchronous; refresh after a few minutes to see the new state."
                  learnMoreHref="https://learn.microsoft.com/azure/azure-resource-manager/management/overview"
                />
              </>
            }
          >
            <ScaleManagePanel />
          </Section>

          <Section
            title="Ops Copilot"
            actions={
              <>
                <Caption1 className={a.muted}>
                  Natural language → ARM / config action, with approval diff + RBAC gate
                </Caption1>
                <LearnPopover
                  title="Ops Copilot"
                  content="Describe an operation in plain language (e.g. “pause the dev SQL pool”) and the copilot proposes the exact ARM/config change. You review a diff and approve before anything runs, and every action is gated by your Azure RBAC — it can never do more than you can."
                  tips={['Every change shows an approval diff first', 'Actions honor your Azure RBAC role', 'Each run is written to the audit log']}
                  learnMoreHref="https://learn.microsoft.com/azure/role-based-access-control/overview"
                />
              </>
            }
          >
            <OpsCopilotPane />
          </Section>

          <Section
            title="Resources"
            actions={
              <Caption1 className={a.muted}>
                {visibleResources.length} of {data.totalResources}
              </Caption1>
            }
          >
            <Toolbar
              search={q}
              onSearch={setQ}
              searchPlaceholder="Filter by name, type, RG, SKU…"
              actions={
                <Dropdown
                  value={provider || 'All providers'}
                  selectedOptions={[provider]}
                  onOptionSelect={(_, d) => setProvider(d.optionValue ?? '')}
                  className={a.filterControl}
                >
                  <Option value="">All providers</Option>
                  {Object.keys(data.byProvider || {}).map((p) => <Option key={p} value={p}>{p}</Option>)}
                </Dropdown>
              }
            />
            <LoomDataTable
              columns={columns}
              rows={visibleResources}
              getRowId={(r) => r.id}
              onRowClick={(r) => setSelected(r)}
              empty="No resources match the current filters."
              ariaLabel="Azure resources"
            />
            <div className={styles.totalBar}>
              <span className={styles.totalIcon} aria-hidden><Money20Regular /></span>
              <Text className={styles.statLabel}>Estimated month-to-date cost (loaded rows)</Text>
              <span className={styles.totalVal}>{fmtCurrency(costSum, currencyRef.current)}</span>
              <Caption1 className={a.muted}>
                across {costCount} resource{costCount === 1 ? '' : 's'} with Cost Management data
                {viz?.isGov ? ' · Azure Government — Power BI Embedded unavailable; Managed Grafana used for embeds' : ''}
              </Caption1>
            </div>
          </Section>
        </>
      )}

      {selected && <DetailPane res={selected} viz={viz} onClose={() => setSelected(null)} />}
    </AdminShell>
  );
}
