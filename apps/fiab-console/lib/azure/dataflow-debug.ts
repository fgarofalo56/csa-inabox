/**
 * dataflow-debug — shared server helpers for the Mapping-Data-Flow **Debug
 * Mode** authoring loop (U7). The Debug experience (session lifecycle,
 * per-transform Data Preview, Inspect/schema, column Statistics) is backed by a
 * REAL Azure Data Factory data-flow **debug session** — the exact mechanism ADF
 * Studio uses (`createDataFlowDebugSession` → `addDataFlowToDebugSession` →
 * `executeDataFlowDebugCommand`) — so a preview runs the SAME Data Flow Script
 * (DFS) the flow's run path executes. One compiler, two entry points; no
 * parallel PySpark implementation, no mocks (no-vaporware.md), and no Fabric
 * (Microsoft.DataFactory is Azure-native — no-fabric-dependency.md).
 *
 * These helpers are the single place the `/api/items/mapping-dataflow/[id]/
 * debug/*` routes (and the legacy `/api/adf/dataflows/[name]/debug` route)
 * resolve a flow's debug **package** (the in-memory flow + every dataset /
 * linked service it references + per-source row caps) and enumerate its
 * previewable streams. Pure, side-effect-free parsing helpers
 * (`parseDfsSchema`, `computeColumnStats`) live here too so they are unit-
 * testable without the network.
 *
 * Server-only: imports the ARM ADF client. Never import into a client
 * component.
 */

import {
  getDataFlow,
  getDataset,
  getLinkedService,
  type AdfDataFlow,
  type AdfDataset,
  type AdfLinkedService,
} from './adf-client';

// ADF Studio's data-preview cap is 1,000 rows; the default sample is 100.
export const DATAFLOW_DEBUG_ROW_CAP = 1000;
export const DATAFLOW_DEBUG_DEFAULT_SAMPLE = 100;

// ADF data-flow names: letters, digits, underscore (matches the dataflows route).
export const DATAFLOW_NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

/** A source / sink / transformation node in a MappingDataFlow's typeProperties. */
export interface FlowNode {
  name?: string;
  dataset?: { referenceName?: string };
  linkedService?: { referenceName?: string };
}

interface FlowTypeProps {
  sources?: FlowNode[];
  sinks?: FlowNode[];
  transformations?: FlowNode[];
}

const isNonEmpty = (s: unknown): s is string => typeof s === 'string' && s.length > 0;

function typeProps(flow: AdfDataFlow): FlowTypeProps {
  return (flow.properties?.typeProperties ?? {}) as FlowTypeProps;
}

/**
 * Every previewable output stream in the flow, in graph order (sources →
 * transformations → sinks). A "stream" is any named source / transformation /
 * sink — the debug session can preview each one's output.
 */
export function flowStreamNames(flow: AdfDataFlow): string[] {
  const tp = typeProps(flow);
  return [
    ...(Array.isArray(tp.sources) ? tp.sources : []),
    ...(Array.isArray(tp.transformations) ? tp.transformations : []),
    ...(Array.isArray(tp.sinks) ? tp.sinks : []),
  ]
    .map((n) => n?.name)
    .filter(isNonEmpty);
}

/** Clamp a requested sample size into `[1, DATAFLOW_DEBUG_ROW_CAP]`. */
export function clampSampleSize(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DATAFLOW_DEBUG_DEFAULT_SAMPLE;
  return Math.min(Math.floor(n), DATAFLOW_DEBUG_ROW_CAP);
}

/** The in-memory debug package a session runs against. */
export interface DebugPackage {
  flow: AdfDataFlow;
  datasets?: AdfDataset[];
  linkedServices?: AdfLinkedService[];
  debugSettings?: { sourceSettings: Array<{ sourceName: string; rowLimit: number }> };
}

/**
 * Resolve the debug package for a flow: the flow definition itself plus every
 * dataset / linked service its sources & sinks reference (the debug cluster
 * needs them to actually read source data), and a per-source row cap so the
 * preview is fast + bounded.
 *
 * `opts.liveFlow` lets the caller pass the **currently-authored** (possibly
 * unsaved) flow properties from the designer so a preview reflects in-canvas
 * edits — exactly ADF Studio's behaviour. Without it we read the saved flow via
 * ARM. Dataset / linked-service reads are best-effort: a node reading an inline
 * source has no dataset, and a transient read miss must not abort the whole
 * preview.
 */
export async function resolveDebugPackage(
  name: string,
  rowLimit: number,
  opts?: { liveFlow?: AdfDataFlow['properties'] },
): Promise<DebugPackage> {
  const flow: AdfDataFlow = opts?.liveFlow
    ? { name, properties: opts.liveFlow }
    : await getDataFlow(name);

  const tp = typeProps(flow);
  const sources: FlowNode[] = Array.isArray(tp.sources) ? tp.sources : [];
  const sinks: FlowNode[] = Array.isArray(tp.sinks) ? tp.sinks : [];

  const datasetNames = new Set<string>();
  const linkedServiceNames = new Set<string>();
  for (const node of [...sources, ...sinks]) {
    if (isNonEmpty(node?.dataset?.referenceName)) datasetNames.add(node.dataset!.referenceName!);
    if (isNonEmpty(node?.linkedService?.referenceName)) {
      linkedServiceNames.add(node.linkedService!.referenceName!);
    }
  }

  const datasets: AdfDataset[] = [];
  for (const dn of datasetNames) {
    try {
      const d = await getDataset(dn);
      datasets.push(d);
      const lsRef = d.properties?.linkedServiceName?.referenceName;
      if (isNonEmpty(lsRef)) linkedServiceNames.add(lsRef);
    } catch {
      /* skip a dataset that can't be read — ADF still previews inline sources */
    }
  }

  const linkedServices: AdfLinkedService[] = [];
  for (const ln of linkedServiceNames) {
    try {
      linkedServices.push(await getLinkedService(ln));
    } catch {
      /* skip a linked service that can't be read */
    }
  }

  const sourceSettings = sources
    .map((s) => s?.name)
    .filter(isNonEmpty)
    .map((sourceName) => ({ sourceName, rowLimit }));

  return {
    flow,
    datasets: datasets.length ? datasets : undefined,
    linkedServices: linkedServices.length ? linkedServices : undefined,
    debugSettings: sourceSettings.length ? { sourceSettings } : undefined,
  };
}

// ============================================================================
// Data Flow Script (DFS) schema parsing — pure, testable (used by Inspect).
// ============================================================================

/** One column in a stream's schema. */
export interface DfsColumn {
  name: string;
  /** DFS type token (`string`, `integer`, `double`, `boolean`, `timestamp`, …). */
  type: string;
}

/**
 * Parse a DFS preview schema string into typed columns. The debug preview
 * command returns a schema like `output(name as string, age as integer,
 * loc as (lat as double, lng as double))`. We split the TOP-LEVEL
 * comma-separated `name as type` pairs (respecting nested `(...)` for struct
 * types, which we keep verbatim as the type token). Returns `[]` for an empty
 * or unparseable schema — the caller then shows "schema unavailable", never a
 * fabricated column list.
 */
export function parseDfsSchema(schema: string | undefined | null): DfsColumn[] {
  if (!schema || typeof schema !== 'string') return [];
  // Strip the leading `output(` / `<stream>(` wrapper and the trailing `)`.
  const open = schema.indexOf('(');
  if (open < 0) return [];
  let inner = schema.slice(open + 1);
  if (inner.endsWith(')')) inner = inner.slice(0, -1);
  const cols: DfsColumn[] = [];
  let depth = 0;
  let buf = '';
  const flush = () => {
    const seg = buf.trim();
    buf = '';
    if (!seg) return;
    // Split on the FIRST top-level ` as ` (name as type). The type may itself
    // contain ` as ` inside a nested struct, so only the first split matters.
    const m = seg.match(/^([^\s]+)\s+as\s+([\s\S]+)$/i);
    if (m) cols.push({ name: m[1].trim(), type: m[2].trim() });
    else cols.push({ name: seg, type: 'unknown' });
  };
  for (const ch of inner) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return cols;
}

/** One schema-drift diff row between an input schema and an output schema. */
export interface SchemaDriftEntry {
  name: string;
  change: 'added' | 'removed' | 'retyped' | 'unchanged';
  inType?: string;
  outType?: string;
}

/**
 * Diff an input schema against an output schema (Inspect's "schema drift"
 * badges). Pure set/type comparison — added (out only), removed (in only),
 * retyped (both, different type), unchanged (both, same type). Order follows
 * the output schema, with removed columns appended.
 */
export function diffSchemas(inCols: DfsColumn[], outCols: DfsColumn[]): SchemaDriftEntry[] {
  const inByName = new Map(inCols.map((c) => [c.name, c.type]));
  const outNames = new Set(outCols.map((c) => c.name));
  const out: SchemaDriftEntry[] = [];
  for (const c of outCols) {
    const inType = inByName.get(c.name);
    if (inType === undefined) out.push({ name: c.name, change: 'added', outType: c.type });
    else if (inType !== c.type) out.push({ name: c.name, change: 'retyped', inType, outType: c.type });
    else out.push({ name: c.name, change: 'unchanged', inType, outType: c.type });
  }
  for (const c of inCols) {
    if (!outNames.has(c.name)) out.push({ name: c.name, change: 'removed', inType: c.type });
  }
  return out;
}

// ============================================================================
// Column statistics — pure, testable (used by the Statistics tab, U7 PR-2).
// ============================================================================

/** A per-column profile computed over the debug preview sample. */
export interface ColumnStat {
  name: string;
  /** Total sample rows considered. */
  count: number;
  /** Rows where the value is null/undefined/empty. */
  nulls: number;
  /** Distinct non-null values in the sample. */
  distinct: number;
  /** Whether the column's non-null values are all numeric. */
  numeric: boolean;
  min?: number;
  max?: number;
  mean?: number;
  stddev?: number;
  /** Top value frequencies (value → count), most-frequent first, up to 8. */
  topValues: Array<{ value: string; count: number }>;
}

function isNullish(v: unknown): boolean {
  return v == null || v === '';
}

/**
 * Compute per-column statistics over a columnar sample (columns[i] ↔ each
 * row[i]). REAL math over the REAL debug-session sample rows — null %, distinct
 * count, min/max/mean/stddev for all-numeric columns, and top value frequency.
 * Deterministic + side-effect-free so the Statistics tab's numbers are unit-
 * tested against fixtures. The caller labels these "over the N-row debug
 * sample" — honest about the sample scope (ADF Studio's preview stats are
 * likewise over the debug sample).
 */
export function computeColumnStats(columns: string[], rows: unknown[][]): ColumnStat[] {
  return columns.map((name, ci) => {
    const values = rows.map((r) => (Array.isArray(r) ? r[ci] : undefined));
    const nonNull = values.filter((v) => !isNullish(v));
    const nulls = values.length - nonNull.length;

    const freq = new Map<string, number>();
    for (const v of nonNull) {
      const key = typeof v === 'object' ? JSON.stringify(v) : String(v);
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
    const topValues = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([value, count]) => ({ value, count }));

    const nums = nonNull
      .map((v) => (typeof v === 'number' ? v : Number(v)))
      .filter((n) => Number.isFinite(n));
    const numeric = nonNull.length > 0 && nums.length === nonNull.length;

    let min: number | undefined;
    let max: number | undefined;
    let mean: number | undefined;
    let stddev: number | undefined;
    if (numeric && nums.length) {
      min = Math.min(...nums);
      max = Math.max(...nums);
      mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      const variance = nums.reduce((a, b) => a + (b - mean!) ** 2, 0) / nums.length;
      stddev = Math.sqrt(variance);
    }

    return {
      name,
      count: values.length,
      nulls,
      distinct: freq.size,
      numeric,
      min,
      max,
      mean,
      stddev,
      topValues,
    };
  });
}
