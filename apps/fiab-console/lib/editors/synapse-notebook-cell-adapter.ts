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
  /** Live Livy statement progress 0..1 while status==='running' (R4-SYN-5). */
  progress?: number;
}

/**
 * A per-cell comment thread entry (R4-SYN-9). Persisted with the notebook
 * definition (IPYNB cell metadata `loomComments`) so it survives save/reopen.
 * Real-time multi-user presence (F6) is NOT provided — that needs a presence
 * backend and is honestly gated in the editor; these comments are a single-user
 * annotation that round-trips through the artifact.
 */
export interface CellComment {
  id: string;
  author: string;
  text: string;
  /** ISO timestamp. */
  at: string;
  resolved?: boolean;
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
  /** output collapsed independently of the input (R4-SYN-8, Synapse B8). */
  outputCollapsed?: boolean;
  /** cell locked (read-only) — the shared CodeCell lock affordance. */
  locked?: boolean;
  /** Livy execution counter shown as [n] in the shared cell gutter. */
  executionCount?: number;
  /** Persisted per-cell comment thread (R4-SYN-9). */
  comments?: CellComment[];
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

// ── R4-SYN-4 · %run reference notebook ───────────────────────────────────────
/**
 * Detect a leading Synapse `%run <path|name>` on the first non-empty line and
 * return the referenced notebook NAME (basename, quotes/path stripped), or null.
 * Synapse resolves `%run` against PUBLISHED workspace notebooks by name, so a
 * `folder/Notebook` path collapses to `Notebook`. Trailing parameters
 * (`%run nb {"p":1}` or positional args) are ignored — we run the referenced
 * notebook's definitions into the session; parameter passing is not modelled.
 */
export function parseRunReference(source: string): string | null {
  const line = source.split('\n').find((l) => l.trim() !== '');
  if (!line) return null;
  const m = line.trim().match(/^%run\s+(.+)$/i);
  if (!m) return null;
  let ref = m[1].trim();
  // Strip a quoted target ("path" or 'path') taking only the quoted content.
  const q = ref.match(/^["']([^"']+)["']/);
  if (q) ref = q[1];
  else ref = ref.split(/\s+/)[0]; // first token before any params
  ref = ref.replace(/^\.?\//, ''); // leading ./ or /
  const base = ref.split('/').pop() || ref;
  return base.trim() || null;
}

/**
 * Build the PySpark preamble that a `%run` cell submits to the warm session:
 * the referenced (published) notebook's Python/PySpark code cells concatenated,
 * so functions/vars it defines become available to later cells — Synapse `%run`
 * semantics. Enforces Synapse's constraints:
 *   - non-recursive: throws if the referenced notebook itself contains a `%run`;
 *   - PySpark-only: only python/pyspark cells are included (a `%%sql`/`%%spark`
 *     cell cannot be spliced into a single PySpark statement) — throws when the
 *     referenced notebook has no runnable PySpark code.
 */
export function buildRunPreamble(refCells: EditorCell[], refName: string): string {
  const parts: string[] = [];
  for (const c of refCells) {
    if (c.type !== 'code') continue;
    if (parseRunReference(c.source)) {
      throw new Error(`Nested %run is not supported — "${refName}" itself references another notebook (Synapse %run is non-recursive).`);
    }
    if (c.lang === 'pyspark' || c.lang === 'spark') {
      // Include PySpark cells verbatim; a %%spark(Scala) body would not run in a
      // PySpark statement, so restrict to python-family. spark(Scala) kept out.
      if (c.lang === 'pyspark' && c.source.trim()) parts.push(c.source);
    }
  }
  if (parts.length === 0) {
    throw new Error(`Referenced notebook "${refName}" has no PySpark code cells to run.`);
  }
  return `# %run ${refName} (Synapse reference — PySpark definitions)\n${parts.join('\n\n')}`;
}

/** Clamp a Livy statement progress value to an integer percentage 0..100. */
export function clampProgress(progress: number | undefined): number {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(progress * 100)));
}

// ── R4-SYN-9 · cell comments IPYNB round-trip ────────────────────────────────
/** Read persisted comments from an IPYNB cell's metadata (`loomComments`). */
export function metaToComments(meta: any): CellComment[] | undefined {
  const raw = meta?.loomComments;
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((c) => c && typeof c.text === 'string')
    .map((c) => ({
      id: String(c.id || `cm-${Math.random().toString(36).slice(2, 8)}`),
      author: String(c.author || 'You'),
      text: String(c.text),
      at: String(c.at || new Date().toISOString()),
      resolved: !!c.resolved,
    }));
  return out.length ? out : undefined;
}
/** Serialize comments for IPYNB cell metadata; undefined when there are none. */
export function commentsToMeta(comments: CellComment[] | undefined): CellComment[] | undefined {
  return comments && comments.length ? comments : undefined;
}

// ── R4-SYN-11 · code-snippet library (cross-language temp tables = B15) ───────
/** A ready-to-insert Spark snippet for the notebook's snippet inserter. */
export interface SparkSnippet { id: string; label: string; lang: CellKind; source: string; }
export const SPARK_SNIPPETS: SparkSnippet[] = [
  {
    id: 'read-delta', label: 'Read a Delta table', lang: 'pyspark',
    source: "df = spark.read.format('delta').load('abfss://<container>@<account>.dfs.core.windows.net/<path>')\ndisplay(df)",
  },
  {
    id: 'write-delta', label: 'Write a Delta table', lang: 'pyspark',
    source: "(df.write.format('delta').mode('overwrite')\n   .save('abfss://<container>@<account>.dfs.core.windows.net/<path>'))",
  },
  {
    id: 'temp-view', label: 'Cross-language temp view (createOrReplaceTempView)', lang: 'pyspark',
    source: "# Register a PySpark DataFrame so a %%sql cell can query it by name.\ndf.createOrReplaceTempView('my_view')",
  },
  {
    id: 'query-temp-view', label: 'Query a temp view from Spark SQL', lang: 'sql',
    source: 'SELECT * FROM my_view LIMIT 100',
  },
  {
    id: 'read-csv', label: 'Read a CSV into a DataFrame', lang: 'pyspark',
    source: "df = (spark.read.option('header', True).option('inferSchema', True)\n   .csv('abfss://<container>@<account>.dfs.core.windows.net/<path>.csv'))\ndisplay(df)",
  },
  {
    id: 'mssparkutils-ls', label: 'List files with mssparkutils', lang: 'pyspark',
    source: "from notebookutils import mssparkutils\nfiles = mssparkutils.fs.ls('abfss://<container>@<account>.dfs.core.windows.net/<path>')\nfor f in files:\n    print(f.name, f.size)",
  },
];

// ── R4-SYN-11 · markdown formatting-toolbar transforms (pure) ─────────────────
export type MarkdownFormat = 'bold' | 'italic' | 'h1' | 'h2' | 'ul' | 'ol' | 'quote' | 'code' | 'link';
/**
 * Apply a WYSIWYG markdown format to a selection within `source`. Returns the
 * new source plus the selection range to restore. Pure so the toolbar logic is
 * unit-testable without a live Monaco editor.
 */
export function applyMarkdownFormat(
  source: string, selStart: number, selEnd: number, fmt: MarkdownFormat,
): { source: string; selStart: number; selEnd: number } {
  const sel = source.slice(selStart, selEnd);
  const wrap = (pre: string, post = pre, placeholder = 'text') => {
    const inner = sel || placeholder;
    const next = source.slice(0, selStart) + pre + inner + post + source.slice(selEnd);
    return { source: next, selStart: selStart + pre.length, selEnd: selStart + pre.length + inner.length };
  };
  const linePrefix = (prefix: string) => {
    // Prefix every selected line (or the current line when nothing is selected).
    let ls = source.lastIndexOf('\n', selStart - 1) + 1;
    let le = source.indexOf('\n', selEnd);
    if (le < 0) le = source.length;
    const block = source.slice(ls, le);
    const numbered = prefix === '1. ';
    const next = block.split('\n').map((l, i) => `${numbered ? `${i + 1}. ` : prefix}${l}`).join('\n');
    const out = source.slice(0, ls) + next + source.slice(le);
    return { source: out, selStart: ls, selEnd: ls + next.length };
  };
  switch (fmt) {
    case 'bold': return wrap('**');
    case 'italic': return wrap('_');
    case 'code': return sel.includes('\n') ? wrap('```\n', '\n```', 'code') : wrap('`', '`', 'code');
    case 'h1': return linePrefix('# ');
    case 'h2': return linePrefix('## ');
    case 'ul': return linePrefix('- ');
    case 'ol': return linePrefix('1. ');
    case 'quote': return linePrefix('> ');
    case 'link': {
      const label = sel || 'text';
      const next = source.slice(0, selStart) + `[${label}](https://)` + source.slice(selEnd);
      const urlAt = selStart + label.length + 3;
      return { source: next, selStart: urlAt, selEnd: urlAt + 'https://'.length };
    }
    default: return { source, selStart, selEnd };
  }
}
