/**
 * GET /api/items/kql-database/[id]
 * Returns live ADX database details (size, retention, hot cache, table count).
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  clusterUri, defaultDatabase, getDatabaseDetails, listTables,
  listFunctions, listMaterializedViews,
  loadKustoItem, resolveDatabase, KustoError,
} from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const item = await loadKustoItem((await ctx.params).id, 'kql-database', session.claims.oid);
    const database = resolveDatabase(item);
    const [details, tables, functions, materializedViews] = await Promise.all([
      getDatabaseDetails(database).catch(() => null),
      listTables(database).catch(() => []),
      listFunctions(database).catch(() => []),
      listMaterializedViews(database).catch(() => []),
    ]);
    return NextResponse.json({
      ok: true,
      cluster: clusterUri(),
      database,
      defaultDatabase: defaultDatabase(),
      details,
      tables,
      tableCount: tables.length,
      functions,
      functionCount: functions.length,
      materializedViews,
      materializedViewCount: materializedViews.length,
      displayName: item?.displayName,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
