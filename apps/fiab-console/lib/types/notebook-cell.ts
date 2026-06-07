export type NotebookCellLang = 'pyspark' | 'spark' | 'sparksql' | 'sparkr' | 'python' | 'tsql';

export interface NotebookCellOutput {
  status: 'ok' | 'error' | 'pending';
  textPlain?: string;
  data?: unknown;
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
  /**
   * Curated Azure ML Environment attached to this notebook (libraries: PyPI /
   * Conda packages, base image). Azure-native 1:1 for a Fabric notebook
   * Environment — see aml-environments-client.ts. Optional; a notebook runs
   * without one (inline %pip/%conda still works against the live session).
   */
  attachedAmlEnv?: { name: string; version: string };
  /**
   * Custom libraries attached to this notebook (.jar / .whl filenames or paths)
   * surfaced to the Spark / Databricks runtime as session-level packages.
   */
  customLibraries?: string[];
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
