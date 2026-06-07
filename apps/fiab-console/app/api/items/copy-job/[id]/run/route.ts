/**
 * POST /api/items/copy-job/[id]/run
 *
 * Materialises the persisted Copy job spec into a REAL Azure Data Factory
 * pipeline and triggers a run. No Microsoft Fabric dependency
 * (no-fabric-dependency.md) — the backend is ADF + Azure SQL.
 *
 *   Full mode        → one Copy activity (source dataset → sink dataset).
 *   Incremental mode → the canonical 4-activity incremental-copy pattern:
 *       LookupOldWatermark (Script, reads dbo.copy_watermark)
 *         → LookupNewWatermark (Script, MAX(<col>) on the source)
 *           → IncrementalCopyActivity (Copy, WHERE <col> > old AND <= new)
 *             → UpdateWatermark (StoredProcedure, dbo.usp_write_watermark)
 *
 * The watermark lives in dbo.copy_watermark in Azure SQL — deployed by
 * platform/fiab/bicep/modules/admin-plane/copy-job-control.bicep and addressed via
 * LOOM_COPYJOB_CONTROL_SQL_SERVER / LOOM_COPYJOB_CONTROL_SQL_DB. When the
 * control server env is unset, Full mode still runs; Incremental mode returns a
 * precise 503 naming the missing env var + bicep module (no-vaporware.md).
 *
 * Grounded in learn.microsoft.com/azure/data-factory/tutorial-incremental-copy-portal.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  runPipeline, upsertPipeline, upsertLinkedService, upsertDataset,
  type AdfPipeline, type AdfDataset, type AdfLinkedService,
} from '@/lib/azure/adf-client';
import { executeQuery } from '@/lib/azure/azure-sql-client';
import { jerr, loadOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'copy-job';
const CONTROL_LS = 'loom-copy-control-sql';

interface SideSpec {
  linkedService: string;
  type: string;
  sourceTable?: string;
  table?: string;
  query?: string;
}

interface CopySpec {
  source: SideSpec;
  sink: SideSpec;
  mode?: 'Full' | 'Incremental';
  writeMode?: 'Append' | 'Overwrite' | 'Merge';
  watermarkCol?: string;
  sourceName?: string;
  mergeKeys?: string;
  mappings?: Array<{ source: string; sink: string }>;
}

const SQL_SOURCE = new Set(['AzureSqlSource', 'SqlServerSource', 'SqlMISource', 'AzureSqlDWSource']);
const SQL_SINK = new Set(['AzureSqlSink', 'SqlServerSink', 'SqlMISink', 'AzureSqlDWSink']);

function isSqlSource(t: string): boolean { return SQL_SOURCE.has(t); }
function isSqlSink(t: string): boolean { return SQL_SINK.has(t); }

/**
 * Idempotently ensure the dbo.copy_watermark control table + dbo.usp_write_watermark
 * stored procedure exist in the control DB. Real DDL via TDS+AAD (the console UAMI
 * must be db_owner / have CREATE TABLE+PROCEDURE on the control DB). This makes the
 * incremental path self-heal even before the copy-job-control.bicep deployment
 * script has run; the proc is what the pipeline's StoredProcedure activity invokes.
 */
async function ensureControlTable(server: string, database: string): Promise<void> {
  await executeQuery(server, database,
    "IF OBJECT_ID('dbo.copy_watermark','U') IS NULL " +
    'CREATE TABLE dbo.copy_watermark (' +
    '  source nvarchar(256) NOT NULL,' +
    '  table_name nvarchar(256) NOT NULL,' +
    '  last_value nvarchar(256) NULL,' +
    '  updated_utc datetimeoffset NOT NULL CONSTRAINT DF_copy_watermark_updated DEFAULT SYSDATETIMEOFFSET(),' +
    '  CONSTRAINT PK_copy_watermark PRIMARY KEY (source, table_name));');
  await executeQuery(server, database,
    'CREATE OR ALTER PROCEDURE dbo.usp_write_watermark ' +
    '@source nvarchar(256), @table_name nvarchar(256), @last_value nvarchar(256) AS BEGIN ' +
    'SET NOCOUNT ON; ' +
    'MERGE dbo.copy_watermark AS tgt ' +
    'USING (SELECT @source AS source, @table_name AS table_name) AS src ' +
    'ON tgt.source = src.source AND tgt.table_name = src.table_name ' +
    'WHEN MATCHED THEN UPDATE SET last_value = @last_value, updated_utc = SYSDATETIMEOFFSET() ' +
    'WHEN NOT MATCHED THEN INSERT (source, table_name, last_value) VALUES (@source, @table_name, @last_value); END;');
}

function splitTable(t: string): { schema: string; table: string } {
  const i = t.indexOf('.');
  if (i < 0) return { schema: 'dbo', table: t };
  return { schema: t.slice(0, i), table: t.slice(i + 1) };
}

/** Dataset `type` for a Copy activity source/sink type. */
function datasetType(activityType: string): string {
  if (SQL_SOURCE.has(activityType) || SQL_SINK.has(activityType)) {
    if (activityType.startsWith('SqlServer')) return 'SqlServerTable';
    if (activityType.startsWith('SqlMI')) return 'AzureSqlMITable';
    if (activityType.startsWith('AzureSqlDW')) return 'AzureSqlDWTable';
    return 'AzureSqlTable';
  }
  if (activityType.startsWith('Parquet')) return 'Parquet';
  if (activityType.startsWith('DelimitedText')) return 'DelimitedText';
  if (activityType.startsWith('Json')) return 'Json';
  if (activityType.startsWith('AzureTable')) return 'AzureTable';
  return 'Binary';
}

/** Build the typeProperties for a dataset given its type + table/path. */
function datasetTypeProps(dsType: string, tableOrPath?: string): Record<string, unknown> {
  if (dsType.endsWith('Table') && dsType !== 'AzureTable') {
    const { schema, table } = splitTable(tableOrPath || '');
    return { schema, table };
  }
  if (dsType === 'AzureTable') return { tableName: tableOrPath || '' };
  // File-based datasets (Parquet/DelimitedText/Json/Binary) — parse path into
  // container + folder for an ADLS Gen2 (AzureBlobFS) location.
  const path = (tableOrPath || '').replace(/^\/+/, '');
  const seg = path.split('/');
  const fileSystem = seg.shift() || '';
  const folderPath = seg.join('/');
  return { location: { type: 'AzureBlobFSLocation', fileSystem, ...(folderPath ? { folderPath } : {}) } };
}

function buildDataset(name: string, activityType: string, linkedService: string, tableOrPath?: string): AdfDataset {
  const dsType = datasetType(activityType);
  return {
    name,
    properties: {
      type: dsType,
      linkedServiceName: { referenceName: linkedService, type: 'LinkedServiceReference' },
      schema: [],
      typeProperties: datasetTypeProps(dsType, tableOrPath),
    },
  };
}

function translator(mappings?: Array<{ source: string; sink: string }>) {
  if (!mappings || mappings.length === 0) return undefined;
  return {
    type: 'TabularTranslator',
    mappings: mappings.map((m) => ({ source: { name: m.source }, sink: { name: m.sink } })),
  };
}

/** Sink typeProperties honouring the chosen write mode (SQL sinks only for upsert/truncate). */
function sinkProps(spec: CopySpec): Record<string, unknown> {
  const type = spec.sink.type;
  const sinkTable = spec.sink.table || '';
  const props: Record<string, unknown> = { type };
  if (isSqlSink(type)) {
    if (spec.writeMode === 'Overwrite' && sinkTable) {
      props.preCopyScript = `TRUNCATE TABLE ${sinkTable}`;
    } else if (spec.writeMode === 'Merge') {
      const keys = (spec.mergeKeys || '').split(',').map((k) => k.trim()).filter(Boolean);
      props.writeBehavior = 'upsert';
      props.upsertSettings = { useTempDB: true, keys };
      props.sqlWriterUseTableLock = false;
    }
  } else {
    // File sinks write via the store; Overwrite maps to copyBehavior=Overwrite.
    props.storeSettings = {
      type: 'AzureBlobFSWriteSettings',
      ...(spec.writeMode === 'Overwrite' ? { copyBehavior: 'Overwrite' } : {}),
    };
  }
  return props;
}

function fullPipeline(itemId: string, spec: CopySpec, srcDs: string, snkDs: string): AdfPipeline {
  const srcQuery = spec.source.query
    || (isSqlSource(spec.source.type) && spec.source.sourceTable ? `SELECT * FROM ${spec.source.sourceTable}` : undefined);
  const tx = translator(spec.mappings);
  return {
    name: `loom-copy-${itemId}`,
    properties: {
      description: `Loom copy-job ${itemId} (Full · ${spec.writeMode || 'Append'})`,
      activities: [
        {
          name: 'Copy',
          type: 'Copy',
          inputs: [{ referenceName: srcDs, type: 'DatasetReference' }],
          outputs: [{ referenceName: snkDs, type: 'DatasetReference' }],
          typeProperties: {
            source: { type: spec.source.type, ...(srcQuery ? { sqlReaderQuery: srcQuery } : {}) },
            sink: sinkProps(spec),
            ...(tx ? { translator: tx } : {}),
            enableStaging: false,
          },
        },
      ],
      annotations: ['loom', 'copy-job', itemId, 'full'],
    },
  };
}

function incrementalPipeline(itemId: string, spec: CopySpec, srcDs: string, snkDs: string): AdfPipeline {
  const sourceTable = spec.source.sourceTable!;
  const wm = spec.watermarkCol!;
  const sourceName = spec.sourceName || sourceTable;
  const tx = translator(spec.mappings);
  const oldVal = "@{activity('LookupOldWatermark').output.resultSets[0].rows[0].last_value}";
  const newVal = "@{activity('LookupNewWatermark').output.resultSets[0].rows[0].new_value}";
  const boundedQuery =
    `SELECT * FROM ${sourceTable} WHERE ${wm} > '${oldVal}' AND ${wm} <= '${newVal}'`;
  return {
    name: `loom-copy-${itemId}`,
    properties: {
      description: `Loom copy-job ${itemId} (Incremental · watermark ${wm})`,
      activities: [
        {
          name: 'LookupOldWatermark',
          type: 'Script',
          linkedServiceName: { referenceName: CONTROL_LS, type: 'LinkedServiceReference' },
          typeProperties: {
            scripts: [{
              type: 'Query',
              text:
                `SELECT ISNULL(last_value, '1900-01-01T00:00:00Z') AS last_value ` +
                `FROM dbo.copy_watermark WHERE source = '${sourceName}' AND table_name = '${sourceTable}'`,
            }],
          },
        },
        {
          name: 'LookupNewWatermark',
          type: 'Script',
          linkedServiceName: { referenceName: spec.source.linkedService, type: 'LinkedServiceReference' },
          typeProperties: {
            scripts: [{ type: 'Query', text: `SELECT MAX(${wm}) AS new_value FROM ${sourceTable}` }],
          },
        },
        {
          name: 'IncrementalCopyActivity',
          type: 'Copy',
          dependsOn: [
            { activity: 'LookupOldWatermark', dependencyConditions: ['Succeeded'] },
            { activity: 'LookupNewWatermark', dependencyConditions: ['Succeeded'] },
          ],
          inputs: [{ referenceName: srcDs, type: 'DatasetReference' }],
          outputs: [{ referenceName: snkDs, type: 'DatasetReference' }],
          typeProperties: {
            source: { type: spec.source.type, sqlReaderQuery: boundedQuery },
            sink: sinkProps(spec),
            ...(tx ? { translator: tx } : {}),
            enableStaging: false,
          },
        },
        {
          name: 'UpdateWatermark',
          type: 'SqlServerStoredProcedure',
          dependsOn: [{ activity: 'IncrementalCopyActivity', dependencyConditions: ['Succeeded'] }],
          linkedServiceName: { referenceName: CONTROL_LS, type: 'LinkedServiceReference' },
          typeProperties: {
            storedProcedureName: 'dbo.usp_write_watermark',
            storedProcedureParameters: {
              source: { value: sourceName, type: 'String' },
              table_name: { value: sourceTable, type: 'String' },
              last_value: { value: newVal, type: 'String' },
            },
          },
        },
      ],
      annotations: ['loom', 'copy-job', itemId, 'incremental'],
    },
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { id } = await ctx.params;
  const override = await req.json().catch(() => ({}));
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const spec = { ...((item.state as any) as CopySpec), ...override } as CopySpec;

    if (!spec?.source?.linkedService || !spec?.sink?.linkedService) {
      return jerr('source.linkedService and sink.linkedService are required — configure the copy job in the wizard first', 400);
    }
    if (!spec.source.type || !spec.sink.type) {
      return jerr('source.type and sink.type are required', 400);
    }
    if (!spec.sink.table) {
      return jerr('a destination table / path is required', 400);
    }
    const mode = spec.mode === 'Incremental' ? 'Incremental' : 'Full';

    const controlServer = process.env.LOOM_COPYJOB_CONTROL_SQL_SERVER;
    if (mode === 'Incremental') {
      if (!spec.source.sourceTable) {
        return jerr('a source table is required for incremental copy', 400);
      }
      if (!spec.watermarkCol) {
        return jerr('a watermark column is required for incremental copy', 400);
      }
      if (!isSqlSource(spec.source.type)) {
        return jerr('incremental copy requires a SQL-family source (the watermark is read with MAX(<column>) against the source table)', 400);
      }
      if (!controlServer) {
        return jerr(
          'LOOM_COPYJOB_CONTROL_SQL_SERVER is not configured, so the watermark control table cannot be reached. ' +
          'Deploy platform/fiab/bicep/modules/admin-plane/copy-job-control.bicep and set LOOM_COPYJOB_CONTROL_SQL_SERVER ' +
          '(+ LOOM_COPYJOB_CONTROL_SQL_DB) on the console app. Full-mode copy works without this.',
          503,
        );
      }
    }

    // Datasets — real ADF child resources referenced by the Copy activity.
    const srcDs = `loom-copy-${id}-src`;
    const snkDs = `loom-copy-${id}-snk`;
    await upsertDataset(srcDs, buildDataset(srcDs, spec.source.type, spec.source.linkedService, spec.source.sourceTable));
    await upsertDataset(snkDs, buildDataset(snkDs, spec.sink.type, spec.sink.linkedService, spec.sink.table));

    if (mode === 'Incremental') {
      // Make sure the watermark control table + stored procedure exist (real DDL).
      await ensureControlTable(controlServer!, process.env.LOOM_COPYJOB_CONTROL_SQL_DB || 'loom-control');
      // Control linked service → Azure SQL watermark DB via the factory's MI.
      const controlLs: AdfLinkedService = {
        name: CONTROL_LS,
        properties: {
          type: 'AzureSqlDatabase',
          description: 'Loom copy-job watermark control DB (dbo.copy_watermark).',
          typeProperties: {
            server: controlServer,
            database: process.env.LOOM_COPYJOB_CONTROL_SQL_DB || 'loom-control',
            authenticationType: 'SystemAssignedManagedIdentity',
          },
        },
      };
      await upsertLinkedService(CONTROL_LS, controlLs);
    }

    const pipelineName = `loom-copy-${id}`;
    const pipeline = mode === 'Incremental'
      ? incrementalPipeline(id, spec, srcDs, snkDs)
      : fullPipeline(id, spec, srcDs, snkDs);
    await upsertPipeline(pipelineName, pipeline);

    const run = await runPipeline(pipelineName);
    return NextResponse.json({ ok: true, pipelineName, mode, ...run });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
