/**
 * spark-format-detect — given a filename, return the Apache Spark format
 * hint a user would pass to `spark.read.format(...)` and the human label.
 *
 * Lakehouse upload uses this to (a) tell the user what they just uploaded
 * is in fact Spark-readable, (b) surface the read-snippet on the file
 * detail panel.
 *
 * Coverage spans every native + community Spark reader currently in scope
 * for CSA Loom workloads:
 *   - Parquet / Delta / ORC / Avro / Iceberg / Arrow
 *   - JSON (multiline + ndjson/jsonl) / CSV / TSV / plain text
 *   - XML (com.databricks:spark-xml)
 *   - GeoJSON / GeoParquet / Shapefile / GeoPackage (Apache Sedona)
 *   - Raster / image (sedona / Spark image)
 *   - Compressed (.gz / .bz2 / .zstd / .snappy) — Spark auto-decompresses
 *     and uses the inner extension
 *   - Excel (com.crealytics:spark-excel)
 *   - Arbitrary binary — Spark binaryFile reader
 */

export interface SparkFormatHint {
  /** e.g. 'parquet', 'delta', 'csv', 'json', 'orc' — what goes into spark.read.format() */
  format: string;
  /** Human label for UI: e.g. 'Apache Parquet', 'Delta Lake', 'CSV (Comma-separated)' */
  label: string;
  /** Reader snippet shown to the user, with placeholders for path */
  readSnippet: string;
  /** Suggested mime type (best-effort) */
  mimeType: string;
  /** Whether Spark can read this natively (true) vs requires a community connector (false) */
  native: boolean;
  /** Optional connector hint (e.g. 'com.databricks:spark-xml') */
  connector?: string;
}

const TABLE: Record<string, SparkFormatHint> = {
  // ---- columnar ----
  parquet: {
    format: 'parquet',
    label: 'Apache Parquet',
    readSnippet: 'spark.read.parquet("{path}")',
    mimeType: 'application/octet-stream',
    native: true,
  },
  orc: {
    format: 'orc',
    label: 'Apache ORC',
    readSnippet: 'spark.read.orc("{path}")',
    mimeType: 'application/octet-stream',
    native: true,
  },
  avro: {
    format: 'avro',
    label: 'Apache Avro',
    readSnippet: 'spark.read.format("avro").load("{path}")',
    mimeType: 'application/octet-stream',
    native: true,
  },
  arrow: {
    format: 'arrow',
    label: 'Apache Arrow IPC',
    readSnippet: 'spark.read.format("arrow").load("{path}")',
    mimeType: 'application/vnd.apache.arrow.file',
    native: false,
    connector: 'org.apache.arrow:arrow-spark',
  },

  // ---- text / json / csv ----
  json: {
    format: 'json',
    label: 'JSON',
    readSnippet: 'spark.read.option("multiline","true").json("{path}")',
    mimeType: 'application/json',
    native: true,
  },
  jsonl: {
    format: 'json',
    label: 'JSON Lines (NDJSON)',
    readSnippet: 'spark.read.json("{path}")',
    mimeType: 'application/x-ndjson',
    native: true,
  },
  ndjson: {
    format: 'json',
    label: 'NDJSON',
    readSnippet: 'spark.read.json("{path}")',
    mimeType: 'application/x-ndjson',
    native: true,
  },
  csv: {
    format: 'csv',
    label: 'CSV',
    readSnippet: 'spark.read.option("header","true").csv("{path}")',
    mimeType: 'text/csv',
    native: true,
  },
  tsv: {
    format: 'csv',
    label: 'TSV (tab-separated)',
    readSnippet: 'spark.read.option("sep","\\t").option("header","true").csv("{path}")',
    mimeType: 'text/tab-separated-values',
    native: true,
  },
  txt: {
    format: 'text',
    label: 'Plain text',
    readSnippet: 'spark.read.text("{path}")',
    mimeType: 'text/plain',
    native: true,
  },
  log: {
    format: 'text',
    label: 'Log file',
    readSnippet: 'spark.read.text("{path}")',
    mimeType: 'text/plain',
    native: true,
  },

  // ---- xml ----
  xml: {
    format: 'xml',
    label: 'XML',
    readSnippet: 'spark.read.format("xml").option("rowTag","row").load("{path}")',
    mimeType: 'application/xml',
    native: false,
    connector: 'com.databricks:spark-xml',
  },

  // ---- excel ----
  xlsx: {
    format: 'excel',
    label: 'Excel Workbook (.xlsx)',
    readSnippet:
      'spark.read.format("com.crealytics.spark.excel").option("header","true").load("{path}")',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    native: false,
    connector: 'com.crealytics:spark-excel',
  },
  xls: {
    format: 'excel',
    label: 'Excel Workbook (.xls)',
    readSnippet:
      'spark.read.format("com.crealytics.spark.excel").option("header","true").load("{path}")',
    mimeType: 'application/vnd.ms-excel',
    native: false,
    connector: 'com.crealytics:spark-excel',
  },

  // ---- geo ----
  geojson: {
    format: 'geojson',
    label: 'GeoJSON',
    readSnippet:
      'sedona.read.format("geojson").option("multiline","true").load("{path}")',
    mimeType: 'application/geo+json',
    native: false,
    connector: 'org.apache.sedona:sedona-spark',
  },
  geoparquet: {
    format: 'geoparquet',
    label: 'GeoParquet',
    readSnippet: 'sedona.read.format("geoparquet").load("{path}")',
    mimeType: 'application/octet-stream',
    native: false,
    connector: 'org.apache.sedona:sedona-spark',
  },
  shp: {
    format: 'shapefile',
    label: 'Esri Shapefile (.shp — upload .shp+.shx+.dbf together)',
    readSnippet: 'sedona.read.format("shapefile").load("{path-parent-directory}")',
    mimeType: 'application/octet-stream',
    native: false,
    connector: 'org.apache.sedona:sedona-spark',
  },
  gpkg: {
    format: 'geopackage',
    label: 'GeoPackage',
    readSnippet: 'sedona.read.format("geopackage").load("{path}")',
    mimeType: 'application/geopackage+sqlite3',
    native: false,
    connector: 'org.apache.sedona:sedona-spark',
  },

  // ---- raster / image ----
  tif: {
    format: 'image',
    label: 'GeoTIFF / Raster',
    readSnippet: 'sedona.read.format("geotiff").load("{path}")',
    mimeType: 'image/tiff',
    native: false,
    connector: 'org.apache.sedona:sedona-spark',
  },
  tiff: {
    format: 'image',
    label: 'GeoTIFF / Raster',
    readSnippet: 'sedona.read.format("geotiff").load("{path}")',
    mimeType: 'image/tiff',
    native: false,
    connector: 'org.apache.sedona:sedona-spark',
  },
  png: {
    format: 'image',
    label: 'PNG image',
    readSnippet: 'spark.read.format("image").load("{path}")',
    mimeType: 'image/png',
    native: true,
  },
  jpg: {
    format: 'image',
    label: 'JPEG image',
    readSnippet: 'spark.read.format("image").load("{path}")',
    mimeType: 'image/jpeg',
    native: true,
  },
  jpeg: {
    format: 'image',
    label: 'JPEG image',
    readSnippet: 'spark.read.format("image").load("{path}")',
    mimeType: 'image/jpeg',
    native: true,
  },

  // ---- compressed wrappers (Spark auto-decompresses) ----
  gz: {
    format: 'auto',
    label: 'gzip-compressed (Spark auto-decompresses based on inner ext)',
    readSnippet: 'spark.read.format("<inner-format>").load("{path}")',
    mimeType: 'application/gzip',
    native: true,
  },
  bz2: {
    format: 'auto',
    label: 'bzip2-compressed (Spark auto-decompresses)',
    readSnippet: 'spark.read.format("<inner-format>").load("{path}")',
    mimeType: 'application/x-bzip2',
    native: true,
  },
  zst: {
    format: 'auto',
    label: 'Zstandard-compressed',
    readSnippet: 'spark.read.format("<inner-format>").load("{path}")',
    mimeType: 'application/zstd',
    native: true,
  },

  // ---- generic ----
  pdf: {
    format: 'binaryFile',
    label: 'PDF (binaryFile reader)',
    readSnippet: 'spark.read.format("binaryFile").load("{path}")',
    mimeType: 'application/pdf',
    native: true,
  },
  zip: {
    format: 'binaryFile',
    label: 'ZIP archive (binaryFile — decompress separately)',
    readSnippet: 'spark.read.format("binaryFile").load("{path}")',
    mimeType: 'application/zip',
    native: true,
  },
};

/** Detect the Spark format hint for a file by filename + content-type fallback. */
export function detectSparkFormat(
  filename: string,
  contentType?: string,
): SparkFormatHint {
  const lower = filename.toLowerCase();
  // Delta is a directory convention — surface a friendly hint if a _delta_log
  // marker file is uploaded.
  if (lower.endsWith('/_delta_log') || lower.includes('_delta_log/')) {
    return {
      format: 'delta',
      label: 'Delta Lake (table directory)',
      readSnippet: 'spark.read.format("delta").load("{path-parent-directory}")',
      mimeType: 'application/octet-stream',
      native: true,
    };
  }

  // Strip outer compression extension, but remember it
  let stripped = lower;
  for (const wrap of ['.gz', '.bz2', '.zst', '.snappy']) {
    if (stripped.endsWith(wrap)) stripped = stripped.slice(0, -wrap.length);
  }
  const ext = stripped.split('.').pop() ?? '';

  const hit = TABLE[ext];
  if (hit) return hit;

  // Fallbacks based on content-type
  if (contentType?.startsWith('image/')) {
    return TABLE.png; // generic image reader
  }
  if (contentType === 'application/json') return TABLE.json;
  if (contentType === 'application/xml' || contentType === 'text/xml') return TABLE.xml;
  if (contentType?.startsWith('text/')) return TABLE.txt;

  // Last resort — binaryFile reader handles literally anything.
  return {
    format: 'binaryFile',
    label: `Unknown extension '${ext || '(none)'}' — using Spark binaryFile reader`,
    readSnippet: 'spark.read.format("binaryFile").load("{path}")',
    mimeType: contentType || 'application/octet-stream',
    native: true,
  };
}

/** Materialize the read snippet against a real ADLS path. */
export function renderReadSnippet(hint: SparkFormatHint, abfssPath: string): string {
  return hint.readSnippet.replace('{path}', abfssPath);
}
