export type NotebookCellLang = 'pyspark' | 'spark' | 'sparksql' | 'sparkr' | 'python' | 'tsql';

/**
 * MIME type the Loom `display()` helper (ai-display.py) emits for a DataFrame.
 * The browser renderer (rich-display.tsx) branches on this so a `display(df)`
 * call surfaces the interactive grid + chart recommendations rather than a
 * plain text table — parity with Synapse Studio / Fabric notebook display().
 */
export const LOOM_DISPLAY_MIME = 'application/vnd.loom.display+json' as const;

/** Per-column profile computed from the sampled rows (real stats, no mocks). */
export interface LoomDisplayColumn {
  name: string;
  dtype: string;          // pandas ('int64'|'float64'|'object'…) or Spark ('long'|'double'|'string'…)
  nullCount: number;
  min?: string;
  max?: string;
  mean?: string;
  stddev?: string;
  cardinality?: number;   // unique value count for categorical cols (capped at 1000)
  topValues?: { value: string; count: number }[]; // top-10 for categorical cols
}

export type LoomChartType = 'bar' | 'scatter' | 'line' | 'heatmap';
export type LoomChartAgg = 'count' | 'sum' | 'mean' | 'min' | 'max';

/** A single recommended (or user-edited) chart definition. */
export interface LoomDisplayChartRec {
  id: string;
  type: LoomChartType;
  xField: string;
  yField: string;
  legend?: string;
  agg: LoomChartAgg;
  title: string;
}

/** Serialized DataFrame payload — sample rows + real column stats + chart recs. */
export interface LoomDisplayPayload {
  version: 1;
  columns: LoomDisplayColumn[];
  rows: (string | number | boolean | null)[][]; // up to sampleSize rows × all cols
  totalCount: number;       // exact (or kernel-reported) full row count
  sampleSize: number;       // actual rows present in `rows`
  chartRecs: LoomDisplayChartRec[]; // up to 5
  dfVarName?: string;       // Python variable name, for full-dataset agg statements
}

export interface NotebookCellOutput {
  status: 'ok' | 'error' | 'pending';
  textPlain?: string;
  data?: unknown;
  /** Rich DataFrame visualization payload — present when a cell called display(df). */
  richDisplay?: LoomDisplayPayload;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  executedAtUtc?: string;
  durationMs?: number;
}

export interface NotebookCell {
  id: string;
  type: 'code' | 'markdown';
  lang?: NotebookCellLang;
  source: string;
  output?: NotebookCellOutput;
  executionCount?: number;
  locked?: boolean;
  collapsed?: boolean;
}

export interface NotebookState {
  cells: NotebookCell[];
  defaultLang: NotebookCellLang;
  attachedSources?: {
    kind: 'lakehouse' | 'warehouse' | 'kql-database';
    id: string;
    displayName: string;
    isDefault?: boolean;
  }[];
  activeSessionId?: string;
}

export function emptyCell(type: 'code' | 'markdown', lang: NotebookCellLang = 'pyspark'): NotebookCell {
  const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `cell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    type,
    lang: type === 'code' ? lang : undefined,
    source: type === 'markdown' ? '# New markdown cell\n\nDouble-click to edit.' : '',
  };
}

export function migrateLegacyState(legacy: { code?: string; lang?: string; cells?: NotebookCell[]; defaultLang?: NotebookCellLang } | null | undefined): NotebookState {
  if (legacy?.cells && Array.isArray(legacy.cells) && legacy.cells.length > 0) {
    return {
      cells: legacy.cells,
      defaultLang: legacy.defaultLang || 'pyspark',
    };
  }
  const lang = (legacy?.lang as NotebookCellLang) || 'pyspark';
  if (legacy?.code) {
    return {
      cells: [{
        id: 'cell-legacy-0',
        type: 'code',
        lang,
        source: legacy.code,
      }],
      defaultLang: lang,
    };
  }
  return {
    cells: [emptyCell('code', lang)],
    defaultLang: lang,
  };
}

export function cellsToConcatenatedCode(cells: NotebookCell[], lang: NotebookCellLang): string {
  const codeCells = cells.filter(c => c.type === 'code' && (!c.lang || c.lang === lang));
  return codeCells.map(c => c.source).join('\n\n# --- next cell ---\n');
}
