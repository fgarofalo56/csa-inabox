/**
 * Shared, cloud-agnostic builder for ADF / Synapse dataset `typeProperties`.
 *
 * The dataset `typeProperties` schema is identical across Azure Data Factory
 * and Synapse pipelines (same `Microsoft.DataFactory` artifact model) and
 * across Commercial / Gov clouds (only the management host differs, which is
 * handled by the clients). This module is the ONE place that turns a guided
 * location/format selection into a correct `typeProperties` block — replacing
 * the old freeform path field + implicit-JSON shape (loom_no_freeform_config).
 *
 * Confirmed against the real ARM schema:
 *   Microsoft.DataFactory/factories/datasets @ 2018-06-01
 *   - DelimitedText: { location, columnDelimiter, rowDelimiter, compressionCodec,
 *       firstRowAsHeader, quoteChar, escapeChar, encodingName, nullValue }
 *   - Json:          { location, compression:{type[,level]} }
 *   - Parquet/Avro/Orc: { location, compressionCodec }
 *   - Binary:        { location }
 *   - AzureSqlTable / AzureSqlDWTable: { schema, table }
 * (learn.microsoft.com/azure/templates/microsoft.datafactory/factories/datasets,
 *  /format-delimited-text, /format-orc)
 */

/** The common file + relational dataset types Loom exposes a guided form for. */
export const DS_TYPES = [
  'DelimitedText', 'Json', 'Parquet', 'Avro', 'Orc', 'Binary', 'AzureSqlTable', 'AzureSqlDWTable',
] as const;
export type DatasetType = (typeof DS_TYPES)[number];

/** File-based dataset types (location + format options). */
export const FILE_DS_TYPES = new Set<string>(['DelimitedText', 'Json', 'Parquet', 'Avro', 'Orc', 'Binary']);
/** Relational dataset types (schema + table). */
export const TABLE_DS_TYPES = new Set<string>(['AzureSqlTable', 'AzureSqlDWTable']);

/** Human labels for the dataset type dropdown. */
export const DS_TYPE_LABELS: Record<string, string> = {
  DelimitedText: 'DelimitedText (CSV / TSV)',
  Json: 'JSON',
  Parquet: 'Parquet',
  Avro: 'Avro',
  Orc: 'ORC',
  Binary: 'Binary',
  AzureSqlTable: 'Azure SQL table',
  AzureSqlDWTable: 'Azure Synapse / SQL DW table',
};

/** Compression codecs valid for the file formats Loom exposes. */
export const COMPRESSION_CODECS = ['none', 'gzip', 'snappy', 'lzo', 'zlib', 'deflate', 'bzip2'] as const;

/** Map a linked-service connector type → the ADF dataset location `type`. */
export function locationTypeFor(lsType?: string): string {
  switch (lsType) {
    case 'AzureBlobFS': return 'AzureBlobFSLocation';
    case 'AmazonS3': return 'AmazonS3Location';
    case 'AzureFileStorage': return 'AzureFileStorageLocation';
    case 'AzureBlobStorage':
    default: return 'AzureBlobStorageLocation';
  }
}

/** The container-key name ADF expects for a given location type. */
export function containerKeyFor(locationType: string): 'fileSystem' | 'bucketName' | 'container' {
  if (locationType === 'AzureBlobFSLocation') return 'fileSystem';
  if (locationType === 'AmazonS3Location') return 'bucketName';
  return 'container';
}

/** Label for the container field, by connector — matches the ADF dialog. */
export function containerLabelFor(locationType: string): string {
  if (locationType === 'AzureBlobFSLocation') return 'File system';
  if (locationType === 'AmazonS3Location') return 'Bucket';
  return 'Container';
}

export interface DatasetBuilderOpts {
  /** Dataset format/type, e.g. 'DelimitedText' | 'Parquet' | 'AzureSqlTable'. */
  type: string;
  /** `.properties.type` of the chosen linked service (drives the location type). */
  linkedServiceType?: string;
  // ---- file-based ----
  container?: string;
  folder?: string;
  file?: string;
  compression?: string;       // 'none' | codec
  // ---- DelimitedText-only ----
  columnDelimiter?: string;
  rowDelimiter?: string;
  firstRowAsHeader?: boolean;
  quoteChar?: string;
  escapeChar?: string;
  encodingName?: string;
  // ---- relational ----
  schema?: string;
  table?: string;
}

const trimmed = (v?: string) => (typeof v === 'string' ? v.trim() : '');

/**
 * Build a correct `typeProperties` block from guided fields. Never raw JSON.
 * Returns `{}` for unknown types so the caller can still PUT a valid dataset.
 */
export function buildDatasetTypeProperties(opts: DatasetBuilderOpts): Record<string, any> {
  const tp: Record<string, any> = {};

  if (FILE_DS_TYPES.has(opts.type)) {
    const locType = locationTypeFor(opts.linkedServiceType);
    const containerKey = containerKeyFor(locType);
    const location: Record<string, any> = { type: locType };
    const container = trimmed(opts.container);
    const folder = trimmed(opts.folder);
    const file = trimmed(opts.file);
    if (container) location[containerKey] = container;
    if (folder) location.folderPath = folder;
    if (file) location.fileName = file;
    tp.location = location;

    const codec = opts.compression && opts.compression !== 'none' ? opts.compression : undefined;
    if (codec) {
      // JSON uses a compression object; every other file format uses compressionCodec.
      if (opts.type === 'Json') tp.compression = { type: codec };
      else tp.compressionCodec = codec;
    }

    if (opts.type === 'DelimitedText') {
      tp.columnDelimiter = opts.columnDelimiter || ',';
      if (trimmed(opts.rowDelimiter)) tp.rowDelimiter = opts.rowDelimiter;
      tp.firstRowAsHeader = opts.firstRowAsHeader ?? true;
      if (trimmed(opts.quoteChar)) tp.quoteChar = opts.quoteChar;
      if (trimmed(opts.escapeChar)) tp.escapeChar = opts.escapeChar;
      if (trimmed(opts.encodingName)) tp.encodingName = opts.encodingName;
    }
  } else if (TABLE_DS_TYPES.has(opts.type)) {
    const schema = trimmed(opts.schema);
    const table = trimmed(opts.table);
    if (schema) tp.schema = schema;
    if (table) tp.table = table;
  }

  return tp;
}

/**
 * Reverse of {@link buildDatasetTypeProperties}: hydrate guided fields from an
 * existing dataset's `typeProperties` so editors round-trip cleanly.
 */
export function readDatasetTypeProperties(tp: Record<string, any> | undefined): DatasetBuilderOpts {
  const t = tp || {};
  const loc = t.location || {};
  return {
    type: '', // caller supplies; not encoded in typeProperties
    container: loc.fileSystem ?? loc.bucketName ?? loc.container ?? '',
    folder: loc.folderPath ?? '',
    file: loc.fileName ?? '',
    compression: t.compressionCodec ?? t.compression?.type ?? 'none',
    columnDelimiter: t.columnDelimiter ?? ',',
    rowDelimiter: t.rowDelimiter ?? '',
    firstRowAsHeader: typeof t.firstRowAsHeader === 'boolean' ? t.firstRowAsHeader : true,
    quoteChar: t.quoteChar ?? '"',
    escapeChar: t.escapeChar ?? '\\',
    encodingName: t.encodingName ?? '',
    schema: t.schema ?? '',
    table: t.table ?? t.tableName ?? '',
  };
}
