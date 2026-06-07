/**
 * Pure-logic helpers for the ML Experiment editor (lib/editors/ml-experiment-editor.tsx).
 *
 * Extracted so the sort/filter/compare math is unit-tested without a browser
 * (see lib/editors/__tests__/ml-experiment-utils.test.ts). Mirrors the MLflow
 * run shapes from lib/azure/mlflow-client.ts.
 */

export interface MlflowMetricLite { key: string; value: number; timestamp?: number; step?: number }
export interface MlflowParamLite { key: string; value: string }
export interface MlflowRunTagLite { key: string; value: string }
export interface MlflowRunLite {
  runId: string;
  runName?: string;
  experimentId?: string;
  status?: string;
  startTime?: number;
  endTime?: number;
  artifactUri?: string;
  metrics: MlflowMetricLite[];
  params: MlflowParamLite[];
  tags: MlflowRunTagLite[];
}

/** Latest logged value of a metric key on a run, or undefined. */
export function runMetric(run: MlflowRunLite, key: string): number | undefined {
  const m = run.metrics.find((x) => x.key === key);
  return m && Number.isFinite(m.value) ? m.value : undefined;
}

/** Param value (string) for a key on a run, or undefined. */
export function runParam(run: MlflowRunLite, key: string): string | undefined {
  return run.params.find((x) => x.key === key)?.value;
}

/** Union of metric keys across runs, sorted. */
export function collectMetricKeys(runs: MlflowRunLite[]): string[] {
  return Array.from(new Set(runs.flatMap((r) => r.metrics.map((m) => m.key)))).sort();
}

/** Union of param keys across runs, sorted. */
export function collectParamKeys(runs: MlflowRunLite[]): string[] {
  return Array.from(new Set(runs.flatMap((r) => r.params.map((p) => p.key)))).sort();
}

/**
 * A sortable column descriptor. `kind` selects how the value is read off a run.
 *   attr   — a top-level run attribute (startTime / status / runName)
 *   metric — metrics.<key> (numeric)
 *   param  — params.<key>  (string, numeric-aware)
 */
export type SortKind = 'attr' | 'metric' | 'param';
export interface SortColumn { kind: SortKind; field: string }
export type SortDir = 'asc' | 'desc';

/** Stable column id used in the table header / sort state. */
export function columnId(col: SortColumn): string {
  return `${col.kind}:${col.field}`;
}

export function parseColumnId(id: string): SortColumn {
  const i = id.indexOf(':');
  const kind = id.slice(0, i) as SortKind;
  return { kind, field: id.slice(i + 1) };
}

/** Read a run's value for a column as a sortable primitive (number | string | undefined). */
export function runValue(run: MlflowRunLite, col: SortColumn): number | string | undefined {
  if (col.kind === 'metric') return runMetric(run, col.field);
  if (col.kind === 'param') {
    const raw = runParam(run, col.field);
    if (raw == null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && raw.trim() !== '' ? n : raw;
  }
  // attribute
  switch (col.field) {
    case 'startTime': return run.startTime;
    case 'endTime': return run.endTime;
    case 'status': return run.status;
    case 'runName': return run.runName || run.runId;
    default: return (run as any)[col.field];
  }
}

/**
 * Sort runs by a column. Undefined values always sort last (regardless of dir).
 * Numbers compare numerically; strings case-insensitively.
 */
export function sortRuns(runs: MlflowRunLite[], col: SortColumn, dir: SortDir): MlflowRunLite[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...runs].sort((a, b) => {
    const va = runValue(a, col);
    const vb = runValue(b, col);
    const aMissing = va == null;
    const bMissing = vb == null;
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;   // missing last
    if (bMissing) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign;
    return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * sign;
  });
}

/**
 * Build the MLflow runs/search order_by array for a column so the tracking
 * server sorts server-side where it can. Params aren't orderable server-side in
 * MLflow, so callers fall back to client sort for those.
 *   metric → ["metrics.<key> DESC"]
 *   attr   → ["attributes.start_time DESC"] etc.
 */
export function buildOrderBy(col: SortColumn, dir: SortDir): string[] | undefined {
  const d = dir.toUpperCase();
  if (col.kind === 'metric') return [`metrics.\`${col.field}\` ${d}`];
  if (col.kind === 'attr') {
    const map: Record<string, string> = {
      startTime: 'attributes.start_time',
      endTime: 'attributes.end_time',
      status: 'attributes.status',
      runName: 'attributes.run_name',
    };
    const f = map[col.field];
    return f ? [`${f} ${d}`] : undefined;
  }
  return undefined; // params: client-side only
}

/** Client-side free-text filter across run name, id, params, and metric keys. */
export function filterRunsLocal(runs: MlflowRunLite[], search: string): MlflowRunLite[] {
  const q = search.trim().toLowerCase();
  if (!q) return runs;
  return runs.filter((r) => {
    if ((r.runName || '').toLowerCase().includes(q)) return true;
    if (r.runId.toLowerCase().includes(q)) return true;
    if (r.params.some((p) => p.key.toLowerCase().includes(q) || String(p.value).toLowerCase().includes(q))) return true;
    if (r.metrics.some((m) => m.key.toLowerCase().includes(q))) return true;
    return false;
  });
}

/** Tags that aren't MLflow system tags (mlflow.*), for the run-detail Tags table. */
export function userTags(run: MlflowRunLite): MlflowRunTagLite[] {
  return run.tags.filter((t) => !t.key.startsWith('mlflow.'));
}

// ---------------- Parallel coordinates ----------------

export interface ParallelAxis {
  /** Column the axis represents. */
  col: SortColumn;
  /** Display label. */
  label: string;
  /** Min/max of finite values across the runs (equal when only one distinct). */
  min: number;
  max: number;
}

/**
 * Choose numeric axes (metrics + numeric params) shared by the runs, with
 * each axis's value range. Non-numeric / all-missing columns are dropped so the
 * parallel-coordinates chart only draws meaningful axes.
 */
export function buildParallelAxes(runs: MlflowRunLite[]): ParallelAxis[] {
  const cols: SortColumn[] = [
    ...collectMetricKeys(runs).map((field) => ({ kind: 'metric' as const, field })),
    ...collectParamKeys(runs).map((field) => ({ kind: 'param' as const, field })),
  ];
  const axes: ParallelAxis[] = [];
  for (const col of cols) {
    const vals: number[] = [];
    for (const r of runs) {
      const v = runValue(r, col);
      if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
    }
    if (vals.length < 1) continue; // no numeric data on this axis → skip
    axes.push({
      col,
      label: `${col.kind === 'param' ? 'p:' : ''}${col.field}`,
      min: Math.min(...vals),
      max: Math.max(...vals),
    });
  }
  return axes;
}

/** Normalize a value onto [0,1] for an axis (0.5 when the axis is flat). */
export function normalizeOnAxis(value: number, axis: ParallelAxis): number {
  const span = axis.max - axis.min;
  if (!Number.isFinite(span) || span === 0) return 0.5;
  return (value - axis.min) / span;
}

/** Deterministic categorical color for a run index (compare overlays). */
export const COMPARE_PALETTE = [
  '#0f6cbd', '#d13438', '#107c10', '#8764b8',
  '#c19c00', '#038387', '#ca5010', '#5c2e91',
];
export function compareColor(index: number): string {
  return COMPARE_PALETTE[index % COMPARE_PALETTE.length];
}
