/**
 * notebook-persona-tools — the server-side tool implementations the Notebook
 * Copilot persona (copilot-personas-notebook.ts → NOTEBOOK_PERSONA) invokes.
 *
 * Split out from notebook-tools.ts (which holds the client-safe in-cell helpers
 * imported by code-cell.tsx) because these tools import the server-only ADLS /
 * Synapse catalog clients. Keeping them separate ensures the client notebook
 * bundle never pulls in @azure/identity / node built-ins.
 *
 * Each is a ToolDef-compatible object so it can be registered into a
 * LoomToolRegistry, but the notebook-assist BFF route calls the read-only ones
 * (`profile`, `perf`, `generate`) directly to inject a real tool-result block
 * into the AOAI prompt — no tool-call round-trip needed since none mutate state.
 *
 * Every data read is Azure-native and REAL (per no-vaporware / no-fabric-
 * dependency):
 *   - notebook_generate_code → buildDatastoreSchema() reads the ADLS Gen2 Delta
 *     `_delta_log` directly (no Spark session, no OneLake).
 *   - notebook_profile_table → scanLakehouseTables() walks the real table
 *     directory + (when Synapse Serverless is reachable) a COUNT_BIG(*) over the
 *     Delta files. rowCount is honest-null when Serverless is offline.
 *   - notebook_perf_insights → interprets the Livy session receipt + last-run
 *     statement output already collected by the editor / BFF.
 *   - notebook_summarize / notebook_refactor_cells → serialize the open cells
 *     (passed from the client) for the model to reason over.
 *
 * No mock schema, no `return []` placeholders. A missing table returns an honest
 * `{ ok:false, error }` naming the tables that DO exist.
 */
import { scanLakehouseTables, type CatalogTable } from '@/lib/azure/synapse-catalog-client';
import { buildDatastoreSchema } from '@/lib/azure/delta-schema';
import type { ToolDef } from '@/lib/azure/copilot-orchestrator';
import type { NotebookCell } from '@/lib/types/notebook-cell';

const S_STRING = { type: 'string' } as const;

function obj(props: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties: props, required, additionalProperties: false } as const;
}

/** Compact cell shape the summarize / refactor tools serialize for the model. */
export interface ToolCell {
  id: string;
  type: 'code' | 'markdown';
  lang?: string;
  source: string;
}

const MAX_CELLS = 80;
const MAX_CELL_CHARS = 4000;

function toToolCells(cells: NotebookCell[] | ToolCell[] | undefined): ToolCell[] {
  if (!Array.isArray(cells)) return [];
  return cells.slice(0, MAX_CELLS).map((c) => ({
    id: String(c.id || ''),
    type: c.type === 'markdown' ? 'markdown' : 'code',
    lang: (c as NotebookCell).lang,
    source: String(c.source || '').slice(0, MAX_CELL_CHARS),
  }));
}

// ---- notebook_summarize ----------------------------------------------------
export const notebookSummarizeTool: ToolDef = {
  name: 'notebook_summarize',
  service: 'Notebook',
  description:
    'Return the open notebook cells (in order) so the assistant can summarize each cell: its purpose, ' +
    'inputs, outputs, and how it connects to the next cell, referencing the ACTUAL variable and column ' +
    'names from the source.',
  parameters: obj(
    {
      cells: {
        type: 'array',
        description: 'Array of {id, type, lang, source} objects from the open notebook, in order.',
        items: { type: 'object' },
      },
    },
    ['cells'],
  ),
  handler: async (args: { cells?: NotebookCell[] }) => {
    const cells = toToolCells(args?.cells);
    return {
      ok: true,
      cellCount: cells.length,
      cells: cells.map((c, i) => ({
        index: i + 1,
        id: c.id,
        kind: c.type === 'markdown' ? 'markdown' : (c.lang || 'code'),
        source: c.source.slice(0, 800),
      })),
    };
  },
};

// ---- notebook_generate_code ------------------------------------------------
export const notebookGenerateCodeTool: ToolDef = {
  name: 'notebook_generate_code',
  service: 'Notebook',
  description:
    'Read the REAL lakehouse schema from the ADLS Gen2 Delta transaction log (no Spark session required) ' +
    'so the assistant can generate runnable PySpark/Spark SQL that loads one or more tables and joins them ' +
    'using the actual table and column names.',
  parameters: obj(
    {
      description: S_STRING,
      tables: {
        type: 'array',
        description: 'Table names to load/join (must match actual lakehouse tables).',
        items: { type: 'string' },
      },
      lang: { type: 'string', description: 'pyspark | spark | sparksql' },
    },
    ['description'],
  ),
  handler: async (args: { description?: string; tables?: string[]; lang?: string }) => {
    const maxTables = Number(process.env.LOOM_NOTEBOOK_PERSONA_CONTEXT_MAX_TABLES) || 30;
    const schema = await buildDatastoreSchema(maxTables).catch(() => '');
    return {
      ok: true,
      description: String(args?.description || ''),
      tables: Array.isArray(args?.tables) ? args!.tables!.map(String) : [],
      lang: String(args?.lang || 'pyspark'),
      schema,
      schemaAvailable: schema.trim().length > 0,
    };
  },
};

// ---- notebook_profile_table ------------------------------------------------
export const notebookProfileTableTool: ToolDef = {
  name: 'notebook_profile_table',
  service: 'Notebook',
  description:
    "Profile a lakehouse Delta table — return sizeInBytes, latest commit version, last-modified, and " +
    'rowCount (when Synapse Serverless is reachable). Reads directly from the ADLS Delta log; equivalent ' +
    'to DESCRIBE DETAIL on Databricks. No interactive Spark session required.',
  parameters: obj(
    {
      tableName: S_STRING,
      container: { type: 'string', description: 'bronze | silver | gold — defaults to all attached containers' },
    },
    ['tableName'],
  ),
  handler: async (args: { tableName?: string; container?: string }) => {
    const tableName = String(args?.tableName || '').trim();
    if (!tableName) return { ok: false, error: 'tableName is required' };
    const containers = args?.container ? [String(args.container)] : undefined;

    let tables: CatalogTable[] = [];
    try {
      // Prefer real row counts (Serverless OPENROWSET COUNT_BIG); fall back to
      // metadata-only when Serverless is offline / region-gated.
      tables = await scanLakehouseTables({ containers, rowCounts: true, rowCountTimeoutMs: 20_000 });
    } catch {
      tables = await scanLakehouseTables({ containers, rowCounts: false }).catch(() => []);
    }

    const t = tables.find((r) => r.name.toLowerCase() === tableName.toLowerCase());
    if (!t) {
      const known = tables.map((r) => r.name).slice(0, 25).join(', ');
      return {
        ok: false,
        error: `Table "${tableName}" not found in the attached lakehouse. ${
          known ? `Known tables: ${known}` : 'No tables found — attach a lakehouse with Delta tables first.'
        }`,
      };
    }
    return {
      ok: true,
      name: t.name,
      schema: t.schema,
      adlsPath: t.adlsPath,
      format: t.format,
      status: t.status,
      sizeInBytes: t.sizeBytes,
      latestVersion: t.latestVersion,
      lastModified: t.lastModified,
      rowCount: t.rowCount, // null when Serverless offline — honest, never fabricated
      rowCountAvailable: t.rowCount !== null,
    };
  },
};

// ---- notebook_perf_insights ------------------------------------------------
export const notebookPerfInsightsTool: ToolDef = {
  name: 'notebook_perf_insights',
  service: 'Notebook',
  description:
    'Provide the last-run Synapse Spark telemetry (Livy session sizing + last cell output / progress text) ' +
    'so the assistant can recommend concrete tuning: executor sizing, broadcast-join thresholds, partition ' +
    'pruning, caching, and skew fixes. No new Spark call is made — this is read-only over already-collected data.',
  parameters: obj({
    sessionReceipt: { type: 'object', description: 'Livy session receipt (id, numExecutors, executorMemory, …).' },
    lastOutput: { type: 'string', description: 'textPlain from the last cell run (stage/row counts, skew warnings).' },
    sessionConfig: { type: 'object', description: 'User session sizing (numExecutors, executorMemoryGb, timeoutMinutes).' },
  }),
  handler: async (args: { sessionReceipt?: unknown; lastOutput?: unknown; sessionConfig?: unknown }) => {
    const lastOutput = typeof args?.lastOutput === 'string' ? args.lastOutput.slice(0, 4000) : '';
    return {
      ok: true,
      sessionReceipt: args?.sessionReceipt ?? null,
      sessionConfig: args?.sessionConfig ?? null,
      lastOutput,
      hasTelemetry: !!(args?.sessionReceipt || lastOutput),
    };
  },
};

// ---- notebook_refactor_cells -----------------------------------------------
export const notebookRefactorCellsTool: ToolDef = {
  name: 'notebook_refactor_cells',
  service: 'Notebook',
  description:
    'Refactor a contiguous range of code cells. The assistant returns ONE fenced code block per output cell; ' +
    'the caller maps blocks back onto the cell range via the notebook editor\'s applyCells bridge — the user ' +
    'must explicitly click "Apply N cells" (an approval-diff step) to accept.',
  parameters: obj(
    {
      cells: {
        type: 'array',
        description: 'Code cells to refactor: [{id, source, lang}], in order.',
        items: { type: 'object' },
      },
      instruction: S_STRING,
    },
    ['cells', 'instruction'],
  ),
  handler: async (args: { cells?: NotebookCell[]; instruction?: string }) => {
    const cells = toToolCells(args?.cells);
    return {
      ok: true,
      cells: cells.map((c) => ({ id: c.id, source: c.source, lang: c.lang })),
      instruction: String(args?.instruction || ''),
    };
  },
};

export const NOTEBOOK_TOOLS: ToolDef[] = [
  notebookSummarizeTool,
  notebookGenerateCodeTool,
  notebookProfileTableTool,
  notebookPerfInsightsTool,
  notebookRefactorCellsTool,
];
