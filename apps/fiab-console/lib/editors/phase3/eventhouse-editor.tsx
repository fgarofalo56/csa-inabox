'use client';

/**
 * EventhouseEditor — extracted from phase3-editors.tsx (byte-for-byte move).
 *
 * Azure-native by DEFAULT: the Eventhouse item maps 1:1 to the shared Azure
 * Data Explorer (ADX / Kusto) cluster — no Microsoft Fabric / OneLake is
 * required. Its exclusive helper cluster (Eventhouse* types,
 * EventhouseCapacityPanel, EventhouseOverviewPanel, EhStatTile, and the
 * fmt/metric helpers) moves with it. The shared KQL ResultChart visual is
 * imported from ./kql-results; the shared phase3 styles hook from ./styles.
 * phase3-editors.tsx re-exports EventhouseEditor + EventhouseCapacityPanel
 * from a barrel line, so the registry resolves both unchanged.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { getItem, createItem, type WorkspaceItem } from '@/lib/api/workspaces';
import {
  Subtitle2, Caption1, Badge, Button, Input, Spinner, Field,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Label, Select, Switch, ProgressBar, SpinButton,
  tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, Play20Regular,
  Save20Regular, Add20Regular, Delete20Regular, ArrowSync20Regular,
  Apps20Regular, List20Regular, Open20Regular,
  Info20Regular, DataBarVertical20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from '../item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { ResultChart } from './kql-results';
import { useStyles } from './styles';

interface EventhouseDb {
  name: string;
  prettyName?: string;
  persistentStorage?: string;
  totalSizeMb?: number;
  retentionDays?: number;
  hotCacheDays?: number;
  tableCount?: number;
}

interface EventhouseState {
  ok: boolean;
  cluster?: string;
  defaultDatabase?: string;
  databases?: EventhouseDb[];
  sku?: { name: string; tier: string; capacity?: number };
  optimizedAutoscale?: {
    isEnabled: boolean;
    minimum: number;
    maximum: number;
    version: number;
  } | null;
  error?: string;
}

// ----- Eventhouse Capacity / throttle panel -----
// Azure-native default: the shared Azure Data Explorer cluster IS the
// eventhouse capacity backend (no Fabric / OneLake). Reads the live capacity
// policy + slot utilization from `.show cluster policy capacity` / `.show
// capacity`, layers Azure Monitor throttle metrics on top, and writes the
// ingestion capacity policy back via `.alter-merge cluster policy capacity`.
// See app/api/items/eventhouse/[id]/capacity/route.ts.

interface CapacitySlot {
  resource: string;
  total: number;
  consumed: number;
  remaining: number;
  origin: string;
}
interface CapacityMetricPoint { timeStamp: string; value: number | null }
interface CapacityMetric { name: string; unit: string; aggregation: string; points: CapacityMetricPoint[] }
interface CapacityResponse {
  ok: boolean;
  error?: string;
  configGate?: string;
  kustoClusterArmId?: string;
  capacityPolicy?: Record<string, any>;
  liveCapacity?: CapacitySlot[];
  metrics?: CapacityMetric[];
  metricsGate?: string;
}

/** Sum every point in a metric series (for Total-aggregated throttle counts). */
function metricSum(metrics: CapacityMetric[] | undefined, name: string): number | null {
  const m = metrics?.find((x) => x.name === name);
  if (!m) return null;
  let any = false;
  let total = 0;
  for (const p of m.points) {
    if (typeof p.value === 'number') { total += p.value; any = true; }
  }
  return any ? total : null;
}

/** Latest non-null point in a metric series (for util/CPU gauges). */
function metricLatest(metrics: CapacityMetric[] | undefined, name: string): number | null {
  const m = metrics?.find((x) => x.name === name);
  if (!m) return null;
  for (let i = m.points.length - 1; i >= 0; i--) {
    if (typeof m.points[i].value === 'number') return m.points[i].value as number;
  }
  return null;
}

function utilColor(pct: number): string {
  if (pct >= 90) return tokens.colorPaletteRedForeground1;
  if (pct >= 70) return tokens.colorPaletteDarkOrangeForeground1;
  return tokens.colorPaletteGreenForeground1;
}

export function EventhouseCapacityPanel({ id }: { id: string }) {
  const s = useStyles();
  const [data, setData] = useState<CapacityResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Editable ingestion capacity policy fields.
  const [editMaxOps, setEditMaxOps] = useState<number>(512);
  const [editCoreCoeff, setEditCoreCoeff] = useState<number>(0.75);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ ok: boolean; applied?: string; effectivePolicy?: string; error?: string } | null>(null);

  const loadCapacity = useCallback(async () => {
    if (!id || id === 'new') return;
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/capacity`);
      const j = (await r.json()) as CapacityResponse;
      setData(j);
      const ing = j.capacityPolicy?.IngestionCapacity;
      if (ing) {
        if (typeof ing.ClusterMaximumConcurrentOperations === 'number') setEditMaxOps(ing.ClusterMaximumConcurrentOperations);
        if (typeof ing.CoreUtilizationCoefficient === 'number') setEditCoreCoeff(ing.CoreUtilizationCoefficient);
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadCapacity(); }, [loadCapacity]);

  const applyCapacityPolicy = useCallback(async () => {
    setApplying(true);
    setApplyResult(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/capacity`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          patch: {
            IngestionCapacity: {
              ClusterMaximumConcurrentOperations: Math.floor(editMaxOps),
              CoreUtilizationCoefficient: editCoreCoeff,
            },
          },
        }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      setApplyResult(j);
      if (j.ok) loadCapacity();
    } catch (e: any) {
      setApplyResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setApplying(false);
    }
  }, [id, editMaxOps, editCoreCoeff, loadCapacity]);

  if (loading && !data) return <Spinner size="small" label="Loading capacity policy…" />;
  if (err) {
    return (
      <MessageBar intent="error">
        <MessageBarBody><MessageBarTitle>Capacity unavailable</MessageBarTitle>{err}</MessageBarBody>
      </MessageBar>
    );
  }
  if (data && !data.ok) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Azure Data Explorer not configured</MessageBarTitle>
          {data.error || 'ADX cluster unreachable.'}
        </MessageBarBody>
      </MessageBar>
    );
  }
  if (!data) return null;

  const policy = data.capacityPolicy || {};
  const ingestion = (policy.IngestionCapacity || {}) as Record<string, any>;
  const exportCap = (policy.ExportCapacity || {}) as Record<string, any>;
  const slots = data.liveCapacity || [];
  const ingestionSlot = slots.find((x) => x.resource === 'ingestions');
  const throttledQueries = metricSum(data.metrics, 'TotalNumberOfThrottledQueries');
  const throttledCommands = metricSum(data.metrics, 'TotalNumberOfThrottledCommands');
  const ingestUtil = metricLatest(data.metrics, 'IngestionUtilization');
  const cacheUtil = metricLatest(data.metrics, 'CacheUtilizationFactor');
  const cpu = metricLatest(data.metrics, 'CPU');
  const concurrentQueries = metricLatest(data.metrics, 'TotalNumberOfConcurrentQueries');

  const throttleActive =
    (ingestionSlot?.remaining === 0) ||
    (typeof throttledQueries === 'number' && throttledQueries > 0) ||
    (typeof throttledCommands === 'number' && throttledCommands > 0);

  const gaugeCards: { label: string; value: number | null; pct?: boolean }[] = [
    { label: 'Ingestion utilization', value: ingestUtil, pct: true },
    { label: 'Cache utilization', value: cacheUtil, pct: true },
    { label: 'CPU', value: cpu, pct: true },
    { label: 'Concurrent queries', value: concurrentQueries },
    { label: 'Throttled queries (15m)', value: throttledQueries },
    { label: 'Throttled commands (15m)', value: throttledCommands },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL }}>
      {/* Section 1 — Throttle state */}
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalM, flexWrap: 'wrap' }}>
        <Subtitle2>Throttle state</Subtitle2>
        <Badge appearance="filled" color={throttleActive ? 'danger' : 'success'}>
          {throttleActive ? 'Throttled' : 'Healthy'}
        </Badge>
        <Button appearance="outline" size="small" icon={<ArrowSync20Regular />} onClick={loadCapacity}>Refresh</Button>
        {ingestionSlot && (
          <Caption1>
            Ingestion slots — consumed {ingestionSlot.consumed} / {ingestionSlot.total} ({ingestionSlot.remaining} remaining), origin {ingestionSlot.origin || 'n/a'}
          </Caption1>
        )}
      </div>

      {data.metricsGate && (
        <MessageBar intent="warning">
          <MessageBarBody><MessageBarTitle>Live metrics gated</MessageBarTitle>{data.metricsGate}</MessageBarBody>
        </MessageBar>
      )}

      {/* Live throttle / utilization gauges (Azure Monitor) */}
      <div className={s.cardGrid}>
        {gaugeCards.map((g) => {
          const has = typeof g.value === 'number';
          const display = !has ? '—' : g.pct ? `${Math.round(g.value as number)}%` : String(Math.round(g.value as number));
          const pct = g.pct && has ? Math.max(0, Math.min(100, g.value as number)) : undefined;
          return (
            <div key={g.label} className={s.card}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{g.label}</Caption1>
              <div style={{ fontSize: tokens.fontSizeBase500, fontWeight: 600, color: pct !== undefined ? utilColor(pct) : undefined }}>{display}</div>
              {pct !== undefined && (
                <ProgressBar value={pct / 100} thickness="large" color={pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'success'} />
              )}
            </div>
          );
        })}
      </div>

      {/* Section 2 — Capacity slots (.show capacity) */}
      <div>
        <Subtitle2>Capacity slots</Subtitle2>
        <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalS }}>
          Live cluster slot utilization across every data-management operation type (from <code>.show capacity</code>).
        </Caption1>
        {slots.length === 0 && <Caption1>No capacity rows returned.</Caption1>}
        {slots.length > 0 && (
          <div className={s.tableWrap}>
            <Table size="small" aria-label="Cluster capacity slots">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Resource</TableHeaderCell>
                  <TableHeaderCell>Total</TableHeaderCell>
                  <TableHeaderCell>Consumed</TableHeaderCell>
                  <TableHeaderCell>Remaining</TableHeaderCell>
                  <TableHeaderCell>Utilization</TableHeaderCell>
                  <TableHeaderCell>Origin</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slots.map((slot) => {
                  const util = slot.total > 0 ? Math.round((slot.consumed / slot.total) * 100) : 0;
                  return (
                    <TableRow key={slot.resource}>
                      <TableCell>{slot.resource}</TableCell>
                      <TableCell>{slot.total}</TableCell>
                      <TableCell>{slot.consumed}</TableCell>
                      <TableCell>{slot.remaining}</TableCell>
                      <TableCell>
                        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS, minWidth: 120 }}>
                          <ProgressBar value={util / 100} color={util >= 90 ? 'error' : util >= 70 ? 'warning' : 'success'} style={{ flex: 1 }} />
                          <span style={{ color: utilColor(util) }}>{util}%</span>
                        </div>
                      </TableCell>
                      <TableCell>{slot.origin || '—'}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Section 3 — Ingestion capacity policy (editable) */}
      <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
        <Subtitle2>Ingestion capacity policy</Subtitle2>
        <Caption1>
          Caps total concurrent ingestion operations. Effective slots ={' '}
          <code>Minimum(ClusterMaximumConcurrentOperations, nodes × max(1, cores × CoreUtilizationCoefficient))</code>.
          Applied via <code>.alter-merge cluster policy capacity</code> — changes can take up to an hour to take effect.
          Microsoft recommends consulting support before changing capacity.
        </Caption1>
        <div style={{ display: 'flex', gap: tokens.spacingVerticalL, flexWrap: 'wrap' }}>
          <Field label="ClusterMaximumConcurrentOperations" hint="Hard cap on concurrent ingestions (long).">
            <Input
              type="number"
              value={String(editMaxOps)}
              onChange={(_: unknown, d: any) => setEditMaxOps(Math.max(1, parseInt(d.value, 10) || 1))}
            />
          </Field>
          <Field label="CoreUtilizationCoefficient" hint="Fraction of cores used in the formula (0–1, real).">
            <Input
              type="number"
              step={0.05}
              min={0}
              max={1}
              value={String(editCoreCoeff)}
              onChange={(_: unknown, d: any) => {
                const n = parseFloat(d.value);
                setEditCoreCoeff(Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
              }}
            />
          </Field>
        </div>
        <div>
          <Button appearance="primary" icon={<Save20Regular />} onClick={applyCapacityPolicy} disabled={applying}>
            {applying ? 'Applying…' : 'Apply ingestion policy'}
          </Button>
        </div>
        {applyResult && (
          <MessageBar intent={applyResult.ok ? 'success' : 'error'}>
            <MessageBarBody>
              <MessageBarTitle>{applyResult.ok ? 'Capacity policy applied' : 'Apply failed'}</MessageBarTitle>
              {applyResult.ok
                ? <span style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, wordBreak: 'break-all' }}>
                    {applyResult.applied}
                    {applyResult.effectivePolicy ? ` → ${applyResult.effectivePolicy.slice(0, 300)}` : ''}
                  </span>
                : applyResult.error}
            </MessageBarBody>
          </MessageBar>
        )}
      </div>

      {/* Section 4 — Export capacity (read-only) */}
      <div className={s.card}>
        <Subtitle2>Export capacity</Subtitle2>
        <Caption1 style={{ display: 'block' }}>
          ClusterMaximumConcurrentOperations: <strong>{exportCap.ClusterMaximumConcurrentOperations ?? '—'}</strong>
          {'  ·  '}CoreUtilizationCoefficient: <strong>{exportCap.CoreUtilizationCoefficient ?? '—'}</strong>
        </Caption1>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Read-only here. Use <code>.alter-merge cluster policy capacity</code> with an <code>ExportCapacity</code> patch to tune export concurrency.
        </Caption1>
      </div>

      {/* Section 5 — Per-DB CU% honest-gate */}
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Per-database CU% usage</MessageBarTitle>
          Per-database CU% is a Microsoft Fabric capacity-billing concept (F/P SKU) that does not exist on the
          Azure-native ADX backend — on the shared cluster, capacity is pooled at the cluster level. The Capacity
          slots table above shows cluster-wide slot utilization across all databases. Set
          <code> LOOM_KUSTO_FABRIC_MANAGED=true</code> only if you have opted into a Fabric-managed eventhouse.
        </MessageBarBody>
      </MessageBar>

      {/* Section 6 — Mission-critical exempt honest-gate */}
      <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
        <Subtitle2>Mission-critical exempt</Subtitle2>
        <Switch checked={false} disabled label="Exempt from capacity throttling (not applicable to ADX)" />
        <MessageBar intent="warning">
          <MessageBarBody>
            Mission-critical exempt is a workspace-level Microsoft Fabric capacity setting (requires a Fabric F or P
            SKU). It has no equivalent in the Azure Data Explorer cluster capacity policy — the shared cluster has no
            exempt toggle. No action is required.
          </MessageBarBody>
        </MessageBar>
      </div>
    </div>
  );
}

/** Human-readable size from a megabyte count (KB / MB / GB / TB). */
function fmtDbSize(mb?: number): string {
  if (typeof mb !== 'number' || !Number.isFinite(mb)) return '—';
  if (mb < 1) return `${(mb * 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  if (gb < 1024) return `${gb.toFixed(1)} GB`;
  return `${(gb / 1024).toFixed(2)} TB`;
}

type EhTimespan = 'PT1H' | 'P1D' | 'P7D' | 'P30D';
type EhTab = 'overview' | 'databases' | 'capacity';

interface EhOverviewData {
  ok: boolean;
  cluster?: string;
  timespan?: string;
  diagnostics?: {
    isHealthy: boolean;
    isScaleOutRequired: boolean;
    machinesTotal: number;
    machinesOffline: number;
    extentsTotal: number;
    totalOriginalDataSizeBytes: number;
    totalExtentSizeBytes: number;
    ingestionsLoadFactor: number;
    ingestionsInProgress: number;
    ingestionsSuccessRate: number;
  } | null;
  capacity?: { ingestions: { total: number; consumed: number; remaining: number } } | null;
  databases?: Array<{
    name: string;
    totalOriginalSizeBytes: number | null;
    totalExtentSizeBytes: number | null;
    hotDataSizeBytes: number | null;
    rowCount: number | null;
  }>;
  topQueriedDbs?: Array<{ database: string; queryCount: number }>;
  topUsers?: Array<{ user: string; queryCount: number }>;
  monitor?: {
    ingestionLatencyAvgSec: number | null;
    queryDurationAvgMs: number | null;
    cpuAvgPct: number | null;
    ingestionUtilPct: number | null;
    ingestionVolumeTotalMb: number | null;
    throttledCommandsTotal: number | null;
    throttledQueriesTotal: number | null;
  } | null;
  monitorGate?: string;
  error?: string;
}

interface EhJournalEntry {
  event: string;
  eventTimestamp: string;
  database: string;
  entityName: string;
  updatedEntityName: string;
  changeCommand: string;
  principal: string;
}

/** Bytes → human GB/MB string for the storage tiles. */
function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

const EH_TIMESPAN_LABEL: Record<EhTimespan, string> = {
  PT1H: '1H', P1D: '1D', P7D: '7D', P30D: '30D',
};

/** Small labelled metric tile used across the overview storage + monitor rows. */
function EhStatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{
      padding: tokens.spacingVerticalL, minHeight: 92, border: `1px solid ${tokens.colorNeutralStroke2}`,
      borderRadius: tokens.borderRadiusLarge, background: tokens.colorNeutralBackground1, display: 'flex',
      flexDirection: 'column', gap: tokens.spacingVerticalXXS, boxShadow: tokens.shadow4,
    }}>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{label}</Caption1>
      <div style={{ fontSize: tokens.fontSizeBase600, fontWeight: 700, color: tokens.colorBrandForeground1, lineHeight: 1.15 }}>{value}</div>
      {hint && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{hint}</Caption1>}
    </div>
  );
}

/**
 * Eventhouse system-overview dashboard — Fabric RTI Eventhouse "system overview"
 * parity rendered over the live ADX cluster. State indicator, storage breakdown,
 * per-db storage bar chart, time-range filter, ingestion/throttle Monitor tiles,
 * top-queried/users grids, and the schema-change journal. All data comes from the
 * /overview + /journal BFF routes — no mocks.
 */
function EventhouseOverviewPanel({
  s, overview, journal, timespan, loading, err, onTimespan, onRefresh,
}: {
  s: ReturnType<typeof useStyles>;
  overview: EhOverviewData | null;
  journal: EhJournalEntry[] | null;
  timespan: EhTimespan;
  loading: boolean;
  err: string | null;
  onTimespan: (ts: EhTimespan) => void;
  onRefresh: () => void;
}) {
  const diag = overview?.diagnostics || null;
  const dbs = overview?.databases || [];
  const mon = overview?.monitor || null;
  const cap = overview?.capacity || null;

  const compressionRatio =
    diag && diag.totalExtentSizeBytes > 0
      ? diag.totalOriginalDataSizeBytes / diag.totalExtentSizeBytes
      : null;
  const hotTotalBytes = dbs.reduce((a, d) => a + (d.hotDataSizeBytes ?? 0), 0);

  const chartRows: unknown[][] = dbs
    .filter((d) => (d.totalExtentSizeBytes ?? 0) > 0)
    .sort((a, b) => (b.totalExtentSizeBytes ?? 0) - (a.totalExtentSizeBytes ?? 0))
    .slice(0, 20)
    .map((d) => [d.name, Math.round((d.totalExtentSizeBytes ?? 0) / 1024 / 1024)]);

  return (
    <div className={s.pad} style={{ paddingTop: tokens.spacingVerticalM }}>
      {/* time-range filter strip */}
      <div className={s.toolbar}>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Time range</Caption1>
        {(['PT1H', 'P1D', 'P7D', 'P30D'] as EhTimespan[]).map((ts) => (
          <Button
            key={ts}
            size="small"
            appearance={timespan === ts ? 'primary' : 'outline'}
            onClick={() => onTimespan(ts)}
          >
            {EH_TIMESPAN_LABEL[ts]}
          </Button>
        ))}
        <Button
          size="small"
          appearance="outline"
          icon={<ArrowSync20Regular />}
          onClick={onRefresh}
          disabled={loading}
          style={{ marginLeft: tokens.spacingHorizontalS }}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
        {diag && (
          <Badge
            appearance="filled"
            color={diag.isHealthy ? 'success' : 'danger'}
            style={{ marginLeft: 'auto' }}
          >
            {diag.isHealthy ? 'Healthy' : 'Unhealthy'}
          </Badge>
        )}
        {diag && (
          <Caption1>
            Nodes: {diag.machinesTotal} ({diag.machinesOffline} offline) · Extents: {diag.extentsTotal.toLocaleString()}
            {diag.isScaleOutRequired ? ' · scale-out recommended' : ''}
          </Caption1>
        )}
      </div>

      {loading && !overview && <Spinner size="small" label="Loading system overview…" />}
      {err && (
        <MessageBar intent="error">
          <MessageBarBody>{err}</MessageBarBody>
        </MessageBar>
      )}
      {overview && !overview.ok && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Overview unavailable</MessageBarTitle>
            {overview.error || 'Unknown error'}
          </MessageBarBody>
        </MessageBar>
      )}

      {overview?.ok && (
        <>
          {/* storage breakdown */}
          <Subtitle2>Storage</Subtitle2>
          <div className={s.cardGrid}>
            <EhStatTile
              label="Original (uncompressed)"
              value={fmtBytes(diag?.totalOriginalDataSizeBytes)}
            />
            <EhStatTile
              label="Compressed (on disk)"
              value={fmtBytes(diag?.totalExtentSizeBytes)}
              hint={compressionRatio ? `${compressionRatio.toFixed(1)}× compression` : undefined}
            />
            <EhStatTile
              label="Hot cache (SSD)"
              value={fmtBytes(hotTotalBytes)}
              hint="sum across databases"
            />
            <EhStatTile
              label="Ingestion capacity"
              value={cap ? `${cap.ingestions.consumed}/${cap.ingestions.total}` : '—'}
              hint={cap ? `${cap.ingestions.remaining} concurrent slots free` : 'concurrent ingestions'}
            />
          </div>

          {/* per-db storage bar chart */}
          <Subtitle2>Storage by database (compressed MB)</Subtitle2>
          <div className={s.card}>
            {chartRows.length > 0 ? (
              <ResultChart columns={['Database', 'Compressed (MB)']} rows={chartRows} kind="bar" />
            ) : (
              <Caption1>No per-database storage reported yet for this cluster.</Caption1>
            )}
          </div>

          {/* ingestion + Monitor tiles */}
          <Subtitle2>Ingestion &amp; query health ({EH_TIMESPAN_LABEL[timespan]})</Subtitle2>
          {overview.monitorGate ? (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Azure Monitor metrics gated</MessageBarTitle>
                {overview.monitorGate}
              </MessageBarBody>
            </MessageBar>
          ) : null}
          <div className={s.cardGrid}>
            <EhStatTile
              label="Ingestions in progress"
              value={diag ? diag.ingestionsInProgress.toLocaleString() : '—'}
              hint={diag ? `load factor ${diag.ingestionsLoadFactor}` : undefined}
            />
            <EhStatTile
              label="Ingestion success rate"
              value={diag ? `${diag.ingestionsSuccessRate}%` : '—'}
            />
            <EhStatTile
              label="Ingested volume"
              value={mon?.ingestionVolumeTotalMb != null ? `${mon.ingestionVolumeTotalMb.toLocaleString(undefined, { maximumFractionDigits: 1 })} MB` : '—'}
              hint="Azure Monitor · total"
            />
            <EhStatTile
              label="Ingest latency"
              value={mon?.ingestionLatencyAvgSec != null ? `${mon.ingestionLatencyAvgSec.toFixed(1)} s` : '—'}
              hint="Azure Monitor · avg"
            />
            <EhStatTile
              label="Query duration"
              value={mon?.queryDurationAvgMs != null ? `${Math.round(mon.queryDurationAvgMs).toLocaleString()} ms` : '—'}
              hint="Azure Monitor · avg"
            />
            <EhStatTile
              label="Throttled commands"
              value={mon?.throttledCommandsTotal != null ? mon.throttledCommandsTotal.toLocaleString() : '—'}
              hint={mon?.throttledQueriesTotal != null ? `${mon.throttledQueriesTotal.toLocaleString()} throttled queries` : 'Azure Monitor · total'}
            />
          </div>

          {/* top queried dbs + top users */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: tokens.spacingVerticalM }}>
            <div className={s.card}>
              <Subtitle2>Top databases by query count</Subtitle2>
              <div className={s.tableWrap} style={{ marginTop: tokens.spacingVerticalS }}>
                <Table size="small" aria-label="Top queried databases">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Database</TableHeaderCell>
                      <TableHeaderCell>Queries</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(overview.topQueriedDbs || []).map((r, i) => (
                      <TableRow key={`${r.database}-${i}`}>
                        <TableCell className={s.cell}>{r.database || '(unknown)'}</TableCell>
                        <TableCell className={s.cell}>{r.queryCount.toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                    {(overview.topQueriedDbs || []).length === 0 && (
                      <TableRow><TableCell className={s.cell}>No queries in this window.</TableCell><TableCell /></TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
            <div className={s.card}>
              <Subtitle2>Top users by query count</Subtitle2>
              <div className={s.tableWrap} style={{ marginTop: tokens.spacingVerticalS }}>
                <Table size="small" aria-label="Top users">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>User</TableHeaderCell>
                      <TableHeaderCell>Queries</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(overview.topUsers || []).map((r, i) => (
                      <TableRow key={`${r.user}-${i}`}>
                        <TableCell className={s.cell}>{r.user || '(unknown)'}</TableCell>
                        <TableCell className={s.cell}>{r.queryCount.toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                    {(overview.topUsers || []).length === 0 && (
                      <TableRow><TableCell className={s.cell}>No queries in this window.</TableCell><TableCell /></TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>

          {/* schema-change journal */}
          <Subtitle2>Schema-change log</Subtitle2>
          <div className={s.tableWrap}>
            <Table size="small" aria-label="Schema-change journal">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Timestamp</TableHeaderCell>
                  <TableHeaderCell>Event</TableHeaderCell>
                  <TableHeaderCell>Database</TableHeaderCell>
                  <TableHeaderCell>Entity</TableHeaderCell>
                  <TableHeaderCell>Change command</TableHeaderCell>
                  <TableHeaderCell>Principal</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(journal || []).slice(0, 50).map((j, i) => (
                  <TableRow key={`${j.eventTimestamp}-${i}`}>
                    <TableCell className={s.cell}>{j.eventTimestamp}</TableCell>
                    <TableCell className={s.cell}>{j.event}</TableCell>
                    <TableCell className={s.cell}>{j.database}</TableCell>
                    <TableCell className={s.cell}>{j.updatedEntityName || j.entityName}</TableCell>
                    <TableCell className={s.cell} title={j.changeCommand}>
                      {j.changeCommand.length > 60 ? `${j.changeCommand.slice(0, 60)}…` : j.changeCommand}
                    </TableCell>
                    <TableCell className={s.cell}>{j.principal}</TableCell>
                  </TableRow>
                ))}
                {(!journal || journal.length === 0) && (
                  <TableRow>
                    <TableCell className={s.cell}>No metadata changes recorded.</TableCell>
                    <TableCell /><TableCell /><TableCell /><TableCell /><TableCell />
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}

export function EventhouseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const router = useRouter();
  // Workspace item record — used by "New dashboard" to resolve workspaceId so
  // the new kql-dashboard lands in the same workspace as this eventhouse. Reads
  // from the React Query cache page.tsx already seeded (same ['item','eventhouse',id]
  // key), so it does NOT fire an extra network request in normal use.
  const { data: itemRecord } = useQuery<WorkspaceItem>({
    queryKey: ['item', 'eventhouse', id],
    queryFn: () => getItem('eventhouse', id),
    enabled: !!(id && id !== 'new'),
    staleTime: 60_000,
  });
  const [state, setState] = useState<EventhouseState | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedDb, setSelectedDb] = useState<string>('');
  const [getDataOpen, setGetDataOpen] = useState(false);
  const [getDataMode, setGetDataMode] = useState<'file' | 'eventhub' | 'onelake'>('file');
  const [getDataBusy, setGetDataBusy] = useState(false);
  const [getDataResult, setGetDataResult] = useState<{ ok?: boolean; error?: string; tableName?: string; rows?: number } | null>(null);
  const [getDataTable, setGetDataTable] = useState('');
  const [getDataFile, setGetDataFile] = useState<File | null>(null);
  const [getDataHubName, setGetDataHubName] = useState('');
  const [getDataConsumer, setGetDataConsumer] = useState('$Default');
  const [getDataOneLakePath, setGetDataOneLakePath] = useState('');
  const [getDataFormat, setGetDataFormat] = useState<'auto' | 'csv' | 'json' | 'multijson' | 'parquet'>('auto');
  // ARM-populated Event Hub pickers (from /api/eventhubs/{hubs,consumergroups}).
  const [ehHubs, setEhHubs] = useState<string[]>([]);
  const [ehHubsErr, setEhHubsErr] = useState<string | null>(null);
  const [ehHubsLoading, setEhHubsLoading] = useState(false);
  const [ehConsumerGroups, setEhConsumerGroups] = useState<string[]>(['$Default']);
  const [ehCgLoading, setEhCgLoading] = useState(false);
  // Loom medallion container quick-pick (from /api/loom/storage-paths).
  const [loomContainers, setLoomContainers] = useState<Array<{ label: string; url: string }>>([]);
  // Schema preview before commit.
  const [schemaPreview, setSchemaPreview] = useState<{ columns: string[]; sampleRows: string[][]; detectedFormat?: string; sampleRowCount?: number } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [policiesOpen, setPoliciesOpen] = useState(false);
  const [hotCacheDays, setHotCacheDays] = useState<number>(7);
  const [softDeleteDays, setSoftDeleteDays] = useState<number>(30);
  const [oneLakeEnabled, setOneLakeEnabled] = useState<boolean>(false);
  const [streamingEnabled, setStreamingEnabled] = useState<boolean>(false);
  const [policiesBusy, setPoliciesBusy] = useState(false);
  const [policiesErr, setPoliciesErr] = useState<string | null>(null);
  // Bind Delta source → ADX external table + query acceleration (lakehouse endpoint).
  const [deltaOpen, setDeltaOpen] = useState(false);
  const [deltaTableName, setDeltaTableName] = useState('');
  const [deltaAbfss, setDeltaAbfss] = useState('');
  const [deltaHotDays, setDeltaHotDays] = useState<number>(7);
  const [deltaKqlView, setDeltaKqlView] = useState<boolean>(true);
  const [deltaBusy, setDeltaBusy] = useState(false);
  const [deltaResult, setDeltaResult] = useState<{
    ok?: boolean; error?: string; hint?: string;
    externalTableName?: string; accelerationPolicy?: unknown;
    kqlViewName?: string; sampleQuery?: string;
    steps?: Array<{ step: string; ok: boolean; detail?: string }>;
  } | null>(null);
  // Purge dialog state — GDPR record erasure (ADX two-step .purge).
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeTableList, setPurgeTableList] = useState<Array<{ name: string }>>([]);
  const [purgeTable, setPurgeTable] = useState('');
  const [purgeColumns, setPurgeColumns] = useState<Array<{ name: string; type: string }>>([]);
  const [purgePredicates, setPurgePredicates] = useState<Array<{ column: string; op: string; value: string }>>([{ column: '', op: '==', value: '' }]);
  const [purgeStep, setPurgeStep] = useState<'idle' | 'verified' | 'done'>('idle');
  const [purgeVerifyResult, setPurgeVerifyResult] = useState<{ numRecordsToPurge: number; estimatedPurgeExecutionTime: string; verificationToken: string } | null>(null);
  const [purgeCommitResult, setPurgeCommitResult] = useState<{ operationId: string; state: string; postPurgeCount: number | null } | null>(null);
  const [purgeConfirmText, setPurgeConfirmText] = useState('');
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeErr, setPurgeErr] = useState<string | null>(null);
  // Databases browser: tile/list view toggle + delete confirmation flow.
  const [dbView, setDbView] = useState<'tile' | 'list'>('tile');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  // Cluster-level optimized auto-scale (ARM PATCH /clusters)
  const [autoscaleOpen, setAutoscaleOpen] = useState(false);
  const [autoscaleEnabled, setAutoscaleEnabled] = useState<boolean>(false);
  const [autoscaleMin, setAutoscaleMin] = useState<number>(2);
  const [autoscaleMax, setAutoscaleMax] = useState<number>(10);
  const [autoscaleBusy, setAutoscaleBusy] = useState(false);
  const [autoscaleResult, setAutoscaleResult] = useState<{ ok: boolean; msg: string; provisioningState?: string } | null>(null);
  // "New dashboard" dialog state — Fabric Eventhouse ribbon parity.
  const [newDashOpen, setNewDashOpen] = useState(false);
  const [newDashName, setNewDashName] = useState('');
  const [newDashBusy, setNewDashBusy] = useState(false);
  const [newDashErr, setNewDashErr] = useState<string | null>(null);

  // Overview tab — live system dashboard over the ADX cluster.
  const [activeTab, setActiveTab] = useState<EhTab>('overview');
  const [timespan, setTimespan] = useState<EhTimespan>('P1D');
  const [overview, setOverview] = useState<EhOverviewData | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewErr, setOverviewErr] = useState<string | null>(null);
  const [journal, setJournal] = useState<EhJournalEntry[] | null>(null);

  // Export to OneLake/ADLS dialog state (continuous-export → Delta on ADLS Gen2)
  const [exportOpen, setExportOpen] = useState(false);
  const [exportSourceTable, setExportSourceTable] = useState('');
  const [exportName, setExportName] = useState('');
  const [exportAdlsAccount, setExportAdlsAccount] = useState('');
  const [exportContainer, setExportContainer] = useState('bronze');
  const [exportPath, setExportPath] = useState('');
  const [exportInterval, setExportInterval] = useState('1h');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportResult, setExportResult] = useState<{
    ok?: boolean; code?: string; missing?: string; hint?: string;
    error?: string; abfssPath?: string; receipt?: string; verify?: string;
  } | null>(null);
  const [continuousExports, setContinuousExports] = useState<Array<{
    name: string; externalTableName?: string; lastRunResult?: string; isRunning?: boolean;
  }>>([]);
  const [exportContainers, setExportContainers] = useState<string[]>(['bronze', 'silver', 'gold', 'landing']);
  const [exportConfigAccount, setExportConfigAccount] = useState<string>('');
  const [exportsLoading, setExportsLoading] = useState(false);

  const load = useCallback(async () => {
    // Pre-save gate: /items/eventhouse/new fires this before any record exists.
    // Skip the fetch — the editor renders its "create database" flow instead.
    if (!id || id === 'new') return;
    try {
      const r = await fetch(`/api/items/eventhouse/${id}`);
      const j = (await r.json()) as EventhouseState;
      setState(j);
      // Seed the auto-scale dialog from live ARM cluster state.
      if (j.optimizedAutoscale) {
        setAutoscaleEnabled(j.optimizedAutoscale.isEnabled);
        setAutoscaleMin(j.optimizedAutoscale.minimum);
        setAutoscaleMax(j.optimizedAutoscale.maximum);
      }
      if (j.ok && (j.databases?.length ?? 0) > 0 && !selectedDb) {
        setSelectedDb(j.defaultDatabase || j.databases![0].name);
      }
    } catch (e: any) {
      setState({ ok: false, error: e?.message || String(e) });
    }
  }, [id, selectedDb]);

  useEffect(() => { load(); }, [load]);

  const createDb = useCallback(async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setCreateErr(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/database`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setCreateErr(j.error || 'create failed'); }
      else { setNewName(''); setDialogOpen(false); load(); }
    } catch (e: any) {
      setCreateErr(e?.message || String(e));
    } finally {
      setCreating(false);
    }
  }, [id, newName, load]);

  // Open the KQL Database editor for a specific database in this eventhouse.
  // Mirrors Fabric's behavior: clicking a DB card or "Query with code" jumps
  // into the focused KQL editor for that database.
  const openKqlEditor = useCallback((dbName: string) => {
    if (!dbName) return;
    const qs = new URLSearchParams({ eventhouseId: id, database: dbName });
    router.push(`/items/kql-database/new?${qs.toString()}`);
  }, [id, router]);

  /**
   * Create a kql-dashboard item in the same workspace as this eventhouse,
   * seed a starter tile + a data source bound to the current (or default)
   * KQL database, then navigate to the new dashboard. Mirrors Fabric's
   * Eventhouse "New dashboard" ribbon action (prompt for name → create
   * dashboard pre-wired to a KQL database data source → land on canvas).
   *
   * Azure-native: Cosmos item creation via POST /api/workspaces/<wsId>/items,
   * then PUT /api/items/kql-dashboard/<id> to seed the data source + tile.
   * Tiles execute against the shared ADX cluster. No Fabric REST involved,
   * works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
   */
  const createDashboard = useCallback(async () => {
    const wsId = itemRecord?.workspaceId;
    const dbName = selectedDb || state?.defaultDatabase || '';
    const displayName =
      newDashName.trim() || `${item.displayName ?? 'Eventhouse'} — Dashboard`;
    if (!wsId) {
      // No workspace context yet (item not loaded). Fall back to empty new-item flow.
      setNewDashOpen(false);
      router.push('/items/kql-dashboard/new');
      return;
    }
    setNewDashBusy(true);
    setNewDashErr(null);
    try {
      // Step 1: create the Cosmos record (POST /api/workspaces/<wsId>/items).
      const created = await createItem(wsId, { itemType: 'kql-dashboard', displayName });
      // Step 2: seed a data source bound to the current DB + a starter tile
      //         (PUT /api/items/kql-dashboard/<id>). The starter tile runs a
      //         real `print` against the ADX database so the dashboard opens
      //         non-empty and every control is immediately editable.
      if (dbName) {
        const dsId = crypto.randomUUID();
        const seedRes = await fetch(`/api/items/kql-dashboard/${created.id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tiles: [{
              title: 'Getting started',
              kql: `print Note="Dashboard wired to the '${dbName}' KQL database. Edit this tile to query your tables."`,
              viz: 'table',
              dataSourceId: dsId,
            }],
            dataSources: [{ id: dsId, name: dbName, database: dbName }],
            parameters: [],
            baseQueries: [],
            timeRange: 'last-24h',
          }),
        });
        if (!seedRes.ok) {
          const j = await seedRes.json().catch(() => ({}));
          throw new Error(j?.error || `seed failed (HTTP ${seedRes.status})`);
        }
      }
      // Step 3: navigate. Receipt = user lands in the live KqlDashboardEditor.
      setNewDashOpen(false);
      router.push(`/items/kql-dashboard/${created.id}`);
    } catch (e: any) {
      setNewDashErr(e?.message || String(e));
    } finally {
      setNewDashBusy(false);
    }
  }, [itemRecord, state?.defaultDatabase, selectedDb, newDashName, item.displayName, router]);

  // Open the focused KQL editor for a database in a NEW browser tab — mirrors
  // Fabric's per-object "Open in new tab" affordance.
  const openKqlEditorNewTab = useCallback((dbName: string) => {
    if (!dbName) return;
    const qs = new URLSearchParams({ eventhouseId: id, database: dbName });
    window.open(`/items/kql-database/new?${qs.toString()}`, '_blank', 'noopener');
  }, [id]);

  // Delete a KQL database via ARM (Microsoft.Kusto/clusters/databases). After
  // a successful delete, re-load the cluster so the tile/row disappears.
  const deleteDb = useCallback(async (dbName: string) => {
    setDeleting(true);
    setDeleteErr(null);
    try {
      const r = await fetch(
        `/api/items/eventhouse/${id}/database?name=${encodeURIComponent(dbName)}`,
        { method: 'DELETE' },
      );
      const j = await r.json();
      if (!j.ok) { setDeleteErr(j.error || 'delete failed'); return; }
      setDeleteTarget(null);
      if (selectedDb === dbName) setSelectedDb('');
      load();
    } catch (e: any) {
      setDeleteErr(e?.message || String(e));
    } finally {
      setDeleting(false);
    }
  }, [id, selectedDb, load]);

  // Ingest a file (CSV / JSON / parquet) into a KQL table. Calls the
  // existing /api/items/eventhouse/{id}/ingest BFF route; honest error if
  // not yet provisioned.
  const onIngest = useCallback(async () => {
    if (!selectedDb || !getDataTable.trim()) {
      setGetDataResult({ ok: false, error: 'Database + table name required' }); return;
    }
    setGetDataBusy(true);
    setGetDataResult(null);
    try {
      if (getDataMode === 'file') {
        if (!getDataFile) { setGetDataResult({ ok: false, error: 'Pick a file first' }); return; }
        const fd = new FormData();
        fd.set('database', selectedDb);
        fd.set('table', getDataTable.trim());
        fd.set('file', getDataFile);
        const r = await fetch(`/api/items/eventhouse/${id}/ingest`, { method: 'POST', body: fd });
        const ct = r.headers.get('content-type') || '';
        const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
        setGetDataResult(j);
      } else if (getDataMode === 'eventhub') {
        const r = await fetch(`/api/items/eventhouse/${id}/ingest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'eventhub', database: selectedDb, table: getDataTable.trim(),
            eventHubName: getDataHubName.trim(), consumerGroup: getDataConsumer.trim() || '$Default',
          }),
        });
        const ct = r.headers.get('content-type') || '';
        const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
        setGetDataResult(j);
      } else {
        const r = await fetch(`/api/items/eventhouse/${id}/ingest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'onelake', database: selectedDb, table: getDataTable.trim(),
            oneLakePath: getDataOneLakePath.trim(), format: getDataFormat,
          }),
        });
        const ct = r.headers.get('content-type') || '';
        const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
        setGetDataResult(j);
      }
    } catch (e: any) {
      setGetDataResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setGetDataBusy(false);
    }
  }, [id, selectedDb, getDataMode, getDataTable, getDataFile, getDataHubName, getDataConsumer, getDataOneLakePath, getDataFormat]);

  // ---- Get-Data wizard: ARM-populated pickers + schema preview ----

  // Load the deployment's Event Hubs from real ARM (/api/eventhubs/hubs) when
  // the dialog opens in eventhub mode. Honest 503 gate is surfaced verbatim.
  useEffect(() => {
    if (!getDataOpen || getDataMode !== 'eventhub') return;
    let cancelled = false;
    setEhHubsLoading(true);
    setEhHubsErr(null);
    fetch('/api/eventhubs/hubs')
      .then((r) => r.json())
      .then((j: any) => {
        if (cancelled) return;
        if (j?.ok) setEhHubs((j.hubs as Array<{ name: string }>).map((h) => h.name).filter(Boolean));
        else if (j?.code === 'not_configured') setEhHubsErr(`Event Hubs namespace not configured — set ${j.missing}.`);
        else setEhHubsErr(j?.error || 'Failed to list event hubs');
      })
      .catch((e: any) => { if (!cancelled) setEhHubsErr(e?.message || String(e)); })
      .finally(() => { if (!cancelled) setEhHubsLoading(false); });
    return () => { cancelled = true; };
  }, [getDataOpen, getDataMode]);

  // Load consumer groups for the chosen hub (real ARM list).
  useEffect(() => {
    if (!getDataHubName) { setEhConsumerGroups(['$Default']); return; }
    let cancelled = false;
    setEhCgLoading(true);
    fetch(`/api/eventhubs/consumergroups?eventHub=${encodeURIComponent(getDataHubName)}`)
      .then((r) => r.json())
      .then((j: any) => {
        if (cancelled) return;
        if (j?.ok) {
          const names = (j.consumerGroups as Array<{ name: string }>).map((c) => c.name).filter(Boolean);
          setEhConsumerGroups(names.length ? names : ['$Default']);
        }
      })
      .catch(() => { /* keep the $Default fallback */ })
      .finally(() => { if (!cancelled) setEhCgLoading(false); });
    return () => { cancelled = true; };
  }, [getDataHubName]);

  // Load Loom medallion container roots for the ADLS quick-pick (env-sourced).
  useEffect(() => {
    if (!getDataOpen) return;
    let cancelled = false;
    fetch('/api/loom/storage-paths')
      .then((r) => r.json())
      .then((j: any) => { if (!cancelled && j?.ok) setLoomContainers(j.containers || []); })
      .catch(() => { /* quick-pick row simply stays hidden */ });
    return () => { cancelled = true; };
  }, [getDataOpen]);

  // Reset the picker/preview state whenever the source mode changes so a stale
  // schema from a previous source never lingers.
  useEffect(() => {
    setSchemaPreview(null);
    setPreviewErr(null);
    setGetDataResult(null);
  }, [getDataMode, getDataOpen]);

  // File mode: detect schema client-side from the first 16 KB (no round-trip).
  useEffect(() => {
    if (getDataMode !== 'file' || !getDataFile) { return; }
    const slice = getDataFile.slice(0, 16 * 1024);
    slice.text().then((text) => {
      try {
        const lower = (getDataFile.name || '').toLowerCase();
        const isJson = /\.(json|jsonl|ndjson)$/.test(lower) || text.trim().startsWith('[') || text.trim().startsWith('{');
        if (isJson) {
          const trimmed = text.trim();
          let rows: any[] = [];
          if (trimmed.startsWith('[')) {
            // tolerate truncation: parse leading complete objects
            try { rows = JSON.parse(trimmed); } catch { rows = []; }
          } else {
            rows = trimmed.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          }
          if (Array.isArray(rows) && rows.length) {
            const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r ?? {}))));
            const sampleRows = rows.slice(0, 5).map((r) => keys.map((k) => { const v = r?.[k]; return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); }));
            setSchemaPreview({ columns: keys, sampleRows, detectedFormat: 'json', sampleRowCount: rows.length });
            return;
          }
        }
        // CSV fallback
        const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
        if (lines.length && !/\n$/.test(text) && lines.length > 1) lines.pop();
        if (!lines.length) { setSchemaPreview(null); return; }
        const header = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim());
        const sampleRows = lines.slice(1, 6).map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '')));
        setSchemaPreview({ columns: header, sampleRows, detectedFormat: 'csv', sampleRowCount: Math.max(0, lines.length - 1) });
      } catch {
        setSchemaPreview(null);
      }
    }).catch(() => setSchemaPreview(null));
  }, [getDataMode, getDataFile]);

  // URL mode: peek the blob/ADLS object on the server (MI or SAS) and preview.
  const onPreview = useCallback(async () => {
    if (!getDataOneLakePath.trim()) return;
    setPreviewBusy(true);
    setPreviewErr(null);
    setSchemaPreview(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/ingest/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: getDataOneLakePath.trim(), format: getDataFormat }),
      });
      const j = await r.json();
      if (j?.ok) setSchemaPreview({ columns: j.columns, sampleRows: j.sampleRows, detectedFormat: j.detectedFormat, sampleRowCount: j.sampleRowCount });
      else setPreviewErr(j?.error || 'preview failed');
    } catch (e: any) {
      setPreviewErr(e?.message || String(e));
    } finally {
      setPreviewBusy(false);
    }
  }, [id, getDataOneLakePath, getDataFormat]);

  // Apply per-database caching + retention policies via the .alter database
  // policy KQL management commands.
  const applyPolicies = useCallback(async () => {
    if (!selectedDb) return;
    setPoliciesBusy(true);
    setPoliciesErr(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/policies`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          database: selectedDb,
          hotCacheDays, softDeleteDays, oneLakeAvailability: oneLakeEnabled,
          enableStreamingIngest: streamingEnabled,
        }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) setPoliciesErr(j.error || 'policy apply failed');
      else { setPoliciesOpen(false); load(); }
    } catch (e: any) {
      setPoliciesErr(e?.message || String(e));
    } finally {
      setPoliciesBusy(false);
    }
  }, [id, selectedDb, hotCacheDays, softDeleteDays, oneLakeEnabled, streamingEnabled, load]);

  // Load active continuous-export jobs + the ADLS picker config (account +
  // visible containers) from the real backend (GET .../continuous-export).
  const loadExports = useCallback(async () => {
    if (!selectedDb) return;
    setExportsLoading(true);
    try {
      const r = await fetch(
        `/api/items/eventhouse/${id}/continuous-export?database=${encodeURIComponent(selectedDb)}`,
      );
      const j = await r.json();
      if (j.ok) {
        if (Array.isArray(j.exports)) setContinuousExports(j.exports);
        if (j.config?.containers?.length) setExportContainers(j.config.containers);
        if (typeof j.config?.adlsAccount === 'string') setExportConfigAccount(j.config.adlsAccount);
      }
    } catch { /* best-effort — gate surfaces on POST */ }
    finally { setExportsLoading(false); }
  }, [id, selectedDb]);

  // Create / replace a continuous Delta-export job to ADLS Gen2 (OneLake-style
  // availability via Azure-native ADX continuous-export — no Fabric workspace).
  const submitExport = useCallback(async () => {
    setExportBusy(true);
    setExportResult(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/continuous-export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          database:    selectedDb,
          sourceTable: exportSourceTable.trim(),
          exportName:  exportName.trim(),
          adlsAccount: exportAdlsAccount.trim() || undefined,
          container:   exportContainer,
          path:        exportPath.trim(),
          interval:    exportInterval,
        }),
      });
      const j = await r.json();
      setExportResult(j);
      if (j.ok) { void loadExports(); }
    } catch (e: any) {
      setExportResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setExportBusy(false);
    }
  }, [id, selectedDb, exportSourceTable, exportName, exportAdlsAccount,
      exportContainer, exportPath, exportInterval, loadExports]);

  // Cluster-level optimized auto-scale via ARM PATCH /clusters. Azure-native;
  // no Fabric workspace involved. Honest 422 gate on Dev/Basic SKUs.
  const applyAutoscale = useCallback(async () => {
    setAutoscaleBusy(true);
    setAutoscaleResult(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/policies`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          optimizedAutoscale: {
            isEnabled: autoscaleEnabled,
            minimum: autoscaleMin,
            maximum: autoscaleMax,
          },
        }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) {
        setAutoscaleResult({ ok: false, msg: j.error || 'Auto-scale update failed' });
      } else {
        setAutoscaleResult({
          ok: true,
          msg: 'Optimized auto-scale settings applied.',
          provisioningState: j.provisioningState,
        });
        load();
      }
    } catch (e: any) {
      setAutoscaleResult({ ok: false, msg: e?.message || String(e) });
    } finally {
      setAutoscaleBusy(false);
    }
  }, [id, autoscaleEnabled, autoscaleMin, autoscaleMax, load]);

  // Purge records (GDPR erasure) — ADX two-step .purge against the DM endpoint.
  // Open: load tables for the selected database (table picker source).
  const openPurgeDialog = useCallback(async () => {
    setPurgeOpen(true);
    setPurgeStep('idle');
    setPurgeVerifyResult(null);
    setPurgeCommitResult(null);
    setPurgeConfirmText('');
    setPurgeErr(null);
    setPurgeTable('');
    setPurgeColumns([]);
    setPurgePredicates([{ column: '', op: '==', value: '' }]);
    if (!selectedDb) return;
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/purge?database=${encodeURIComponent(selectedDb)}`);
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (j.ok) setPurgeTableList(j.tables || []);
      else setPurgeErr(j.error || 'failed to load tables');
    } catch (e: any) {
      setPurgeErr(e?.message || String(e));
    }
  }, [id, selectedDb]);

  // Table picked → load its columns (predicate-builder source).
  const onPurgeTableChange = useCallback(async (tableName: string) => {
    setPurgeTable(tableName);
    setPurgeColumns([]);
    if (!selectedDb || !tableName) return;
    try {
      const r = await fetch(
        `/api/items/eventhouse/${id}/purge?database=${encodeURIComponent(selectedDb)}&table=${encodeURIComponent(tableName)}`,
      );
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false };
      if (j.ok) setPurgeColumns(j.columns || []);
    } catch { /* non-blocking — predicate column can still be picked once reloaded */ }
  }, [id, selectedDb]);

  // Step 1 — verify: preview record count + obtain the verification token.
  const runPurgeVerify = useCallback(async () => {
    if (!selectedDb || !purgeTable) return;
    setPurgeBusy(true);
    setPurgeErr(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/purge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ database: selectedDb, table: purgeTable, predicates: purgePredicates, step: 'verify' }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) { setPurgeErr(j.error || 'verify failed'); return; }
      setPurgeVerifyResult({
        numRecordsToPurge: j.numRecordsToPurge,
        estimatedPurgeExecutionTime: j.estimatedPurgeExecutionTime,
        verificationToken: j.verificationToken,
      });
      setPurgeStep('verified');
    } catch (e: any) {
      setPurgeErr(e?.message || String(e));
    } finally {
      setPurgeBusy(false);
    }
  }, [id, selectedDb, purgeTable, purgePredicates]);

  // Step 2 — commit: irreversibly schedule the purge using the token + typed confirm.
  const runPurgeCommit = useCallback(async () => {
    if (!selectedDb || !purgeTable || !purgeVerifyResult?.verificationToken) return;
    if (purgeConfirmText !== 'PURGE') { setPurgeErr('Type PURGE exactly to confirm'); return; }
    setPurgeBusy(true);
    setPurgeErr(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/purge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          database: selectedDb, table: purgeTable, predicates: purgePredicates,
          step: 'commit', verificationToken: purgeVerifyResult.verificationToken,
        }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) { setPurgeErr(j.error || 'commit failed'); return; }
      setPurgeCommitResult({ operationId: j.operationId, state: j.state, postPurgeCount: j.postPurgeCount });
      setPurgeStep('done');
    } catch (e: any) {
      setPurgeErr(e?.message || String(e));
    } finally {
      setPurgeBusy(false);
    }
  }, [id, selectedDb, purgeTable, purgePredicates, purgeVerifyResult, purgeConfirmText]);

  // Bind an ADLS Gen2 Delta path to an ADX external table + query acceleration.
  // Real backend: .create-or-alter external table kind=delta /
  // .alter external table policy query_acceleration via the continuous-export
  // BFF route. Lakehouse/warehouse Delta becomes KQL-queryable within seconds —
  // no Fabric / OneLake dependency.
  const onBindDelta = useCallback(async () => {
    if (!selectedDb || !deltaTableName.trim() || !deltaAbfss.trim()) {
      setDeltaResult({ ok: false, error: 'Database, external table name, and ADLS abfss:// path are required' });
      return;
    }
    setDeltaBusy(true);
    setDeltaResult(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/continuous-export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          database: selectedDb,
          tableName: deltaTableName.trim(),
          abfssUri: deltaAbfss.trim(),
          hotDays: deltaHotDays,
          createKqlView: deltaKqlView,
        }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      setDeltaResult(j);
    } catch (e: any) {
      setDeltaResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setDeltaBusy(false);
    }
  }, [id, selectedDb, deltaTableName, deltaAbfss, deltaHotDays, deltaKqlView]);

  const hasDbs = (state?.databases?.length ?? 0) > 0;
  const dbCount = state?.databases?.length ?? 0;
  // Dev(No SLA)/Basic-tier SKUs reject optimizedAutoscale — drives the honest gate.
  const isDevSku = (state?.sku?.tier || '').toLowerCase() === 'basic'
    || (state?.sku?.name || '').toLowerCase().startsWith('dev(no sla)');

  // Load the live system-overview + schema-change journal for the current window.
  const loadOverview = useCallback(async () => {
    if (!id || id === 'new') return;
    setOverviewLoading(true);
    setOverviewErr(null);
    try {
      const [ovRes, jRes] = await Promise.all([
        fetch(`/api/items/eventhouse/${id}/overview?timespan=${timespan}`),
        fetch(`/api/items/eventhouse/${id}/journal?limit=50`),
      ]);
      const ov = (await ovRes.json()) as EhOverviewData;
      setOverview(ov);
      const jr = await jRes.json();
      if (jr?.ok) setJournal((jr.entries || []) as EhJournalEntry[]);
      else setJournal([]);
    } catch (e: any) {
      setOverviewErr(e?.message || String(e));
    } finally {
      setOverviewLoading(false);
    }
  }, [id, timespan]);

  useEffect(() => {
    if (activeTab === 'overview') loadOverview();
  }, [activeTab, loadOverview]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'New', actions: [
        { label: 'New KQL database', onClick: () => setDialogOpen(true) },
        { label: 'KQL database shortcut', disabled: true,
          title: 'ReadOnlyFollowing (shortcut) databases require a Fabric-managed eventhouse; the standalone ADX cluster hosts ReadWrite databases only' },
        { label: 'New dashboard',
          onClick: () => { setNewDashName(''); setNewDashErr(null); setNewDashOpen(true); },
          title: 'Create a Real-Time Dashboard pre-wired to this eventhouse’s KQL database' },
      ]},
      { label: 'Query', actions: [
        { label: 'Query with code', onClick: hasDbs && selectedDb ? () => openKqlEditor(selectedDb) : undefined,
          disabled: !hasDbs || !selectedDb,
          title: !hasDbs ? 'create a KQL database first' : !selectedDb ? 'select a database below' : undefined },
        { label: 'Get data', onClick: hasDbs ? () => setGetDataOpen(true) : undefined,
          disabled: !hasDbs, title: !hasDbs ? 'create a KQL database first' : undefined },
      ]},
      { label: 'Manage', actions: [
        { label: 'Data policies', onClick: hasDbs && selectedDb ? () => setPoliciesOpen(true) : undefined,
          disabled: !hasDbs || !selectedDb,
          title: !hasDbs ? 'create a KQL database first' : !selectedDb ? 'select a database below' : undefined },
        { label: 'Bind Delta source', onClick: hasDbs && selectedDb ? () => { setDeltaResult(null); setDeltaOpen(true); } : undefined,
          disabled: !hasDbs || !selectedDb,
          title: !hasDbs ? 'create a KQL database first' : !selectedDb ? 'select a database below' : undefined },
        { label: 'OneLake availability', onClick: hasDbs && selectedDb ? () => { setOneLakeEnabled(true); setPoliciesOpen(true); } : undefined,
          disabled: !hasDbs || !selectedDb,
          title: !hasDbs || !selectedDb ? 'pick a database first' : undefined },
        { label: 'Export to OneLake/ADLS',
          onClick: hasDbs && selectedDb
            ? () => { setExportResult(null); setExportOpen(true); void loadExports(); }
            : undefined,
          disabled: !hasDbs || !selectedDb,
          title: !hasDbs || !selectedDb
            ? 'pick a database first'
            : 'configure continuous Delta export to ADLS Gen2 / OneLake' },
        { label: 'Purge records (GDPR)', onClick: hasDbs && selectedDb ? openPurgeDialog : undefined,
          disabled: !hasDbs || !selectedDb,
          title: !hasDbs || !selectedDb
            ? 'select a database first'
            : 'Predicate-based GDPR erasure via ADX .purge (two-step verify→commit, irreversible)' },
        { label: 'Auto-scale', onClick: state?.ok ? () => { setAutoscaleResult(null); setAutoscaleOpen(true); } : undefined,
          disabled: !state?.ok,
          title: !state?.ok ? 'cluster must be reachable' : 'configure optimized auto-scale (min/max instances)' },
        { label: 'Streaming ingest', onClick: hasDbs && selectedDb ? () => { setStreamingEnabled(true); setPoliciesOpen(true); } : undefined,
          disabled: !hasDbs || !selectedDb,
          title: !hasDbs || !selectedDb ? 'pick a database first' : 'Enable/disable low-latency streaming ingestion on the cluster' },
        { label: 'Capacity & throttling', onClick: () => setActiveTab('capacity'),
          title: 'View capacity policy + live throttle metrics' },
      ]},
      { label: 'Refresh', actions: [
        { label: 'Refresh', onClick: load },
      ]},
    ]},
  ], [hasDbs, selectedDb, openKqlEditor, load, loadExports, openPurgeDialog, state?.ok]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        <div className={s.toolbar}>
          <Badge appearance="filled" color="brand">Eventhouse · shared cluster</Badge>
          <Caption1>{state?.cluster || 'loading…'}</Caption1>
          <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={load}>Refresh</Button>
          <Dialog open={dialogOpen} onOpenChange={(_: unknown, d: any) => setDialogOpen(d.open)}>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="primary" icon={<Add20Regular />} style={{ marginLeft: 'auto' }}>New KQL database</Button>
            </DialogTrigger>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Create KQL database</DialogTitle>
                <DialogContent>
                  <Caption1>Provisions a Microsoft.Kusto/clusters/databases resource via ARM. Hot cache = 7 days, soft-delete = 30 days.</Caption1>
                  <Input
                    placeholder="database-name"
                    value={newName}
                    onChange={(_: unknown, d: any) => setNewName(d.value)}
                    style={{ marginTop: tokens.spacingVerticalM, width: '100%' }}
                  />
                  {createErr && (
                    <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
                      <MessageBarBody>{createErr}</MessageBarBody>
                    </MessageBar>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setDialogOpen(false)}>Cancel</Button>
                  <Button appearance="primary" onClick={createDb} disabled={creating || !newName.trim()}>
                    {creating ? 'Creating…' : 'Create'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
          <Dialog open={newDashOpen} onOpenChange={(_: unknown, d: any) => { if (!newDashBusy) setNewDashOpen(d.open); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>
                  <span style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS }}>
                    <DataBarVertical20Regular />
                    New Real-Time Dashboard
                  </span>
                </DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                    <Caption1>
                      Creates a KQL dashboard in this workspace, pre-wired to the{' '}
                      <strong>{selectedDb || state?.defaultDatabase || 'default'}</strong> KQL
                      database as its data source. You can add tiles and change the data
                      source after creation.
                    </Caption1>
                    <Field
                      label="Dashboard name"
                      hint="Leave blank to use the suggested name."
                    >
                      <Input
                        autoFocus
                        placeholder={`${item.displayName ?? 'Eventhouse'} — Dashboard`}
                        value={newDashName}
                        disabled={newDashBusy}
                        onChange={(_: unknown, d: any) => setNewDashName(d.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !newDashBusy) { e.preventDefault(); void createDashboard(); }
                        }}
                        style={{ width: '100%' }}
                      />
                    </Field>
                    {newDashErr && (
                      <MessageBar intent="error">
                        <MessageBarBody>
                          <MessageBarTitle>Couldn’t create dashboard</MessageBarTitle>
                          {newDashErr}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setNewDashOpen(false)} disabled={newDashBusy}>Cancel</Button>
                  <Button
                    appearance="primary"
                    icon={newDashBusy ? <Spinner size="tiny" /> : <Add20Regular />}
                    onClick={createDashboard}
                    disabled={newDashBusy}
                  >
                    {newDashBusy ? 'Creating…' : 'Create dashboard'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>

        {state?.ok && (
          <div className={s.tabBar}>
            <TabList selectedValue={activeTab} onTabSelect={(_: unknown, d: any) => setActiveTab(d.value as EhTab)}>
              <Tab value="overview" icon={<Info20Regular />}>System overview</Tab>
              <Tab value="databases" icon={<Database20Regular />}>Databases ({dbCount})</Tab>
              <Tab value="capacity" icon={<DataBarVertical20Regular />}>Capacity</Tab>
            </TabList>
          </div>
        )}

        {state?.ok && activeTab === 'capacity' && <EventhouseCapacityPanel id={id} />}

        {!state && <Spinner size="small" label="Loading cluster…" />}
        {state && !state.ok && (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Cluster unreachable</MessageBarTitle>
              {state.error || 'Unknown error'}
            </MessageBarBody>
          </MessageBar>
        )}

        {state?.ok && activeTab === 'overview' && (
          <EventhouseOverviewPanel
            s={s}
            overview={overview}
            journal={journal}
            timespan={timespan}
            loading={overviewLoading}
            err={overviewErr}
            onTimespan={setTimespan}
            onRefresh={loadOverview}
          />
        )}

        {state?.ok && activeTab === 'databases' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS}}>
              <Subtitle2>Databases ({dbCount})</Subtitle2>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: tokens.spacingVerticalXS}} role="group" aria-label="Database view">
                <Button
                  size="small"
                  appearance={dbView === 'tile' ? 'primary' : 'subtle'}
                  icon={<Apps20Regular />}
                  onClick={() => setDbView('tile')}
                  aria-pressed={dbView === 'tile'}
                  aria-label="Tile view"
                  title="Tile view"
                />
                <Button
                  size="small"
                  appearance={dbView === 'list' ? 'primary' : 'subtle'}
                  icon={<List20Regular />}
                  onClick={() => setDbView('list')}
                  aria-pressed={dbView === 'list'}
                  aria-label="List view"
                  title="List view"
                />
              </div>
            </div>

            {dbView === 'tile' && (
              <div className={s.cardGrid}>
                {(state.databases || []).map((d) => {
                  const isSelected = selectedDb === d.name;
                  return (
                    <div
                      key={d.name}
                      className={s.card}
                      onClick={() => setSelectedDb(d.name)}
                      onDoubleClick={() => openKqlEditor(d.name)}
                      role="button"
                      tabIndex={0}
                      style={{
                        cursor: 'pointer',
                        borderColor: isSelected ? tokens.colorBrandStroke1 : undefined,
                        borderWidth: isSelected ? 2 : undefined,
                        backgroundColor: isSelected ? tokens.colorNeutralBackground1Selected : undefined,
                      }}
                    >
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>KQL database</Caption1>
                      <div style={{ fontSize: tokens.fontSizeBase400, fontWeight: 600 }}>{d.name}</div>
                      {d.prettyName && d.prettyName !== d.name && <Caption1>{d.prettyName}</Caption1>}
                      <div style={{ display: 'flex', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalXS, flexWrap: 'wrap', color: tokens.colorNeutralForeground3 }}>
                        {typeof d.totalSizeMb === 'number' && <Caption1>{fmtDbSize(d.totalSizeMb)}</Caption1>}
                        {typeof d.retentionDays === 'number' && <Caption1>ret {d.retentionDays}d</Caption1>}
                        {typeof d.tableCount === 'number' && <Caption1>{d.tableCount} {d.tableCount === 1 ? 'table' : 'tables'}</Caption1>}
                      </div>
                      <div style={{ display: 'flex', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
                        {d.name === state.defaultDatabase && <Badge appearance="filled" color="brand">default</Badge>}
                        {isSelected && <Badge appearance="outline" color="informative">selected</Badge>}
                      </div>
                      <div style={{ marginTop: tokens.spacingVerticalS, display: 'flex', gap: tokens.spacingVerticalXS, flexWrap: 'wrap' }}>
                        <Button size="small" appearance="primary" icon={<Play20Regular />}
                          onClick={(e) => { e.stopPropagation(); openKqlEditor(d.name); }}
                          title="Query data (this tab)">
                          Query
                        </Button>
                        <Button size="small" appearance="outline" icon={<Open20Regular />}
                          aria-label={`Open ${d.name} in new tab`}
                          onClick={(e) => { e.stopPropagation(); openKqlEditorNewTab(d.name); }}
                          title="Open in new tab" />
                        <Button size="small" appearance="outline"
                          onClick={(e) => { e.stopPropagation(); setSelectedDb(d.name); setGetDataOpen(true); }}
                          title="Get data">
                          Get data
                        </Button>
                        <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                          aria-label={`Delete ${d.name}`}
                          onClick={(e) => { e.stopPropagation(); setSelectedDb(d.name); setDeleteTarget(d.name); setDeleteErr(null); }}
                          title="Delete database" />
                      </div>
                    </div>
                  );
                })}
                {(!state.databases || state.databases.length === 0) && (
                  <Caption1>No databases yet. Click <strong>New KQL database</strong> to create one.</Caption1>
                )}
              </div>
            )}

            {dbView === 'list' && (
              <div className={s.tableWrap}>
                <Table aria-label="KQL databases" size="small">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Name</TableHeaderCell>
                      <TableHeaderCell>Tables</TableHeaderCell>
                      <TableHeaderCell>Total size</TableHeaderCell>
                      <TableHeaderCell>Retention</TableHeaderCell>
                      <TableHeaderCell>Hot cache</TableHeaderCell>
                      <TableHeaderCell aria-label="Actions" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(state.databases || []).map((d) => (
                      <TableRow
                        key={d.name}
                        onClick={() => setSelectedDb(d.name)}
                        style={{
                          cursor: 'pointer',
                          backgroundColor: selectedDb === d.name ? tokens.colorNeutralBackground1Selected : undefined,
                        }}
                      >
                        <TableCell>
                          <span style={{ fontWeight: 600 }}>{d.name}</span>
                          {d.name === state.defaultDatabase &&
                            <Badge appearance="filled" color="brand" style={{ marginLeft: tokens.spacingHorizontalS }}>default</Badge>}
                        </TableCell>
                        <TableCell>{typeof d.tableCount === 'number' ? d.tableCount : '—'}</TableCell>
                        <TableCell>{fmtDbSize(d.totalSizeMb)}</TableCell>
                        <TableCell>{typeof d.retentionDays === 'number' ? `${d.retentionDays} days` : '—'}</TableCell>
                        <TableCell>{typeof d.hotCacheDays === 'number' ? `${d.hotCacheDays} days` : '—'}</TableCell>
                        <TableCell>
                          <div style={{ display: 'flex', gap: tokens.spacingVerticalXS}}>
                            <Button size="small" appearance="primary" icon={<Play20Regular />}
                              aria-label={`Query ${d.name}`}
                              onClick={(e) => { e.stopPropagation(); openKqlEditor(d.name); }}
                              title="Query data" />
                            <Button size="small" appearance="outline" icon={<Open20Regular />}
                              aria-label={`Open ${d.name} in new tab`}
                              onClick={(e) => { e.stopPropagation(); openKqlEditorNewTab(d.name); }}
                              title="Open in new tab" />
                            <Button size="small" appearance="outline"
                              onClick={(e) => { e.stopPropagation(); setSelectedDb(d.name); setGetDataOpen(true); }}
                              title="Get data">
                              Get data
                            </Button>
                            <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                              aria-label={`Delete ${d.name}`}
                              onClick={(e) => { e.stopPropagation(); setSelectedDb(d.name); setDeleteTarget(d.name); setDeleteErr(null); }}
                              title="Delete database" />
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {(!state.databases || state.databases.length === 0) && (
                      <TableRow>
                        <TableCell colSpan={6}>
                          <Caption1>No databases yet. Click <strong>New KQL database</strong> to create one.</Caption1>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Delete confirmation */}
            <Dialog open={!!deleteTarget} onOpenChange={(_, d) => { if (!d.open) { setDeleteTarget(null); setDeleteErr(null); } }}>
              <DialogSurface style={{ maxWidth: 480 }}>
                <DialogBody>
                  <DialogTitle>Delete database?</DialogTitle>
                  <DialogContent>
                    <Caption1>
                      This permanently deletes <strong>{deleteTarget}</strong> and all of its tables from the
                      ADX cluster. This cannot be undone — an ARM DELETE is issued immediately.
                    </Caption1>
                    {deleteErr && (
                      <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
                        <MessageBarBody>{deleteErr}</MessageBarBody>
                      </MessageBar>
                    )}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => { setDeleteTarget(null); setDeleteErr(null); }}>Cancel</Button>
                    <Button appearance="primary" icon={<Delete20Regular />}
                      style={{ backgroundColor: tokens.colorPaletteRedBackground3 }}
                      disabled={deleting || !deleteTarget}
                      onClick={() => deleteTarget && deleteDb(deleteTarget)}>
                      {deleting ? 'Deleting…' : 'Delete'}
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>

            {/* Get data dialog — file / event hub / OneLake */}
            <Dialog open={getDataOpen} onOpenChange={(_, d) => setGetDataOpen(d.open)}>
              <DialogSurface style={{ maxWidth: 520 }}>
                <DialogBody>
                  <DialogTitle>Get data into KQL</DialogTitle>
                  <DialogContent>
                    <Caption1>Target database: <strong>{selectedDb || '(none)'}</strong></Caption1>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM }}>
                      <div>
                        <Label>Source</Label>
                        <Select value={getDataMode} onChange={(_, d) => setGetDataMode(d.value as any)}>
                          <option value="file">Upload file (CSV / JSON / Parquet)</option>
                          <option value="eventhub">Event Hub (streaming)</option>
                          <option value="onelake">OneLake / ADLS Gen2 path</option>
                        </Select>
                      </div>
                      <div>
                        <Label>Target table name</Label>
                        <Input value={getDataTable} onChange={(_, d) => setGetDataTable(d.value)} placeholder="raw_events" />
                      </div>
                      {getDataMode === 'file' && (
                        <div>
                          <Label>File</Label>
                          <input type="file" aria-label="Data file to ingest (CSV, JSON, or Parquet)" onChange={(e) => setGetDataFile(e.target.files?.[0] || null)} />
                          {getDataFile && (
                            <Caption1>{getDataFile.name} ({(getDataFile.size / 1024).toFixed(1)} KB)</Caption1>
                          )}
                        </div>
                      )}
                      {getDataMode === 'eventhub' && (
                        <>
                          {ehHubsErr && (
                            <MessageBar intent="warning">
                              <MessageBarBody>{ehHubsErr}</MessageBarBody>
                            </MessageBar>
                          )}
                          <div>
                            <Label>Event Hub</Label>
                            {ehHubsLoading ? (
                              <Spinner size="tiny" label="Loading event hubs…" />
                            ) : (
                              <Select
                                value={getDataHubName}
                                onChange={(_, d) => { setGetDataHubName(d.value); setGetDataConsumer('$Default'); }}
                                disabled={!!ehHubsErr || ehHubs.length === 0}
                              >
                                <option value="">— select an event hub —</option>
                                {ehHubs.map((h) => <option key={h} value={h}>{h}</option>)}
                              </Select>
                            )}
                          </div>
                          <div>
                            <Label>Consumer group</Label>
                            {ehCgLoading ? (
                              <Spinner size="tiny" label="Loading consumer groups…" />
                            ) : (
                              <Select
                                value={getDataConsumer}
                                onChange={(_, d) => setGetDataConsumer(d.value)}
                                disabled={!getDataHubName}
                              >
                                {ehConsumerGroups.map((cg) => <option key={cg} value={cg}>{cg}</option>)}
                              </Select>
                            )}
                          </div>
                          {getDataHubName && (
                            <MessageBar intent="info">
                              <MessageBarBody>
                                Streaming connection <strong>{getDataHubName}</strong> / <strong>{getDataConsumer || '$Default'}</strong>.
                                Schema is inferred from the first arriving JSON events; rows land as the data connection warms up (typically &lt;60s).
                              </MessageBarBody>
                            </MessageBar>
                          )}
                        </>
                      )}
                      {getDataMode === 'onelake' && (
                        <>
                          <div>
                            <Label>Storage path (ADLS Gen2 abfss:// or Blob https:// with SAS)</Label>
                            <Input value={getDataOneLakePath} onChange={(_, d) => setGetDataOneLakePath(d.value)} placeholder="abfss://bronze@account.dfs.core.windows.net/folder/data.csv" />
                          </div>
                          {loomContainers.length > 0 && (
                            <div style={{ display: 'flex', gap: tokens.spacingVerticalS, flexWrap: 'wrap', alignItems: 'center' }}>
                              <Caption1>Quick-pick:</Caption1>
                              {loomContainers.map((c) => (
                                <Button
                                  key={c.label}
                                  size="small"
                                  appearance="outline"
                                  onClick={() => setGetDataOneLakePath(c.url.endsWith('/') ? c.url : `${c.url}/`)}
                                >
                                  {c.label}
                                </Button>
                              ))}
                            </div>
                          )}
                          <div>
                            <Label>Format</Label>
                            <Select value={getDataFormat} onChange={(_, d) => setGetDataFormat(d.value as any)}>
                              <option value="auto">Auto-detect (from extension)</option>
                              <option value="csv">CSV</option>
                              <option value="json">JSON (one object per line)</option>
                              <option value="multijson">MultiJSON (array)</option>
                              <option value="parquet">Parquet</option>
                            </Select>
                          </div>
                          <div>
                            <Button
                              appearance="outline"
                              onClick={onPreview}
                              disabled={previewBusy || !getDataOneLakePath.trim()}
                            >
                              {previewBusy ? 'Previewing…' : 'Preview schema'}
                            </Button>
                          </div>
                          {previewErr && (
                            <MessageBar intent="warning">
                              <MessageBarBody>{previewErr}</MessageBarBody>
                            </MessageBar>
                          )}
                        </>
                      )}
                    </div>
                    {schemaPreview && schemaPreview.columns.length > 0 && (
                      <div style={{ marginTop: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalS }}>
                        <Caption1><strong>Detected schema</strong>{schemaPreview.detectedFormat ? ` (${schemaPreview.detectedFormat})` : ''}</Caption1>
                        <div style={{ overflowX: 'auto', marginTop: tokens.spacingVerticalXS }}>
                          <Table size="small" aria-label="Detected schema preview">
                            <TableHeader>
                              <TableRow>
                                {schemaPreview.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {schemaPreview.sampleRows.slice(0, 3).map((row, i) => (
                                <TableRow key={i}>
                                  {schemaPreview.columns.map((_, j) => (
                                    <TableCell key={j} className={s.cell}>{String(row?.[j] ?? '')}</TableCell>
                                  ))}
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                        <Caption1>{schemaPreview.columns.length} columns detected · {schemaPreview.sampleRows.length} sample rows shown.</Caption1>
                      </div>
                    )}
                    {getDataResult && (
                      <MessageBar intent={getDataResult.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalM }}>
                        <MessageBarBody>
                          {getDataResult.ok
                            ? `Ingested ${getDataResult.rows ?? '?'} rows into ${getDataResult.tableName || getDataTable}`
                            : getDataResult.error}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setGetDataOpen(false)}>Close</Button>
                    <Button appearance="primary" onClick={onIngest} disabled={getDataBusy || !selectedDb || !getDataTable.trim()}>
                      {getDataBusy ? 'Ingesting…' : 'Ingest'}
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>

            {/* Data policies dialog — hot cache / soft delete / OneLake availability */}
            <Dialog open={policiesOpen} onOpenChange={(_, d) => setPoliciesOpen(d.open)}>
              <DialogSurface style={{ maxWidth: 500 }}>
                <DialogBody>
                  <DialogTitle>Data policies — {selectedDb}</DialogTitle>
                  <DialogContent>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
                      <div>
                        <Label>Hot cache (days)</Label>
                        <Input
                          type="number"
                          value={String(hotCacheDays)}
                          onChange={(_, d) => setHotCacheDays(Math.max(0, parseInt(d.value, 10) || 0))}
                        />
                        <Caption1>How many days of data live in SSD cache for sub-second queries.</Caption1>
                      </div>
                      <div>
                        <Label>Soft delete (days)</Label>
                        <Input
                          type="number"
                          value={String(softDeleteDays)}
                          onChange={(_, d) => setSoftDeleteDays(Math.max(1, parseInt(d.value, 10) || 1))}
                        />
                        <Caption1>How many days data is retained before automatic delete.</Caption1>
                      </div>
                      <div>
                        <Label>OneLake availability</Label>
                        <Switch
                          checked={oneLakeEnabled}
                          onChange={(_, d) => setOneLakeEnabled(!!d.checked)}
                          label={oneLakeEnabled ? 'Mirrored to OneLake' : 'Not mirrored'}
                        />
                        <Caption1>Fabric-managed eventhouses only. Mirrors KQL tables into OneLake as Delta for Spark/Power BI.</Caption1>
                      </div>
                      <div>
                        <Label>Enable streaming ingestion</Label>
                        <Switch
                          checked={streamingEnabled}
                          onChange={(_, d) => setStreamingEnabled(!!d.checked)}
                          label={streamingEnabled ? 'Enabled' : 'Disabled'}
                        />
                        <Caption1>
                          Cluster-level flag (ARM). Enables the low-latency (&lt;1s) ingest path
                          for Event Hub data connections and the <code>.ingest inline</code> command,
                          then turns on the database streaming-ingestion policy. Toggling triggers an
                          async cluster update; the cluster stays online. New Loom clusters ship with
                          this on by default.
                        </Caption1>
                      </div>
                    </div>
                    {policiesErr && (
                      <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
                        <MessageBarBody>{policiesErr}</MessageBarBody>
                      </MessageBar>
                    )}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setPoliciesOpen(false)}>Cancel</Button>
                    <Button appearance="primary" onClick={applyPolicies} disabled={policiesBusy}>
                      {policiesBusy ? 'Applying…' : 'Apply'}
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>


            {/* Bind Delta source — ADX external table over an ADLS Gen2 Delta path
                + query acceleration. The lakehouse/warehouse endpoint: Delta data
                becomes KQL-queryable within seconds, no copy, no Fabric. */}
            <Dialog open={deltaOpen} onOpenChange={(_, d) => { setDeltaOpen(d.open); if (!d.open) setDeltaResult(null); }}>
              <DialogSurface style={{ maxWidth: 560 }}>
                <DialogBody>
                  <DialogTitle>Bind Delta source to KQL external table</DialogTitle>
                  <DialogContent>
                    <Caption1>
                      Creates an ADX external table over an ADLS Gen2 Delta Lake path (lakehouse
                      Bronze/Silver/Gold or a warehouse Delta export) and applies a query
                      acceleration policy. The Delta data is queryable via KQL within seconds of
                      binding — no copy, no ingestion job. The ADX cluster managed identity must
                      hold Storage Blob Data Reader on the target ADLS account.
                    </Caption1>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM }}>
                      <div>
                        <Label required>Target KQL database</Label>
                        <Select value={selectedDb} onChange={(_, d) => setSelectedDb(d.value)}>
                          {(state?.databases || []).map((db) => (
                            <option key={db.name} value={db.name}>{db.name}</option>
                          ))}
                        </Select>
                      </div>
                      <div>
                        <Label required>External table name</Label>
                        <Input value={deltaTableName} onChange={(_, d) => setDeltaTableName(d.value)} placeholder="bronze_orders_delta" />
                        <Caption1>KQL identifier: starts with a letter, alphanumeric + underscore only.</Caption1>
                      </div>
                      <div>
                        <Label required>ADLS Gen2 Delta path (abfss://)</Label>
                        <Input
                          value={deltaAbfss}
                          onChange={(_, d) => setDeltaAbfss(d.value)}
                          placeholder="abfss://bronze@account.dfs.core.windows.net/orders/"
                          style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200}}
                        />
                        <Caption1>Root folder of the Delta table (the folder containing _delta_log).</Caption1>
                      </div>
                      <div>
                        <Label>Query acceleration hot window (days)</Label>
                        <Input
                          type="number"
                          value={String(deltaHotDays)}
                          onChange={(_, d) => setDeltaHotDays(Math.max(1, parseInt(d.value, 10) || 7))}
                        />
                        <Caption1>Delta files within this window are cached in ADX for sub-second queries (min 1 day).</Caption1>
                      </div>
                      <div>
                        <Switch
                          checked={deltaKqlView}
                          onChange={(_, d) => setDeltaKqlView(!!d.checked)}
                          label={deltaKqlView ? 'Create KQL view function (recommended)' : 'External table only'}
                        />
                        <Caption1>
                          Creates <code>{deltaTableName ? `${deltaTableName}_view()` : '<name>_view()'}</code> — a
                          stored function wrapping <code>external_table()</code> for clean KQL access.
                        </Caption1>
                      </div>
                    </div>

                    {deltaResult && !deltaResult.ok && (
                      <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
                        <MessageBarBody>
                          <MessageBarTitle>Binding failed</MessageBarTitle>
                          {deltaResult.error}
                          {deltaResult.hint && <div style={{ marginTop: tokens.spacingVerticalS }}><Caption1>{deltaResult.hint}</Caption1></div>}
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    {deltaResult?.ok && (
                      <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalM }}>
                        <MessageBarBody>
                          <MessageBarTitle>External table {deltaResult.externalTableName} bound</MessageBarTitle>
                          <div style={{ marginTop: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS}}>
                            {deltaResult.kqlViewName && (
                              <Caption1>KQL view: <code>{deltaResult.kqlViewName}()</code></Caption1>
                            )}
                            {deltaResult.accelerationPolicy != null && (
                              <Caption1>Acceleration policy: <code>{JSON.stringify(deltaResult.accelerationPolicy)}</code></Caption1>
                            )}
                            {deltaResult.sampleQuery && (
                              <Caption1>Sample query: <code>{deltaResult.sampleQuery}</code></Caption1>
                            )}
                            {(deltaResult.steps || []).map((st, i) => (
                              <Caption1 key={i} style={{ color: st.ok ? tokens.colorStatusSuccessForeground1 : tokens.colorStatusWarningForeground1 }}>
                                {st.ok ? '✓' : '⚠'} {st.step}{st.detail ? `: ${st.detail}` : ''}
                              </Caption1>
                            ))}
                          </div>
                        </MessageBarBody>
                      </MessageBar>
                    )}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => { setDeltaOpen(false); setDeltaResult(null); }}>Close</Button>
                    <Button
                      appearance="primary"
                      onClick={onBindDelta}
                      disabled={deltaBusy || !selectedDb || !deltaTableName.trim() || !deltaAbfss.trim()}
                    >
                      {deltaBusy ? 'Binding…' : 'Bind Delta source'}
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>

            {/* Export to OneLake/ADLS dialog — continuous Delta export via Kusto
                continuous-export (Azure-native; no Fabric workspace required). */}
            <Dialog open={exportOpen} onOpenChange={(_, d) => setExportOpen(d.open)}>
              <DialogSurface style={{ maxWidth: 560 }}>
                <DialogBody>
                  <DialogTitle>Export to OneLake / ADLS Gen2 (Delta)</DialogTitle>
                  <DialogContent>
                    <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalS}}>
                      Configures a Kusto continuous-export job that writes Delta files to ADLS Gen2 on
                      each interval. The ADX cluster&rsquo;s system-assigned MI authenticates to storage
                      (impersonation — no SAS key). Requires <strong>Storage Blob Data Contributor</strong> on
                      the target account, provisioned by <code>adx-cluster.bicep</code> when
                      <code> LOOM_RTI_EXPORT_ADLS</code> is set.
                    </Caption1>

                    {/* Honest gate — fires when LOOM_RTI_EXPORT_ADLS is not set */}
                    {exportResult?.code === 'no_adls_config' && (
                      <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM}}>
                        <MessageBarBody>
                          <MessageBarTitle>ADLS export not configured</MessageBarTitle>
                          {exportResult.hint ||
                            'Set LOOM_RTI_EXPORT_ADLS to the storage account name and redeploy. ' +
                            'See adx-cluster.bicep (exportAdlsAccountName param).'}
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
                      <div>
                        <Label>Source table</Label>
                        <Input
                          value={exportSourceTable}
                          onChange={(_, d) => setExportSourceTable(d.value)}
                          placeholder="raw_events"
                        />
                        <Caption1>KQL fact table in <strong>{selectedDb}</strong>. New rows exported each interval.</Caption1>
                      </div>
                      <div>
                        <Label>Export name</Label>
                        <Input
                          value={exportName}
                          onChange={(_, d) => setExportName(d.value)}
                          placeholder={exportSourceTable ? `export_${exportSourceTable}_delta` : 'export_raw_events_delta'}
                        />
                        <Caption1>Unique continuous-export job name in this database (KQL identifier).</Caption1>
                      </div>
                      <div>
                        <Label>ADLS account</Label>
                        <Input
                          value={exportAdlsAccount}
                          onChange={(_, d) => setExportAdlsAccount(d.value)}
                          placeholder={exportConfigAccount
                            ? `${exportConfigAccount} (deployment default)`
                            : '(uses LOOM_RTI_EXPORT_ADLS when blank)'}
                        />
                        <Caption1>Storage account name. Leave blank to use the deployment default.</Caption1>
                      </div>
                      <div>
                        <Label>Container</Label>
                        <Select value={exportContainer} onChange={(_, d) => setExportContainer(d.value)}>
                          {exportContainers.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </Select>
                        <Caption1>ADLS Gen2 filesystem (populated from the deployment&rsquo;s storage account).</Caption1>
                      </div>
                      <div>
                        <Label>Path (inside container)</Label>
                        <Input
                          value={exportPath}
                          onChange={(_, d) => setExportPath(d.value)}
                          placeholder={`exports/${selectedDb}/${exportSourceTable || 'table'}`}
                        />
                        <Caption1>Root folder for the Delta table, e.g. <code>exports/raw_events</code>.</Caption1>
                      </div>
                      <div>
                        <Label>Export interval</Label>
                        <Select value={exportInterval} onChange={(_, d) => setExportInterval(d.value)}>
                          <option value="5m">5 minutes</option>
                          <option value="15m">15 minutes</option>
                          <option value="30m">30 minutes</option>
                          <option value="1h">1 hour (recommended)</option>
                          <option value="6h">6 hours</option>
                          <option value="24h">24 hours</option>
                        </Select>
                      </div>
                    </div>

                    {/* Active exports list */}
                    {exportsLoading && (
                      <Spinner size="extra-small" label="Loading exports…" style={{ marginTop: tokens.spacingVerticalM}} />
                    )}
                    {continuousExports.length > 0 && (
                      <div style={{ marginTop: tokens.spacingVerticalL}}>
                        <Caption1 style={{ fontWeight: 600 }}>Active exports ({continuousExports.length})</Caption1>
                        {continuousExports.map((ce) => (
                          <div key={ce.name} style={{ fontSize: tokens.fontSizeBase200, marginTop: tokens.spacingVerticalXS, fontFamily: 'monospace' }}>
                            <strong>{ce.name}</strong>
                            {ce.externalTableName && ` → ${ce.externalTableName}`}
                            {ce.lastRunResult && (
                              <Caption1 style={{ marginLeft: tokens.spacingHorizontalS}}>{ce.lastRunResult}</Caption1>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Success receipt */}
                    {exportResult?.ok && (
                      <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalM}}>
                        <MessageBarBody>
                          <MessageBarTitle>Export configured</MessageBarTitle>
                          Delta files will land at <code>{exportResult.abfssPath}</code> every {exportInterval}.
                          Verify: <code>{exportResult.verify}</code>
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    {/* Error (not the honest gate) */}
                    {exportResult && !exportResult.ok && exportResult.code !== 'no_adls_config' && (
                      <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM}}>
                        <MessageBarBody>{exportResult.error}</MessageBarBody>
                      </MessageBar>
                    )}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setExportOpen(false)}>Close</Button>
                    <Button
                      appearance="primary"
                      onClick={submitExport}
                      disabled={
                        exportBusy ||
                        !selectedDb ||
                        !exportSourceTable.trim() ||
                        !exportName.trim() ||
                        !exportContainer
                      }
                    >
                      {exportBusy ? 'Configuring…' : 'Create export'}
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>

            {/* Purge records dialog — GDPR erasure via ADX two-step .purge */}
            <Dialog open={purgeOpen} onOpenChange={(_, d) => { if (!purgeBusy) setPurgeOpen(d.open); }}>
              <DialogSurface style={{ maxWidth: 620 }}>
                <DialogBody>
                  <DialogTitle>Purge records — {selectedDb}</DialogTitle>
                  <DialogContent>
                    {purgeStep === 'idle' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
                        <MessageBar intent="warning">
                          <MessageBarBody>
                            <MessageBarTitle>Irreversible erasure</MessageBarTitle>
                            Purge permanently deletes matching records from storage (GDPR /
                            right-to-be-forgotten). It cannot be undone. Use only when required by a
                            privacy obligation. Requires Database Admin on the cluster.
                          </MessageBarBody>
                        </MessageBar>
                        <div>
                          <Label>Table</Label>
                          <Select value={purgeTable} onChange={(_, d) => onPurgeTableChange(d.value)} style={{ width: '100%' }}>
                            <option value="">— select a table —</option>
                            {purgeTableList.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                          </Select>
                        </div>
                        {purgeTable && (
                          <div>
                            <Label>Predicate — all conditions are joined with AND</Label>
                            {purgePredicates.map((pred, i) => (
                              <div key={i} style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalS}}>
                                <Select
                                  value={pred.column}
                                  onChange={(_, d) => setPurgePredicates((ps) => ps.map((p, j) => (j === i ? { ...p, column: d.value } : p)))}
                                  style={{ minWidth: 150 }}
                                >
                                  <option value="">— column —</option>
                                  {purgeColumns.length
                                    ? purgeColumns.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.type})</option>)
                                    : <option disabled>loading schema…</option>}
                                </Select>
                                <Select
                                  value={pred.op}
                                  onChange={(_, d) => setPurgePredicates((ps) => ps.map((p, j) => (j === i ? { ...p, op: d.value } : p)))}
                                  style={{ minWidth: 110 }}
                                >
                                  {(['==', '!=', '>', '<', '>=', '<=', 'contains', 'startswith'] as const).map((op) => (
                                    <option key={op} value={op}>{op}</option>
                                  ))}
                                </Select>
                                <Input
                                  value={pred.value}
                                  onChange={(_, d) => setPurgePredicates((ps) => ps.map((p, j) => (j === i ? { ...p, value: d.value } : p)))}
                                  placeholder="value"
                                  style={{ flex: 1 }}
                                />
                                {purgePredicates.length > 1 && (
                                  <Button
                                    size="small"
                                    appearance="subtle"
                                    icon={<Delete20Regular />}
                                    aria-label="Remove condition"
                                    onClick={() => setPurgePredicates((ps) => ps.filter((_, j) => j !== i))}
                                  />
                                )}
                              </div>
                            ))}
                            <Button
                              size="small"
                              appearance="outline"
                              icon={<Add20Regular />}
                              onClick={() => setPurgePredicates((ps) => [...ps, { column: '', op: '==', value: '' }])}
                              style={{ marginTop: tokens.spacingVerticalS}}
                            >
                              Add condition
                            </Button>
                            <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
                              Predicate:{' '}
                              <code style={{ fontFamily: 'Consolas, monospace' }}>
                                where {purgePredicates.filter((p) => p.column && p.value).map((p) => `["${p.column}"] ${p.op} "${p.value}"`).join(' and ') || '(incomplete)'}
                              </code>
                            </Caption1>
                          </div>
                        )}
                        {purgeErr && <MessageBar intent="error"><MessageBarBody>{purgeErr}</MessageBarBody></MessageBar>}
                      </div>
                    )}

                    {purgeStep === 'verified' && purgeVerifyResult && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
                        <MessageBar intent="warning">
                          <MessageBarBody>
                            <MessageBarTitle>Confirm purge</MessageBarTitle>
                            <strong>{purgeVerifyResult.numRecordsToPurge.toLocaleString()}</strong> record(s) in{' '}
                            <strong>{purgeTable}</strong> will be permanently erased. Estimated purge time:{' '}
                            {purgeVerifyResult.estimatedPurgeExecutionTime || 'unknown'}. This action cannot be undone.
                          </MessageBarBody>
                        </MessageBar>
                        <div>
                          <Label required>Type PURGE to confirm</Label>
                          <Input
                            value={purgeConfirmText}
                            onChange={(_, d) => setPurgeConfirmText(d.value)}
                            placeholder="PURGE"
                            style={{ width: '100%' }}
                          />
                        </div>
                        {purgeErr && <MessageBar intent="error"><MessageBarBody>{purgeErr}</MessageBarBody></MessageBar>}
                      </div>
                    )}

                    {purgeStep === 'done' && purgeCommitResult && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
                        <MessageBar intent="success">
                          <MessageBarBody>
                            <MessageBarTitle>Purge scheduled</MessageBarTitle>
                            Operation ID:{' '}
                            <code style={{ fontFamily: 'Consolas, monospace' }}>{purgeCommitResult.operationId || '(pending)'}</code>.
                            State: {purgeCommitResult.state}. Post-purge match count:{' '}
                            {purgeCommitResult.postPurgeCount != null ? purgeCommitResult.postPurgeCount.toLocaleString() : '(checking…)'}.
                          </MessageBarBody>
                        </MessageBar>
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                          ADX purge runs in the background: Phase 1 (soft-delete; rows no longer visible)
                          completes in minutes to hours; Phase 2 (hard-delete from storage) follows within
                          5–30 days. Track status with{' '}
                          <code style={{ fontFamily: 'Consolas, monospace' }}>.show purges {purgeCommitResult.operationId}</code>{' '}
                          against the data-management endpoint.
                        </Caption1>
                      </div>
                    )}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setPurgeOpen(false)} disabled={purgeBusy}>
                      {purgeStep === 'done' ? 'Close' : 'Cancel'}
                    </Button>
                    {purgeStep === 'idle' && (
                      <Button
                        appearance="primary"
                        onClick={runPurgeVerify}
                        disabled={purgeBusy || !purgeTable || purgePredicates.every((p) => !p.column || !p.value)}
                      >
                        {purgeBusy ? 'Verifying…' : 'Verify (preview records)'}
                      </Button>
                    )}
                    {purgeStep === 'verified' && (
                      <>
                        <Button appearance="outline" onClick={() => { setPurgeStep('idle'); setPurgeErr(null); }} disabled={purgeBusy}>
                          Back
                        </Button>
                        <Button
                          appearance="primary"
                          onClick={runPurgeCommit}
                          disabled={purgeBusy || purgeConfirmText !== 'PURGE'}
                        >
                          {purgeBusy ? 'Purging…' : 'Commit purge'}
                        </Button>
                      </>
                    )}
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>

            {/* Optimized auto-scale dialog — cluster-level ARM PATCH /clusters */}
            <Dialog open={autoscaleOpen} onOpenChange={(_, d) => setAutoscaleOpen(d.open)}>
              <DialogSurface style={{ maxWidth: 480 }}>
                <DialogBody>
                  <DialogTitle>Optimized auto-scale</DialogTitle>
                  <DialogContent>
                    {state?.sku && (
                      <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalS}}>
                        Cluster SKU: <strong>{state.sku.name}</strong> ({state.sku.tier} tier
                        {typeof state.sku.capacity === 'number' ? `, ${state.sku.capacity} instance${state.sku.capacity === 1 ? '' : 's'}` : ''})
                      </Caption1>
                    )}
                    {isDevSku && (
                      <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM}}>
                        <MessageBarBody>
                          <MessageBarTitle>Dev/Basic SKU — auto-scale not supported</MessageBarTitle>
                          Optimized auto-scale requires a Standard-tier ADX SKU
                          (e.g. <code>Standard_E2ads_v5</code>). This cluster is on{' '}
                          <strong>{state?.sku?.name}</strong> (Basic tier). Upgrade the
                          cluster SKU via Manage › Scale up, then return here.
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, opacity: isDevSku ? 0.5 : 1 }}>
                      <div>
                        <Switch
                          checked={autoscaleEnabled}
                          onChange={(_, d) => setAutoscaleEnabled(!!d.checked)}
                          label={autoscaleEnabled ? 'Optimized auto-scale enabled' : 'Optimized auto-scale disabled'}
                          disabled={isDevSku}
                        />
                        <Caption1>
                          ADX automatically scales instance count between the minimum and
                          maximum based on CPU, cache utilisation, and ingestion load.
                          Predictive + reactive — no custom rules needed.
                        </Caption1>
                      </div>
                      <div>
                        <Label>Minimum instances</Label>
                        <SpinButton
                          min={2}
                          max={autoscaleMax}
                          value={autoscaleMin}
                          onChange={(_, d) => {
                            const v = d.value ?? Number(d.displayValue);
                            if (Number.isFinite(v)) setAutoscaleMin(Math.max(2, Math.min(autoscaleMax, Number(v))));
                          }}
                          disabled={isDevSku || !autoscaleEnabled}
                        />
                        <Caption1>Cluster will never scale below this count (minimum 2).</Caption1>
                      </div>
                      <div>
                        <Label>Maximum instances</Label>
                        <SpinButton
                          min={autoscaleMin}
                          max={1000}
                          value={autoscaleMax}
                          onChange={(_, d) => {
                            const v = d.value ?? Number(d.displayValue);
                            if (Number.isFinite(v)) setAutoscaleMax(Math.max(autoscaleMin, Math.min(1000, Number(v))));
                          }}
                          disabled={isDevSku || !autoscaleEnabled}
                        />
                        <Caption1>Cluster will never scale above this count (maximum 1000).</Caption1>
                      </div>
                    </div>
                    {autoscaleResult && (
                      <MessageBar intent={autoscaleResult.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalM}}>
                        <MessageBarBody>
                          {autoscaleResult.msg}
                          {autoscaleResult.provisioningState && (
                            <> — cluster state: <strong>{autoscaleResult.provisioningState}</strong></>
                          )}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setAutoscaleOpen(false)}>Close</Button>
                    <Button appearance="primary" onClick={applyAutoscale} disabled={autoscaleBusy || isDevSku}>
                      {autoscaleBusy ? 'Applying…' : 'Apply'}
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
          </>
        )}
      </div>
    } />
  );
}
