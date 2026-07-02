/**
 * copy-activity-catalog — the data-driven inventory of ADF / Synapse Copy
 * activity SOURCE, SINK, format, and activity-level "Settings" metadata.
 *
 * WHY THIS EXISTS
 * ---------------
 * A Copy activity (`Microsoft.DataFactory/factories/pipelines` →
 * `activities[].type === 'Copy'`, api 2018-06-01) carries a
 * `typeProperties.source` and `typeProperties.sink`, each of whose `type` is a
 * connector-specific Copy type (e.g. `AzureSqlSource` / `AzureSqlSink`,
 * `DelimitedTextSource` / `DelimitedTextSink`, `RestSource` / `RestSink`,
 * `CosmosDbSqlApiSource` / `CosmosDbSqlApiSink`) and whose remaining keys are the
 * per-store read / write settings the real Azure backend honors. Above those,
 * the activity itself carries performance / staging / fault-tolerance / logging
 * / preserve settings.
 *
 * The connector-catalog (`./connector-catalog.ts`) describes the LINKED SERVICE
 * + DATASET side (how to connect + where the data lives). THIS file describes
 * the COPY side (how the Copy activity reads from / writes to that store). The
 * two compose: `connector-catalog` → `ConnectorDef.datasetTypes[].type`
 * (dataset `properties.type`) maps here to a Copy source/sink `typeName` + the
 * fields that source/sink accepts.
 *
 * The Loom Copy editor renders STRUCTURED FORMS from this catalog — never a
 * freeform JSON textarea (per loom-no-freeform-config). Each `ConfigField`'s
 * `key` is the EXACT `typeProperties.source` / `.sink` / `.formatSettings` /
 * `.storeSettings` key from the ADF Copy-activity + per-store connector docs,
 * so the editor assembles a payload the real ARM REST PUT accepts (via
 * `lib/azure/adf-client.ts` / `lib/azure/synapse-artifacts-client.ts`). No
 * mocks (per no-vaporware.md).
 *
 * Grounded in Microsoft Learn:
 *   - Copy activity overview + configuration / performance features:
 *       https://learn.microsoft.com/azure/data-factory/copy-activity-overview
 *       https://learn.microsoft.com/azure/data-factory/copy-activity-performance-features
 *       https://learn.microsoft.com/azure/data-factory/copy-activity-fault-tolerance
 *       https://learn.microsoft.com/azure/data-factory/copy-activity-log
 *       https://learn.microsoft.com/azure/data-factory/copy-activity-preserve-metadata
 *   - per-store "Copy activity properties" pages:
 *       /connector-azure-sql-database, /connector-azure-data-lake-storage,
 *       /format-delimited-text, /format-parquet, /format-json,
 *       /connector-rest, /connector-azure-cosmos-db, …
 *   - ARM Copy-activity schema:
 *       https://learn.microsoft.com/azure/templates/microsoft.datafactory/2018-06-01/factories/pipelines
 *
 * EXTENSIBILITY
 * -------------
 * Like the connector-catalog, adding a store's source/sink is pure data: copy
 * its "Copy activity properties" rows from Learn into a new `CopySettingsDef`
 * keyed by the linked-service `type`. The form renderer, BFF route, and ARM
 * client are all connector-agnostic.
 */

import type { ConfigField, ConnectorDef } from './connector-catalog';
import { CONNECTORS, connectorByType } from './connector-catalog';

// =============================================================================
// Shared contract.
// =============================================================================

/**
 * Coarse Copy family — drives the generic fallback when a connector type has no
 * dedicated `CopySettingsDef`, and lets the editor group controls sensibly.
 */
export type CopyFamily = 'file' | 'tabular' | 'nosql' | 'rest';

/**
 * One side (source or sink) of a connector's Copy settings.
 *
 *  - `typeName`     the exact `typeProperties.source.type` / `.sink.type`
 *                   (e.g. 'AzureSqlSource', 'DelimitedTextSink', 'RestSource').
 *  - `family`       coarse family for grouping + fallback selection.
 *  - `fields`       connector-specific source/sink keys (verbatim from Learn).
 *  - `storeSettings`  file-store read/write settings (`storeSettings.*`) —
 *                   only on file-based stores.
 *  - `formatSettings` format read/write settings (`formatSettings.*`) — keyed by
 *                   dataset format on file-based stores (DelimitedText/…).
 */
export interface CopySideDef {
  typeName: string;
  family: CopyFamily;
  fields: ConfigField[];
  /** File-store read/write settings (`storeSettings.*`); file family only. */
  storeSettings?: ConfigField[];
}

/** A connector's full Copy metadata (source + sink, either may be absent). */
export interface CopySettingsDef {
  /** Linked-service `type` this maps to (e.g. 'AzureSqlDatabase'). */
  connectorType: string;
  source?: CopySideDef;
  sink?: CopySideDef;
}

// =============================================================================
// Reusable field fragments (DRY; every key verbatim from the Copy docs).
// =============================================================================

const MAX_CONCURRENT_CONNECTIONS: ConfigField = {
  key: 'maxConcurrentConnections',
  label: 'Max concurrent connections',
  kind: 'number',
  hint: 'Upper limit of concurrent connections to the store during the run. Blank = unlimited.',
};

const SQL_ISOLATION_LEVEL: ConfigField = {
  key: 'isolationLevel',
  label: 'Isolation level',
  kind: 'select',
  hint: 'Transaction locking behavior. Blank uses the database default.',
  options: [
    { value: '', label: '(database default)' },
    { value: 'ReadCommitted', label: 'ReadCommitted' },
    { value: 'ReadUncommitted', label: 'ReadUncommitted' },
    { value: 'RepeatableRead', label: 'RepeatableRead' },
    { value: 'Serializable', label: 'Serializable' },
    { value: 'Snapshot', label: 'Snapshot' },
  ],
};

const SQL_PARTITION_OPTION: ConfigField = {
  key: 'partitionOption',
  label: 'Partition option',
  kind: 'select',
  hint: 'Parallel-read partitioning. With a partition option the parallelism is the activity’s degree-of-copy-parallelism.',
  options: [
    { value: 'None', label: 'None (default)' },
    { value: 'PhysicalPartitionsOfTable', label: 'Physical partitions of table' },
    { value: 'DynamicRange', label: 'Dynamic range' },
  ],
};

/** partitionSettings.* — only relevant when partitionOption = DynamicRange. */
const SQL_PARTITION_SETTINGS: ConfigField[] = [
  {
    key: 'partitionColumnName',
    label: 'Partition column',
    kind: 'text',
    hint: 'Integer / date/datetime column used for range partitioning. Auto-detected from index/PK if blank.',
    showIf: { key: 'partitionOption', equals: 'DynamicRange' },
    supportsDynamic: true,
  },
  {
    key: 'partitionUpperBound',
    label: 'Partition upper bound',
    kind: 'text',
    hint: 'Max partition-column value for stride calculation (not a row filter). Auto-detected if blank.',
    showIf: { key: 'partitionOption', equals: 'DynamicRange' },
    supportsDynamic: true,
  },
  {
    key: 'partitionLowerBound',
    label: 'Partition lower bound',
    kind: 'text',
    hint: 'Min partition-column value for stride calculation (not a row filter). Auto-detected if blank.',
    showIf: { key: 'partitionOption', equals: 'DynamicRange' },
    supportsDynamic: true,
  },
];

/** Shared SQL-family source fields (AzureSqlSource / SqlDWSource / …). */
function sqlSourceFields(): ConfigField[] {
  return [
    {
      key: 'sqlReaderQuery',
      label: 'Query',
      kind: 'multiline',
      hint: 'Custom SQL to read data. Blank reads the whole bound table.',
      placeholder: 'SELECT * FROM dbo.Orders WHERE Modified >= @{pipeline().parameters.since}',
      supportsDynamic: true,
    },
    {
      key: 'sqlReaderStoredProcedureName',
      label: 'Stored procedure name',
      kind: 'text',
      hint: 'Stored procedure whose final statement is a SELECT. Mutually exclusive with Query.',
      supportsDynamic: true,
    },
    {
      key: 'queryTimeout',
      label: 'Query timeout (HH:MM:SS)',
      kind: 'text',
      placeholder: '02:00:00',
      hint: 'Wait time for the query to complete.',
    },
    SQL_ISOLATION_LEVEL,
    SQL_PARTITION_OPTION,
    ...SQL_PARTITION_SETTINGS,
    MAX_CONCURRENT_CONNECTIONS,
  ];
}

/** Shared SQL-family sink fields (AzureSqlSink / SqlDWSink / …). */
function sqlSinkFields(): ConfigField[] {
  return [
    {
      key: 'writeBehavior',
      label: 'Write behavior',
      kind: 'select',
      hint: 'Insert appends rows; Upsert merges on the key columns below.',
      options: [
        { value: 'Insert', label: 'Insert (default)' },
        { value: 'Upsert', label: 'Upsert' },
      ],
    },
    {
      key: 'preCopyScript',
      label: 'Pre-copy script',
      kind: 'multiline',
      hint: 'SQL run once before the copy (e.g. TRUNCATE TABLE). Use for delete/truncate, not row logic.',
      placeholder: 'TRUNCATE TABLE dbo.Staging',
      supportsDynamic: true,
    },
    {
      key: 'tableOption',
      label: 'Table option',
      kind: 'select',
      hint: 'Auto-create the sink table from the source schema if it does not exist. Not supported with a writer stored procedure.',
      options: [
        { value: 'none', label: 'None (default)' },
        { value: 'autoCreate', label: 'Auto create table' },
      ],
    },
    {
      key: 'sqlWriterStoredProcedureName',
      label: 'Writer stored procedure',
      kind: 'text',
      hint: 'Stored procedure invoked per batch to apply source data into the target.',
      supportsDynamic: true,
    },
    {
      key: 'sqlWriterTableType',
      label: 'Writer table type',
      kind: 'text',
      hint: 'Table type the writer stored procedure consumes (the staged rows are exposed as this type).',
      supportsDynamic: true,
    },
    {
      key: 'storedProcedureTableTypeParameterName',
      label: 'Table-type parameter name',
      kind: 'text',
      hint: 'Name of the table-type parameter in the writer stored procedure.',
      supportsDynamic: true,
    },
    {
      key: 'writeBatchSize',
      label: 'Write batch size (rows)',
      kind: 'number',
      hint: 'Rows per insert batch. Blank lets the service size batches by row width.',
    },
    {
      key: 'writeBatchTimeout',
      label: 'Write batch timeout (HH:MM:SS)',
      kind: 'text',
      placeholder: '00:30:00',
      hint: 'Wait time for the insert / upsert / stored-procedure operation.',
    },
    {
      key: 'disableMetricsCollection',
      label: 'Disable metrics collection',
      kind: 'boolean',
      hint: 'Skip DTU/RU metric collection (avoids extra master-DB access).',
    },
    MAX_CONCURRENT_CONNECTIONS,
  ];
}

// =============================================================================
// File-store read / write settings (storeSettings.*) — verbatim from the
// per-connector "format-based copy source / sink" tables. The `type` of
// storeSettings is connector-specific (AzureBlobFSReadSettings,
// AzureBlobStorageReadSettings, AmazonS3ReadSettings, SftpReadSettings, …); the
// editor stamps the right `*ReadSettings` / `*WriteSettings` type for the bound
// connector. These FIELDS are common across the file connectors.
// =============================================================================

const FILE_READ_STORE_SETTINGS: ConfigField[] = [
  {
    key: 'recursive',
    label: 'Recursive',
    kind: 'boolean',
    hint: 'Read all sub-folders under the dataset path (default true). Ignored when a file-list path is set.',
  },
  {
    key: 'wildcardFolderPath',
    label: 'Wildcard folder path',
    kind: 'text',
    hint: 'Folder filter with * (zero-or-more) / ? (single) wildcards. e.g. data/2026/*',
    supportsDynamic: true,
  },
  {
    key: 'wildcardFileName',
    label: 'Wildcard file name',
    kind: 'text',
    hint: 'File filter with * / ? wildcards. e.g. *.csv. Required when using the wildcard option.',
    supportsDynamic: true,
  },
  {
    key: 'fileListPath',
    label: 'File list path',
    kind: 'text',
    hint: 'Path to a text file listing the files to copy (one relative path per line). Do not also set a file name in the dataset.',
    supportsDynamic: true,
  },
  {
    key: 'modifiedDatetimeStart',
    label: 'Modified after (UTC)',
    kind: 'text',
    placeholder: '2026-01-01T00:00:00Z',
    hint: 'Select files whose last-modified time is >= this. Ignored when a file-list path is set.',
    supportsDynamic: true,
  },
  {
    key: 'modifiedDatetimeEnd',
    label: 'Modified before (UTC)',
    kind: 'text',
    placeholder: '2026-12-31T00:00:00Z',
    hint: 'Select files whose last-modified time is < this.',
    supportsDynamic: true,
  },
  {
    key: 'enablePartitionDiscovery',
    label: 'Enable partition discovery',
    kind: 'boolean',
    hint: 'Parse Hive-style partition folders (year=…/month=…) into extra source columns.',
  },
  {
    key: 'partitionRootPath',
    label: 'Partition root path',
    kind: 'text',
    hint: 'Absolute root used to derive partition columns when partition discovery is on.',
    showIf: { key: 'enablePartitionDiscovery', equals: 'true' },
    supportsDynamic: true,
  },
  {
    key: 'deleteFilesAfterCompletion',
    label: 'Delete files after completion',
    kind: 'boolean',
    hint: 'Delete each source file after it copies successfully (binary copy only). Effectively a move.',
  },
  MAX_CONCURRENT_CONNECTIONS,
];

const FILE_WRITE_STORE_SETTINGS: ConfigField[] = [
  {
    key: 'copyBehavior',
    label: 'Copy behavior',
    kind: 'select',
    hint: 'How source files/folders map onto the sink folder.',
    options: [
      { value: '', label: '(default — Preserve hierarchy)' },
      { value: 'PreserveHierarchy', label: 'Preserve hierarchy' },
      { value: 'FlattenHierarchy', label: 'Flatten hierarchy' },
      { value: 'MergeFiles', label: 'Merge files' },
    ],
  },
  {
    key: 'blockSizeInMB',
    label: 'Block size (MB)',
    kind: 'number',
    hint: 'Write block size, 4–100 MB. Blank lets the service choose (100 MB for non-binary into ADLS Gen2).',
  },
  MAX_CONCURRENT_CONNECTIONS,
];

// =============================================================================
// Format read / write settings (formatSettings.*) — keyed by dataset format
// type. The Copy editor reads the bound dataset's `properties.type` and renders
// the matching format settings on top of the storeSettings.
// =============================================================================

export interface FormatSettingsDef {
  /** Dataset format `type` (e.g. 'DelimitedText','Parquet','Json'). */
  format: string;
  /** `formatSettings.type` on source (e.g. 'DelimitedTextReadSettings'). */
  readType: string;
  /** `formatSettings.type` on sink (e.g. 'DelimitedTextWriteSettings'). */
  writeType: string;
  readFields: ConfigField[];
  writeFields: ConfigField[];
}

export const COPY_FORMAT_SETTINGS: Record<string, FormatSettingsDef> = {
  DelimitedText: {
    format: 'DelimitedText',
    readType: 'DelimitedTextReadSettings',
    writeType: 'DelimitedTextWriteSettings',
    readFields: [
      {
        key: 'skipLineCount',
        label: 'Skip line count',
        kind: 'number',
        hint: 'Number of non-empty rows to skip before reading (applied before the header row).',
      },
    ],
    writeFields: [
      {
        key: 'fileExtension',
        label: 'File extension',
        kind: 'text',
        placeholder: '.csv',
        hint: 'Extension for auto-named output files. Required when the output dataset has no file name.',
      },
      {
        key: 'maxRowsPerFile',
        label: 'Max rows per file',
        kind: 'number',
        hint: 'Split the write into multiple files of at most this many rows.',
      },
      {
        key: 'fileNamePrefix',
        label: 'File name prefix',
        kind: 'text',
        hint: 'Prefix for multi-file output (<prefix>_00000.<ext>). Applies when max rows per file is set.',
        showIf: { key: 'maxRowsPerFile', equals: '' },
      },
    ],
  },
  Json: {
    format: 'Json',
    readType: 'JsonReadSettings',
    writeType: 'JsonWriteSettings',
    readFields: [
      {
        key: 'compressionProperties',
        label: 'Decompress nested zip name as folder',
        kind: 'boolean',
        hint: 'Preserve the source compressed file name as a folder when decompressing.',
      },
    ],
    writeFields: [
      {
        key: 'filePattern',
        label: 'File pattern',
        kind: 'select',
        hint: 'How JSON rows are laid out in each output file.',
        options: [
          { value: '', label: '(default)' },
          { value: 'setOfObjects', label: 'Set of objects (one per line)' },
          { value: 'arrayOfObjects', label: 'Array of objects' },
        ],
      },
    ],
  },
  Parquet: {
    format: 'Parquet',
    readType: 'ParquetReadSettings',
    writeType: 'ParquetWriteSettings',
    readFields: [],
    writeFields: [
      {
        key: 'maxRowsPerFile',
        label: 'Max rows per file',
        kind: 'number',
        hint: 'Split the write into multiple files of at most this many rows.',
      },
      {
        key: 'fileNamePrefix',
        label: 'File name prefix',
        kind: 'text',
        hint: 'Prefix for multi-file output. Applies when max rows per file is set.',
        showIf: { key: 'maxRowsPerFile', equals: '' },
      },
    ],
  },
  Orc: { format: 'Orc', readType: 'OrcReadSettings', writeType: 'OrcWriteSettings', readFields: [], writeFields: [] },
  Avro: { format: 'Avro', readType: 'AvroReadSettings', writeType: 'AvroWriteSettings', readFields: [], writeFields: [] },
  Binary: { format: 'Binary', readType: 'BinaryReadSettings', writeType: 'BinaryWriteSettings', readFields: [], writeFields: [] },
};

/** Look up the format settings for a dataset format `type`. */
export function copyFormatSettingsFor(format: string | undefined): FormatSettingsDef | undefined {
  return format ? COPY_FORMAT_SETTINGS[format] : undefined;
}

// =============================================================================
// Generic fallbacks (file / tabular / nosql / rest) — used when a connector has
// no dedicated entry so the editor NEVER renders a blank surface (no-vaporware).
// =============================================================================

/** A generic file source/sink (covers any DelimitedText/Parquet/Json/… store). */
const GENERIC_FILE: CopySettingsDef = {
  connectorType: '__file__',
  source: {
    typeName: 'DelimitedTextSource',
    family: 'file',
    fields: [],
    storeSettings: FILE_READ_STORE_SETTINGS,
  },
  sink: {
    typeName: 'DelimitedTextSink',
    family: 'file',
    fields: [],
    storeSettings: FILE_WRITE_STORE_SETTINGS,
  },
};

/** A generic tabular (SQL-family) source/sink. */
const GENERIC_TABULAR: CopySettingsDef = {
  connectorType: '__tabular__',
  source: { typeName: 'SqlSource', family: 'tabular', fields: sqlSourceFields() },
  sink: { typeName: 'SqlSink', family: 'tabular', fields: sqlSinkFields() },
};

/** A generic NoSQL/document source/sink. */
const GENERIC_NOSQL: CopySettingsDef = {
  connectorType: '__nosql__',
  source: {
    typeName: 'CosmosDbSqlApiSource',
    family: 'nosql',
    fields: [
      {
        key: 'query',
        label: 'Query',
        kind: 'multiline',
        hint: 'Document query to read. Blank reads all documents in the collection.',
        placeholder: 'SELECT * FROM c WHERE c.modified > "2026-01-01T00:00:00"',
        supportsDynamic: true,
      },
      { key: 'pageSize', label: 'Page size', kind: 'number', hint: 'Documents per result page. -1 (default) lets the service choose, up to 1000.' },
      MAX_CONCURRENT_CONNECTIONS,
    ],
  },
  sink: {
    typeName: 'CosmosDbSqlApiSink',
    family: 'nosql',
    fields: [
      {
        key: 'writeBehavior',
        label: 'Write behavior',
        kind: 'select',
        hint: 'Insert appends; Upsert replaces a document with the same id (id required for upsert).',
        options: [
          { value: 'insert', label: 'Insert (default)' },
          { value: 'upsert', label: 'Upsert' },
        ],
      },
      { key: 'writeBatchSize', label: 'Write batch size', kind: 'number', hint: 'Documents per bulk write. Default 10000; reduce for large documents (2 MB request cap).' },
      { key: 'disableMetricsCollection', label: 'Disable metrics collection', kind: 'boolean', hint: 'Skip RU metric collection.' },
      MAX_CONCURRENT_CONNECTIONS,
    ],
  },
};

/** A generic REST/HTTP source/sink. */
const GENERIC_REST: CopySettingsDef = {
  connectorType: '__rest__',
  source: {
    typeName: 'RestSource',
    family: 'rest',
    fields: [
      {
        key: 'requestMethod',
        label: 'Request method',
        kind: 'select',
        hint: 'HTTP verb used to read.',
        options: [
          { value: 'GET', label: 'GET (default)' },
          { value: 'POST', label: 'POST' },
        ],
      },
      { key: 'requestBody', label: 'Request body', kind: 'multiline', hint: 'Body for a POST read request.', supportsDynamic: true },
      {
        key: 'paginationRules',
        label: 'Pagination rules',
        kind: 'multiline',
        hint: 'Key:value rules to compose next-page requests, e.g. AbsoluteUrl = $.paging.next. (JSON object of rules.)',
        placeholder: '{ "AbsoluteUrl": "$.paging.next" }',
      },
      { key: 'httpRequestTimeout', label: 'HTTP request timeout (HH:MM:SS)', kind: 'text', placeholder: '00:01:40', hint: 'Time-out to get a response (not to read data).' },
      { key: 'requestInterval', label: 'Request interval', kind: 'text', placeholder: '00:00:01', hint: 'Wait before the next page request.' },
      MAX_CONCURRENT_CONNECTIONS,
    ],
  },
  sink: {
    typeName: 'RestSink',
    family: 'rest',
    fields: [
      {
        key: 'requestMethod',
        label: 'Request method',
        kind: 'select',
        hint: 'HTTP verb used to write.',
        options: [
          { value: 'POST', label: 'POST (default)' },
          { value: 'PUT', label: 'PUT' },
          { value: 'PATCH', label: 'PATCH' },
        ],
      },
      { key: 'httpRequestTimeout', label: 'HTTP request timeout (HH:MM:SS)', kind: 'text', placeholder: '00:01:40', hint: 'Time-out to get a response.' },
      { key: 'requestInterval', label: 'Request interval (ms)', kind: 'number', hint: 'Interval between requests, 10–60000 ms.' },
      {
        key: 'httpCompressionType',
        label: 'HTTP compression',
        kind: 'select',
        hint: 'Compression applied when sending data.',
        options: [
          { value: 'none', label: 'None (default)' },
          { value: 'gzip', label: 'gzip' },
        ],
      },
      { key: 'writeBatchSize', label: 'Write batch size', kind: 'number', hint: 'Records per batch. Default 10000.' },
      MAX_CONCURRENT_CONNECTIONS,
    ],
  },
};

/** The four generic fallbacks, addressable by family. */
export const COPY_GENERIC_BY_FAMILY: Record<CopyFamily, CopySettingsDef> = {
  file: GENERIC_FILE,
  tabular: GENERIC_TABULAR,
  nosql: GENERIC_NOSQL,
  rest: GENERIC_REST,
};

// =============================================================================
// Per-connector Copy settings (keyed by linked-service `type`).
// =============================================================================

/** Build a SQL-family entry with the right `*Source`/`*Sink` type names. */
function sqlEntry(connectorType: string, sourceType: string, sinkType: string, sinkSupported = true): CopySettingsDef {
  return {
    connectorType,
    source: { typeName: sourceType, family: 'tabular', fields: sqlSourceFields() },
    ...(sinkSupported ? { sink: { typeName: sinkType, family: 'tabular', fields: sqlSinkFields() } } : {}),
  };
}

/** Build a file-family entry with the right `*Source`/`*Sink` type names. */
function fileEntry(connectorType: string, sourceType: string, sinkType: string, sinkSupported = true): CopySettingsDef {
  return {
    connectorType,
    source: { typeName: sourceType, family: 'file', fields: [], storeSettings: FILE_READ_STORE_SETTINGS },
    ...(sinkSupported
      ? { sink: { typeName: sinkType, family: 'file', fields: [], storeSettings: FILE_WRITE_STORE_SETTINGS } }
      : {}),
  };
}

/**
 * COPY_SOURCE_SETTINGS / COPY_SINK_SETTINGS are derived from this single keyed
 * table so the two exports never drift. Key = linked-service `type` from the
 * connector-catalog.
 */
const COPY_SETTINGS_TABLE: Record<string, CopySettingsDef> = {
  // ── Azure SQL family ─────────────────────────────────────────────────────
  AzureSqlDatabase: sqlEntry('AzureSqlDatabase', 'AzureSqlSource', 'AzureSqlSink'),
  AzureSqlMI: sqlEntry('AzureSqlMI', 'AzureSqlMISource', 'AzureSqlMISink'),
  AzureSqlDW: sqlEntry('AzureSqlDW', 'SqlDWSource', 'SqlDWSink'),
  SqlServer: sqlEntry('SqlServer', 'SqlServerSource', 'SqlServerSink'),
  Oracle: sqlEntry('Oracle', 'OracleSource', 'OracleSink'),
  AmazonRedshift: sqlEntry('AmazonRedshift', 'AmazonRedshiftSource', '', false),
  PostgreSql: sqlEntry('PostgreSql', 'PostgreSqlSource', '', false),
  AzurePostgreSql: sqlEntry('AzurePostgreSql', 'AzurePostgreSqlSource', 'AzurePostgreSqlSink'),
  MySql: sqlEntry('MySql', 'MySqlSource', '', false),
  AzureMySql: sqlEntry('AzureMySql', 'AzureMySqlSource', 'AzureMySqlSink'),
  Teradata: sqlEntry('Teradata', 'TeradataSource', '', false),
  SapHana: sqlEntry('SapHana', 'SapHanaSource', '', false),
  Snowflake: {
    connectorType: 'Snowflake',
    // Snowflake V2 copy is import/export via staged files; it still exposes a
    // query on source and import settings on sink, plus the SQL-family knobs.
    source: {
      typeName: 'SnowflakeV2Source',
      family: 'tabular',
      fields: [
        { key: 'query', label: 'Query', kind: 'multiline', hint: 'SQL to read from Snowflake. Blank reads the whole table.', placeholder: 'SELECT * FROM PUBLIC.ORDERS', supportsDynamic: true },
        MAX_CONCURRENT_CONNECTIONS,
      ],
    },
    sink: {
      typeName: 'SnowflakeV2Sink',
      family: 'tabular',
      fields: [
        { key: 'preCopyScript', label: 'Pre-copy script', kind: 'multiline', hint: 'SQL run once before the copy.', supportsDynamic: true },
        MAX_CONCURRENT_CONNECTIONS,
      ],
    },
  },
  GoogleBigQueryV2: {
    connectorType: 'GoogleBigQueryV2',
    source: {
      typeName: 'GoogleBigQueryV2Source',
      family: 'tabular',
      fields: [
        { key: 'query', label: 'Query', kind: 'multiline', hint: 'BigQuery SQL to read. Blank reads the whole object.', supportsDynamic: true },
        MAX_CONCURRENT_CONNECTIONS,
      ],
    },
  },
  AzureDataExplorer: {
    connectorType: 'AzureDataExplorer',
    source: {
      typeName: 'AzureDataExplorerSource',
      family: 'tabular',
      fields: [
        { key: 'query', label: 'KQL query', kind: 'multiline', required: true, hint: 'Kusto query to read data.', placeholder: 'Events | where Timestamp > ago(1d)', supportsDynamic: true },
        { key: 'queryTimeout', label: 'Query timeout (HH:MM:SS)', kind: 'text', placeholder: '00:10:00' },
        { key: 'noTruncation', label: 'No truncation', kind: 'boolean', hint: 'Disable Kusto result-set truncation limits.' },
      ],
    },
    sink: {
      typeName: 'AzureDataExplorerSink',
      family: 'tabular',
      fields: [
        { key: 'ingestionMappingName', label: 'Ingestion mapping name', kind: 'text', hint: 'Pre-created Kusto ingestion mapping to use.', supportsDynamic: true },
        { key: 'ingestionMappingAsJson', label: 'Ingestion mapping (inline JSON)', kind: 'multiline', hint: 'Explicit column mapping when no named mapping exists.' },
        { key: 'flushImmediately', label: 'Flush immediately', kind: 'boolean', hint: 'Skip aggregation; flush each batch immediately.' },
      ],
    },
  },
  AzureDatabricksDeltaLake: {
    connectorType: 'AzureDatabricksDeltaLake',
    source: {
      typeName: 'AzureDatabricksDeltaLakeSource',
      family: 'tabular',
      fields: [
        { key: 'query', label: 'Query', kind: 'multiline', hint: 'Spark SQL to read from the Delta table. Blank reads the whole table.', supportsDynamic: true },
      ],
    },
    sink: {
      typeName: 'AzureDatabricksDeltaLakeSink',
      family: 'tabular',
      fields: [
        { key: 'preCopyScript', label: 'Pre-copy script', kind: 'multiline', hint: 'Spark SQL run once before the copy.', supportsDynamic: true },
      ],
    },
  },

  // ── Azure storage / file stores ──────────────────────────────────────────
  AzureBlobFS: fileEntry('AzureBlobFS', 'DelimitedTextSource', 'DelimitedTextSink'),
  AzureBlobStorage: fileEntry('AzureBlobStorage', 'DelimitedTextSource', 'DelimitedTextSink'),
  AzureFileStorage: fileEntry('AzureFileStorage', 'DelimitedTextSource', 'DelimitedTextSink'),
  AmazonS3: fileEntry('AmazonS3', 'DelimitedTextSource', '', false),
  FileServer: fileEntry('FileServer', 'DelimitedTextSource', 'DelimitedTextSink'),
  Ftp: fileEntry('Ftp', 'DelimitedTextSource', '', false),
  Sftp: fileEntry('Sftp', 'DelimitedTextSource', 'DelimitedTextSink'),
  HttpServer: fileEntry('HttpServer', 'DelimitedTextSource', '', false),

  // ── NoSQL / document ───────────────────────────────────────────────────────
  CosmosDb: {
    connectorType: 'CosmosDb',
    source: GENERIC_NOSQL.source,
    sink: GENERIC_NOSQL.sink,
  },
  CosmosDbMongoDbApi: {
    connectorType: 'CosmosDbMongoDbApi',
    source: {
      typeName: 'CosmosDbMongoDbApiSource',
      family: 'nosql',
      fields: [
        { key: 'filter', label: 'Filter', kind: 'multiline', hint: 'Mongo query filter (JSON). Blank reads all documents.', placeholder: '{ "status": "active" }' },
        { key: 'batchSize', label: 'Batch size', kind: 'number', hint: 'Documents returned per server round-trip. Default 100.' },
        MAX_CONCURRENT_CONNECTIONS,
      ],
    },
    sink: {
      typeName: 'CosmosDbMongoDbApiSink',
      family: 'nosql',
      fields: [
        {
          key: 'writeBehavior',
          label: 'Write behavior',
          kind: 'select',
          hint: 'Insert appends; Upsert replaces a document with the same _id.',
          options: [
            { value: 'insert', label: 'Insert (default)' },
            { value: 'upsert', label: 'Upsert' },
          ],
        },
        { key: 'writeBatchSize', label: 'Write batch size', kind: 'number', hint: 'Documents per bulk write. Default 10000.' },
        MAX_CONCURRENT_CONNECTIONS,
      ],
    },
  },

  // ── REST / OData ───────────────────────────────────────────────────────────
  RestService: { connectorType: 'RestService', source: GENERIC_REST.source, sink: GENERIC_REST.sink },
  OData: {
    connectorType: 'OData',
    source: {
      typeName: 'ODataSource',
      family: 'rest',
      fields: [
        { key: 'query', label: 'OData query options', kind: 'text', hint: 'OData system query options, e.g. $select=Name,Id&$filter=Revenue gt 5000000', supportsDynamic: true },
        { key: 'httpRequestTimeout', label: 'HTTP request timeout (HH:MM:SS)', kind: 'text', placeholder: '00:05:00' },
        MAX_CONCURRENT_CONNECTIONS,
      ],
    },
  },

  // ── Services & apps ──────────────────────────────────────────────────────
  Salesforce: {
    connectorType: 'Salesforce',
    source: {
      typeName: 'SalesforceV2Source',
      family: 'tabular',
      fields: [
        { key: 'SOQLQuery', label: 'SOQL query', kind: 'multiline', hint: 'Salesforce SOQL to read. Blank reads the whole object.', placeholder: 'SELECT Id, Name FROM Account', supportsDynamic: true },
        { key: 'includeDeletedObjects', label: 'Include deleted/archived', kind: 'boolean', hint: 'Query deleted and archived records (queryAll).' },
        MAX_CONCURRENT_CONNECTIONS,
      ],
    },
    sink: {
      typeName: 'SalesforceV2Sink',
      family: 'tabular',
      fields: [
        {
          key: 'writeBehavior',
          label: 'Write behavior',
          kind: 'select',
          hint: 'Insert appends; Upsert merges on the external-id field below.',
          options: [
            { value: 'Insert', label: 'Insert (default)' },
            { value: 'Upsert', label: 'Upsert' },
          ],
        },
        { key: 'externalIdFieldName', label: 'External-id field', kind: 'text', hint: 'External-id field used to match records on upsert.', showIf: { key: 'writeBehavior', equals: 'Upsert' }, supportsDynamic: true },
        { key: 'ignoreNullValues', label: 'Ignore null values', kind: 'boolean', hint: 'Skip writing null source values (leave target field unchanged).' },
        { key: 'writeBatchSize', label: 'Write batch size', kind: 'number', hint: 'Rows per write batch. Default 5000.' },
        MAX_CONCURRENT_CONNECTIONS,
      ],
    },
  },
  CommonDataServiceForApps: {
    connectorType: 'CommonDataServiceForApps',
    source: {
      typeName: 'CommonDataServiceForAppsSource',
      family: 'tabular',
      fields: [
        { key: 'query', label: 'FetchXML query', kind: 'multiline', hint: 'FetchXML to read from Dataverse. Blank reads the whole entity.', supportsDynamic: true },
        MAX_CONCURRENT_CONNECTIONS,
      ],
    },
    sink: {
      typeName: 'CommonDataServiceForAppsSink',
      family: 'tabular',
      fields: [
        {
          key: 'writeBehavior',
          label: 'Write behavior',
          kind: 'select',
          required: true,
          hint: 'Dataverse upsert (insert-or-update on the alternate/primary key).',
          options: [{ value: 'Upsert', label: 'Upsert' }],
        },
        { key: 'alternateKeyName', label: 'Alternate key name', kind: 'text', hint: 'Alternate-key name used to match rows on upsert.', supportsDynamic: true },
        { key: 'ignoreNullValues', label: 'Ignore null values', kind: 'boolean' },
        { key: 'writeBatchSize', label: 'Write batch size', kind: 'number', hint: 'Rows per batch. Default 10.' },
        MAX_CONCURRENT_CONNECTIONS,
      ],
    },
  },
  SharePointOnlineList: {
    connectorType: 'SharePointOnlineList',
    source: {
      typeName: 'SharePointOnlineListSource',
      family: 'rest',
      fields: [
        { key: 'query', label: 'OData query', kind: 'text', hint: 'OData filter applied to the SharePoint list, e.g. $filter=Title eq ‘Open’', supportsDynamic: true },
        { key: 'httpRequestTimeout', label: 'HTTP request timeout (HH:MM:SS)', kind: 'text', placeholder: '00:05:00' },
      ],
    },
  },
};

// =============================================================================
// Family inference (so even an unmapped connector lands on a sensible fallback).
// =============================================================================

/**
 * Infer a Copy family from a connector's catalog `category` (preferred) or a
 * type-name heuristic. Mirrors the connector-catalog's categories:
 *   azure | database | file | nosql | generic-protocol | services-and-apps
 */
export function familyForConnector(connectorType: string | undefined): CopyFamily {
  const def: ConnectorDef | undefined = connectorByType(connectorType || '');
  if (def) {
    switch (def.category) {
      case 'file':
        return 'file';
      case 'nosql':
        return 'nosql';
      case 'generic-protocol':
        return 'rest';
      case 'database':
        return 'tabular';
      case 'azure': {
        // Azure bucket mixes storage (file) with SQL/ADX/PG (tabular).
        const t = def.type.toLowerCase();
        if (/(blobfs|blobstorage|filestorage|datalakestore)/.test(t)) return 'file';
        return 'tabular';
      }
      case 'services-and-apps':
        return 'tabular';
    }
  }
  // No catalog entry — fall back to a type-name heuristic.
  const t = (connectorType || '').toLowerCase();
  if (/(blob|adls|datalake|file|s3|ftp|sftp|hdfs)/.test(t)) return 'file';
  if (/(cosmos|mongo|table|cassandra|couch)/.test(t)) return 'nosql';
  if (/(rest|http|odata|graphql|web)/.test(t)) return 'rest';
  return 'tabular';
}

// =============================================================================
// Public lookups.
// =============================================================================

/**
 * COPY_SOURCE_SETTINGS — connector `type` → source side (typeName + fields +
 * file storeSettings). Connectors with no source are absent.
 */
export const COPY_SOURCE_SETTINGS: Record<string, CopySideDef> = Object.fromEntries(
  Object.values(COPY_SETTINGS_TABLE)
    .filter((d) => d.source)
    .map((d) => [d.connectorType, d.source as CopySideDef]),
);

/**
 * COPY_SINK_SETTINGS — connector `type` → sink side. Connectors with no sink
 * (source-only stores like AmazonS3 / Redshift / REST-read-only) are absent.
 */
export const COPY_SINK_SETTINGS: Record<string, CopySideDef> = Object.fromEntries(
  Object.values(COPY_SETTINGS_TABLE)
    .filter((d) => d.sink)
    .map((d) => [d.connectorType, d.sink as CopySideDef]),
);

/**
 * The Copy SOURCE side for a connector `type` — the dedicated entry if one
 * exists, else the generic fallback for the connector's family. Always returns
 * a usable spec (never undefined) so the editor never renders a blank tab.
 */
export function copySourceFor(connectorType: string | undefined): CopySideDef {
  const exact = connectorType ? COPY_SOURCE_SETTINGS[connectorType] : undefined;
  if (exact) return exact;
  const family = familyForConnector(connectorType);
  return COPY_GENERIC_BY_FAMILY[family].source as CopySideDef;
}

/**
 * The Copy SINK side for a connector `type` — the dedicated entry if one
 * exists, else the generic fallback for the connector's family.
 */
export function copySinkFor(connectorType: string | undefined): CopySideDef {
  const exact = connectorType ? COPY_SINK_SETTINGS[connectorType] : undefined;
  if (exact) return exact;
  const family = familyForConnector(connectorType);
  return COPY_GENERIC_BY_FAMILY[family].sink as CopySideDef;
}

/** Whether the connector supports being a Copy sink (has a dedicated or generic sink). */
export function connectorSupportsSink(connectorType: string | undefined): boolean {
  const def = connectorByType(connectorType || '');
  if (def) return def.supportsSink;
  // Unknown connector: the generic family fallback decides.
  return !!COPY_GENERIC_BY_FAMILY[familyForConnector(connectorType)].sink;
}

// =============================================================================
// Copy activity-level "Settings" tab field set (reusable spec).
//
// These live directly under `typeProperties` of the Copy activity (NOT under
// source/sink). Grouped into sections the Settings tab renders as Subtitle2
// headers. Every key is verbatim from the Copy-activity schema + the
// performance / fault-tolerance / log / preserve feature docs.
// =============================================================================

export interface CopySettingsSection {
  /** Section header shown in the Settings tab. */
  title: string;
  /** Short caption under the header. */
  hint?: string;
  fields: ConfigField[];
}

/** Valid Data Integration Unit values; '' = Auto (the service picks). */
export const DIU_VALUES = ['', '2', '4', '8', '16', '32', '48', '64', '80', '96', '128', '160', '192', '224', '256'];

/** Linked-service `type`s ADF accepts as an interim staging store. */
export const STAGING_LINKED_SERVICE_TYPES = new Set([
  'AzureBlobStorage',
  'AzureBlobFS',
  'AzureDataLakeStore',
]);

/**
 * COPY_SETTINGS_SPEC — the activity-level Settings field set, grouped. The
 * Settings tab maps each field to a Fluent control (kind → control) and writes
 * the value straight onto `typeProperties`. Staging / redirect / log-location
 * linked-service pickers and the upsert-key list are richer than a single field
 * (they reference a linked service / take an array), so they are represented as
 * structural fields here and the tab renders the appropriate picker — see the
 * `control` hint on each.
 */
export const COPY_SETTINGS_SPEC: CopySettingsSection[] = [
  {
    title: 'Performance',
    hint: 'Compute power and parallelism for the copy.',
    fields: [
      {
        key: 'dataIntegrationUnits',
        label: 'Data integration units (DIU)',
        kind: 'select',
        hint: 'Compute power. Auto lets the service pick the optimal value (2–256).',
        options: DIU_VALUES.map((v) => ({ value: v, label: v === '' ? 'Auto' : v })),
      },
      {
        key: 'parallelCopies',
        label: 'Degree of copy parallelism',
        kind: 'number',
        hint: 'Max parallel read/write sessions (and partition parallelism). Blank = auto.',
      },
    ],
  },
  {
    title: 'Staging',
    hint: 'Stage data in Blob / ADLS Gen2 before the sink (required for e.g. Synapse PolyBase, Snowflake).',
    fields: [
      {
        key: 'enableStaging',
        label: 'Enable staging',
        kind: 'boolean',
      },
      {
        key: 'stagingSettings.linkedServiceName',
        label: 'Staging linked service',
        kind: 'select',
        required: true,
        hint: 'Blob / ADLS Gen2 store used as the interim staging area. (linked-service picker)',
        showIf: { key: 'enableStaging', equals: 'true' },
      },
      {
        key: 'stagingSettings.path',
        label: 'Staging path',
        kind: 'text',
        hint: 'Folder within the staging store. Blank = auto-created container.',
        showIf: { key: 'enableStaging', equals: 'true' },
        supportsDynamic: true,
      },
      {
        key: 'stagingSettings.enableCompression',
        label: 'Enable staging compression',
        kind: 'boolean',
        showIf: { key: 'enableStaging', equals: 'true' },
      },
    ],
  },
  {
    title: 'Fault tolerance',
    hint: 'Skip incompatible rows / forbidden / missing files instead of failing the copy.',
    fields: [
      {
        key: 'enableSkipIncompatibleRow',
        label: 'Skip incompatible rows',
        kind: 'boolean',
        hint: 'Skip rows whose source/sink types are incompatible.',
      },
      {
        key: 'skipErrorFile.fileMissingOrForbidden',
        label: 'Skip missing / forbidden files',
        kind: 'boolean',
        hint: 'Continue when a source file is deleted or access is denied during the run.',
      },
      {
        key: 'skipErrorFile.dataInconsistency',
        label: 'Skip inconsistent data',
        kind: 'boolean',
        hint: 'Continue on file size / last-modified inconsistency between source and sink.',
      },
      {
        key: 'redirectIncompatibleRowSettings.linkedServiceName',
        label: 'Log skipped rows to (linked service)',
        kind: 'select',
        hint: 'Optional Blob / ADLS store to log skipped rows. (linked-service picker)',
        showIf: { key: 'enableSkipIncompatibleRow', equals: 'true' },
      },
      {
        key: 'redirectIncompatibleRowSettings.path',
        label: 'Skipped-row log path',
        kind: 'text',
        hint: 'Folder for the skipped-row log files.',
        showIf: { key: 'enableSkipIncompatibleRow', equals: 'true' },
        supportsDynamic: true,
      },
      {
        key: 'abortOnFirstFailure',
        label: 'Abort on first failure',
        kind: 'boolean',
        hint: 'Stop the activity on the first incompatible row instead of skipping (mutually exclusive with skip).',
      },
    ],
  },
  {
    title: 'Logging',
    hint: 'Record per-file copy outcomes (session log) to a store for audit.',
    fields: [
      {
        key: 'enableCopyActivityLog',
        label: 'Enable logging',
        kind: 'boolean',
      },
      {
        key: 'copyActivityLogSettings.logLevel',
        label: 'Log level',
        kind: 'select',
        hint: 'Warning logs only failures; Info logs all copied files.',
        options: [
          { value: 'Warning', label: 'Warning (failures only, default)' },
          { value: 'Info', label: 'Info (all files)' },
        ],
        showIf: { key: 'enableCopyActivityLog', equals: 'true' },
      },
      {
        key: 'copyActivityLogSettings.enableReliableLogging',
        label: 'Reliable logging',
        kind: 'boolean',
        hint: 'Guarantee log durability (lower throughput) vs. best-effort.',
        showIf: { key: 'enableCopyActivityLog', equals: 'true' },
      },
      {
        key: 'logSettings.logLocationSettings.linkedServiceName',
        label: 'Log store (linked service)',
        kind: 'select',
        required: true,
        hint: 'Blob / ADLS Gen2 store for the session logs. (linked-service picker)',
        showIf: { key: 'enableCopyActivityLog', equals: 'true' },
      },
      {
        key: 'logSettings.logLocationSettings.path',
        label: 'Log path',
        kind: 'text',
        hint: 'Folder for the log files.',
        showIf: { key: 'enableCopyActivityLog', equals: 'true' },
        supportsDynamic: true,
      },
    ],
  },
  {
    title: 'Preserve',
    hint: 'Carry source metadata / ACLs through to the sink (Blob / ADLS / file stores).',
    fields: [
      {
        key: 'preserve.Attributes',
        label: 'Preserve attributes',
        kind: 'boolean',
        hint: 'Preserve file attributes (owner, last-modified, etc.) onto the sink.',
      },
      {
        key: 'preserve.ACL',
        label: 'Preserve ACLs',
        kind: 'boolean',
        hint: 'Preserve POSIX ACLs from ADLS Gen1/Gen2 source onto an ADLS Gen2 sink.',
      },
    ],
  },
  {
    title: 'Data consistency',
    hint: 'Verify the copy after it completes.',
    fields: [
      {
        key: 'validateDataConsistency',
        label: 'Enable data consistency verification',
        kind: 'boolean',
        hint: 'Verify row count (tabular) or file size/checksum (binary) match between source and sink.',
      },
      {
        key: 'maxConcurrentConnections',
        label: 'Max concurrent connections (activity)',
        kind: 'number',
        hint: 'Cap concurrent connections across the whole activity. Blank = unlimited.',
      },
    ],
  },
];

// =============================================================================
// Counts / coverage helpers (for tests + the catalog summary).
// =============================================================================

/** Connector `type`s with a dedicated (non-fallback) Copy entry. */
export const COPY_SETTINGS_KEYS = Object.keys(COPY_SETTINGS_TABLE);

/** Number of connectors with dedicated Copy source/sink metadata. */
export const COPY_SETTINGS_COUNT = COPY_SETTINGS_KEYS.length;

/**
 * Coverage cross-check: every CONNECTORS entry resolves to a usable
 * source (and a sink when it supportsSink) via the dedicated map or a generic
 * fallback. Used by the unit test to guarantee no connector is ever left blank.
 */
export function copyCoverageForAllConnectors(): Array<{
  type: string;
  source: string;
  sink: string | null;
}> {
  return CONNECTORS.map((c) => ({
    type: c.type,
    source: copySourceFor(c.type).typeName,
    sink: c.supportsSink ? copySinkFor(c.type).typeName : null,
  }));
}
