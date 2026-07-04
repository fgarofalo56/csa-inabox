/**
 * Search-management BFF for Azure SQL Database — full-text search (FTS) and
 * SQL Server 2025 native vector indexes, driven entirely by guided dialogs in
 * the AzureSqlDatabaseEditor (Fabric Build 2026 #23).
 *
 * Real backend: every read AND every DDL is executed over live TDS + AAD MI
 * via `executeQuery` (azure-sql-client). NO Microsoft Fabric and NO mock data
 * on any path — the Azure-native engine is the only backend.
 *
 * GET  /api/items/azure-sql-database/[id]/search-management?server=&database=&kind=inventory|columns&objectName=
 *   - kind=inventory (default): catalogs + fts indexes + vector indexes + a
 *     pick-list of base tables with their eligible FTS columns, vector columns,
 *     and single-column unique non-null indexes (for the KEY INDEX dropdown).
 *   - kind=columns&objectName=schema.table: columns of one table.
 *
 * POST /api/items/azure-sql-database/[id]/search-management
 *   body { server, database, action, ... } where action is one of:
 *     - 'create-catalog'  { name, accentSensitivity?, asDefault? }
 *     - 'drop-catalog'    { name }
 *     - 'create-fts'      { schema, table, columns:[{name,language?}], keyIndex, catalog, changeTracking, stoplist? }
 *     - 'populate-fts'    { schema, table, mode:'AUTO'|'MANUAL'|'START FULL'|'START INCREMENTAL'|'STOP' }
 *     - 'drop-fts'        { schema, table }
 *     - 'create-vector'   { schema, table, column, name, metric, type?, maxdop? }
 *     - 'drop-vector'     { schema, table, name }
 *
 * Identifiers are validated against a strict whitelist and bracket-quoted before
 * interpolation, so the dialog inputs can never inject arbitrary T-SQL. All DDL
 * is returned in the response (`ddl`) so the UI can show exactly what ran.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeQuery, AzureSqlError } from '@/lib/azure/azure-sql-client';
import { escapeSqlLiteral, bracket } from '@/lib/sql/quoting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Identifier safety ────────────────────────────────────────────────────────
// SQL Server identifiers may contain almost anything when quoted, but for a
// guided-dialog surface we deliberately restrict to the common, safe subset and
// bracket-quote. This blocks injection while covering every realistic name.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$#@ ]*$/;

class ValidationError extends Error {}

function quoteIdent(name: string, label: string): string {
  const v = String(name || '').trim();
  if (!v) throw new ValidationError(`${label} is required`);
  if (v.length > 128) throw new ValidationError(`${label} too long (max 128)`);
  if (!IDENT_RE.test(v)) throw new ValidationError(`${label} '${v}' contains characters that aren't allowed here`);
  return bracket(v);
}
function quoteString(v: string): string {
  return `'${escapeSqlLiteral(String(v ?? ''))}'`;
}

function jerr(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

function readState(req: NextRequest) {
  const server = String(req.nextUrl.searchParams.get('server') || '').trim();
  const database = String(req.nextUrl.searchParams.get('database') || '').trim();
  return { server, database };
}

// ── GET: inventory + dialog pick-lists ───────────────────────────────────────
export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { server, database } = readState(req);
  if (!server) return jerr('server is required');
  if (!database) return jerr('database is required');
  const kind = (req.nextUrl.searchParams.get('kind') || 'inventory').toLowerCase();

  try {
    if (kind === 'columns') {
      const objectName = String(req.nextUrl.searchParams.get('objectName') || '').trim();
      if (!objectName) return jerr('objectName is required for kind=columns');
      const columns = await runRows(server, database, `
        SELECT c.name AS column_name, t.name AS data_type, c.max_length AS max_length
        FROM sys.columns c
        JOIN sys.types t ON t.user_type_id = c.user_type_id
        WHERE c.object_id = OBJECT_ID(${quoteString(objectName)})
        ORDER BY c.column_id;`);
      return NextResponse.json({ ok: true, columns });
    }

    const out: Record<string, unknown> = { ok: true };

    out.catalogs = await runRows(server, database, `
      SELECT name, is_default, is_accent_sensitivity_on
      FROM sys.fulltext_catalogs ORDER BY name;`);

    out.ftsIndexes = await runRows(server, database, `
      SELECT SCHEMA_NAME(t.schema_id) AS schema_name, t.name AS table_name,
             c.name AS catalog_name, fi.change_tracking_state_desc AS change_tracking,
             fi.is_enabled,
             STUFF((SELECT ', ' + col.name FROM sys.fulltext_index_columns fic
                    JOIN sys.columns col ON col.object_id = fic.object_id AND col.column_id = fic.column_id
                    WHERE fic.object_id = fi.object_id FOR XML PATH('')), 1, 2, '') AS columns
      FROM sys.fulltext_indexes fi
      JOIN sys.tables t ON t.object_id = fi.object_id
      JOIN sys.fulltext_catalogs c ON c.fulltext_catalog_id = fi.fulltext_catalog_id
      ORDER BY schema_name, table_name;`);

    // sys.vector_indexes exists only on SQL 2025 / Azure SQL DB with the
    // feature. Probe defensively so older engines return [] with a note,
    // never an error that breaks the whole inventory.
    try {
      out.vectorIndexes = await runRows(server, database, `
        IF OBJECT_ID('sys.vector_indexes') IS NOT NULL
        BEGIN
          SELECT SCHEMA_NAME(t.schema_id) AS schema_name, t.name AS table_name,
                 i.name AS index_name,
                 JSON_VALUE(v.build_parameters, '$.Metric') AS metric,
                 JSON_VALUE(v.build_parameters, '$.Version') AS version
          FROM sys.vector_indexes v
          JOIN sys.indexes i ON i.object_id = v.object_id AND i.index_id = v.index_id
          JOIN sys.tables t ON t.object_id = v.object_id
          ORDER BY schema_name, table_name, index_name;
        END
        ELSE SELECT TOP 0 CAST(NULL AS sysname) AS schema_name;`);
    } catch {
      out.vectorIndexes = [];
      out.vectorNote = 'sys.vector_indexes not available on this engine (SQL Server 2025 / Azure SQL Database required).';
    }

    // Base tables for the create dialogs.
    out.tables = await runRows(server, database, `
      SELECT SCHEMA_NAME(schema_id) AS schema_name, name AS table_name, object_id
      FROM sys.tables ORDER BY schema_name, table_name;`);
    // FTS-eligible columns per table (char/varchar/.../xml/varbinary/image).
    out.ftsColumns = await runRows(server, database, `
      SELECT SCHEMA_NAME(t.schema_id) AS schema_name, t.name AS table_name, c.name AS column_name, ty.name AS data_type
      FROM sys.columns c
      JOIN sys.tables t ON t.object_id = c.object_id
      JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      WHERE ty.name IN ('char','varchar','nchar','nvarchar','text','ntext','xml','image','varbinary')
      ORDER BY schema_name, table_name, c.column_id;`);
    // Vector-typed columns per table (data_type 'vector' on SQL 2025).
    out.vectorColumns = await runRows(server, database, `
      SELECT SCHEMA_NAME(t.schema_id) AS schema_name, t.name AS table_name, c.name AS column_name
      FROM sys.columns c
      JOIN sys.tables t ON t.object_id = c.object_id
      JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      WHERE ty.name = 'vector'
      ORDER BY schema_name, table_name, c.column_id;`);
    // Single-column, unique, non-nullable indexes — eligible KEY INDEX for FTS.
    out.keyIndexes = await runRows(server, database, `
      SELECT SCHEMA_NAME(t.schema_id) AS schema_name, t.name AS table_name, i.name AS index_name
      FROM sys.indexes i
      JOIN sys.tables t ON t.object_id = i.object_id
      WHERE i.is_unique = 1 AND i.is_disabled = 0 AND i.name IS NOT NULL
        AND (SELECT COUNT(*) FROM sys.index_columns ic WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id) = 1
        AND NOT EXISTS (
          SELECT 1 FROM sys.index_columns ic
          JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
          WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND col.is_nullable = 1)
      ORDER BY schema_name, table_name, index_name;`);

    return NextResponse.json(out);
  } catch (e: any) {
    if (e instanceof ValidationError) return jerr(e.message);
    const status = e instanceof AzureSqlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.code }, { status });
  }
}

// ── POST: create / drop / populate ───────────────────────────────────────────
export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const body = await req.json().catch(() => ({}));
  const server = String(body?.server || '').trim();
  const database = String(body?.database || '').trim();
  const action = String(body?.action || '').trim();
  if (!server) return jerr('server is required');
  if (!database) return jerr('database is required');
  if (!action) return jerr('action is required');

  let ddl = '';
  try {
    ddl = buildDdl(action, body);
  } catch (e: any) {
    if (e instanceof ValidationError) return jerr(e.message);
    throw e;
  }

  try {
    const result = await executeQuery(server, database, ddl);
    return NextResponse.json({
      ok: true,
      action,
      ddl,
      rowCount: result.rowCount,
      executionMs: result.executionMs,
      columns: result.columns,
      rows: result.rows,
    });
  } catch (e: any) {
    const status = e instanceof AzureSqlError ? e.status : 502;
    return NextResponse.json({
      ok: false, action, ddl,
      error: e?.message || String(e), code: e?.code, sqlNumber: e?.number,
    }, { status });
  }
}

// ── DDL builders (server-side, escaped) ──────────────────────────────────────
function objRef(schema: string, table: string): string {
  return `${quoteIdent(schema || 'dbo', 'schema')}.${quoteIdent(table, 'table')}`;
}

function buildDdl(action: string, b: any): string {
  switch (action) {
    case 'create-catalog': {
      const name = quoteIdent(b.name, 'catalog name');
      const accent = b.accentSensitivity === false ? 'OFF' : 'ON';
      const asDefault = b.asDefault ? ' AS DEFAULT' : '';
      return `CREATE FULLTEXT CATALOG ${name} WITH ACCENT_SENSITIVITY = ${accent}${asDefault};`;
    }
    case 'drop-catalog':
      return `DROP FULLTEXT CATALOG ${quoteIdent(b.name, 'catalog name')};`;

    case 'create-fts': {
      const ref = objRef(b.schema, b.table);
      const cols = Array.isArray(b.columns) ? b.columns : [];
      if (cols.length === 0) throw new ValidationError('at least one column is required');
      const colSql = cols.map((c: any) => {
        let frag = `  ${quoteIdent(c.name, 'column')}`;
        if (c.language != null && String(c.language).trim() !== '') {
          const lang = String(c.language).trim();
          if (!/^\d{1,7}$/.test(lang)) throw new ValidationError(`language LCID '${lang}' must be a numeric LCID`);
          frag += ` LANGUAGE ${lang}`;
        }
        return frag;
      }).join(',\n');
      const keyIndex = quoteIdent(b.keyIndex, 'KEY INDEX');
      const onCatalog = b.catalog ? ` ON ${quoteIdent(b.catalog, 'catalog')}` : '';
      const ct = String(b.changeTracking || 'AUTO').toUpperCase();
      if (!['AUTO', 'MANUAL', 'OFF'].includes(ct)) {
        throw new ValidationError(`invalid change tracking '${ct}'`);
      }
      let withClause: string;
      if (b.stoplist) {
        const sl = b.stoplist === 'SYSTEM' ? 'SYSTEM' : b.stoplist === 'OFF' ? 'OFF' : quoteIdent(b.stoplist, 'stoplist');
        withClause = `\nWITH STOPLIST = ${sl}, CHANGE_TRACKING ${ct}`;
      } else {
        withClause = `\nWITH CHANGE_TRACKING ${ct}`;
      }
      return `CREATE FULLTEXT INDEX ON ${ref} (\n${colSql}\n) KEY INDEX ${keyIndex}${onCatalog}${withClause};`;
    }
    case 'populate-fts': {
      const ref = objRef(b.schema, b.table);
      const mode = String(b.mode || '').toUpperCase();
      switch (mode) {
        case 'AUTO': return `ALTER FULLTEXT INDEX ON ${ref} SET CHANGE_TRACKING AUTO;`;
        case 'MANUAL': return `ALTER FULLTEXT INDEX ON ${ref} SET CHANGE_TRACKING MANUAL;`;
        case 'START FULL': return `ALTER FULLTEXT INDEX ON ${ref} START FULL POPULATION;`;
        case 'START INCREMENTAL': return `ALTER FULLTEXT INDEX ON ${ref} START INCREMENTAL POPULATION;`;
        case 'STOP': return `ALTER FULLTEXT INDEX ON ${ref} STOP POPULATION;`;
        default: throw new ValidationError(`invalid populate mode '${b.mode}'`);
      }
    }
    case 'drop-fts':
      return `DROP FULLTEXT INDEX ON ${objRef(b.schema, b.table)};`;

    case 'create-vector': {
      const ref = objRef(b.schema, b.table);
      const col = quoteIdent(b.column, 'vector column');
      const name = quoteIdent(b.name, 'index name');
      const metric = String(b.metric || 'cosine').toLowerCase();
      if (!['cosine', 'dot', 'euclidean'].includes(metric)) throw new ValidationError(`invalid metric '${b.metric}'`);
      const type = String(b.type || 'DiskANN');
      if (type.toUpperCase() !== 'DISKANN') throw new ValidationError(`only TYPE = 'DiskANN' is supported`);
      let withClause = `METRIC = '${metric}', TYPE = 'DiskANN'`;
      if (b.maxdop != null && String(b.maxdop).trim() !== '') {
        const md = Number(b.maxdop);
        if (!Number.isInteger(md) || md < 0 || md > 64) throw new ValidationError('MAXDOP must be 0-64');
        withClause += `, MAXDOP = ${md}`;
      }
      return `CREATE VECTOR INDEX ${name}\n  ON ${ref} (${col})\n  WITH (${withClause});`;
    }
    case 'drop-vector':
      return `DROP INDEX ${quoteIdent(b.name, 'index name')} ON ${objRef(b.schema, b.table)};`;

    default:
      throw new ValidationError(`unknown action '${action}'`);
  }
}

// ── Helper: run a read query and shape rows to objects ───────────────────────
async function runRows(server: string, database: string, sqlText: string): Promise<Array<Record<string, unknown>>> {
  const r = await executeQuery(server, database, sqlText);
  const cols = r.columns || [];
  return (r.rows || []).map((row: unknown[]) => {
    const o: Record<string, unknown> = {};
    cols.forEach((c: string, i: number) => { o[c] = row[i]; });
    return o;
  });
}
