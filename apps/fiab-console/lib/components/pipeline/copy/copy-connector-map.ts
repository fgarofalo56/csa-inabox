/**
 * Copy activity connector map — translate a dataset's `properties.type` into
 * the ADF Copy `source.type` / `sink.type` the wire format requires, and into
 * a coarse "category" that decides which connector-specific controls the
 * Source/Sink tabs render.
 *
 * Grounded in the ADF Copy-activity schema (api-version 2018-06-01):
 *   https://learn.microsoft.com/azure/data-factory/copy-activity-overview
 *   https://learn.microsoft.com/azure/templates/microsoft.datafactory/2018-06-01/factories/pipelines
 *
 * The Copy `source`/`sink` `type` must agree with the backing connector of the
 * bound dataset (e.g. an `AzureBlob` dataset → `BlobSource` / `BlobSink`). When
 * the user picks a new dataset, the Source/Sink tabs look the type up here and
 * stamp it onto `typeProperties.source.type` / `typeProperties.sink.type` so the
 * payload ADF receives is always valid — no hand-edited JSON for the happy path.
 */

/** Coarse connector family used to pick which extra controls a tab shows. */
export type ConnectorCategory = 'fileBased' | 'sqlBased' | 'other';

export interface ConnectorMapEntry {
  /** Copy `source.type` (undefined when the connector is sink-only). */
  source?: string;
  /** Copy `sink.type` (undefined when the connector is source-only). */
  sink?: string;
  category: ConnectorCategory;
}

/**
 * Dataset `properties.type` → Copy source/sink type + category.
 * Covers the connectors the Manage-hub dataset picker commonly surfaces.
 * Unlisted dataset types fall through to `resolveConnector()`'s heuristics
 * (and ultimately preserve whatever source/sink type already exists).
 */
export const CONNECTOR_MAP: Record<string, ConnectorMapEntry> = {
  // ── File / object stores ───────────────────────────────────────────────
  AzureBlob:                 { source: 'BlobSource',                 sink: 'BlobSink',                 category: 'fileBased' },
  AzureBlobFSFile:           { source: 'AzureBlobFSSource',          sink: 'AzureBlobFSSink',          category: 'fileBased' },
  AzureDataLakeStoreFile:    { source: 'AzureDataLakeStoreSource',   sink: 'AzureDataLakeStoreSink',   category: 'fileBased' },
  DelimitedText:             { source: 'DelimitedTextSource',        sink: 'DelimitedTextSink',        category: 'fileBased' },
  Parquet:                   { source: 'ParquetSource',              sink: 'ParquetSink',              category: 'fileBased' },
  Json:                      { source: 'JsonSource',                 sink: 'JsonSink',                 category: 'fileBased' },
  Orc:                       { source: 'OrcSource',                  sink: 'OrcSink',                  category: 'fileBased' },
  Avro:                      { source: 'AvroSource',                 sink: 'AvroSink',                 category: 'fileBased' },
  Binary:                    { source: 'BinarySource',               sink: 'BinarySink',               category: 'fileBased' },
  FileShare:                 { source: 'FileSystemSource',           sink: 'FileSystemSink',           category: 'fileBased' },
  SftpFile:                  { source: 'SftpReadSettings',           sink: undefined,                  category: 'fileBased' },

  // ── SQL family ─────────────────────────────────────────────────────────
  AzureSqlTable:             { source: 'AzureSqlSource',             sink: 'AzureSqlSink',             category: 'sqlBased' },
  AzureSqlDWTable:           { source: 'SqlDWSource',                sink: 'SqlDWSink',                category: 'sqlBased' },
  AzureSqlMITable:           { source: 'AzureSqlMISource',           sink: 'AzureSqlMISink',           category: 'sqlBased' },
  SqlServerTable:            { source: 'SqlServerSource',            sink: 'SqlServerSink',            category: 'sqlBased' },
  OracleTable:               { source: 'OracleSource',               sink: 'OracleSink',               category: 'sqlBased' },
  PostgreSqlV2Table:         { source: 'PostgreSqlV2Source',         sink: undefined,                  category: 'sqlBased' },
  MySqlTable:                { source: 'MySqlSource',                sink: undefined,                  category: 'sqlBased' },

  // ── NoSQL / API / other ────────────────────────────────────────────────
  AzureTableDataset:         { source: 'AzureTableSource',           sink: 'AzureTableSink',           category: 'other' },
  CosmosDbSqlApiCollection:  { source: 'CosmosDbSqlApiSource',       sink: 'CosmosDbSqlApiSink',       category: 'other' },
  CosmosDbMongoDbApiCollection: { source: 'CosmosDbMongoDbApiSource', sink: 'CosmosDbMongoDbApiSink',  category: 'other' },
  RestResource:              { source: 'RestSource',                 sink: 'RestSink',                 category: 'other' },
  HttpFile:                  { source: 'HttpSource',                 sink: undefined,                  category: 'other' },
};

/**
 * Resolve a dataset type to its Copy connector entry. Falls back to substring
 * heuristics so newly-added connectors still land in the right category, and
 * finally to `other` (which renders only connector-agnostic controls + the
 * Advanced JSON escape hatch — nothing is ever blocked).
 */
export function resolveConnector(datasetType: string | undefined): ConnectorMapEntry {
  if (!datasetType) return { category: 'other' };
  const exact = CONNECTOR_MAP[datasetType];
  if (exact) return exact;
  const t = datasetType.toLowerCase();
  if (/(blob|adls|datalake|file|sftp|ftp|parquet|delimited|avro|orc|json|binary)/.test(t)) {
    return { category: 'fileBased' };
  }
  if (/(sql|synapse|oracle|postgres|mysql|teradata|db2|warehouse)/.test(t)) {
    return { category: 'sqlBased' };
  }
  return { category: 'other' };
}

/** Connector family the *current* source/sink type belongs to (for re-render). */
export function categoryOfCopyType(copyType: string | undefined): ConnectorCategory {
  if (!copyType) return 'other';
  const t = copyType.toLowerCase();
  if (/(blob|adls|datalake|filesystem|sftp|ftp|parquet|delimited|avro|orc|json|binary)/.test(t)) {
    return 'fileBased';
  }
  if (/(sql|dw|oracle|postgres|mysql|teradata|db2)/.test(t)) return 'sqlBased';
  return 'other';
}
