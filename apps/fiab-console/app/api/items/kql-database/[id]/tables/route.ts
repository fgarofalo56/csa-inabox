/**
 * GET /api/items/kql-database/[id]/tables
 * Lists tables in the resolved database. Optional ?table=<name> appends
 * the JSON schema for that table.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listTables, getTableSchema, loadKustoItem, resolveDatabase, KustoError,
} from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const item = await loadKustoItem(ctx.params.id, 'kql-database', session.claims.oid);
    const database = resolveDatabase(item);
    const tables = await listTables(database);
    const which = req.nextUrl.searchParams.get('table');
    let schema: unknown = null;
    if (which) {
      schema = await getTableSchema(database, which).catch(() => null);
    }
    return NextResponse.json({ ok: true, database, tables, schema });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
