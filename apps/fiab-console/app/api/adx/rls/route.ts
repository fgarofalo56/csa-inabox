/**
 * Row-level security (RLS) policy authoring for a table on the ADX/KQL database
 * bound to a kql-database item.
 *
 *   GET  /api/adx/rls?id=ITEM&table=T
 *     → { ok, database, table, policy: { enabled, query, raw } | null }
 *     → .show table ["<T>"] policy row_level_security
 *
 *   POST /api/adx/rls?id=ITEM
 *     body { table, enabled, query }
 *     → .alter table ["<T>"] policy row_level_security enable|disable "<query>"
 *     → { ok, database, table, applied: { enabled, query } }
 *
 * Real Kusto control commands to /v1/rest/mgmt. Table/Database Admin required.
 * Honest 503 gate when LOOM_KUSTO_CLUSTER_URI is unset. No mocks.
 * No Fabric / OneLake dependency — targets the stand-alone ADX cluster.
 */

import { NextRequest, NextResponse } from 'next/server';
import { showTableRlsPolicy, setTableRlsPolicy } from '@/lib/azure/kusto-client';
import { guardAdxRequest, adxError, validName } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_QUERY = 4096;

export async function GET(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const table = req.nextUrl.searchParams.get('table')?.trim();
  if (!validName(table)) return NextResponse.json({ ok: false, error: 'table query param is required and must be a valid Kusto name' }, { status: 400 });
  try {
    const policy = await showTableRlsPolicy(g.ctx.database, table);
    return NextResponse.json({ ok: true, database: g.ctx.database, table, policy });
  } catch (e: any) {
    return adxError(e);
  }
}

export async function POST(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const body = await req.json().catch(() => ({}));
  const table: string = typeof body?.table === 'string' ? body.table.trim() : '';
  const enabled = Boolean(body?.enabled);
  const query: string = typeof body?.query === 'string' ? body.query : '';

  if (!validName(table)) {
    return NextResponse.json({ ok: false, error: 'table is required and must be a valid Kusto name' }, { status: 400 });
  }
  if (enabled && !query.trim()) {
    return NextResponse.json({ ok: false, error: 'a KQL predicate query is required when enabling RLS' }, { status: 400 });
  }
  if (query.length > MAX_QUERY) {
    return NextResponse.json({ ok: false, error: `query exceeds ${MAX_QUERY} characters` }, { status: 400 });
  }

  try {
    await setTableRlsPolicy(g.ctx.database, table, enabled, query);
    return NextResponse.json({ ok: true, database: g.ctx.database, table, applied: { enabled, query: query.trim() } });
  } catch (e: any) {
    return adxError(e);
  }
}
