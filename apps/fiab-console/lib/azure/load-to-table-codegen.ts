/**
 * load-to-table-codegen — pure builders for the Lakehouse "Load to Table"
 * (F6) wizard. Given a source file in ADLS Gen2 and a target table name, emit
 * the PySpark a Synapse Spark pool runs (via Livy) to materialize a managed
 * Delta table under the container's `Tables/` folder.
 *
 * Kept side-effect free so it can be unit-tested without Azure.
 *
 * The generated job writes Delta files to
 *   abfss://<container>@<account>.dfs.core.windows.net/Tables/<table>
 * AND registers the table in the Spark metastore via saveAsTable(..., path=…),
 * so the new table:
 *   - appears in the Lakehouse editor's Tables tab (it lists `Tables/` dirs)
 *   - is queryable via `SELECT * FROM <database>.<table>` in a notebook / Spark SQL
 *     (the bare `<table>` when no database is given).
 *
 * No Fabric dependency: this targets Azure Synapse Spark (dev.azuresynapse.net
 * Livy), never api.fabric.microsoft.com.
 */

import { trimSlashes } from '@/lib/util/trim';

export const LOAD_TABLE_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Formats this wizard can read with Spark's native readers (no connector). */
export const SUPPORTED_LOAD_FORMATS = ['csv', 'parquet', 'json', 'orc', 'avro', 'text'] as const;
export type LoadFormat = (typeof SUPPORTED_LOAD_FORMATS)[number];

export interface LoadToTableSpec {
  /** ADLS container the file lives in (bronze|silver|gold|landing). */
  container: string;
  /** ADLS storage account name (no suffix). */
  account: string;
  /** Path within the container, e.g. "Files/sales.csv". */
  path: string;
  /** Destination managed Delta table name (validated against LOAD_TABLE_NAME_RE). */
  tableName: string;
  /** Spark write mode. */
  writeMode: 'overwrite' | 'append';
  /** Resolved source format (one of SUPPORTED_LOAD_FORMATS). */
  format: LoadFormat;
  /**
   * The lakehouse item root inside the container (e.g. "lakehouses/Sales--<id>").
   * When set, the Delta table is written to `<tablesRoot>/Tables/<table>`, the
   * folder the item's Tables tab lists; when omitted, to `Tables/<table>` at the
   * container top level.
   */
  tablesRoot?: string;
  /**
   * The Spark database the table is registered in (e.g. the lakehouse item's
   * own `lh_<digest>_dbo`). When set, the job creates the database if needed
   * and registers the table as `<database>.<table>`; when omitted, the table is
   * registered under its bare name in the session's current database.
   */
  database?: string;
}

/** A Spark database name this builder will emit: lower-case, 1-128 chars. */
export const LOAD_DATABASE_NAME_RE = /^[a-z][a-z0-9_]{0,127}$/;

/** The name the table is registered under in the Spark metastore. */
export function loadTargetTableName(spec: Pick<LoadToTableSpec, 'tableName' | 'database'>): string {
  return spec.database ? `${spec.database}.${spec.tableName}` : spec.tableName;
}

/** Validate a candidate Delta table name. Returns an error string or null. */
export function validateLoadTableName(name: string): string | null {
  if (!name) return 'Table name is required.';
  if (!LOAD_TABLE_NAME_RE.test(name)) {
    return 'Use 1-64 chars: start with a lowercase letter, then lowercase letters, digits, or underscores.';
  }
  return null;
}

/** Suggest a table name from a file path leaf (strip extension, slugify). */
export function suggestTableName(path: string): string {
  const leaf = path.replace(/\/+$/, '').split('/').pop() || path;
  let base = leaf.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'loaded_table';
  if (!/^[a-z]/.test(base)) base = `t_${base}`;
  return base.slice(0, 64);
}

/** Build the abfss:// URL for a path inside an ADLS Gen2 container. */
export function abfssUrl(account: string, container: string, path: string): string {
  const clean = path.replace(/^\/+/, '');
  return `abfss://${container}@${account}.dfs.core.windows.net/${clean}`;
}

/** The Spark read expression for a given native format against a source URL. */
export function readExprFor(format: LoadFormat, srcUrl: string): string {
  const p = JSON.stringify(srcUrl); // safely quoted python string literal
  switch (format) {
    case 'csv':
      return `spark.read.option("header", "true").option("inferSchema", "true").csv(${p})`;
    case 'json':
      return `spark.read.option("multiline", "true").json(${p})`;
    case 'parquet':
      return `spark.read.parquet(${p})`;
    case 'orc':
      return `spark.read.orc(${p})`;
    case 'avro':
      return `spark.read.format("avro").load(${p})`;
    case 'text':
      return `spark.read.text(${p})`;
    default: {
      const _exhaustive: never = format;
      throw new Error(`Unsupported load format: ${_exhaustive}`);
    }
  }
}

/**
 * Build the full PySpark job. The final print emits a single machine-parseable
 * line `LOOM_LOAD_RESULT rows=<n> table=<name>` the BFF reads back as the
 * receipt's row count.
 */
export function buildLoadToTablePySpark(spec: LoadToTableSpec): string {
  const nameErr = validateLoadTableName(spec.tableName);
  if (nameErr) throw new Error(nameErr);
  if (!SUPPORTED_LOAD_FORMATS.includes(spec.format)) {
    throw new Error(`Unsupported load format: ${spec.format}`);
  }
  if (spec.database !== undefined && !LOAD_DATABASE_NAME_RE.test(spec.database)) {
    throw new Error(`Invalid Spark database name: ${JSON.stringify(spec.database)}`);
  }
  const srcUrl = abfssUrl(spec.account, spec.container, spec.path);
  const tablesRoot = trimSlashes(spec.tablesRoot || '');
  const targetUrl = abfssUrl(spec.account, spec.container, `${tablesRoot ? `${tablesRoot}/` : ''}Tables/${spec.tableName}`);
  const readExpr = readExprFor(spec.format, srcUrl);
  const target = JSON.stringify(targetUrl);
  const qualified = loadTargetTableName(spec);
  const table = JSON.stringify(qualified);

  // The comment lines carry the two URLs as quoted string literals, so a path
  // segment holding a line break or other control character stays on its one
  // comment line and never starts a statement of its own.
  return [
    '# Auto-generated by the Loom Lakehouse Load to Table wizard (F6)',
    `# Source: ${JSON.stringify(srcUrl)}`,
    `# Target: ${qualified} (Delta, ${spec.writeMode}) at ${target}`,
    ...(spec.database ? [`spark.sql(${JSON.stringify(`CREATE DATABASE IF NOT EXISTS \`${spec.database}\``)})`] : []),
    `df = ${readExpr}`,
    `_loom_rows = df.count()`,
    `(df.write`,
    `   .mode(${JSON.stringify(spec.writeMode)})`,
    `   .format("delta")`,
    `   .option("path", ${target})`,
    `   .saveAsTable(${table}))`,
    `print(f"LOOM_LOAD_RESULT rows={_loom_rows} table=${qualified}")`,
  ].join('\n');
}

/** Parse the row count back out of a Livy statement's text/plain output. */
export function parseLoadRowCount(textPlain: string | undefined | null): number | null {
  if (!textPlain) return null;
  const m = textPlain.match(/LOOM_LOAD_RESULT\s+rows=(\d+)/);
  return m ? Number(m[1]) : null;
}
