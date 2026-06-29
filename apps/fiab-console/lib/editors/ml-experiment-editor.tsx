'use client';

/**
 * ML Experiment editor — full MLflow tracking surface over Azure Machine
 * Learning's MLflow-compatible tracking server (no Fabric / Power BI dependency).
 *
 * Parity target: the Azure ML Studio "Jobs / Experiment" experience —
 *   - a sortable + filterable runs table (sort any metric/param/attribute,
 *     free-text filter client-side, MLflow filter string server-side),
 *   - run detail: metric step charts, params, tags, and the artifact tree,
 *   - compare-runs: an overlaid metric step chart + a parallel-coordinates plot
 *     across the selected runs.
 *
 * Backends (all real MLflow REST via lib/azure/mlflow-client.ts):
 *   GET  /api/aml/experiments                         → searchExperiments()
 *   GET  /api/items/ml-experiment/[name]/runs         → experiment + runs (by name)
 *   POST /api/aml/runs                                 → searchRuns (filter/orderBy/compare)
 *   GET  /api/aml/runs/[runId]/metrics?metricKey=...   → metric step history
 *   GET  /api/aml/runs/[runId]/artifacts?path=...      → artifact listing
 *
 * Honest gate: when neither LOOM_MLFLOW_TRACKING_URI (the only supported path
 * in IL5 / GCC-High) nor the LOOM_AML_WORKSPACE + LOOM_AML_REGION +
 * LOOM_SUBSCRIPTION_ID auto-construction env (Commercial / GCC) is set, the
 * routes return { configured: false, hint } and this editor renders a Fluent
 * MessageBar naming the variable — the full surface still renders.
 *
 * Charts are pure SVG (no vega-lite/vega-embed dependency) so nothing new needs
 * supply-chain vetting in a cleared boundary; the SVG step chart and parallel
 * coordinates render the same data the Studio Metrics/Compare tabs do.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Spinner, Checkbox,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Field, Dropdown, Option,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSortUp16Regular, ArrowSortDown16Regular, ArrowSort16Regular,
  Folder16Regular, Document16Regular, ChevronRight16Regular, ChevronDown16Regular,
  BeakerRegular, DataHistogramRegular, DataLineRegular, ChartMultipleRegular,
  TableSimpleRegular, FlashRegular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemBrowseGate } from './new-item-gate';
import { EmptyState } from '@/lib/components/empty-state';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import {
  type MlflowRunLite, type SortColumn, type SortDir, type ParallelAxis,
  columnId, sortRuns, buildOrderBy, filterRunsLocal,
  collectMetricKeys, collectParamKeys, runMetric, runValue,
  userTags, buildParallelAxes, normalizeOnAxis, compareColor,
} from './_ml-experiment-utils';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingVerticalM,
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transition: 'box-shadow 0.15s ease, transform 0.15s ease',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge },
  sectionIcon: { color: tokens.colorBrandForeground1, display: 'inline-flex', flexShrink: 0 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
  sortHeader: { cursor: 'pointer', userSelect: 'none' },
  mono: { fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  legendRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  swatch: { width: '12px', height: '12px', borderRadius: tokens.borderRadiusSmall, display: 'inline-block' },
  treeRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, padding: `${tokens.spacingVerticalXXS} 0`, fontSize: tokens.fontSizeBase300, minWidth: 0 },
});

interface MlflowExperimentLite { experimentId: string; name: string; lastUpdateTime?: number; tags?: Record<string, string> }
interface ArtifactNode { path: string; isDir: boolean; fileSize?: number }

function fmtEpochMs(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  try { return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z'); } catch { return '—'; }
}
function fmtBytes(n?: number): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}
function statusColor(s?: string): 'success' | 'danger' | 'informative' {
  if (s === 'FINISHED') return 'success';
  if (s === 'FAILED' || s === 'KILLED') return 'danger';
  return 'informative';
}

// ============================================================
// SVG metric step chart (single or overlaid series)
// ============================================================
interface ChartSeries { runId: string; label: string; color: string; points: { x: number; y: number }[] }

function MetricStepChart({ series, metricLabel }: { series: ChartSeries[]; metricLabel: string }) {
  const W = 700, H = 250, padL = 56, padR = 150, padT = 16, padB = 32;
  const cleaned = series
    .map((s) => ({ ...s, points: s.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) }))
    .filter((s) => s.points.length > 0);
  const all = cleaned.flatMap((s) => s.points);
  if (all.length < 1) return null;
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const xSpan = xMax - xMin || 1, ySpan = yMax - yMin || 1;
  const sx = (x: number) => padL + ((x - xMin) / xSpan) * (W - padL - padR);
  const sy = (y: number) => H - padB - ((y - yMin) / ySpan) * (H - padT - padB);
  const yTicks = [yMin, (yMin + yMax) / 2, yMax];
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Metric ${metricLabel} step chart`}
      style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, background: tokens.colorNeutralBackground2, maxWidth: W }}>
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={padL} y1={sy(t)} x2={W - padR} y2={sy(t)} stroke={tokens.colorNeutralStroke3} strokeWidth={1} />
          <text x={padL - 6} y={sy(t) + 4} textAnchor="end" fontSize={10} fill={tokens.colorNeutralForeground3}>{t.toPrecision(4)}</text>
        </g>
      ))}
      <text x={padL} y={H - 8} textAnchor="start" fontSize={10} fill={tokens.colorNeutralForeground3}>{xMin}</text>
      <text x={W - padR} y={H - 8} textAnchor="end" fontSize={10} fill={tokens.colorNeutralForeground3}>{xMax}</text>
      <text x={(padL + W - padR) / 2} y={H - 8} textAnchor="middle" fontSize={10} fill={tokens.colorNeutralForeground3}>step</text>
      <text x={14} y={(padT + H - padB) / 2} textAnchor="middle" fontSize={10} fill={tokens.colorNeutralForeground3}
        transform={`rotate(-90 14 ${(padT + H - padB) / 2})`}>{metricLabel}</text>
      {cleaned.map((s) => {
        const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
        return (
          <g key={s.runId}>
            <path d={d} fill="none" stroke={s.color} strokeWidth={2} />
            {s.points.map((p, i) => <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={2.2} fill={s.color} />)}
          </g>
        );
      })}
      {/* legend */}
      {cleaned.map((s, i) => (
        <g key={`lg-${s.runId}`} transform={`translate(${W - padR + 8}, ${padT + 4 + i * 18})`}>
          <rect width={12} height={12} rx={2} fill={s.color} />
          <text x={18} y={10} fontSize={11} fill={tokens.colorNeutralForeground2}>
            {s.label.length > 16 ? `${s.label.slice(0, 15)}…` : s.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

// ============================================================
// SVG parallel coordinates (compare runs across metrics/params)
// ============================================================
function ParallelCoordinates({ runs, axes }: { runs: MlflowRunLite[]; axes: ParallelAxis[] }) {
  const W = 760, H = 320, padL = 24, padR = 24, padT = 28, padB = 48;
  if (axes.length < 1 || runs.length < 1) return null;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const axisX = (i: number) => padL + (axes.length === 1 ? innerW / 2 : (i / (axes.length - 1)) * innerW);
  const valY = (norm: number) => padT + innerH - norm * innerH;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Parallel coordinates of selected runs"
      style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, background: tokens.colorNeutralBackground2, maxWidth: W }}>
      {/* axes */}
      {axes.map((ax, i) => (
        <g key={columnId(ax.col)}>
          <line x1={axisX(i)} y1={padT} x2={axisX(i)} y2={padT + innerH} stroke={tokens.colorNeutralStroke2} strokeWidth={1} />
          <text x={axisX(i)} y={padT - 8} textAnchor="middle" fontSize={10} fill={tokens.colorNeutralForeground2}>
            {ax.label.length > 14 ? `${ax.label.slice(0, 13)}…` : ax.label}
          </text>
          <text x={axisX(i)} y={padT + innerH + 14} textAnchor="middle" fontSize={9} fill={tokens.colorNeutralForeground3}>{ax.min.toPrecision(3)}</text>
          <text x={axisX(i)} y={padT - 18} textAnchor="middle" fontSize={9} fill={tokens.colorNeutralForeground3}>{ax.max.toPrecision(3)}</text>
        </g>
      ))}
      {/* one polyline per run */}
      {runs.map((r, ri) => {
        const color = compareColor(ri);
        const pts: string[] = [];
        axes.forEach((ax, i) => {
          const v = runValue(r, ax.col);
          if (typeof v === 'number' && Number.isFinite(v)) {
            pts.push(`${axisX(i).toFixed(1)},${valY(normalizeOnAxis(v, ax)).toFixed(1)}`);
          }
        });
        if (pts.length < 1) return null;
        return (
          <polyline key={r.runId} points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.8} opacity={0.85}>
            <title>{r.runName || r.runId}</title>
          </polyline>
        );
      })}
    </svg>
  );
}

// ============================================================
// Artifact tree (lazy, real /artifacts list per directory)
// ============================================================
function ArtifactTree({ runId }: { runId: string }) {
  const s = useStyles();
  const [children, setChildren] = useState<Record<string, ArtifactNode[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [hint, setHint] = useState<string | null>(null);

  const fetchPath = useCallback(async (path: string) => {
    setLoading((l) => ({ ...l, [path]: true }));
    try {
      const qs = path ? `?path=${encodeURIComponent(path)}` : '';
      const r = await fetch(`/api/aml/runs/${encodeURIComponent(runId)}/artifacts${qs}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      if (j.configured === false) { setConfigured(false); setHint(j.hint || null); return; }
      setChildren((c) => ({ ...c, [path]: Array.isArray(j.artifacts) ? j.artifacts : [] }));
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading((l) => ({ ...l, [path]: false })); }
  }, [runId]);

  useEffect(() => { setChildren({}); setOpen(new Set()); setError(null); fetchPath(''); }, [fetchPath]);

  const toggle = useCallback((path: string) => {
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(path)) n.delete(path);
      else { n.add(path); if (!children[path]) fetchPath(path); }
      return n;
    });
  }, [children, fetchPath]);

  const renderLevel = (path: string, depth: number): ReactElement[] => {
    const nodes = children[path];
    if (!nodes) return [];
    return nodes.flatMap((node) => {
      const isOpen = open.has(node.path);
      const rows: ReactElement[] = [
        <div key={node.path} className={s.treeRow} style={{ paddingLeft: depth * 18 }}>
          {node.isDir ? (
            <span
              role="button"
              tabIndex={0}
              aria-label={isOpen ? `Collapse ${node.path}` : `Expand ${node.path}`}
              onClick={() => toggle(node.path)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(node.path); } }}
              style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
            >
              {isOpen ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
              <Folder16Regular style={{ margin: `0 ${tokens.spacingHorizontalXS}`, color: tokens.colorBrandForeground1 }} />
            </span>
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', paddingLeft: tokens.spacingHorizontalL }}>
              <Document16Regular style={{ margin: `0 ${tokens.spacingHorizontalXS}`, color: tokens.colorNeutralForeground3 }} />
            </span>
          )}
          <span style={{ minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{node.path.split('/').pop() || node.path}</span>
          {!node.isDir && <Caption1 style={{ color: tokens.colorNeutralForeground3, marginLeft: tokens.spacingHorizontalS }}>{fmtBytes(node.fileSize)}</Caption1>}
          {!node.isDir && (
            <span style={{ display: 'inline-flex', gap: tokens.spacingHorizontalXS, marginLeft: tokens.spacingHorizontalS }}>
              <a href={`/api/aml/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(node.path)}`} target="_blank" rel="noreferrer" aria-label={`Preview ${node.path}`}>preview</a>
              <a href={`/api/aml/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(node.path)}&download=1`} aria-label={`Download ${node.path}`}>download</a>
            </span>
          )}
          {node.isDir && loading[node.path] && <Spinner size="extra-tiny" style={{ marginLeft: tokens.spacingHorizontalS }} />}
        </div>,
      ];
      if (node.isDir && isOpen) rows.push(...renderLevel(node.path, depth + 1));
      return rows;
    });
  };

  if (!configured) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>MLflow tracking not configured</MessageBarTitle>
          {hint || 'Set LOOM_MLFLOW_TRACKING_URI (or LOOM_AML_WORKSPACE + LOOM_AML_REGION + LOOM_SUBSCRIPTION_ID).'}
        </MessageBarBody>
      </MessageBar>
    );
  }
  if (error) return <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>;
  if (loading[''] && !children['']) return <Spinner size="tiny" label="Loading artifacts…" labelPosition="after" />;
  if (children[''] && children[''].length === 0) {
    return <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No artifacts logged on this run.</Caption1>;
  }
  return <div role="tree" aria-label="Run artifacts">{renderLevel('', 0)}</div>;
}

// ============================================================
// Entry — /new browses the real experiment registry
// ============================================================
export function MlExperimentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const isNew = id === 'new' || !id;
  if (isNew) {
    return (
      <NewItemBrowseGate
        item={item}
        endpoint="/api/aml/experiments"
        listKey="experiments"
        openSlug="ml-experiment"
        studioUrl="https://ml.azure.com/experiments"
        studioLabel="Open Azure ML Studio"
        intro="MLflow experiments group runs logged from notebooks, jobs, or any MLflow client against the Azure Machine Learning tracking server. Select an experiment and Open it to browse its runs, metric step charts, params, tags, artifacts, and compare runs side by side."
        gateHint="No experiments found — log a run with mlflow.start_run() against this workspace. If this errors, set LOOM_MLFLOW_TRACKING_URI (required in IL5 / GCC-High) or LOOM_AML_WORKSPACE + LOOM_AML_REGION + LOOM_SUBSCRIPTION_ID, then grant the Console UAMI the AzureML Data Scientist role."
        mapEntity={(e: MlflowExperimentLite) => ({
          id: e.name,
          name: e.name,
          badge: e.experimentId ? `id ${e.experimentId}` : undefined,
        })}
      />
    );
  }
  return <MlExperimentEditorBody item={item} id={id} />;
}

// ============================================================
// Body — runs table / detail / compare
// ============================================================
type ViewMode = 'runs' | 'detail' | 'compare';

function MlExperimentEditorBody({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();

  // load state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [hint, setHint] = useState<string | null>(null);
  const [experiment, setExperiment] = useState<MlflowExperimentLite | null>(null);
  const [runs, setRuns] = useState<MlflowRunLite[]>([]);

  // view
  const [view, setView] = useState<ViewMode>('runs');

  // table sort / filter
  const [sortCol, setSortCol] = useState<SortColumn>({ kind: 'attr', field: 'startTime' });
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [localSearch, setLocalSearch] = useState('');
  const [serverFilter, setServerFilter] = useState('');
  const [applying, setApplying] = useState(false);

  // selection
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());

  // detail: metric history
  const [detailMetric, setDetailMetric] = useState('');
  const [detailHistory, setDetailHistory] = useState<{ x: number; y: number }[]>([]);
  const [detailMetricLoading, setDetailMetricLoading] = useState(false);
  const [detailTab, setDetailTab] = useState<'metrics' | 'params' | 'tags' | 'artifacts'>('metrics');

  // compare
  const [compareMetric, setCompareMetric] = useState('');
  const [compareSeries, setCompareSeries] = useState<ChartSeries[]>([]);
  const [compareLoading, setCompareLoading] = useState(false);

  // ---- initial load: experiment + runs (by name) ----
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/items/ml-experiment/${encodeURIComponent(id)}/runs`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setLoading(false); return; }
      if (j.configured === false) { setConfigured(false); setHint(j.hint || null); setRuns([]); setLoading(false); return; }
      setConfigured(true);
      setExperiment(j.experiment || (j.experimentName ? { experimentId: '', name: j.experimentName } : null));
      const rows: MlflowRunLite[] = Array.isArray(j.runs) ? j.runs : [];
      setRuns(rows);
      setDetailRunId((prev) => (prev && rows.some((x) => x.runId === prev) ? prev : rows[0]?.runId || null));
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  // ---- server query (MLflow filter + orderBy) via /api/aml/runs ----
  const applyServerQuery = useCallback(async () => {
    if (!experiment?.experimentId) {
      // No resolved id (e.g. older route) — re-run name resolution + filter.
      setApplying(true);
      try {
        const qs = serverFilter ? `?filter=${encodeURIComponent(serverFilter)}` : '';
        const r = await fetch(`/api/items/ml-experiment/${encodeURIComponent(id)}/runs${qs}`);
        const j = await r.json();
        if (j.ok && j.configured !== false) setRuns(Array.isArray(j.runs) ? j.runs : []);
        else if (j.configured === false) { setConfigured(false); setHint(j.hint || null); }
      } catch (e: any) { setError(e?.message || String(e)); }
      finally { setApplying(false); }
      return;
    }
    setApplying(true);
    try {
      const orderBy = buildOrderBy(sortCol, sortDir);
      const r = await fetch('/api/aml/runs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          experimentIds: [experiment.experimentId],
          filter: serverFilter || undefined,
          orderBy,
          maxResults: 1000,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      if (j.configured === false) { setConfigured(false); setHint(j.hint || null); return; }
      setRuns(Array.isArray(j.runs) ? j.runs : []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setApplying(false); }
  }, [experiment, id, serverFilter, sortCol, sortDir]);

  // ---- detail metric history ----
  const selectedRun = useMemo(() => runs.find((r) => r.runId === detailRunId) || null, [runs, detailRunId]);
  const detailMetricKeys = useMemo(() => (selectedRun ? collectMetricKeys([selectedRun]) : []), [selectedRun]);

  useEffect(() => {
    setDetailMetric((prev) => (prev && detailMetricKeys.includes(prev) ? prev : detailMetricKeys[0] || ''));
    setDetailHistory([]);
  }, [detailRunId, detailMetricKeys]);

  const loadDetailHistory = useCallback(async () => {
    if (!detailRunId || !detailMetric) { setDetailHistory([]); return; }
    setDetailMetricLoading(true);
    try {
      const r = await fetch(`/api/aml/runs/${encodeURIComponent(detailRunId)}/metrics?metricKey=${encodeURIComponent(detailMetric)}`);
      const j = await r.json();
      if (j.ok && j.configured !== false) {
        const hist = (Array.isArray(j.history) ? j.history : []).map((m: any, i: number) => ({ x: m.step ?? i, y: m.value }));
        setDetailHistory(hist);
      } else if (j.configured === false) { setConfigured(false); setHint(j.hint || null); }
    } catch { /* surfaced via empty chart */ }
    finally { setDetailMetricLoading(false); }
  }, [detailRunId, detailMetric]);
  useEffect(() => { if (detailRunId && detailMetric && detailTab === 'metrics') loadDetailHistory(); }, [detailRunId, detailMetric, detailTab, loadDetailHistory]);

  // ---- compare ----
  const checkedRuns = useMemo(() => runs.filter((r) => checked.has(r.runId)), [runs, checked]);
  const compareMetricKeys = useMemo(() => collectMetricKeys(checkedRuns), [checkedRuns]);
  const parallelAxes = useMemo(() => buildParallelAxes(checkedRuns), [checkedRuns]);

  useEffect(() => {
    setCompareMetric((prev) => (prev && compareMetricKeys.includes(prev) ? prev : compareMetricKeys[0] || ''));
  }, [compareMetricKeys]);

  const loadCompareSeries = useCallback(async () => {
    if (!compareMetric || checkedRuns.length === 0) { setCompareSeries([]); return; }
    setCompareLoading(true);
    try {
      const series = await Promise.all(checkedRuns.map(async (run, idx) => {
        const r = await fetch(`/api/aml/runs/${encodeURIComponent(run.runId)}/metrics?metricKey=${encodeURIComponent(compareMetric)}`);
        const j = await r.json();
        const pts = (j.ok && Array.isArray(j.history) ? j.history : []).map((m: any, i: number) => ({ x: m.step ?? i, y: m.value }));
        return { runId: run.runId, label: run.runName || run.runId, color: compareColor(idx), points: pts } as ChartSeries;
      }));
      setCompareSeries(series);
    } catch { setCompareSeries([]); }
    finally { setCompareLoading(false); }
  }, [compareMetric, checkedRuns]);
  useEffect(() => { if (view === 'compare' && compareMetric) loadCompareSeries(); }, [view, compareMetric, loadCompareSeries]);

  // ---- displayed rows (client sort + client free-text filter) ----
  const displayRuns = useMemo(
    () => sortRuns(filterRunsLocal(runs, localSearch), sortCol, sortDir),
    [runs, localSearch, sortCol, sortDir],
  );

  // metric/param columns to show in the table (union across runs)
  const metricCols = useMemo(() => collectMetricKeys(runs), [runs]);
  const paramCols = useMemo(() => collectParamKeys(runs), [runs]);

  const onSort = useCallback((col: SortColumn) => {
    setSortCol((prev) => {
      if (columnId(prev) === columnId(col)) { setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); return prev; }
      setSortDir('desc');
      return col;
    });
  }, []);

  const sortIcon = (col: SortColumn) => {
    if (columnId(sortCol) !== columnId(col)) return <ArrowSort16Regular />;
    return sortDir === 'asc' ? <ArrowSortUp16Regular /> : <ArrowSortDown16Regular />;
  };

  const toggleCheck = useCallback((runId: string) => {
    setChecked((c) => { const n = new Set(c); if (n.has(runId)) n.delete(runId); else n.add(runId); return n; });
  }, []);

  const openDetail = useCallback((runId: string) => { setDetailRunId(runId); setView('detail'); setDetailTab('metrics'); }, []);

  // Run lifecycle actions (delete / clone / archive) — real MLflow REST.
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const runAction = useCallback(async (runId: string, action: 'delete' | 'clone' | 'archive') => {
    setActionBusy(`${action}:${runId}`); setActionMsg(null);
    try {
      const r = await fetch(`/api/aml/runs/${encodeURIComponent(runId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
      const j = await r.json();
      if (!j.ok) { setActionMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      if (j.configured === false) { setActionMsg({ intent: 'error', text: j.hint || 'MLflow not configured' }); return; }
      setActionMsg({ intent: 'success', text: j.message || `${action} done` });
      await load();
    } catch (e: any) { setActionMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setActionBusy(null); }
  }, [load]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Experiment', actions: [
        { label: loading ? 'Reloading…' : 'Reload', onClick: loading ? undefined : load, disabled: loading },
      ]},
      { label: 'View', actions: [
        { label: 'Runs', onClick: () => setView('runs') },
        { label: 'Run detail', onClick: () => detailRunId && setView('detail'), disabled: !detailRunId },
        { label: `Compare (${checked.size})`, onClick: () => setView('compare'), disabled: checked.size < 2 },
      ]},
      { label: 'Selection', actions: [
        { label: 'Clear selection', onClick: () => setChecked(new Set()), disabled: checked.size === 0 },
      ]},
    ]},
  ], [loading, load, detailRunId, checked.size]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      main={
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading experiment…" labelPosition="after" />}

          {!configured && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Azure ML MLflow tracking not configured</MessageBarTitle>
                {hint || 'MLflow tracking is not configured in this deployment.'}
                <br />
                <Caption1>
                  Set <code>LOOM_MLFLOW_TRACKING_URI</code> (required in IL5 / GCC-High — get it via{' '}
                  <code>az ml workspace show --query mlflow_tracking_uri -o tsv</code>), or in Commercial / GCC set{' '}
                  <code>LOOM_AML_WORKSPACE</code> + <code>LOOM_AML_REGION</code> + <code>LOOM_SUBSCRIPTION_ID</code>,
                  then grant the Console UAMI the <strong>AzureML Data Scientist</strong> role on the workspace.
                </Caption1>
              </MessageBarBody>
            </MessageBar>
          )}

          {error && (
            <MessageBar intent="error">
              <MessageBarBody><MessageBarTitle>Load failed</MessageBarTitle>{error}</MessageBarBody>
            </MessageBar>
          )}

          {!loading && configured && (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' }}>
                <span className={s.sectionHeader}>
                  <BeakerRegular className={s.sectionIcon} aria-hidden />
                  <Subtitle2>Experiment: {experiment?.name || id}</Subtitle2>
                </span>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  {experiment?.experimentId ? `id ${experiment.experimentId} · ` : ''}{runs.length} run(s)
                </Caption1>
              </div>

              <TabList selectedValue={view} onTabSelect={(_, d) => setView(d.value as ViewMode)}>
                <Tab value="runs">Runs</Tab>
                <Tab value="detail" disabled={!detailRunId}>Run detail</Tab>
                <Tab value="compare" disabled={checked.size < 2}>Compare ({checked.size})</Tab>
              </TabList>

              {/* ---------- RUNS ---------- */}
              {view === 'runs' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalMNudge }}>
                  <div className={s.toolbar}>
                    <Field label="Filter rows (name / param / metric)" style={{ minWidth: 240 }}>
                      <Input value={localSearch} onChange={(_, d) => setLocalSearch(d.value)} placeholder="e.g. lr, accuracy, run-42" />
                    </Field>
                    <Field label="MLflow filter (server-side)" style={{ minWidth: 280 }}>
                      <Input
                        value={serverFilter}
                        onChange={(_, d) => setServerFilter(d.value)}
                        placeholder="metrics.accuracy > 0.9 and params.lr = '0.01'"
                        onKeyDown={(e) => { if (e.key === 'Enter') applyServerQuery(); }}
                      />
                    </Field>
                    <Button appearance="primary" onClick={applyServerQuery} disabled={applying}>
                      {applying ? 'Applying…' : 'Apply filter'}
                    </Button>
                    {serverFilter && (
                      <Button appearance="subtle" onClick={() => { setServerFilter(''); load(); }} disabled={applying}>Clear</Button>
                    )}
                  </div>
                  {actionMsg && <MessageBar intent={actionMsg.intent === 'success' ? 'success' : 'error'}><MessageBarBody>{actionMsg.text}</MessageBarBody></MessageBar>}

                  {runs.length === 0 ? (
                    <EmptyState
                      icon={<BeakerRegular />}
                      title="No runs for this experiment"
                      body={`Log a run with mlflow.start_run() + mlflow.log_metric() under "${experiment?.name || id}", then reload to see its runs, metric step charts, params, tags, and artifacts.`}
                    />
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <Table aria-label="MLflow runs" size="small">
                        <TableHeader>
                          <TableRow>
                            <TableHeaderCell style={{ width: 40 }}>Sel</TableHeaderCell>
                            <TableHeaderCell className={s.sortHeader} onClick={() => onSort({ kind: 'attr', field: 'runName' })}>
                              Run {sortIcon({ kind: 'attr', field: 'runName' })}
                            </TableHeaderCell>
                            <TableHeaderCell className={s.sortHeader} onClick={() => onSort({ kind: 'attr', field: 'status' })}>
                              Status {sortIcon({ kind: 'attr', field: 'status' })}
                            </TableHeaderCell>
                            <TableHeaderCell className={s.sortHeader} onClick={() => onSort({ kind: 'attr', field: 'startTime' })}>
                              Started {sortIcon({ kind: 'attr', field: 'startTime' })}
                            </TableHeaderCell>
                            {metricCols.map((k) => (
                              <TableHeaderCell key={`m-${k}`} className={s.sortHeader} onClick={() => onSort({ kind: 'metric', field: k })}>
                                {k} {sortIcon({ kind: 'metric', field: k })}
                              </TableHeaderCell>
                            ))}
                            {paramCols.map((k) => (
                              <TableHeaderCell key={`p-${k}`} className={s.sortHeader} onClick={() => onSort({ kind: 'param', field: k })}>
                                p:{k} {sortIcon({ kind: 'param', field: k })}
                              </TableHeaderCell>
                            ))}
                            <TableHeaderCell>Actions</TableHeaderCell>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {displayRuns.map((r) => (
                            <TableRow
                              key={r.runId}
                              style={{ background: r.runId === detailRunId ? tokens.colorNeutralBackground2 : undefined }}
                            >
                              <TableCell>
                                <Checkbox
                                  checked={checked.has(r.runId)}
                                  onChange={() => toggleCheck(r.runId)}
                                  aria-label={`Select run ${r.runName || r.runId} for compare`}
                                />
                              </TableCell>
                              <TableCell>
                                <Button appearance="transparent" size="small" onClick={() => openDetail(r.runId)} style={{ padding: 0, minWidth: 0 }}>
                                  <strong>{r.runName || r.runId}</strong>
                                </Button>
                              </TableCell>
                              <TableCell>
                                <Badge appearance="tint" color={statusColor(r.status)}>{r.status || '—'}</Badge>
                              </TableCell>
                              <TableCell>{fmtEpochMs(r.startTime)}</TableCell>
                              {metricCols.map((k) => {
                                const v = runMetric(r, k);
                                return <TableCell key={`m-${r.runId}-${k}`} className={s.mono}>{v == null ? '—' : v.toPrecision(5)}</TableCell>;
                              })}
                              {paramCols.map((k) => {
                                const v = r.params.find((p) => p.key === k)?.value;
                                return <TableCell key={`p-${r.runId}-${k}`} className={s.mono}>{v ?? '—'}</TableCell>;
                              })}
                              <TableCell>
                                <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' }}>
                                  <Button size="small" appearance="subtle" disabled={!!actionBusy} onClick={() => runAction(r.runId, 'clone')}>Clone</Button>
                                  <Button size="small" appearance="subtle" disabled={!!actionBusy} onClick={() => runAction(r.runId, 'archive')}>Archive</Button>
                                  <Button size="small" appearance="subtle" disabled={!!actionBusy} onClick={() => runAction(r.runId, 'delete')}>{actionBusy === `delete:${r.runId}` ? '…' : 'Delete'}</Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                  {checked.size >= 2 && (
                    <Button appearance="primary" style={{ alignSelf: 'flex-start' }} onClick={() => setView('compare')}>
                      Compare {checked.size} runs
                    </Button>
                  )}
                </div>
              )}

              {/* ---------- DETAIL ---------- */}
              {view === 'detail' && selectedRun && (
                <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                  <span className={s.sectionHeader}>
                    <FlashRegular className={s.sectionIcon} aria-hidden />
                    <Subtitle2>Run: {selectedRun.runName || selectedRun.runId}</Subtitle2>
                  </span>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                    <Badge appearance="outline" color={statusColor(selectedRun.status)}>{selectedRun.status || '—'}</Badge>
                    <Badge appearance="outline">start: {fmtEpochMs(selectedRun.startTime)}</Badge>
                    <Badge appearance="outline">end: {fmtEpochMs(selectedRun.endTime)}</Badge>
                    {selectedRun.artifactUri && <Badge appearance="outline" title={selectedRun.artifactUri}>artifacts ✓</Badge>}
                  </div>

                  <TabList selectedValue={detailTab} onTabSelect={(_, d) => setDetailTab(d.value as any)}>
                    <Tab value="metrics">Metrics</Tab>
                    <Tab value="params">Params</Tab>
                    <Tab value="tags">Tags</Tab>
                    <Tab value="artifacts">Artifacts</Tab>
                  </TabList>

                  {detailTab === 'metrics' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                      <div className={s.toolbar}>
                        <Field label="Metric">
                          <Dropdown
                            placeholder={detailMetricKeys.length ? 'Select a metric' : 'No metrics logged'}
                            value={detailMetric}
                            selectedOptions={detailMetric ? [detailMetric] : []}
                            onOptionSelect={(_, d) => setDetailMetric(d.optionValue || '')}
                            disabled={detailMetricKeys.length === 0}
                          >
                            {detailMetricKeys.map((k) => <Option key={k} value={k}>{k}</Option>)}
                          </Dropdown>
                        </Field>
                        {detailMetricLoading && <Spinner size="tiny" label="Loading history…" labelPosition="after" />}
                      </div>
                      {!detailMetricLoading && detailMetric && detailHistory.length === 0 && (
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No step history for <code>{detailMetric}</code> (single-value metric).</Caption1>
                      )}
                      {detailHistory.length > 0 && (
                        <MetricStepChart metricLabel={detailMetric} series={[{ runId: selectedRun.runId, label: selectedRun.runName || selectedRun.runId, color: compareColor(0), points: detailHistory }]} />
                      )}
                      {selectedRun.metrics.length > 0 && (
                        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                          <Table aria-label="Latest metric values" size="small">
                            <TableHeader><TableRow><TableHeaderCell>Metric</TableHeaderCell><TableHeaderCell>Latest value</TableHeaderCell><TableHeaderCell>Step</TableHeaderCell></TableRow></TableHeader>
                            <TableBody>
                              {selectedRun.metrics.map((m) => (
                                <TableRow key={m.key}>
                                  <TableCell className={s.mono}>{m.key}</TableCell>
                                  <TableCell className={s.mono}>{m.value}</TableCell>
                                  <TableCell className={s.mono}>{m.step ?? '—'}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      )}
                    </div>
                  )}

                  {detailTab === 'params' && (
                    selectedRun.params.length === 0
                      ? <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No params logged.</Caption1>
                      : (
                        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                          <Table aria-label="Run params" size="small">
                            <TableHeader><TableRow><TableHeaderCell>Key</TableHeaderCell><TableHeaderCell>Value</TableHeaderCell></TableRow></TableHeader>
                            <TableBody>
                              {selectedRun.params.map((p) => (
                                <TableRow key={p.key}><TableCell className={s.mono}>{p.key}</TableCell><TableCell className={s.mono}>{p.value}</TableCell></TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      )
                  )}

                  {detailTab === 'tags' && (() => {
                    const tags = userTags(selectedRun);
                    return tags.length === 0
                      ? <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No user tags (mlflow.* system tags hidden).</Caption1>
                      : (
                        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                          <Table aria-label="Run tags" size="small">
                            <TableHeader><TableRow><TableHeaderCell>Key</TableHeaderCell><TableHeaderCell>Value</TableHeaderCell></TableRow></TableHeader>
                            <TableBody>
                              {tags.map((t) => (
                                <TableRow key={t.key}><TableCell className={s.mono}>{t.key}</TableCell><TableCell className={s.mono}>{t.value}</TableCell></TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      );
                  })()}

                  {detailTab === 'artifacts' && <ArtifactTree runId={selectedRun.runId} />}
                </div>
              )}

              {/* ---------- COMPARE ---------- */}
              {view === 'compare' && (
                <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                  <span className={s.sectionHeader}>
                    <ChartMultipleRegular className={s.sectionIcon} aria-hidden />
                    <Subtitle2>Compare {checkedRuns.length} runs</Subtitle2>
                  </span>
                  {checkedRuns.length < 2 ? (
                    <MessageBar intent="info"><MessageBarBody>Select at least 2 runs (checkboxes in the Runs tab) to compare.</MessageBarBody></MessageBar>
                  ) : (
                    <>
                      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                        {checkedRuns.map((r, i) => (
                          <span key={r.runId} className={s.legendRow}>
                            <span className={s.swatch} style={{ background: compareColor(i) }} />
                            <Caption1>{r.runName || r.runId}</Caption1>
                          </span>
                        ))}
                      </div>

                      <span className={s.sectionHeader}>
                        <DataLineRegular className={s.sectionIcon} aria-hidden />
                        <Subtitle2>Overlaid metric step chart</Subtitle2>
                      </span>
                      <div className={s.toolbar}>
                        <Field label="Metric">
                          <Dropdown
                            placeholder={compareMetricKeys.length ? 'Select a metric' : 'No common metrics'}
                            value={compareMetric}
                            selectedOptions={compareMetric ? [compareMetric] : []}
                            onOptionSelect={(_, d) => setCompareMetric(d.optionValue || '')}
                            disabled={compareMetricKeys.length === 0}
                          >
                            {compareMetricKeys.map((k) => <Option key={k} value={k}>{k}</Option>)}
                          </Dropdown>
                        </Field>
                        {compareLoading && <Spinner size="tiny" label="Loading…" labelPosition="after" />}
                      </div>
                      {compareSeries.length > 0
                        ? <MetricStepChart metricLabel={compareMetric} series={compareSeries} />
                        : !compareLoading && compareMetric && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No step history for <code>{compareMetric}</code> on the selected runs.</Caption1>}

                      <span className={s.sectionHeader} style={{ marginTop: tokens.spacingVerticalS }}>
                        <DataHistogramRegular className={s.sectionIcon} aria-hidden />
                        <Subtitle2>Parallel coordinates</Subtitle2>
                      </span>
                      {parallelAxes.length > 0
                        ? <ParallelCoordinates runs={checkedRuns} axes={parallelAxes} />
                        : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No numeric metrics/params to plot across the selected runs.</Caption1>}

                      <span className={s.sectionHeader} style={{ marginTop: tokens.spacingVerticalS }}>
                        <TableSimpleRegular className={s.sectionIcon} aria-hidden />
                        <Subtitle2>Side-by-side</Subtitle2>
                      </span>
                      <div style={{ overflowX: 'auto' }}>
                        <Table aria-label="Compare runs" size="small">
                          <TableHeader>
                            <TableRow>
                              <TableHeaderCell>Field</TableHeaderCell>
                              {checkedRuns.map((r, i) => (
                                <TableHeaderCell key={r.runId}>
                                  <span className={s.legendRow}><span className={s.swatch} style={{ background: compareColor(i) }} />{r.runName || r.runId}</span>
                                </TableHeaderCell>
                              ))}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            <TableRow>
                              <TableCell>Status</TableCell>
                              {checkedRuns.map((r) => <TableCell key={r.runId}>{r.status || '—'}</TableCell>)}
                            </TableRow>
                            {parallelAxes.map((ax) => (
                              <TableRow key={columnId(ax.col)}>
                                <TableCell className={s.mono}>{ax.label}</TableCell>
                                {checkedRuns.map((r) => {
                                  const v = runValue(r, ax.col);
                                  return <TableCell key={r.runId} className={s.mono}>{typeof v === 'number' ? v.toPrecision(5) : v ?? '—'}</TableCell>;
                                })}
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      }
    />
  );
}
