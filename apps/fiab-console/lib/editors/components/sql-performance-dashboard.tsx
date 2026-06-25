'use client';

/**
 * SqlPerformanceDashboard — the Azure SQL Database "Performance" surface, a
 * one-for-one Loom build of the Azure portal **Query Performance Insight** /
 * SSMS **Query Store** dashboards, themed with Fluent v9 + Loom tokens.
 *
 * Backend: 100% Azure-native via the real Query Store catalog views
 * (`sys.query_store_*`) over live TDS — NO Microsoft Fabric / Power BI. Every
 * control calls POST /api/items/azure-sql-database/[id]/performance:
 *   - metric / window / top-N pickers       → action:'top-queries'
 *   - top-resource queries bar chart (click) → selects a query
 *   - per-query runtime-stats time series    → action:'time-series' (SVG)
 *   - per-query text + execution plan         → included + action:'query-plan'
 *   - Query Store status badge                → action:'status'
 *   - one-click enable gate (QS OFF)          → action:'enable' confirm:true
 *
 * No mock data, no dead controls, no JSON config. When Query Store is not
 * collecting, an honest Fluent MessageBar offers the one-click enable
 * (ALTER DATABASE CURRENT SET QUERY_STORE = ON), per no-vaporware.md.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Spinner, Label, Tooltip,
  Dropdown, Option, MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  makeStyles, tokens, Text,
} from '@fluentui/react-components';
import {
  ChartMultiple20Regular, ArrowClockwise20Regular, DataBarVertical20Regular,
  Copy20Regular, DocumentText20Regular, Timer20Regular, TopSpeed20Regular,
  Clock20Regular, CheckmarkCircle20Regular, DataTrending20Regular,
  DataBarVertical24Regular, DataPie24Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';

// ── Types mirror the BFF response shapes (sql-objects-client) ──
interface QsStatus {
  actualState: string;
  readonlyReason: number | null;
  currentStorageSizeMb: number;
  maxStorageSizeMb: number;
  captureMode: string;
  collecting: boolean;
}
interface TopQueryRow {
  queryId: number;
  queryText: string;
  totalCpuMs: number;
  totalDurationMs: number;
  totalLogicalReads: number;
  totalExecutions: number;
  lastExecutionTime: string | null;
}
interface TimeSeriesPoint {
  intervalStart: string;
  intervalEnd: string;
  executions: number;
  avgCpuMs: number;
  avgDurationMs: number;
  avgLogicalReads: number;
}
interface PlanResult {
  planId: number;
  queryPlanXml: string | null;
  lastCompileTime: string | null;
}

type Metric = 'cpu' | 'duration' | 'logical-reads' | 'executions';

const METRICS: { key: Metric; label: string; unit: string }[] = [
  { key: 'cpu', label: 'CPU time', unit: 'ms' },
  { key: 'duration', label: 'Duration', unit: 'ms' },
  { key: 'logical-reads', label: 'Logical reads', unit: 'pages' },
  { key: 'executions', label: 'Execution count', unit: 'execs' },
];
const WINDOWS: { hours: number; label: string }[] = [
  { hours: 1, label: 'Last 1 hour' },
  { hours: 6, label: 'Last 6 hours' },
  { hours: 24, label: 'Last 24 hours' },
  { hours: 168, label: 'Last 7 days' },
  { hours: 720, label: 'Last 30 days' },
];
const TOPNS = [5, 10, 15, 20, 25];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  toolbar: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: '150px' },
  split: { display: 'flex', gap: tokens.spacingHorizontalL, alignItems: 'stretch', flexWrap: 'wrap' },
  leftCol: { flex: '1 1 460px', minWidth: '380px', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  rightCol: {
    flex: '1 1 420px', minWidth: '360px', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
  },
  barRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, cursor: 'pointer',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, borderRadius: tokens.borderRadiusSmall,
    border: `1px solid transparent`,
  },
  barRowSelected: {
    backgroundColor: tokens.colorBrandBackground2,
    border: `1px solid ${tokens.colorBrandStroke1}`,
  },
  barLabel: { flex: '0 0 46px', fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
  barTrack: { flex: '1 1 auto', height: '22px', position: 'relative', backgroundColor: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusSmall, overflow: 'hidden' },
  barFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: tokens.colorBrandBackground, borderRadius: tokens.borderRadiusSmall },
  barText: { position: 'absolute', left: '6px', top: 0, bottom: 0, display: 'flex', alignItems: 'center', fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForegroundOnBrand, whiteSpace: 'nowrap', maxWidth: 'calc(100% - 12px)', overflow: 'hidden', textOverflow: 'ellipsis' },
  barValue: { flex: '0 0 auto', minWidth: '92px', textAlign: 'right', fontSize: tokens.fontSizeBase200, fontVariantNumeric: 'tabular-nums' },
  detailText: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap',
    wordBreak: 'break-word', backgroundColor: tokens.colorNeutralBackground3,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusSmall, maxHeight: '220px', overflow: 'auto',
  },
  planXml: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase100, whiteSpace: 'pre-wrap',
    wordBreak: 'break-word', backgroundColor: tokens.colorNeutralBackground3,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusSmall, maxHeight: '260px', overflow: 'auto',
  },
  metricChips: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  chip: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1, minWidth: '96px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, boxShadow: tokens.shadow2,
    transitionProperty: 'box-shadow', transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow4 },
  },
  detailsSummary: { cursor: 'pointer', fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  sectionHeader: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  sectionTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  selectedHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: tokens.spacingHorizontalM },
  labelRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: tokens.spacingVerticalXS,
  },
  planMeta: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginTop: tokens.spacingVerticalXS, marginBottom: tokens.spacingVerticalXS,
  },
  toolbarSplit: { justifyContent: 'space-between' },
});

function fmtMetric(row: TopQueryRow, metric: Metric): number {
  switch (metric) {
    case 'cpu': return row.totalCpuMs;
    case 'duration': return row.totalDurationMs;
    case 'logical-reads': return row.totalLogicalReads;
    case 'executions': return row.totalExecutions;
  }
}
function fmtValue(v: number, metric: Metric): string {
  const m = METRICS.find((x) => x.key === metric)!;
  if (metric === 'logical-reads' || metric === 'executions') {
    return `${Math.round(v).toLocaleString()} ${m.unit}`;
  }
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${m.unit}`;
}

async function postPerf(id: string, body: Record<string, unknown>): Promise<any> {
  const r = await fetch(`/api/items/azure-sql-database/${encodeURIComponent(id)}/performance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return { ok: false, error: `Unexpected response (HTTP ${r.status})` };
  }
  return r.json();
}

export interface SqlPerformanceDashboardProps {
  id: string;
  server: string;
  database: string;
}

export function SqlPerformanceDashboard({ id, server, database }: SqlPerformanceDashboardProps) {
  const s = useStyles();

  const [qsStatus, setQsStatus] = useState<QsStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [metric, setMetric] = useState<Metric>('cpu');
  const [windowHours, setWindowHours] = useState(24);
  const [topN, setTopN] = useState(10);

  const [rows, setRows] = useState<TopQueryRow[]>([]);
  const [topLoading, setTopLoading] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);

  const [selected, setSelected] = useState<TopQueryRow | null>(null);
  const [series, setSeries] = useState<TimeSeriesPoint[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [planLoading, setPlanLoading] = useState(false);

  const [enabling, setEnabling] = useState(false);
  const [enableMsg, setEnableMsg] = useState<string | null>(null);

  const ready = Boolean(server && database);

  const loadStatus = useCallback(async () => {
    if (!ready) return;
    setStatusLoading(true);
    setStatusError(null);
    const j = await postPerf(id, { server, database, action: 'status' });
    if (j.ok) setQsStatus(j.status);
    else setStatusError(j.error || 'Could not read Query Store status');
    setStatusLoading(false);
  }, [id, server, database, ready]);

  const loadTop = useCallback(async () => {
    if (!ready) return;
    setTopLoading(true);
    setTopError(null);
    const j = await postPerf(id, { server, database, action: 'top-queries', metric, windowHours, topN });
    if (j.ok) {
      setRows(j.rows || []);
      setSelected(null);
      setSeries([]);
      setPlan(null);
    } else {
      setRows([]);
      setTopError(j.error || 'Could not load top queries');
    }
    setTopLoading(false);
  }, [id, server, database, metric, windowHours, topN, ready]);

  const selectQuery = useCallback(async (row: TopQueryRow) => {
    setSelected(row);
    setSeries([]);
    setPlan(null);
    setSeriesLoading(true);
    const ts = await postPerf(id, { server, database, action: 'time-series', queryId: row.queryId, windowHours });
    if (ts.ok) setSeries(ts.points || []);
    setSeriesLoading(false);
    setPlanLoading(true);
    const pl = await postPerf(id, { server, database, action: 'query-plan', queryId: row.queryId });
    if (pl.ok) setPlan(pl.plan || null);
    setPlanLoading(false);
  }, [id, server, database, windowHours]);

  const enableQs = useCallback(async () => {
    if (!ready) return;
    setEnabling(true);
    setEnableMsg(null);
    const j = await postPerf(id, { server, database, action: 'enable', confirm: true });
    if (j.ok) {
      setQsStatus(j.status);
      setEnableMsg(`Query Store is now ${j.status?.actualState}. Run some queries; statistics begin accumulating per interval.`);
      await loadTop();
    } else {
      setEnableMsg(j.error || j.message || 'Could not enable Query Store');
    }
    setEnabling(false);
  }, [id, server, database, ready, loadTop]);

  // Status once when connection is set.
  useEffect(() => { if (ready) loadStatus(); }, [ready, loadStatus]);
  // Top queries reload whenever connection / metric / window / topN change.
  useEffect(() => { if (ready) loadTop(); }, [ready, loadTop]);

  const maxValue = useMemo(
    () => rows.reduce((m, r) => Math.max(m, fmtMetric(r, metric)), 0) || 1,
    [rows, metric],
  );

  if (!ready) {
    return (
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Pick a server + database first</MessageBarTitle>
          Select an Azure SQL server and database on the <strong>Connect</strong> tab to open the
          Query Store performance dashboard.
        </MessageBarBody>
      </MessageBar>
    );
  }

  const collecting = qsStatus?.collecting ?? true;

  return (
    <div className={s.root}>
      {/* Status badge + intro */}
      <div className={`${s.toolbar} ${s.toolbarSplit}`}>
        <div className={s.metricChips}>
          <Badge appearance="filled" color="brand" icon={<ChartMultiple20Regular />}>
            Query Performance Insight · sys.query_store_*
          </Badge>
          {statusLoading ? (
            <Spinner size="tiny" label="Reading Query Store status…" labelPosition="after" />
          ) : qsStatus ? (
            <Badge
              appearance="filled"
              color={collecting ? 'success' : 'warning'}
              icon={collecting ? <CheckmarkCircle20Regular /> : <Clock20Regular />}
            >
              Query Store: {qsStatus.actualState} · capture {qsStatus.captureMode}
              {qsStatus.maxStorageSizeMb > 0 && ` · ${qsStatus.currentStorageSizeMb}/${qsStatus.maxStorageSizeMb} MB`}
            </Badge>
          ) : null}
        </div>
        <Button
          size="small"
          appearance="outline"
          icon={<ArrowClockwise20Regular />}
          onClick={() => { loadStatus(); loadTop(); }}
          disabled={topLoading || statusLoading}
        >
          Refresh
        </Button>
      </div>

      {statusError && (
        <MessageBar intent="error"><MessageBarBody>
          <MessageBarTitle>Query Store status unavailable</MessageBarTitle>
          {statusError} — the console identity needs <code>VIEW DATABASE STATE</code> (or db_datareader) on this database.
        </MessageBarBody></MessageBar>
      )}

      {/* Honest gate: Query Store not collecting */}
      {qsStatus && !collecting && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Query Store is not collecting ({qsStatus.actualState})</MessageBarTitle>
            Azure SQL Database enables Query Store by default, but on this database it is{' '}
            <strong>{qsStatus.actualState}</strong>
            {qsStatus.actualState === 'READ_ONLY' && qsStatus.readonlyReason
              ? ` (readonly_reason ${qsStatus.readonlyReason}${qsStatus.readonlyReason === 65536 ? ' — storage quota exceeded' : ''})`
              : ''}
            . Enabling runs <code>ALTER DATABASE CURRENT SET QUERY_STORE = ON (OPERATION_MODE = READ_WRITE)</code>;
            the console identity must hold <code>ALTER</code> on the database. New statistics accrue once queries run.
            {enableMsg && <><br /><Text weight="semibold">{enableMsg}</Text></>}
          </MessageBarBody>
          <MessageBarActions>
            <Button appearance="primary" disabled={enabling} onClick={enableQs}>
              {enabling ? 'Enabling…' : 'Enable Query Store'}
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {/* Pickers */}
      <div className={s.toolbar}>
        <div className={s.field}>
          <Label size="small"><DataBarVertical20Regular style={{ verticalAlign: 'middle' }} /> Metric</Label>
          <Dropdown
            value={METRICS.find((m) => m.key === metric)!.label}
            selectedOptions={[metric]}
            onOptionSelect={(_, d) => setMetric((d.optionValue as Metric) || 'cpu')}
          >
            {METRICS.map((m) => <Option key={m.key} value={m.key}>{m.label}</Option>)}
          </Dropdown>
        </div>
        <div className={s.field}>
          <Label size="small"><Clock20Regular style={{ verticalAlign: 'middle' }} /> Time range</Label>
          <Dropdown
            value={WINDOWS.find((w) => w.hours === windowHours)!.label}
            selectedOptions={[String(windowHours)]}
            onOptionSelect={(_, d) => setWindowHours(Number(d.optionValue) || 24)}
          >
            {WINDOWS.map((w) => <Option key={w.hours} value={String(w.hours)}>{w.label}</Option>)}
          </Dropdown>
        </div>
        <div className={s.field}>
          <Label size="small"><TopSpeed20Regular style={{ verticalAlign: 'middle' }} /> Top N</Label>
          <Dropdown
            value={`Top ${topN}`}
            selectedOptions={[String(topN)]}
            onOptionSelect={(_, d) => setTopN(Number(d.optionValue) || 10)}
          >
            {TOPNS.map((n) => <Option key={n} value={String(n)}>{`Top ${n}`}</Option>)}
          </Dropdown>
        </div>
        {topLoading && <Spinner size="tiny" label="Querying Query Store…" labelPosition="after" />}
      </div>

      {topError && (
        <MessageBar intent="error"><MessageBarBody>
          <MessageBarTitle>Could not load top queries</MessageBarTitle>{topError}
        </MessageBarBody></MessageBar>
      )}

      {/* Split: bar chart (left) + detail pane (right) */}
      <div className={s.split}>
        <div className={s.leftCol}>
          <div className={s.sectionHeader}>
            <Subtitle2 className={s.sectionTitle}>
              <DataBarVertical24Regular />
              Top {rows.length} queries by {METRICS.find((m) => m.key === metric)!.label.toLowerCase()}
            </Subtitle2>
            <Caption1>Ranked from <code>sys.query_store_runtime_stats</code> over the selected window — click a bar for detail.</Caption1>
          </div>
          {topLoading && rows.length === 0 && (
            <Spinner size="tiny" label="Querying Query Store…" labelPosition="after" />
          )}
          {!topLoading && rows.length === 0 && (
            <EmptyState
              icon={<DataBarVertical24Regular />}
              title="No queries captured in this window"
              body={collecting
                ? 'Query Store is collecting but no runtime statistics fall in the selected time range. Run some workload against the database, widen the time range, then refresh.'
                : 'Query Store is not collecting yet. Enable it above to begin capturing query runtime statistics.'}
              primaryAction={{ label: 'Refresh', onClick: () => { loadStatus(); loadTop(); }, appearance: 'outline' }}
            />
          )}
          {rows.map((row) => {
            const v = fmtMetric(row, metric);
            const pct = Math.max(2, (v / maxValue) * 100);
            const isSel = selected?.queryId === row.queryId;
            const oneLine = row.queryText.replace(/\s+/g, ' ').trim().slice(0, 90);
            return (
              <div
                key={row.queryId}
                className={`${s.barRow} ${isSel ? s.barRowSelected : ''}`}
                onClick={() => selectQuery(row)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectQuery(row); } }}
                title={row.queryText}
              >
                <span className={s.barLabel}>#{row.queryId}</span>
                <div className={s.barTrack}>
                  <div className={s.barFill} style={{ width: `${pct}%` }} />
                  <span className={s.barText}>{oneLine || '(no text)'}</span>
                </div>
                <span className={s.barValue}>{fmtValue(v, metric)}</span>
              </div>
            );
          })}
        </div>

        <div className={s.rightCol}>
          {!selected ? (
            <EmptyState
              icon={<DataPie24Regular />}
              title="Select a query for detail"
              body="Pick a query on the left to see its text, aggregate metrics, runtime-stats time series, and execution plan."
            />
          ) : (
            <>
              <div className={s.selectedHeader}>
                <Subtitle2 className={s.sectionTitle}><DocumentText20Regular /> Query #{selected.queryId}</Subtitle2>
                {selected.lastExecutionTime && (
                  <Caption1>last run {new Date(selected.lastExecutionTime).toLocaleString()}</Caption1>
                )}
              </div>

              {/* Aggregate metric chips */}
              <div className={s.metricChips}>
                <div className={s.chip}><Caption1>CPU</Caption1><Text weight="semibold">{selected.totalCpuMs.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms</Text></div>
                <div className={s.chip}><Caption1>Duration</Caption1><Text weight="semibold">{selected.totalDurationMs.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms</Text></div>
                <div className={s.chip}><Caption1>Logical reads</Caption1><Text weight="semibold">{selected.totalLogicalReads.toLocaleString()}</Text></div>
                <div className={s.chip}><Caption1>Executions</Caption1><Text weight="semibold">{selected.totalExecutions.toLocaleString()}</Text></div>
              </div>

              {/* Query text */}
              <div>
                <div className={s.labelRow}>
                  <Label size="small"><DocumentText20Regular style={{ verticalAlign: 'middle' }} /> Query text</Label>
                  <Tooltip content="Copy query text" relationship="label">
                    <Button size="small" appearance="subtle" icon={<Copy20Regular />} aria-label="Copy query text"
                      onClick={() => navigator.clipboard?.writeText(selected.queryText)} />
                  </Tooltip>
                </div>
                <div className={s.detailText}>{selected.queryText || '(no text captured)'}</div>
              </div>

              {/* Runtime-stats time series (SVG sparkline) */}
              <div>
                <Label size="small"><DataTrending20Regular style={{ verticalAlign: 'middle' }} /> {METRICS.find((m) => m.key === metric)!.label} over time</Label>
                {seriesLoading ? (
                  <Spinner size="tiny" label="Loading runtime stats…" labelPosition="after" />
                ) : (
                  <Sparkline points={series} metric={metric} />
                )}
              </div>

              {/* Execution plan */}
              <details>
                <summary className={s.detailsSummary}><Timer20Regular style={{ verticalAlign: 'middle' }} /> Execution plan (showplan XML)</summary>
                {planLoading ? (
                  <Spinner size="tiny" label="Loading plan…" labelPosition="after" />
                ) : plan?.queryPlanXml ? (
                  <>
                    <div className={s.planMeta}>
                      <Caption1>plan #{plan.planId}{plan.lastCompileTime && ` · compiled ${new Date(plan.lastCompileTime).toLocaleString()}`}</Caption1>
                      <Tooltip content="Copy plan XML" relationship="label">
                        <Button size="small" appearance="subtle" icon={<Copy20Regular />} aria-label="Copy plan XML"
                          onClick={() => navigator.clipboard?.writeText(plan.queryPlanXml || '')} />
                      </Tooltip>
                    </div>
                    <div className={s.planXml}>{plan.queryPlanXml}</div>
                  </>
                ) : (
                  <Caption1>No showplan XML captured for this query (plan store may have trimmed it).</Caption1>
                )}
              </details>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Inline SVG sparkline for the runtime-stats series (no chart library) ──
function Sparkline({ points, metric }: { points: TimeSeriesPoint[]; metric: Metric }) {
  const W = 460, H = 90, PAD = 24;
  const valOf = (p: TimeSeriesPoint): number => {
    switch (metric) {
      case 'cpu': return p.avgCpuMs;
      case 'duration': return p.avgDurationMs;
      case 'logical-reads': return p.avgLogicalReads;
      case 'executions': return p.executions;
    }
  };
  if (!points.length) {
    return <Caption1>No interval data for this query in the selected window.</Caption1>;
  }
  const vals = points.map(valOf);
  const maxV = Math.max(...vals, 1);
  const n = points.length;
  const x = (i: number) => PAD + (n === 1 ? (W - 2 * PAD) / 2 : (i / (n - 1)) * (W - 2 * PAD));
  const y = (v: number) => H - PAD - (v / maxV) * (H - 2 * PAD);
  const poly = points.map((p, i) => `${x(i)},${y(valOf(p))}`).join(' ');
  const unit = METRICS.find((m) => m.key === metric)!.unit;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Runtime stats time series (${n} intervals)`} style={{ maxWidth: W }}>
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--colorNeutralStroke2)" strokeWidth={1} />
      <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="var(--colorNeutralStroke2)" strokeWidth={1} />
      <text x={PAD} y={PAD - 8} fontSize={10} fill="var(--colorNeutralForeground3)">{maxV.toLocaleString(undefined, { maximumFractionDigits: 1 })} {unit}</text>
      {n > 1 && <polyline points={poly} fill="none" stroke="var(--colorBrandForeground1)" strokeWidth={2} />}
      {points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(valOf(p))} r={2.5} fill="var(--colorBrandForeground1)">
          <title>{`${new Date(p.intervalStart).toLocaleString()} → ${valOf(p).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit} · ${p.executions} execs`}</title>
        </circle>
      ))}
    </svg>
  );
}

export default SqlPerformanceDashboard;
