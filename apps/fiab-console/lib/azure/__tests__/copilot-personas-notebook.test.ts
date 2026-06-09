/**
 * Unit tests for the Notebook Copilot persona + tools.
 *
 *  - copilot-personas.ts is PURE (no Azure I/O): we assert the system-prompt
 *    factory grounds the model in real context and surfaces the gov-cloud note.
 *  - notebook-tools.ts reads real backends; we mock synapse-catalog-client +
 *    delta-schema so the handlers can be exercised without ADLS, and assert the
 *    honest-null / honest-error shapes (no fabricated rows, per no-vaporware).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock the Azure backends the tools read from ----
vi.mock('@/lib/azure/synapse-catalog-client', () => ({
  scanLakehouseTables: vi.fn(),
}));
vi.mock('@/lib/azure/delta-schema', () => ({
  buildDatastoreSchema: vi.fn(),
}));

import {
  NOTEBOOK_PERSONA,
  NOTEBOOK_SLASH_COMMANDS,
  NOTEBOOK_TOOL_NAMES,
  notebookSystemPrompt,
  getPersona,
  type PersonaSystemCtx,
} from '../copilot-personas-notebook';
import {
  notebookProfileTableTool,
  notebookGenerateCodeTool,
  notebookSummarizeTool,
  notebookPerfInsightsTool,
  notebookRefactorCellsTool,
  NOTEBOOK_TOOLS,
} from '@/lib/copilot/notebook-persona-tools';
import { scanLakehouseTables } from '@/lib/azure/synapse-catalog-client';
import { buildDatastoreSchema } from '@/lib/azure/delta-schema';

const TOOL_CTX = { userOid: 'u', session: { claims: { oid: 'u' } } } as any;

function baseCtx(over: Partial<PersonaSystemCtx> = {}): PersonaSystemCtx {
  return {
    notebookName: 'sales_etl',
    cellCount: 4,
    defaultLang: 'pyspark',
    attachedSources: 'lakehouse "silver" (default)',
    schema: 'silver.orders(order_id long, amount double)',
    lastRunTelemetry: '',
    cloud: 'Commercial',
    ...over,
  };
}

describe('copilot-personas — notebook', () => {
  it('exposes the 9 fixed slash commands + 5 tool names', () => {
    expect(NOTEBOOK_SLASH_COMMANDS.map((c) => c.cmd)).toEqual([
      '/fix', '/explain', '/comments', '/optimize',
      '/summarize', '/generate', '/refactor', '/profile', '/perf',
    ]);
    expect(NOTEBOOK_TOOL_NAMES).toContain('notebook_profile_table');
    expect(NOTEBOOK_PERSONA.tools).toBe(NOTEBOOK_TOOL_NAMES);
    expect(getPersona('notebook')).toBe(NOTEBOOK_PERSONA);
  });

  it('grounds the system prompt in the real notebook name, schema, and sources', () => {
    const p = notebookSystemPrompt(baseCtx());
    expect(p).toContain('sales_etl');
    expect(p).toContain('4 cells');
    expect(p).toContain('silver.orders(order_id long, amount double)');
    expect(p).toContain('lakehouse "silver" (default)');
    expect(p).toContain('Never invent table names');
  });

  it('adds the US-Gov boundary note for GCC-High / DoD only', () => {
    expect(notebookSystemPrompt(baseCtx({ cloud: 'GCC-High' }))).toContain('azuresynapse.us');
    expect(notebookSystemPrompt(baseCtx({ cloud: 'DoD' }))).toContain('US Government boundary');
    expect(notebookSystemPrompt(baseCtx({ cloud: 'Commercial' }))).not.toContain('US Government boundary');
  });

  it('includes a telemetry section only when telemetry is present', () => {
    expect(notebookSystemPrompt(baseCtx({ lastRunTelemetry: '' }))).not.toContain('Last-run Spark telemetry');
    expect(notebookSystemPrompt(baseCtx({ lastRunTelemetry: 'Livy session: {"id":3}' })))
      .toContain('Last-run Spark telemetry');
  });
});

describe('notebook-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('NOTEBOOK_TOOLS registers all five tool names', () => {
    expect(NOTEBOOK_TOOLS.map((t) => t.name).sort()).toEqual(
      [...NOTEBOOK_TOOL_NAMES].sort(),
    );
  });

  it('profile returns real stats for a known table (rowCount preserved)', async () => {
    (scanLakehouseTables as any).mockResolvedValue([
      {
        schema: 'silver', name: 'orders', adlsPath: 'silver/Tables/orders', bulkUrl: 'https://x',
        format: 'delta', status: 'ok', latestVersion: 12, rowCount: 4200, sizeBytes: 99999, lastModified: '2026-06-01T00:00:00Z',
      },
    ]);
    const r: any = await notebookProfileTableTool.handler({ tableName: 'ORDERS' }, TOOL_CTX);
    expect(r.ok).toBe(true);
    expect(r.name).toBe('orders');
    expect(r.rowCount).toBe(4200);
    expect(r.rowCountAvailable).toBe(true);
    expect(r.sizeInBytes).toBe(99999);
  });

  it('profile keeps rowCount honest-null when Serverless is offline', async () => {
    (scanLakehouseTables as any).mockResolvedValue([
      { schema: 'silver', name: 'orders', adlsPath: 'p', bulkUrl: 'u', format: 'delta', status: 'ok', latestVersion: 1, rowCount: null, sizeBytes: 10, lastModified: null },
    ]);
    const r: any = await notebookProfileTableTool.handler({ tableName: 'orders' }, TOOL_CTX);
    expect(r.ok).toBe(true);
    expect(r.rowCount).toBeNull();
    expect(r.rowCountAvailable).toBe(false);
  });

  it('profile returns an honest error listing known tables when not found', async () => {
    (scanLakehouseTables as any).mockResolvedValue([
      { schema: 'silver', name: 'orders', adlsPath: 'p', bulkUrl: 'u', format: 'delta', status: 'ok', latestVersion: 1, rowCount: 1, sizeBytes: 1, lastModified: null },
    ]);
    const r: any = await notebookProfileTableTool.handler({ tableName: 'nope' }, TOOL_CTX);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('orders');
  });

  it('generate reads the real schema (no mock schema in the tool itself)', async () => {
    (buildDatastoreSchema as any).mockResolvedValue('silver.orders(order_id long)');
    const r: any = await notebookGenerateCodeTool.handler({ description: 'join orders + customers', lang: 'pyspark' }, TOOL_CTX);
    expect(r.ok).toBe(true);
    expect(r.schema).toBe('silver.orders(order_id long)');
    expect(r.schemaAvailable).toBe(true);
    expect(buildDatastoreSchema).toHaveBeenCalled();
  });

  it('summarize serializes the open cells in order', async () => {
    const r: any = await notebookSummarizeTool.handler({
      cells: [
        { id: 'a', type: 'code', lang: 'pyspark', source: 'df = spark.read.parquet("x")' },
        { id: 'b', type: 'markdown', source: '# notes' },
      ],
    } as any, TOOL_CTX);
    expect(r.ok).toBe(true);
    expect(r.cellCount).toBe(2);
    expect(r.cells[0].index).toBe(1);
    expect(r.cells[1].kind).toBe('markdown');
  });

  it('perf reports hasTelemetry based on receipt/output presence', async () => {
    const empty: any = await notebookPerfInsightsTool.handler({}, TOOL_CTX);
    expect(empty.hasTelemetry).toBe(false);
    const withT: any = await notebookPerfInsightsTool.handler({ sessionReceipt: { id: 3 }, lastOutput: 'Stage 1/4' }, TOOL_CTX);
    expect(withT.hasTelemetry).toBe(true);
    expect(withT.lastOutput).toContain('Stage 1/4');
  });

  it('refactor passes through only code cells + the instruction', async () => {
    const r: any = await notebookRefactorCellsTool.handler({
      cells: [{ id: 'a', type: 'code', lang: 'pyspark', source: 'x=1' }] as any,
      instruction: 'split into two cells',
    }, TOOL_CTX);
    expect(r.ok).toBe(true);
    expect(r.cells[0].id).toBe('a');
    expect(r.instruction).toBe('split into two cells');
  });
});
