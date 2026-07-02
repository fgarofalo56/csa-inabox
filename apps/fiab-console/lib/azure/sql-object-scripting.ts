/**
 * Shared T-SQL catalog enumeration + script-out for the Synapse SQL family
 * (Dedicated SQL pool and the Fabric Warehouse, which is backed by the same
 * Dedicated compute). Both routes call these helpers so the Explorer tree and
 * the "Script as CREATE/ALTER/DROP" action behave identically.
 *
 * Grounded in the Dedicated SQL pool system-views reference:
 *   sys.views, sys.procedures, sys.objects (FN/IF/TF), sys.sql_modules,
 *   sys.schemas — https://learn.microsoft.com/azure/synapse-analytics/
 *   sql-data-warehouse/sql-data-warehouse-reference-tsql-system-views
 *
 * Object names come from the catalog enumeration (not raw user input), but
 * every name is still single-quote-escaped before it reaches a WHERE clause
 * and bracket-sanitized before it is emitted into generated DDL.
 */

import { executeQuery, type SynapseTarget } from '@/lib/azure/synapse-sql-client';

export interface SqlObjectRef {
  schema: string;
  name: string;
}
export interface SqlFunctionRef extends SqlObjectRef {
  /** FN = scalar, IF = inline TVF, TF = multi-statement TVF. */
  type: 'FN' | 'IF' | 'TF';
}
export interface SqlObjectInventory {
  views: SqlObjectRef[];
  procedures: SqlObjectRef[];
  functions: SqlFunctionRef[];
  warnings: string[];
}

const Q_VIEWS = `
SELECT TOP 500 s.name AS [schema], v.name AS name
FROM sys.views v
JOIN sys.schemas s ON s.schema_id = v.schema_id
WHERE v.is_ms_shipped = 0
ORDER BY s.name, v.name`;

const Q_PROCS = `
SELECT TOP 500 s.name AS [schema], p.name AS name
FROM sys.procedures p
JOIN sys.schemas s ON s.schema_id = p.schema_id
WHERE p.is_ms_shipped = 0
ORDER BY s.name, p.name`;

const Q_FUNCS = `
SELECT TOP 500 s.name AS [schema], o.name AS name, o.type AS [type]
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type IN ('FN','IF','TF') AND o.is_ms_shipped = 0
ORDER BY s.name, o.name`;

/** Enumerate views / stored procedures / functions for the Explorer tree.
 *  Each query is independently caught so one empty/failed catalog does not
 *  fail the whole response (partial-but-honest, per no-vaporware.md). */
export async function enumerateSqlObjects(target: SynapseTarget): Promise<SqlObjectInventory> {
  const warnings: string[] = [];

  async function safe<T>(label: string, q: string, map: (rows: unknown[][]) => T[]): Promise<T[]> {
    try {
      const r = await executeQuery(target, q);
      return map(r.rows as unknown[][]);
    } catch (e: any) {
      warnings.push(`${label}: ${e?.message || String(e)}`);
      return [];
    }
  }

  const [views, procedures, functions] = await Promise.all([
    safe('views', Q_VIEWS, (rows) =>
      rows.map((r) => ({ schema: String(r[0]), name: String(r[1]) }))),
    safe('procedures', Q_PROCS, (rows) =>
      rows.map((r) => ({ schema: String(r[0]), name: String(r[1]) }))),
    safe('functions', Q_FUNCS, (rows) =>
      rows.map((r) => {
        const t = String(r[2]).trim();
        const type: SqlFunctionRef['type'] = t === 'IF' ? 'IF' : t === 'TF' ? 'TF' : 'FN';
        return { schema: String(r[0]), name: String(r[1]), type };
      })),
  ]);

  return { views, procedures, functions, warnings };
}

export type ScriptObjectType = 'view' | 'procedure' | 'function';
export type ScriptMode = 'create' | 'alter' | 'drop';

function ddlKeyword(type: ScriptObjectType): 'VIEW' | 'PROCEDURE' | 'FUNCTION' {
  return type === 'view' ? 'VIEW' : type === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
}

function bracket(id: string): string {
  // Strip any closing bracket so the identifier cannot break out of [ ].
  return `[${id.replace(/]/g, '')}]`;
}

/** Build a runnable DROP … IF EXISTS for the object (no backend call needed). */
export function dropScript(type: ScriptObjectType, schema: string, name: string): string {
  return `DROP ${ddlKeyword(type)} IF EXISTS ${bracket(schema)}.${bracket(name)};`;
}

export interface ScriptOutResult {
  ok: boolean;
  script?: string;
  error?: string;
}

/** Fetch the real OBJECT_DEFINITION body for CREATE/ALTER, or build a DROP. */
export async function scriptOutSqlObject(
  target: SynapseTarget,
  opts: { type: ScriptObjectType; schema: string; name: string; mode: ScriptMode },
): Promise<ScriptOutResult> {
  const { type, schema, name, mode } = opts;

  if (mode === 'drop') {
    return { ok: true, script: dropScript(type, schema, name) };
  }

  const safeSchema = schema.replace(/'/g, "''");
  const safeName = name.replace(/'/g, "''");
  const lookup = `
SELECT m.definition
FROM sys.sql_modules m
JOIN sys.objects o ON o.object_id = m.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name = N'${safeSchema}' AND o.name = N'${safeName}'`;

  let definition = '';
  try {
    const r = await executeQuery(target, lookup);
    definition = (r.rows?.[0]?.[0] as string) || '';
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }

  if (!definition) {
    return { ok: false, error: `No definition found for ${bracket(schema)}.${bracket(name)}.` };
  }

  if (mode === 'alter') {
    // Rewrite the leading CREATE [OR ALTER] to CREATE OR ALTER so the script
    // re-applies in place. Dedicated SQL pools support CREATE OR ALTER for
    // views/procedures; for scalar functions the user runs it as a re-create.
    return { ok: true, script: definition.replace(/^\s*CREATE\s+(OR\s+ALTER\s+)?/i, 'CREATE OR ALTER ') };
  }

  return { ok: true, script: definition };
}

/** Narrow an arbitrary string to a ScriptObjectType, or null. */
export function asScriptObjectType(v: string | null): ScriptObjectType | null {
  return v === 'view' || v === 'procedure' || v === 'function' ? v : null;
}
/** Narrow an arbitrary string to a ScriptMode, or null. */
export function asScriptMode(v: string | null): ScriptMode | null {
  return v === 'create' || v === 'alter' || v === 'drop' ? v : null;
}
