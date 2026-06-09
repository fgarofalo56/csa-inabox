/**
 * copilot-result-tagger — typed tool-result model + heuristic tagger.
 *
 * The Copilot orchestrator runs real Azure-native tools (Synapse TDS, ADX KQL,
 * ADLS REST, Databricks SQL, ADF, …) and streams each tool's result over SSE.
 * Historically the UI either dropped the payload (right-rail pane) or dumped it
 * as `JSON.stringify(result, null, 2)` in a <pre> (full-screen console) — a
 * no-vaporware-adjacent dead end: real rows existed but the user saw raw JSON.
 *
 * This module gives those results a TYPE so the renderer can show a real
 * DataGrid for tabular data, a chart for series, Monaco for code, and rendered
 * markdown for summaries. It is pure TypeScript (NO React, NO 'use client', NO
 * server imports) so BOTH the server-side orchestrator (to tag handler output
 * explicitly) and the client renderer (to tag untagged/legacy output) can use
 * it. Keeping it dependency-free is what lets `copilot-orchestrator.ts` import
 * the typed-result constructors without dragging React into the server bundle.
 */

export type ResultKind =
  | 'table'
  | 'chart'
  | 'code'
  | 'summary'
  | 'proposed_change'
  | 'error'
  | 'unknown';

/** Tabular result — the NL2SQL / KQL / Databricks query path. */
export interface TableResult {
  kind: 'table';
  columns: string[];
  rows: unknown[][];
  rowCount?: number;
  executionMs?: number;
  truncated?: boolean;
  /** Provenance label, e.g. "synapse_serverless" or "adx". */
  source?: string;
}

/** Series result rendered by the existing KqlChart SVG component. */
export interface ChartResult {
  kind: 'chart';
  chartType: 'timechart' | 'barchart' | 'piechart';
  columns: string[];
  rows: unknown[][];
  title?: string;
  source?: string;
}

/** Generated code (SQL / Python / KQL / JSON / …) shown in read-only Monaco. */
export interface CodeResult {
  kind: 'code';
  language: string;
  code: string;
  filename?: string;
  description?: string;
}

/** Narrative / explanation rendered as markdown. */
export interface SummaryResult {
  kind: 'summary';
  markdown: string;
  title?: string;
}

/** A change applied to (or proposed for) a Loom item — a change-set receipt. */
export interface ProposedChangeResult {
  kind: 'proposed_change';
  targetType: string;
  targetId?: string;
  displayName?: string;
  description?: string;
  changes: Array<{ field: string; before?: unknown; after: unknown }>;
}

/** A tool error surfaced as a Fluent error MessageBar. */
export interface ErrorResult {
  kind: 'error';
  message: string;
  code?: string;
}

/** Last-resort fallback — a collapsible raw view; never shown for tagged results. */
export interface UnknownResult {
  kind: 'unknown';
  raw: unknown;
}

export type TypedResult =
  | TableResult
  | ChartResult
  | CodeResult
  | SummaryResult
  | ProposedChangeResult
  | ErrorResult
  | UnknownResult;

const KNOWN_KINDS: ReadonlySet<string> = new Set<ResultKind>([
  'table', 'chart', 'code', 'summary', 'proposed_change', 'error', 'unknown',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True when `v` is already a fully-formed TypedResult envelope. */
export function isTypedResult(v: unknown): v is TypedResult {
  return isRecord(v) && typeof v.kind === 'string' && KNOWN_KINDS.has(v.kind);
}

// ---------- explicit constructors (used by orchestrator tool handlers) -------

/** Wrap a {columns, rows} query result (Synapse QueryResult / KustoQueryResult). */
export function asTable(
  q: { columns?: string[]; rows?: unknown[][]; rowCount?: number; executionMs?: number; truncated?: boolean },
  source?: string,
): TableResult {
  const columns = Array.isArray(q.columns) ? q.columns : [];
  const rows = Array.isArray(q.rows) ? q.rows : [];
  return {
    kind: 'table',
    columns,
    rows,
    rowCount: typeof q.rowCount === 'number' ? q.rowCount : rows.length,
    executionMs: typeof q.executionMs === 'number' ? q.executionMs : undefined,
    truncated: !!q.truncated,
    source,
  };
}

/** Wrap narrative text as a markdown summary. */
export function asSummary(markdown: string, title?: string): SummaryResult {
  return { kind: 'summary', markdown, title };
}

/** Wrap generated code. */
export function asCode(language: string, code: string, opts?: { filename?: string; description?: string }): CodeResult {
  return { kind: 'code', language, code, filename: opts?.filename, description: opts?.description };
}

// ---------- heuristic tagger (used by the client renderer for legacy output) --

function looksTimeColumn(rows: unknown[][]): boolean {
  if (rows.length < 2) return false;
  let seen = 0;
  for (const r of rows) {
    const v = r?.[0];
    if (v == null || v === '') continue;
    if (v instanceof Date) { seen++; continue; }
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})/.test(v)) { seen++; continue; }
    return false;
  }
  return seen > 0;
}

/**
 * tagResult — give an arbitrary tool result a kind so the renderer can pick a
 * surface. Idempotent: an already-tagged TypedResult is returned unchanged.
 *
 *   • already a TypedResult                    → as-is
 *   • string                                   → summary (treated as markdown)
 *   • { ok:false, error }                      → error
 *   • { columns:[], rows:[] }                  → table
 *   • { markdown }                             → summary
 *   • { code, language }                       → code
 *   • { changes:[], targetType }               → proposed_change
 *   • everything else                          → unknown (collapsible raw)
 */
export function tagResult(raw: unknown, _toolName?: string): TypedResult {
  if (raw == null) return { kind: 'unknown', raw };
  if (isTypedResult(raw)) return raw;

  if (typeof raw === 'string') {
    return { kind: 'summary', markdown: raw };
  }

  if (isRecord(raw)) {
    if (raw.ok === false && typeof raw.error === 'string') {
      return { kind: 'error', message: raw.error, code: typeof raw.code === 'string' ? raw.code : undefined };
    }
    if (Array.isArray(raw.columns) && Array.isArray(raw.rows)) {
      const columns = raw.columns as unknown[];
      const rows = raw.rows as unknown[][];
      return asTable(
        {
          columns: columns.map((c) => String(c)),
          rows,
          rowCount: typeof raw.rowCount === 'number' ? raw.rowCount : undefined,
          executionMs: typeof raw.executionMs === 'number' ? raw.executionMs : undefined,
          truncated: typeof raw.truncated === 'boolean' ? raw.truncated : undefined,
        },
        typeof raw.source === 'string' ? raw.source : _toolName,
      );
    }
    if (typeof raw.markdown === 'string') {
      return { kind: 'summary', markdown: raw.markdown, title: typeof raw.title === 'string' ? raw.title : undefined };
    }
    if (typeof raw.code === 'string' && typeof raw.language === 'string') {
      return asCode(raw.language, raw.code, {
        filename: typeof raw.filename === 'string' ? raw.filename : undefined,
        description: typeof raw.description === 'string' ? raw.description : undefined,
      });
    }
    if (Array.isArray(raw.changes) && typeof raw.targetType === 'string') {
      return {
        kind: 'proposed_change',
        targetType: raw.targetType,
        targetId: typeof raw.targetId === 'string' ? raw.targetId : undefined,
        displayName: typeof raw.displayName === 'string' ? raw.displayName : undefined,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        changes: raw.changes as ProposedChangeResult['changes'],
      };
    }
  }

  return { kind: 'unknown', raw };
}

/** Suggest a chart type from a tabular result's shape (time vs categorical). */
export function inferChartType(columns: string[], rows: unknown[][]): ChartResult['chartType'] {
  return looksTimeColumn(rows) ? 'timechart' : 'barchart';
}
