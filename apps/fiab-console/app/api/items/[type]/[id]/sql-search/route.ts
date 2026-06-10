/**
 * SQL Database "Search" management (FTS + Vector index) — BFF route.
 *
 *   GET  /api/items/[type]/[id]/sql-search?server=&database=
 *        → live search state for the wizard pickers + state tables:
 *          { ftCatalogs, ftIndexes, keyIndexCandidates, ftColumnCandidates,
 *            vectorColumnCandidates, vectorIndexes, capabilities }
 *
 *   POST /api/items/[type]/[id]/sql-search
 *        body { wizard, params, preview?, server?, database? }
 *        - preview:true  → returns { ok, sql } WITHOUT executing (preview pane)
 *        - preview:false → executes the generated T-SQL over TDS and returns
 *                          { ok, sql, recordsAffected, executionMs }
 *
 * Wizards (SQL built server-side from structured params — never raw client SQL):
 *   - ft-catalog / ft-catalog-drop   CREATE/DROP FULLTEXT CATALOG
 *   - ft-index   / ft-index-drop     CREATE/DROP FULLTEXT INDEX
 *   - vector-index / vector-index-drop  CREATE VECTOR INDEX (DiskANN) / DROP INDEX
 *
 * Backend (Azure-native default, NO Microsoft Fabric): Azure SQL Database via
 * TDS + Microsoft Entra access token (server + database from the editor state).
 * Full-text search and DiskANN vector indexes are first-party data-plane
 * features of Azure SQL Database — no extra Azure resource / env var is
 * required, so there is no infra gate beyond "pick a server + database".
 *
 * AUTH IS ENTRA-ONLY (azure-sql-client builds the pool with an Entra token).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeQuery as azureSqlExecute, AzureSqlError } from '@/lib/azure/azure-sql-client';
import { splitSqlBatches } from '@/lib/sql/tsql-builders';
import {
  buildSearchWizardSql,
  TsqlBuildError,
  SQL_LIST_FT_CATALOGS,
  SQL_LIST_FT_INDEXES,
  SQL_LIST_KEY_INDEX_CANDIDATES,
  SQL_LIST_FT_COLUMN_CANDIDATES,
  SQL_LIST_VECTOR_COLUMN_CANDIDATES,
  SQL_LIST_VECTOR_INDEXES,
  SQL_PROBE_SEARCH_CAPABILITIES,
  type SearchWizardKind,
} from '@/lib/sql/sql-search-builders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Reader {
  run: (sql: string) => Promise<{ columns: string[]; rows: unknown[][] }>;
  exec: (sql: string) => Promise<{ recordsAffected: number; executionMs: number }>;
}
interface Gate { gated: true; error: string }

/**
 * Resolve the Azure SQL backend. The Search surface is Azure SQL only — FTS +
 * native vector indexes are Azure SQL Database data-plane features. Returns an
 * honest "pick a server + database" gate when unbound (never a Fabric gate).
 */
function resolveBackend(type: string, opts: { server?: string; database?: string }): Reader | Gate {
  if (type !== 'azure-sql-database' && type !== 'sql-database') {
    return {
      gated: true,
      error:
        'Full-text search and vector indexes are managed here for Azure SQL Database only. ' +
        'Open this surface from an azure-sql-database item.',
    };
  }
  if (!opts.server || !opts.database) {
    return {
      gated: true,
      error:
        'Pick a server and database on the Connect tab first — the Search wizards run against ' +
        'that Azure SQL database via TDS + Microsoft Entra token.',
    };
  }
  const server = opts.server;
  const database = opts.database;
  return {
    run: async (sql: string) => {
      const r = await azureSqlExecute(server, database, sql);
      return { columns: r.columns, rows: r.rows };
    },
    exec: async (sql: string) => {
      const started = Date.now();
      let recordsAffected = 0;
      for (const batch of splitSqlBatches(sql)) {
        const r = await azureSqlExecute(server, database, batch);
        recordsAffected += r.rowCount;
      }
      return { recordsAffected, executionMs: Date.now() - started };
    },
  };
}

function rowsToObjects(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}

async function ctxParams(ctx: { params: Promise<{ type: string; id: string }> }) {
  return ctx.params;
}

// ============================================================
// GET — live FTS + vector state for pickers + state tables
// ============================================================

export async function GET(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { type } = await ctxParams(ctx);
  const server = req.nextUrl.searchParams.get('server') || undefined;
  const database = req.nextUrl.searchParams.get('database') || undefined;

  const backend = resolveBackend(type, { server, database });
  if ('gated' in backend) {
    return NextResponse.json({ ok: false, gated: true, error: backend.error }, { status: 200 });
  }

  async function safe(label: string, sql: string) {
    try {
      const r = await (backend as Reader).run(sql);
      return { rows: rowsToObjects(r.columns, r.rows), error: undefined as string | undefined };
    } catch (e: any) {
      return { rows: [] as Record<string, unknown>[], error: `${label}: ${e?.message || String(e)}` };
    }
  }

  try {
    const [cats, fti, keyIdx, ftCols, vecCols, vecIdx, caps] = await Promise.all([
      safe('ftCatalogs', SQL_LIST_FT_CATALOGS),
      safe('ftIndexes', SQL_LIST_FT_INDEXES),
      safe('keyIndexCandidates', SQL_LIST_KEY_INDEX_CANDIDATES),
      safe('ftColumnCandidates', SQL_LIST_FT_COLUMN_CANDIDATES),
      safe('vectorColumnCandidates', SQL_LIST_VECTOR_COLUMN_CANDIDATES),
      safe('vectorIndexes', SQL_LIST_VECTOR_INDEXES),
      safe('capabilities', SQL_PROBE_SEARCH_CAPABILITIES),
    ]);

    // Group key-index candidates + columns by schema.table for the pickers.
    const keyIndexesByTable: Record<string, string[]> = {};
    for (const r of keyIdx.rows) {
      const key = `${String(r.schema_name)}.${String(r.table_name)}`;
      (keyIndexesByTable[key] ||= []).push(String(r.index_name));
    }
    const ftColumnsByTable: Record<string, { name: string; dataType: string }[]> = {};
    for (const r of ftCols.rows) {
      const key = `${String(r.schema_name)}.${String(r.object_name)}`;
      (ftColumnsByTable[key] ||= []).push({ name: String(r.column_name), dataType: String(r.data_type) });
    }
    const vectorColumnsByTable: Record<string, string[]> = {};
    for (const r of vecCols.rows) {
      const key = `${String(r.schema_name)}.${String(r.object_name)}`;
      (vectorColumnsByTable[key] ||= []).push(String(r.column_name));
    }

    const cap = caps.rows[0] || {};
    const warnings = [cats.error, fti.error, keyIdx.error, ftCols.error, vecCols.error, vecIdx.error, caps.error]
      .filter(Boolean) as string[];

    return NextResponse.json({
      ok: true,
      ftCatalogs: cats.rows,
      ftIndexes: fti.rows,
      keyIndexesByTable,
      ftColumnsByTable,
      vectorColumnsByTable,
      vectorIndexes: vecIdx.rows,
      capabilities: {
        majorVersion: cap.major_version != null ? Number(cap.major_version) : null,
        productVersion: cap.product_version != null ? String(cap.product_version) : null,
        hasVectorType: cap.has_vector_type === 1 || cap.has_vector_type === true,
        ftsInstalled: cap.fts_installed === 1 || cap.fts_installed === true,
      },
      ...(warnings.length ? { warnings } : {}),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

// ============================================================
// POST — preview / execute a wizard
// ============================================================

export async function POST(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { type } = await ctxParams(ctx);
  const body = await req.json().catch(() => ({}));
  const server = body?.server ? String(body.server) : undefined;
  const database = body?.database ? String(body.database) : undefined;

  const backend = resolveBackend(type, { server, database });
  if ('gated' in backend) {
    return NextResponse.json({ ok: false, gated: true, error: backend.error }, { status: 200 });
  }

  const wizard = String(body?.wizard || '') as SearchWizardKind;
  const preview = body?.preview === true;
  const params = body?.params ?? {};

  let sql: string;
  try {
    sql = buildSearchWizardSql(wizard, params);
  } catch (e: any) {
    const status = e instanceof TsqlBuildError ? 400 : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }

  if (preview) {
    return NextResponse.json({ ok: true, preview: true, sql });
  }

  try {
    const receipt = await backend.exec(sql);
    return NextResponse.json({
      ok: true,
      sql,
      recordsAffected: receipt.recordsAffected,
      executionMs: receipt.executionMs,
      executedBy: session.claims.upn,
    });
  } catch (e: any) {
    const status = e instanceof AzureSqlError ? e.status : 502;
    return NextResponse.json({
      ok: false,
      sql,
      error: e?.message || String(e),
      code: e?.code,
      sqlNumber: e?.number,
    }, { status });
  }
}
