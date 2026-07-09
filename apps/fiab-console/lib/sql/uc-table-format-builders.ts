/**
 * uc-table-format-builders — pure, dependency-free Databricks SQL generator for
 * creating a Unity Catalog managed table in a chosen **table format**
 * (parity item DBX-11: Managed Iceberg + UniForm).
 *
 * The plain "define columns" create path goes through the UC REST tables API
 * (createUcTable), which creates a managed Delta table. That REST body cannot
 * carry the `TBLPROPERTIES` a UniForm / managed-Iceberg / deletion-vector /
 * row-lineage table needs, so those formats compile to a real
 * `CREATE TABLE … USING … TBLPROPERTIES(...)` DDL that runs on a SQL Warehouse
 * via the Statement Execution API (executeStatement). Same "real backend"
 * pattern as the UC security / tag builders.
 *
 * SECURITY MODEL:
 *   - catalog/schema/table/column identifiers → {@link quoteIdent} (Databricks
 *     back-tick dialect, doubles embedded back-ticks), each name validated
 *     against a strict allowlist first.
 *   - Column SQL types are validated against a strict allowlist regex (the same
 *     shape used by uc-security-builders) so a type can never carry a payload.
 *   - TBLPROPERTIES keys/values are emitted as single-quote-escaped literals via
 *     {@link escapeSqlLiteral}.
 *
 * Grounded in Microsoft Learn:
 *   UniForm (Delta↔Iceberg): https://learn.microsoft.com/azure/databricks/delta/uniform
 *   Managed Iceberg:         https://learn.microsoft.com/azure/databricks/tables/managed-iceberg
 *   Deletion vectors:        https://learn.microsoft.com/azure/databricks/delta/deletion-vectors
 *   Row tracking (lineage):  https://learn.microsoft.com/azure/databricks/delta/row-tracking
 *   CREATE TABLE:            https://learn.microsoft.com/azure/databricks/sql/language-manual/sql-ref-syntax-ddl-create-table-using
 */

import { escapeSqlLiteral, quoteIdent } from '@/lib/sql/quoting';

/** Throwable for all build-time validation failures (surfaced as HTTP 400). */
export class TableFormatBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TableFormatBuildError';
  }
}

/**
 * Table format the create dialog exposes:
 *   - 'DELTA'            — plain managed Delta (the default; no TBLPROPERTIES).
 *   - 'DELTA_UNIFORM'    — Delta with UniForm Iceberg interop
 *                          (`delta.universalFormat.enabledFormats='iceberg'`),
 *                          readable by external Iceberg engines.
 *   - 'ICEBERG'          — a UC managed Iceberg table (`USING ICEBERG`).
 */
export type UcTableFormat = 'DELTA' | 'DELTA_UNIFORM' | 'ICEBERG';

export const UC_TABLE_FORMATS: UcTableFormat[] = ['DELTA', 'DELTA_UNIFORM', 'ICEBERG'];

export interface UcTableFormatColumn {
  name: string;
  /** SQL type — STRING, BIGINT, DECIMAL(10,2), TIMESTAMP, MAP<STRING,STRING>… */
  type: string;
  nullable?: boolean;
  comment?: string;
}

export interface UcTableFormatSpec {
  catalog: string;
  schema: string;
  name: string;
  columns: UcTableFormatColumn[];
  format: UcTableFormat;
  /** Enable deletion vectors (`delta.enableDeletionVectors`). Delta-family only.*/
  deletionVectors?: boolean;
  /** Enable row tracking / row lineage (`delta.enableRowTracking`). Delta-family only. */
  rowLineage?: boolean;
  comment?: string;
  /** IF NOT EXISTS guard. */
  ifNotExists?: boolean;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertName(name: string, what: string): string {
  const s = String(name ?? '').trim();
  if (!s) throw new TableFormatBuildError(`${what} is required`);
  if (!NAME_RE.test(s)) {
    throw new TableFormatBuildError(`${what} "${s}" is not a valid identifier (letters, digits, underscore; must not start with a digit)`);
  }
  if (s.length > 128) throw new TableFormatBuildError(`${what} is too long (>128)`);
  return s;
}

// Column SQL types: STRING, BIGINT, DECIMAL(10,2), MAP<STRING,STRING>, etc.
const SAFE_TYPE = /^[A-Za-z0-9_(),<> .]{1,128}$/;

function assertType(t: string): string {
  const s = String(t ?? '').trim();
  if (!SAFE_TYPE.test(s)) throw new TableFormatBuildError(`"${t}" is not a recognised SQL type`);
  return s;
}

function threePart(catalog: string, schema: string, name: string): string {
  return `${quoteIdent(assertName(catalog, 'catalog'), 'databricks-sql')}.${quoteIdent(assertName(schema, 'schema'), 'databricks-sql')}.${quoteIdent(assertName(name, 'table name'), 'databricks-sql')}`;
}

/** `'k' = 'v'` — TBLPROPERTIES key/value emitted as escaped string literals. */
function tblProp(key: string, value: string): string {
  return `'${escapeSqlLiteral(key)}' = '${escapeSqlLiteral(value)}'`;
}

/**
 * Which TBLPROPERTIES a format + toggles require. Pure and exported so the route
 * and tests can assert the exact property set independently of the full DDL.
 */
export function tableFormatProperties(spec: Pick<UcTableFormatSpec, 'format' | 'deletionVectors' | 'rowLineage'>): Record<string, string> {
  const props: Record<string, string> = {};
  if (spec.format === 'DELTA_UNIFORM') {
    props['delta.universalFormat.enabledFormats'] = 'iceberg';
    // UniForm requires column mapping + deletion vectors off historically; the
    // supported baseline sets name-mode column mapping + IcebergCompatV2.
    props['delta.columnMapping.mode'] = 'name';
    props['delta.enableIcebergCompatV2'] = 'true';
  }
  if (spec.deletionVectors) props['delta.enableDeletionVectors'] = 'true';
  if (spec.rowLineage) props['delta.enableRowTracking'] = 'true';
  return props;
}

/** True when the chosen format/toggles require the SQL-DDL path (the REST create
 *  API cannot carry these). Plain DELTA with no toggles → false (use REST). */
export function requiresDdlPath(spec: Pick<UcTableFormatSpec, 'format' | 'deletionVectors' | 'rowLineage'>): boolean {
  return spec.format !== 'DELTA' || !!spec.deletionVectors || !!spec.rowLineage;
}

/**
 * Build the `CREATE TABLE … USING <fmt> (cols) TBLPROPERTIES(...)` DDL.
 */
export function buildCreateTableFormatDdl(spec: UcTableFormatSpec): string {
  if (!UC_TABLE_FORMATS.includes(spec.format)) {
    throw new TableFormatBuildError(`unsupported table format: ${String(spec.format)}`);
  }
  if (!spec.columns?.length) throw new TableFormatBuildError('at least one column is required');
  if (spec.format === 'ICEBERG' && (spec.deletionVectors || spec.rowLineage)) {
    throw new TableFormatBuildError('deletion vectors and row lineage are Delta-family features; they do not apply to a managed Iceberg (USING ICEBERG) table');
  }

  const table = threePart(spec.catalog, spec.schema, spec.name);
  const using = spec.format === 'ICEBERG' ? 'ICEBERG' : 'DELTA';

  const cols = spec.columns.map((c) => {
    const col = quoteIdent(assertName(c.name, 'column name'), 'databricks-sql');
    const type = assertType(c.type);
    const notNull = c.nullable === false ? ' NOT NULL' : '';
    const comment = c.comment && c.comment.trim() ? ` COMMENT '${escapeSqlLiteral(c.comment.trim())}'` : '';
    return `  ${col} ${type}${notNull}${comment}`;
  }).join(',\n');

  const props = tableFormatProperties(spec);
  const propList = Object.entries(props).map(([k, v]) => tblProp(k, v));

  const lines: string[] = [
    `CREATE TABLE ${spec.ifNotExists ? 'IF NOT EXISTS ' : ''}${table} (`,
    cols,
    `)`,
    `USING ${using}`,
  ];
  if (spec.comment && spec.comment.trim()) lines.push(`COMMENT '${escapeSqlLiteral(spec.comment.trim())}'`);
  if (propList.length) lines.push(`TBLPROPERTIES (${propList.join(', ')})`);
  return lines.join('\n') + ';';
}
