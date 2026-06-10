/**
 * synapse-compat.ts — compatibility assessment + DDL generation for migrating
 * a parsed .dacpac model onto an Azure Synapse Dedicated SQL pool (the
 * Azure-native default backing for the Loom "Warehouse" item — see
 * .claude/rules/no-fabric-dependency.md).
 *
 * This is the same class of analysis the SQL Server Migration Assistant / the
 * "Assessment" pass of the Azure Synapse Pathway tool performs: it walks every
 * object in the source model and flags constructs the Dedicated SQL pool engine
 * does NOT support, so the operator sees an accurate report BEFORE importing.
 *
 * Grounded in the documented Dedicated SQL pool surface area:
 *   - Unsupported / limited data types (e.g. no XML/geography/sql_variant,
 *     no nvarchar(max) in some contexts, identity restrictions):
 *     https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-tables-overview
 *   - Table-feature limits (no PRIMARY KEY enforcement other than NONCLUSTERED
 *     NOT ENFORCED, no FK enforcement, no memory-optimized / temporal tables):
 *     https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-tables-overview
 *
 * No mocks: the report is computed entirely from the uploaded model; the import
 * executes the generated T-SQL against the live pool via synapse-sql-client.
 */

import type { DacModel, DacTable, DacColumn } from './dacpac-model';

export type Severity = 'error' | 'warning' | 'info';

export interface CompatFinding {
  severity: Severity;
  /** "[schema].[table].[col]" or "[schema].[obj]" the finding applies to. */
  object: string;
  /** Short rule id for grouping (e.g. "unsupported-type"). */
  rule: string;
  message: string;
  /** How the import handles it (when it can auto-remediate). */
  remediation?: string;
}

export interface CompatReport {
  packageName?: string;
  packageVersion?: string;
  sourceCompatLevel?: number;
  counts: {
    schemas: number;
    tables: number;
    columns: number;
    views: number;
    procedures: number;
    functions: number;
    triggers: number;
  };
  findings: CompatFinding[];
  /** True when no `error`-severity findings remain → schema import can proceed. */
  importable: boolean;
}

// ── Dedicated SQL pool capability rules ─────────────────────────────────────

/**
 * Data types the Dedicated SQL pool does NOT support at all. Importing a column
 * of one of these types is an `error` (the CREATE TABLE would fail), so the
 * generator substitutes a documented replacement and the report names it.
 */
const UNSUPPORTED_TYPES: Record<string, { replacement: string; note: string }> = {
  xml: { replacement: 'nvarchar(max)', note: 'XML type is unsupported on Dedicated SQL pool; stored as nvarchar(max).' },
  geography: { replacement: 'varchar(max)', note: 'Spatial types are unsupported; stored as WKT in varchar(max).' },
  geometry: { replacement: 'varchar(max)', note: 'Spatial types are unsupported; stored as WKT in varchar(max).' },
  hierarchyid: { replacement: 'varchar(4000)', note: 'hierarchyid is unsupported; stored as varchar(4000).' },
  sql_variant: { replacement: 'nvarchar(4000)', note: 'sql_variant is unsupported; stored as nvarchar(4000).' },
  image: { replacement: 'varbinary(max)', note: 'image is deprecated/unsupported; use varbinary(max).' },
  text: { replacement: 'varchar(max)', note: 'text is deprecated/unsupported; use varchar(max).' },
  ntext: { replacement: 'nvarchar(max)', note: 'ntext is deprecated/unsupported; use nvarchar(max).' },
  timestamp: { replacement: 'binary(8)', note: 'rowversion/timestamp is unsupported; use binary(8) (no auto-update).' },
  rowversion: { replacement: 'binary(8)', note: 'rowversion/timestamp is unsupported; use binary(8) (no auto-update).' },
};

/** Types supported natively — used to flag "unknown" (likely CLR/UDT) types. */
const KNOWN_SUPPORTED = new Set([
  'bigint', 'int', 'smallint', 'tinyint', 'bit', 'decimal', 'numeric', 'money',
  'smallmoney', 'float', 'real', 'date', 'datetime', 'datetime2',
  'datetimeoffset', 'smalldatetime', 'time', 'char', 'varchar', 'nchar',
  'nvarchar', 'binary', 'varbinary', 'uniqueidentifier',
]);

/** Resolve the effective Dedicated-pool type, mapping unsupported types. */
export function mapType(col: DacColumn): { sqlType: string; mapped?: { from: string; note: string } } {
  const base = col.dataType.toLowerCase();
  const sub = UNSUPPORTED_TYPES[base];
  if (sub) return { sqlType: sub.replacement, mapped: { from: base, note: sub.note } };

  // Length / precision rendering for supported types.
  if (['char', 'varchar', 'nchar', 'nvarchar', 'binary', 'varbinary'].includes(base)) {
    const len = col.length === 'max' ? 'max' : (col.length ?? (base.startsWith('n') ? 4000 : 8000));
    return { sqlType: `${base}(${len})` };
  }
  if (['decimal', 'numeric'].includes(base)) {
    const p = col.precision ?? 18;
    const s = col.scale ?? 0;
    return { sqlType: `${base}(${p}, ${s})` };
  }
  if (base === 'datetime2' || base === 'time' || base === 'datetimeoffset') {
    return { sqlType: col.scale != null ? `${base}(${col.scale})` : base };
  }
  return { sqlType: base };
}

// ── Assessment ──────────────────────────────────────────────────────────────

function fullName(schema: string, name: string, col?: string): string {
  return col ? `[${schema}].[${name}].[${col}]` : `[${schema}].[${name}]`;
}

/** Build the full compatibility report from a parsed DacModel. */
export function assessModel(model: DacModel): CompatReport {
  const findings: CompatFinding[] = [];
  let columnCount = 0;

  for (const t of model.tables) {
    columnCount += t.columns.length;

    if (t.memoryOptimized) {
      findings.push({
        severity: 'error',
        object: fullName(t.schema, t.name),
        rule: 'memory-optimized',
        message: 'Memory-optimized tables are not supported on Dedicated SQL pool.',
        remediation: 'Imported as a standard rowstore table (MEMORY_OPTIMIZED dropped).',
      });
    }
    if (t.temporal) {
      findings.push({
        severity: 'warning',
        object: fullName(t.schema, t.name),
        rule: 'temporal',
        message: 'System-versioned (temporal) tables are not supported; system-versioning is dropped.',
        remediation: 'Imported as a standard table without the PERIOD/HISTORY clause.',
      });
    }

    for (const c of t.columns) {
      const obj = fullName(t.schema, t.name, c.name);
      if (c.computedExpression !== undefined) {
        findings.push({
          severity: 'warning',
          object: obj,
          rule: 'computed-column',
          message: 'Computed column — persisted/deterministic semantics may differ on Dedicated SQL pool.',
          remediation: 'Imported as a computed column with the same expression; verify after import.',
        });
        continue;
      }
      const base = c.dataType.toLowerCase();
      if (UNSUPPORTED_TYPES[base]) {
        findings.push({
          severity: 'error',
          object: obj,
          rule: 'unsupported-type',
          message: `Column type "${base}" is not supported on Dedicated SQL pool.`,
          remediation: UNSUPPORTED_TYPES[base].note,
        });
      } else if (!KNOWN_SUPPORTED.has(base) && base !== 'computed') {
        findings.push({
          severity: 'warning',
          object: obj,
          rule: 'unknown-type',
          message: `Column type "${base}" is not a recognized built-in type (likely a CLR/user-defined type).`,
          remediation: 'Review manually; the import emits the type verbatim and may fail.',
        });
      }
    }

    if (t.primaryKey.length > 0) {
      findings.push({
        severity: 'info',
        object: fullName(t.schema, t.name),
        rule: 'pk-not-enforced',
        message: 'Dedicated SQL pool supports only NONCLUSTERED … NOT ENFORCED primary keys.',
        remediation: 'Imported as PRIMARY KEY NONCLUSTERED NOT ENFORCED.',
      });
    }
  }

  let views = 0, procedures = 0, functions = 0, triggers = 0;
  for (const o of model.objects) {
    switch (o.type) {
      case 'SqlView': views++; break;
      case 'SqlProcedure': procedures++; break;
      case 'SqlDmlTrigger':
        triggers++;
        findings.push({
          severity: 'error',
          object: fullName(o.schema, o.name),
          rule: 'trigger',
          message: 'DML triggers are not supported on Dedicated SQL pool.',
          remediation: 'Excluded from import; reimplement the logic as a pipeline/stored procedure.',
        });
        break;
      default:
        functions++; break;
    }
    if ((o.type === 'SqlView' || o.type === 'SqlProcedure' || o.type.includes('Function')) && !o.script) {
      findings.push({
        severity: 'warning',
        object: fullName(o.schema, o.name),
        rule: 'missing-script',
        message: `${o.type} body is not present in the package model; only the table schema can be imported.`,
        remediation: 'Re-export the .dacpac with object scripts, or recreate this object manually.',
      });
    }
  }

  const importable = !findings.some((f) => f.severity === 'error' && f.rule !== 'unsupported-type' && f.rule !== 'memory-optimized');
  // unsupported-type + memory-optimized are auto-remediated by the generator, so
  // they are reported as errors (visibility) but DO NOT block the schema import.

  return {
    packageName: model.packageName,
    packageVersion: model.packageVersion,
    sourceCompatLevel: model.sourceCompatLevel,
    counts: {
      schemas: model.schemas.length,
      tables: model.tables.length,
      columns: columnCount,
      views,
      procedures,
      functions,
      triggers,
    },
    findings,
    importable,
  };
}

// ── DDL generation (Dedicated SQL pool flavored) ────────────────────────────

/** Render a single column definition line for CREATE TABLE. */
function columnDdl(c: DacColumn): string {
  if (c.computedExpression !== undefined) {
    return `    [${c.name}] AS (${c.computedExpression})`;
  }
  const { sqlType } = mapType(c);
  const identity = c.identity ? ' IDENTITY(1,1)' : '';
  const nullability = c.nullable ? ' NULL' : ' NOT NULL';
  return `    [${c.name}] ${sqlType}${identity}${nullability}`;
}

/** Generate a CREATE TABLE statement for one table (Dedicated SQL pool). */
export function tableDdl(t: DacTable): string {
  const cols = t.columns.map(columnDdl);
  const lines = [...cols];

  if (t.primaryKey.length > 0) {
    // Dedicated pool: PK must be NONCLUSTERED and NOT ENFORCED.
    const pkCols = t.primaryKey.map((c) => `[${c}]`).join(', ');
    lines.push(`    PRIMARY KEY NONCLUSTERED (${pkCols}) NOT ENFORCED`);
  }

  // Distribution + index: ROUND_ROBIN is the safe default when no distribution
  // hint is in the source model; columnstore tables map to CLUSTERED COLUMNSTORE.
  const indexClause = t.hasClusteredColumnstore ? 'CLUSTERED COLUMNSTORE INDEX' : 'CLUSTERED COLUMNSTORE INDEX';
  const withClause = `WITH ( DISTRIBUTION = ROUND_ROBIN, ${indexClause} )`;

  return [
    `CREATE TABLE [${t.schema}].[${t.name}]`,
    `(`,
    lines.join(',\n'),
    `)`,
    withClause,
    `;`,
  ].join('\n');
}

/** CREATE SCHEMA IF NOT EXISTS equivalent (Dedicated pool has no IF NOT EXISTS). */
export function schemaDdl(schema: string): string {
  if (schema.toLowerCase() === 'dbo') return ''; // dbo always exists
  return [
    `IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = '${schema.replace(/'/g, "''")}')`,
    `    EXEC('CREATE SCHEMA [${schema}]');`,
  ].join('\n');
}

export interface GeneratedDdl {
  /** Ordered list of executable statements (schemas, then tables, then objects). */
  statements: { kind: 'schema' | 'table' | 'view' | 'procedure' | 'function'; name: string; sql: string }[];
  /** Concatenated script for download / preview. */
  script: string;
}

/**
 * Generate the full migration script: schemas → tables → script-bearing objects.
 * Objects without a script body and unsupported objects (triggers) are skipped
 * (the report already flagged them).
 */
export function generateDdl(model: DacModel): GeneratedDdl {
  const statements: GeneratedDdl['statements'] = [];

  for (const schema of model.schemas) {
    const sql = schemaDdl(schema);
    if (sql) statements.push({ kind: 'schema', name: `[${schema}]`, sql });
  }

  for (const t of model.tables) {
    statements.push({ kind: 'table', name: `[${t.schema}].[${t.name}]`, sql: tableDdl(t) });
  }

  for (const o of model.objects) {
    if (o.type === 'SqlDmlTrigger') continue; // unsupported
    if (!o.script) continue; // body not in package; report flagged it
    const kind = o.type === 'SqlView' ? 'view' : o.type === 'SqlProcedure' ? 'procedure' : 'function';
    statements.push({ kind, name: `[${o.schema}].[${o.name}]`, sql: `${o.script.trim().replace(/;?\s*$/, '')};` });
  }

  const script = statements.map((s) => `-- ${s.kind}: ${s.name}\n${s.sql}`).join('\n\nGO\n\n');
  return { statements, script };
}
