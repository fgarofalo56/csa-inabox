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
