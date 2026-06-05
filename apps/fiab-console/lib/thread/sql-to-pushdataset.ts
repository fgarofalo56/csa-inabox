/**
 * sql-to-pushdataset — map a T-SQL table's catalog schema onto a Power BI Push
 * Datasets model (the supported REST authoring path; no XMLA required).
 *
 * Used by the Loom Thread "Build a Power BI model" edge to turn a real warehouse
 * table (columns discovered from sys.* via sql-objects-client) into a typed push
 * table, and to coerce sampled TDS rows into the JSON shape Power BI accepts.
 *
 * Per .claude/rules/no-vaporware.md the column types + rows are derived from the
 * real catalog + a real read-only SELECT — never fabricated.
 */

import type { PushColumn, PushColumnType } from '@/lib/azure/powerbi-client';
import type { SqlColumnRow } from '@/lib/azure/sql-objects-client';

/**
 * Map a SQL Server / Synapse `sys.types` name onto one of the six column types
 * the Power BI Push Datasets REST API accepts (Int64 / Double / Boolean /
 * DateTime / String / Decimal). Unknown types fall back to String, which round-
 * trips any value safely.
 */
export function sqlTypeToPush(dataType: string): PushColumnType {
  const t = (dataType || '').trim().toLowerCase();
  switch (t) {
    case 'bigint':
    case 'int':
    case 'smallint':
    case 'tinyint':
      return 'Int64';
    case 'bit':
      return 'Boolean';
    case 'decimal':
    case 'numeric':
    case 'money':
    case 'smallmoney':
      return 'Decimal';
    case 'float':
    case 'real':
      return 'Double';
    case 'date':
    case 'datetime':
    case 'datetime2':
    case 'smalldatetime':
    case 'datetimeoffset':
    case 'time':
      return 'DateTime';
    default:
      // varchar/nvarchar/char/nchar/text/uniqueidentifier/xml/binary/etc.
      return 'String';
  }
}

/**
 * Build the push-table column list from catalog columns, skipping computed
 * columns (push datasets can't ingest a value for them). Returns the columns
 * to define on the model AND the ordered names to SELECT from the source.
 */
export function pushColumnsFromCatalog(cols: SqlColumnRow[]): { pushColumns: PushColumn[]; selectNames: string[] } {
  const usable = cols.filter((c) => !c.isComputed);
  return {
    pushColumns: usable.map((c) => ({ name: c.name, dataType: sqlTypeToPush(c.dataType) })),
    selectNames: usable.map((c) => c.name),
  };
}

/** Bracket-quote a SQL identifier (double any `]`). */
export function bracket(ident: string): string {
  return `[${ident.replace(/]/g, ']]')}]`;
}

/**
 * Coerce one TDS result row (array aligned to `columns`) into the typed JSON
 * object Power BI push rows expect: Dates → ISO strings, Int64/Decimal/Double →
 * numbers, Boolean → bool, everything else → string|null.
 */
export function coerceRow(
  row: unknown[],
  columns: string[],
  pushColumns: PushColumn[],
): Record<string, unknown> {
  const typeByName = new Map(pushColumns.map((c) => [c.name, c.dataType] as const));
  const out: Record<string, unknown> = {};
  columns.forEach((name, i) => {
    const v = row[i];
    const t = typeByName.get(name);
    if (v == null) { out[name] = null; return; }
    if (t === 'DateTime') {
      out[name] = v instanceof Date ? v.toISOString() : String(v);
    } else if (t === 'Int64' || t === 'Double' || t === 'Decimal') {
      const n = typeof v === 'number' ? v : Number(v);
      out[name] = Number.isFinite(n) ? n : null;
    } else if (t === 'Boolean') {
      out[name] = typeof v === 'boolean' ? v : v === 1 || v === '1' || String(v).toLowerCase() === 'true';
    } else {
      out[name] = typeof v === 'string' ? v : String(v);
    }
  });
  return out;
}
