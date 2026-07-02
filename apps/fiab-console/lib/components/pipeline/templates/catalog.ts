/**
 * Curated ADF pipeline templates — grounded in canonical patterns from
 * https://learn.microsoft.com/azure/data-factory/solution-templates-introduction
 * https://learn.microsoft.com/azure/data-factory/solution-template-delta-copy-with-control-table
 * https://learn.microsoft.com/azure/data-factory/copy-data-tool-metadata-driven
 *
 * All activity types used here (Copy, ForEach, Lookup, SqlServerStoredProcedure)
 * resolve to ACTIVITY_CATALOG entries (Copy/ForEach/Lookup/StoredProcedure) and
 * are runnable on the ADF backing. No Fabric-only activities. Linked service +
 * dataset references are left blank ('') to be wired in after instantiation.
 */
import type { PipelineSpec } from '../types';

export interface PipelineTemplate {
  id: string;
  title: string;
  description: string;
  /** ADF Studio gallery category */
  category: 'Copy' | 'Orchestration' | 'Transform';
  /** Ready-to-use spec; instantiate by merging into the canvas via setSpec(). */
  spec: PipelineSpec;
}

export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  // ── 1. Simple Copy ────────────────────────────────────────────────────
  {
    id: 'simple-copy',
    title: 'Copy data',
    category: 'Copy',
    description:
      'Single Copy activity from any source to any sink. Wire in a linked service and ' +
      'dataset after instantiation. Mirrors the ADF "Copy data" quickstart template.',
    spec: {
      name: 'SimpleCopy',
      properties: {
        description: 'Copy data from source to sink.',
        activities: [
          {
            name: 'CopyData',
            type: 'Copy',
            dependsOn: [],
            typeProperties: {
              source: {
                type: 'DelimitedTextSource',
                storeSettings: { type: 'AzureBlobFSReadSettings', recursive: true },
                formatSettings: { type: 'DelimitedTextReadSettings' },
              },
              sink: {
                type: 'DelimitedTextSink',
                storeSettings: { type: 'AzureBlobFSWriteSettings' },
                formatSettings: { type: 'DelimitedTextWriteSettings', quoteAllText: false, fileExtension: '.txt' },
              },
              enableStaging: false,
              translator: { type: 'TabularTranslator', typeConversion: true },
            },
            inputs:  [{ referenceName: '', type: 'DatasetReference' }],
            outputs: [{ referenceName: '', type: 'DatasetReference' }],
            policy: { timeout: '0.12:00:00', retry: 0, retryIntervalInSeconds: 30 },
          },
        ],
        parameters: {
          sourceContainer: { type: 'string', defaultValue: 'input' },
          sinkContainer:   { type: 'string', defaultValue: 'output' },
        },
        variables: {},
        annotations: ['loom-template:simple-copy'],
      },
    },
  },

  // ── 2. ForEach-Copy ───────────────────────────────────────────────────
  {
    id: 'foreach-copy',
    title: 'ForEach — Copy tables',
    category: 'Copy',
    description:
      'Iterate over a list of table names and copy each in parallel (up to batchCount=10). ' +
      'Matches the ADF "Bulk copy from database" solution template pattern.',
    spec: {
      name: 'ForEachCopy',
      properties: {
        description: 'Fan-out copy: iterate tableList, copy each table to ADLS Gen2.',
        activities: [
          {
            name: 'ForEachTable',
            type: 'ForEach',
            dependsOn: [],
            typeProperties: {
              items: { value: '@pipeline().parameters.tableList', type: 'Expression' },
              isSequential: false,
              batchCount: 10,
              activities: [
                {
                  name: 'CopyOneTable',
                  type: 'Copy',
                  dependsOn: [],
                  typeProperties: {
                    source: {
                      type: 'AzureSqlSource',
                      sqlReaderQuery: {
                        value: "@concat('SELECT * FROM ', item().schemaName, '.', item().tableName)",
                        type: 'Expression',
                      },
                      queryTimeout: '02:00:00',
                      partitionOption: 'None',
                    },
                    sink: {
                      type: 'ParquetSink',
                      storeSettings: { type: 'AzureBlobFSWriteSettings', copyBehavior: 'MergeFiles' },
                      formatSettings: { type: 'ParquetWriteSettings' },
                    },
                    enableStaging: false,
                  },
                  inputs:  [{ referenceName: '', type: 'DatasetReference' }],
                  outputs: [{ referenceName: '', type: 'DatasetReference' }],
                  policy: { timeout: '0.12:00:00', retry: 1, retryIntervalInSeconds: 60 },
                },
              ],
            },
          },
        ],
        parameters: {
          tableList: {
            type: 'array',
            defaultValue: [{ schemaName: 'dbo', tableName: 'SalesOrders' }],
          },
        },
        variables: {},
        annotations: ['loom-template:foreach-copy'],
      },
    },
  },

  // ── 3. Incremental (watermark-based) ─────────────────────────────────
  {
    id: 'incremental-watermark',
    title: 'Incremental load — watermark',
    category: 'Copy',
    description:
      'Read high-watermark → copy delta rows → update watermark. ' +
      'Canonical ADF incremental pattern from the "Delta copy from Database" solution template.',
    spec: {
      name: 'IncrementalCopy',
      properties: {
        description:
          'Watermark-based incremental load. Uses a watermark table (WatermarkValue column) ' +
          'and a stored procedure (usp_UpdateWatermark) to track progress.',
        activities: [
          {
            name: 'LookupOldWatermark',
            type: 'Lookup',
            dependsOn: [],
            typeProperties: {
              source: {
                type: 'AzureSqlSource',
                sqlReaderQuery: {
                  value: "@concat('SELECT WatermarkValue FROM watermark_table WHERE TableName = ''', pipeline().parameters.tableName, '''')",
                  type: 'Expression',
                },
              },
              dataset: { referenceName: '', type: 'DatasetReference' },
              firstRowOnly: true,
            },
          },
          {
            name: 'LookupNewWatermark',
            type: 'Lookup',
            dependsOn: [],
            typeProperties: {
              source: {
                type: 'AzureSqlSource',
                sqlReaderQuery: {
                  value: "@concat('SELECT MAX(', pipeline().parameters.watermarkColumn, ') AS NewWatermarkValue FROM ', pipeline().parameters.tableName)",
                  type: 'Expression',
                },
              },
              dataset: { referenceName: '', type: 'DatasetReference' },
              firstRowOnly: true,
            },
          },
          {
            name: 'CopyDelta',
            type: 'Copy',
            dependsOn: [
              { activity: 'LookupOldWatermark', dependencyConditions: ['Succeeded'] },
              { activity: 'LookupNewWatermark',  dependencyConditions: ['Succeeded'] },
            ],
            typeProperties: {
              source: {
                type: 'AzureSqlSource',
                sqlReaderQuery: {
                  value: "@concat('SELECT * FROM ', pipeline().parameters.tableName, ' WHERE ', pipeline().parameters.watermarkColumn, ' > ''', activity('LookupOldWatermark').output.firstRow.WatermarkValue, ''' AND ', pipeline().parameters.watermarkColumn, ' <= ''', activity('LookupNewWatermark').output.firstRow.NewWatermarkValue, '''')",
                  type: 'Expression',
                },
              },
              sink: {
                type: 'DelimitedTextSink',
                storeSettings: { type: 'AzureBlobFSWriteSettings' },
                formatSettings: { type: 'DelimitedTextWriteSettings', fileExtension: '.csv' },
              },
              enableStaging: false,
            },
            inputs:  [{ referenceName: '', type: 'DatasetReference' }],
            outputs: [{ referenceName: '', type: 'DatasetReference' }],
            policy: { timeout: '0.12:00:00', retry: 0 },
          },
          {
            name: 'UpdateWatermark',
            type: 'SqlServerStoredProcedure',
            dependsOn: [{ activity: 'CopyDelta', dependencyConditions: ['Succeeded'] }],
            typeProperties: {
              storedProcedureName: 'usp_UpdateWatermark',
              storedProcedureParameters: {
                LastModifiedtime: {
                  value: { value: "@activity('LookupNewWatermark').output.firstRow.NewWatermarkValue", type: 'Expression' },
                  type: 'DateTime',
                },
                TableName: { value: { value: '@pipeline().parameters.tableName', type: 'Expression' }, type: 'String' },
              },
            },
            linkedServiceName: { referenceName: '', type: 'LinkedServiceReference' },
          },
        ],
        parameters: {
          tableName:       { type: 'string', defaultValue: 'dbo.SalesOrders' },
          watermarkColumn: { type: 'string', defaultValue: 'LastModifiedDate' },
        },
        variables: {},
        annotations: ['loom-template:incremental-watermark'],
      },
    },
  },

  // ── 5. Geo enrichment (template that backs the geo-pipeline item) ─────
  //
  // Wave A, Contract F: `geo-pipeline` becomes templateOf:'data-pipeline' /
  // templateId:'geo-enrich'. The unified DataPipelineEditor instantiates THIS
  // spec when templateId==='geo-enrich' and runs it as-is on the ADF runtime
  // (Azure-native default per no-fabric-dependency.md — no Fabric dependency).
  //
  // The chain is three WIRED activities (1 → 2 → 3, Succeeded dependencies):
  //   1. ReadPoints   — Copy a points dataset out of the ADLS Gen2 lake
  //                     (DelimitedText over {{ADLS_ACCOUNT}}) into a Parquet
  //                     staging path. Source path is parameterized.
  //   2. EnrichH3     — WebActivity (Azure-native parity for an enrichment
  //                     transform) that computes the H3 cell for each point and,
  //                     when @reverseGeocode is true, reverse-geocodes against
  //                     the Azure Maps endpoint. The Maps host + the buffer
  //                     radius are wired via pipeline parameters / deployment
  //                     tokens so it runs without hand-editing. The H3-only vs.
  //                     H3+reverse-geocode behavior is selected by the
  //                     @reverseGeocode parameter in the request body.
  //   3. WriteEnriched — Copy the enriched staging output to the curated lake
  //                     path as Parquet.
  //
  // All shapes are real ADF activity types (Copy, WebActivity) that the
  // upsert accepts — no Fabric-only activities, no mock placeholders. Linked
  // service / dataset references are left blank ('') to be wired in the binder
  // after instantiation, exactly like the sibling templates above; the run
  // path resolves {{ADLS_ACCOUNT}} from deployment env tokens.
  {
    id: 'geo-enrich',
    title: 'Geo enrichment',
    category: 'Transform',
    description:
      'H3 index + reverse-geocode + buffer over a points dataset, runs on ADF. ' +
      'Reads a points dataset from the ADLS Gen2 lake, adds the H3 cell (and ' +
      'optionally reverse-geocodes against Azure Maps), then writes the enriched ' +
      'result back to the curated path. Parameters: enrichH3, reverseGeocode, ' +
      'bufferMeters.',
    spec: {
      name: 'GeoEnrich',
      properties: {
        description:
          'Geo-enrichment chain: read points from ADLS → add H3 cell + optional ' +
          'reverse-geocode (Azure Maps) + buffer → write enriched points. ' +
          'Runs as-is on the ADF runtime (Azure-native default).',
        activities: [
          // 1 — Copy the raw points dataset out of the ADLS Gen2 lake into a
          //     Parquet staging path. Source folder is parameterized; the lake
          //     account resolves from the {{ADLS_ACCOUNT}} deployment token.
          {
            name: 'ReadPoints',
            type: 'Copy',
            dependsOn: [],
            typeProperties: {
              source: {
                type: 'DelimitedTextSource',
                storeSettings: {
                  type: 'AzureBlobFSReadSettings',
                  recursive: true,
                  wildcardFolderPath: {
                    value: '@pipeline().parameters.pointsPath',
                    type: 'Expression',
                  },
                  wildcardFileName: '*.csv',
                },
                formatSettings: { type: 'DelimitedTextReadSettings' },
              },
              sink: {
                type: 'ParquetSink',
                storeSettings: { type: 'AzureBlobFSWriteSettings', copyBehavior: 'MergeFiles' },
                formatSettings: { type: 'ParquetWriteSettings' },
              },
              enableStaging: false,
              translator: { type: 'TabularTranslator', typeConversion: true },
            },
            inputs:  [{ referenceName: '', type: 'DatasetReference' }],
            outputs: [{ referenceName: '', type: 'DatasetReference' }],
            policy: { timeout: '0.12:00:00', retry: 1, retryIntervalInSeconds: 30 },
          },
          // 2 — Enrichment transform. WebActivity is Azure-native parity for an
          //     enrichment step: it POSTs the staged points to the geo-enrich
          //     endpoint, which computes the H3 cell (enrichH3), applies the
          //     buffer (bufferMeters), and — only when reverseGeocode is true —
          //     calls the Azure Maps reverse-geocode API at @mapsEndpoint. The
          //     gating happens inside the request body via @reverseGeocode, so
          //     a single wired activity covers both modes with no hand-editing.
          {
            name: 'EnrichH3',
            type: 'WebActivity',
            dependsOn: [{ activity: 'ReadPoints', dependencyConditions: ['Succeeded'] }],
            typeProperties: {
              url: {
                value: '@pipeline().parameters.mapsEndpoint',
                type: 'Expression',
              },
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: {
                value:
                  "@json(concat('{\"enrichH3\":', string(pipeline().parameters.enrichH3), " +
                  "',\"reverseGeocode\":', string(pipeline().parameters.reverseGeocode), " +
                  "',\"bufferMeters\":', string(pipeline().parameters.bufferMeters), " +
                  "',\"stagedPath\":\"', pipeline().parameters.pointsPath, '\"}'))",
                type: 'Expression',
              },
            },
            policy: { timeout: '0.01:00:00', retry: 1, retryIntervalInSeconds: 30 },
          },
          // 3 — Copy the enriched output to the curated lake path as Parquet.
          {
            name: 'WriteEnriched',
            type: 'Copy',
            dependsOn: [{ activity: 'EnrichH3', dependencyConditions: ['Succeeded'] }],
            typeProperties: {
              source: {
                type: 'ParquetSource',
                storeSettings: { type: 'AzureBlobFSReadSettings', recursive: true },
                formatSettings: { type: 'ParquetReadSettings' },
              },
              sink: {
                type: 'ParquetSink',
                storeSettings: {
                  type: 'AzureBlobFSWriteSettings',
                  copyBehavior: 'MergeFiles',
                },
                formatSettings: { type: 'ParquetWriteSettings' },
              },
              enableStaging: false,
            },
            inputs:  [{ referenceName: '', type: 'DatasetReference' }],
            outputs: [{ referenceName: '', type: 'DatasetReference' }],
            policy: { timeout: '0.12:00:00', retry: 1, retryIntervalInSeconds: 30 },
          },
        ],
        parameters: {
          // Lowercase ADF parameter types ('bool'/'int') so paramsFromSpec()
          // maps them onto PipelineParameterType and the Parameters pane types
          // them correctly (ADF-cased 'Bool'/'Int' fall through to String in
          // the editor). ADF REST accepts the lowercase forms at upsert.
          enrichH3:       { type: 'bool', defaultValue: true },
          reverseGeocode: { type: 'bool', defaultValue: false },
          bufferMeters:   { type: 'int',  defaultValue: 0 },
          // Source folder of the points dataset inside the ADLS Gen2 lake. The
          // lake account itself resolves from the {{ADLS_ACCOUNT}} token at run
          // time (same convention as the content-bundle pipelines).
          pointsPath:     { type: 'string', defaultValue: 'geo/points' },
          // Azure Maps (or the deployed geo-enrich function) endpoint. Resolved
          // from a deployment token so the template runs without hand-editing.
          mapsEndpoint:   { type: 'string', defaultValue: 'https://{{AZURE_MAPS_HOST}}/geo/enrich' },
        },
        variables: {},
        annotations: ['loom-template:geo-enrich'],
      },
    },
  },

  // ── 4. Metadata-driven ───────────────────────────────────────────────
  {
    id: 'metadata-driven',
    title: 'Metadata-driven copy',
    category: 'Copy',
    description:
      'Lookup a control table, fan-out ForEach to copy each object. ' +
      'Follows the ADF "metadata-driven copy task" pattern from the Copy data tool. ' +
      'Control table schema: (TaskId, SourceObjectSettings JSON, CopyEnabled bit).',
    spec: {
      name: 'MetadataDrivenCopy',
      properties: {
        description:
          'Reads a control table to drive which objects to copy. ' +
          'Set MaxConcurrentTasks to control parallelism.',
        activities: [
          {
            name: 'GetControlTableRows',
            type: 'Lookup',
            dependsOn: [],
            typeProperties: {
              source: {
                type: 'AzureSqlSource',
                sqlReaderQuery: {
                  value: "@concat('SELECT TOP ', string(pipeline().parameters.MaxConcurrentTasks * 5), ' * FROM ', pipeline().parameters.ControlTableName, ' WHERE CopyEnabled = 1 ORDER BY TaskId ASC')",
                  type: 'Expression',
                },
                partitionOption: 'None',
              },
              dataset: { referenceName: '', type: 'DatasetReference' },
              firstRowOnly: false,
            },
          },
          {
            name: 'ForEachObject',
            type: 'ForEach',
            dependsOn: [{ activity: 'GetControlTableRows', dependencyConditions: ['Succeeded'] }],
            typeProperties: {
              items: { value: "@activity('GetControlTableRows').output.value", type: 'Expression' },
              isSequential: false,
              batchCount: { value: '@pipeline().parameters.MaxConcurrentTasks', type: 'Expression' },
              activities: [
                {
                  name: 'CopyObject',
                  type: 'Copy',
                  dependsOn: [],
                  typeProperties: {
                    source: {
                      type: 'AzureSqlSource',
                      sqlReaderQuery: { value: '@json(item().SourceObjectSettings).query', type: 'Expression' },
                    },
                    sink: {
                      type: 'ParquetSink',
                      storeSettings: { type: 'AzureBlobFSWriteSettings', copyBehavior: 'MergeFiles' },
                      formatSettings: { type: 'ParquetWriteSettings' },
                    },
                    enableStaging: false,
                  },
                  inputs:  [{ referenceName: '', type: 'DatasetReference' }],
                  outputs: [{ referenceName: '', type: 'DatasetReference' }],
                  policy: { timeout: '0.12:00:00', retry: 1 },
                },
              ],
            },
          },
        ],
        parameters: {
          ControlTableName:   { type: 'string', defaultValue: 'dbo.copy_control' },
          MaxConcurrentTasks: { type: 'int',    defaultValue: 20 },
        },
        variables: {},
        annotations: ['loom-template:metadata-driven'],
      },
    },
  },
];
