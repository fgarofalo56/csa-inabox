/**
 * synapse-notebook-cell-adapter — the thin mapping layer that lets the Synapse
 * notebook editor render on the SHARED cell/output stack (CodeCell + RichDisplay
 * + MarkdownCell) without forking any of them (R4-SYN-1).
 *
 * The Synapse editor keeps its own `EditorCell` model + Livy session/execute run
 * path (that path is unchanged — the swap is the RENDERING stack, not execution).
 * This module maps that model to/from the shared `NotebookCell`, and converts a
 * Livy DataFrame table output into the `LoomDisplayPayload` the shared
 * `RichDisplay` grid + chart builder consumes.
 *
 * Split out of synapse-notebook-editor.tsx so it is pure (no React) and unit
 * testable — the editor's render tests need a live DOM, these do not.
 */
import type { MonacoLanguage } from '@/lib/components/editor/monaco-textarea';
import type {
  NotebookCell, NotebookCellOutput, NotebookCellLang, LoomDisplayPayload,
} from '@/lib/types/notebook-cell';
import { buildLoomDisplay } from '@/lib/notebook/display-stats';

// Synapse Studio notebooks support five interactive languages via %%magic.
export type CellKind = 'pyspark' | 'spark' | 'sql' | 'sparkr' | 'csharp';

export const KIND_TO_MONACO: Record<CellKind, MonacoLanguage> = {
  pyspark: 'pyspark', spark: 'scala', sql: 'sparksql', sparkr: 'sparkr', csharp: 'csharp',
};
export const KIND_LABEL: Record<CellKind, string> = {
  pyspark: 'PySpark (Python)', spark: 'Spark (Scala)', sql: 'Spark SQL',
  sparkr: 'SparkR (R)', csharp: '.NET Spark (C#)',
};
// The %%magic header Synapse expects at the top of a non-default-language cell.
export const KIND_MAGIC: Record<CellKind, string> = {
  pyspark: '', spark: '%%spark', sql: '%%sql', sparkr: '%%sparkr', csharp: '%%csharp',
};

/** Synapse per-cell language ⇄ the shared NotebookCell language. */
export const KIND_TO_LANG: Record<CellKind, NotebookCellLang> = {
  pyspark: 'pyspark', spark: 'spark', sql: 'sparksql', sparkr: 'sparkr', csharp: 'csharp',
};
export const LANG_TO_KIND: Record<string, CellKind> = {
  pyspark: 'pyspark', python: 'pyspark', spark: 'spark', scala: 'spark',
  sparksql: 'sql', tsql: 'sql', sparkr: 'sparkr', csharp: 'csharp',
};

export interface CellOutput {
  status: 'ok' | 'error' | 'running';
  text?: string;
  html?: string;
  tableColumns?: string[];
  tableRows?: string[][];
  imageBase64?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface EditorCell {
  id: string;
  type: 'code' | 'markdown';
  lang: CellKind;
  source: string;
  output?: CellOutput;
  running?: boolean;
  /** papermill/ADF "parameters" cell — at most one per notebook. */
  isParameters?: boolean;
  /** input collapsed (Synapse jupyter.source_hidden) — header still shows. */
  collapsed?: boolean;
  /** cell locked (read-only) — the shared CodeCell lock affordance. */
  locked?: boolean;
  /** Livy execution counter shown as [n] in the shared cell gutter. */
  executionCount?: number;
}

/**
 * Adapt an EditorCell to the shared NotebookCell that CodeCell / MarkdownCell
 * consume. Only an ERROR is surfaced on the shared cell (so CodeCell renders the
 * traceback + "Fix with Copilot"); success / table / html / image output is
 * rendered below the cell by <SynapseCellOutput> — that path owns the RichDisplay
 * chart builder and the html/image shapes. A running cell carries no output so
 * CodeCell shows its own run spinner.
 */
export function toSharedCell(cell: EditorCell): NotebookCell {
  const out = cell.output;
  let sharedOutput: NotebookCellOutput | undefined;
  if (out?.status === 'error') {
    sharedOutput = {
      status: 'error',
      ename: out.ename,
      evalue: out.evalue,
      traceback: out.traceback,
      textPlain: out.text,
    };
  }
  return {
    id: cell.id,
    type: cell.type,
    lang: cell.type === 'code' ? KIND_TO_LANG[cell.lang] : undefined,
    source: cell.source,
    collapsed: cell.collapsed,
    locked: cell.locked,
    executionCount: cell.executionCount,
    output: sharedOutput,
  };
}

/**
 * Map a shared-cell change (source edit, language switch, lock, collapse, or a
 * Copilot "Accept" that rewrites the source) back onto EditorCell fields. Only
 * the changed keys are returned so the editor's patchCell keeps every
 * Synapse-only field (isParameters, running, the full CellOutput) intact.
 */
export function mergeSharedChange(prev: EditorCell, next: NotebookCell): Partial<EditorCell> {
  const patch: Partial<EditorCell> = {};
  if (next.source !== prev.source) patch.source = next.source;
  if (!!next.collapsed !== !!prev.collapsed) patch.collapsed = next.collapsed;
  if (!!next.locked !== !!prev.locked) patch.locked = next.locked;
  if (next.type === 'code' && next.lang) {
    const kind = LANG_TO_KIND[next.lang];
    if (kind && kind !== prev.lang) patch.lang = kind;
  }
  // The shared in-cell Copilot "Accept" rewrites source and clears output +
  // executionCount; mirror the clear so a re-run starts clean.
  if (next.source !== prev.source && next.output === undefined && prev.output !== undefined) {
    patch.output = undefined;
    patch.executionCount = undefined;
  }
  return patch;
}

/**
 * Convert a Livy DataFrame table output (tableColumns + tableRows from
 * normalizeLivyOutput) into the LoomDisplayPayload the shared RichDisplay grid +
 * chart builder consume. Column dtypes are inferred by sampling values (numeric
 * when every non-empty value parses as a number); real per-column stats + chart
 * recommendations are then computed by the shared buildLoomDisplay profiler.
 *
 * dfVarName is intentionally left unset on the Synapse Livy path — RichDisplay's
 * "Aggregate over all rows" full-dataset Spark job targets the Fabric-flavour run
 * route, so it stays honestly disabled here while the sample-based chart builder
 * works fully.
 */
export function buildRichFromTable(
  columns: string[] | undefined,
  rows: string[][] | undefined,
): LoomDisplayPayload | null {
  if (!columns?.length || !rows?.length) return null;
  const fields = columns.map((name, ci) => {
    let numeric = true;
    let seen = false;
    for (const r of rows) {
      const v = r?.[ci];
      if (v == null || v === '') continue;
      seen = true;
      if (Number.isNaN(Number(v))) { numeric = false; break; }
    }
    return { name, type: seen && numeric ? 'double' : 'string' };
  });
  return buildLoomDisplay({ schema: { fields }, data: rows as unknown[][] }, 5000);
}
