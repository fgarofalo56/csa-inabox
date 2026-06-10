/**
 * Vector index + Full-Text Search management for an Azure SQL database.
 *
 *   GET  ?server=&database=
 *     → full search/vector inventory (existing vector indexes, FTS catalogs,
 *       FTS indexes) + the candidate columns / unique key indexes the create
 *       dialogs need to populate their dropdowns. One TDS round-trip.
 *
 *   POST { server, database, kind, spec }
 *     kind = 'vector-index'   → CREATE VECTOR INDEX (DiskANN)
 *     kind = 'fts-catalog'    → CREATE FULLTEXT CATALOG
 *     kind = 'fts-index'      → CREATE FULLTEXT INDEX
 *       → builds the DDL from structured `spec` fields (no raw SQL from the
 *         client; every identifier is brace-quoted server-side) and executes
 *         it over TDS + AAD MI. Returns the executed `sql` text for the receipt.
 *
 * Azure-native, no Microsoft Fabric. Vector indexes require SQL Server 2025 /
 * Azure SQL Database (engine major ≥ 17); an older engine surfaces an honest
 * MessageBar-friendly note from the inventory rather than a fake success.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getSearchInventory,
  buildCreateVectorIndexSql,
  buildCreateFullTextCatalogSql,
  buildCreateFullTextIndexSql,
  executeQueryBatch,
  AzureSqlError,
  type CreateVectorIndexSpec,
  type CreateFullTextCatalogSpec,
  type CreateFullTextIndexSpec,
} from '@/lib/azure/azure-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const server = (req.nextUrl.searchParams.get('server') || '').trim();
  const database = (req.nextUrl.searchParams.get('database') || '').trim();
  if (!server) return NextResponse.json({ ok: false, error: 'server is required' }, { status: 400 });
  if (!database) return NextResponse.json({ ok: false, error: 'database is required' }, { status: 400 });
  try {
    const inventory = await getSearchInventory(server, database);
    return NextResponse.json({ ok: true, inventory });
  } catch (e: any) {
    const status = e instanceof AzureSqlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.code }, { status });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const server = String(body?.server || '').trim();
  const database = String(body?.database || '').trim();
  const kind = String(body?.kind || '').trim();
  const spec = body?.spec ?? {};
  if (!server) return NextResponse.json({ ok: false, error: 'server is required' }, { status: 400 });
  if (!database) return NextResponse.json({ ok: false, error: 'database is required' }, { status: 400 });

  let sql: string;
  try {
    switch (kind) {
      case 'vector-index':
        sql = buildCreateVectorIndexSql(spec as CreateVectorIndexSpec);
        break;
      case 'fts-catalog':
        sql = buildCreateFullTextCatalogSql(spec as CreateFullTextCatalogSpec);
        break;
      case 'fts-index':
        sql = buildCreateFullTextIndexSql(spec as CreateFullTextIndexSpec);
        break;
      default:
        return NextResponse.json({ ok: false, error: `unknown kind '${kind}'` }, { status: 400 });
    }
  } catch (e: any) {
    const status = e instanceof AzureSqlError ? e.status : 400;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }

  try {
    const result = await executeQueryBatch(server, database, sql);
    return NextResponse.json({
      ok: true,
      sql,
      messages: result.messages,
      executionMs: result.executionMs,
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
