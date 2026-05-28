/**
 * POST /api/items/kql-database/[id]/query
 * Body: { kql: string, db?: string }
 * Executes KQL against the resolved database (or override).
 * Mgmt commands (starting with `.`) are routed to the mgmt endpoint.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  executeQuery, executeMgmtCommand, loadKustoItem, resolveDatabase, KustoError,
} from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const kql = (body?.kql || '').toString().trim();
  if (!kql) return NextResponse.json({ ok: false, error: 'kql is required' }, { status: 400 });
  if (kql.length > 65_536) return NextResponse.json({ ok: false, error: 'kql too large (>64KB)' }, { status: 413 });

  try {
    const item = await loadKustoItem((await ctx.params).id, 'kql-database', session.claims.oid);
    const database = (body?.db && String(body.db)) || resolveDatabase(item);
    const isMgmt = kql.startsWith('.');
    const result = isMgmt
      ? await executeMgmtCommand(database, kql)
      : await executeQuery(database, kql);
    return NextResponse.json({
      ok: true,
      database,
      mode: isMgmt ? 'mgmt' : 'query',
      ...result,
      executedBy: session.claims.upn,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
