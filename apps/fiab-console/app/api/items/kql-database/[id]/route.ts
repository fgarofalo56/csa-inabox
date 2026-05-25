/**
 * GET /api/items/kql-database/[id]
 * Returns live ADX database details (size, retention, hot cache, table count).
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  clusterUri, defaultDatabase, getDatabaseDetails, listTables,
  loadKustoItem, resolveDatabase, KustoError,
} from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const item = await loadKustoItem(ctx.params.id, 'kql-database', session.claims.oid);
    const database = resolveDatabase(item);
    const [details, tables] = await Promise.all([
      getDatabaseDetails(database).catch(() => null),
      listTables(database).catch(() => []),
    ]);
    return NextResponse.json({
      ok: true,
      cluster: clusterUri(),
      database,
      defaultDatabase: defaultDatabase(),
      details,
      tables,
      tableCount: tables.length,
      displayName: item?.displayName,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
