/**
 * Row-Level Security (RLS) policy authoring on the ADX/KQL database bound to a
 * kql-database item.
 *
 *   GET  /api/adx/rls?id=ITEM&table=T
 *        → { ok, database, table, policy: { isEnabled, query, raw } | null }
 *
 *   POST /api/adx/rls?id=ITEM  body { table, enabled, query }
 *        → validates the KQL predicate (validateKustoRlsQuery), issues
 *          .alter table ["T"] policy row_level_security enable|disable "<query>",
 *          reads it back as the receipt → { ok, table, policy, warning? }
 *
 * Real Kusto control commands against /v1/rest/mgmt (Console UAMI holds
 * AllDatabasesAdmin). The predicate is the one free-form field in this feature;
 * it is sanitized server-side before the command is issued (no control commands,
 * no `;`, length cap) per loom-no-freeform-config's RLS carve-out. Honest 503
 * via the shared guard when LOOM_KUSTO_CLUSTER_URI is unset. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  showTableRlsPolicy, alterTableRlsPolicy, validateKustoRlsQuery,
} from '@/lib/azure/kusto-client';
import { guardAdxRequest, adxError, validName } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const table = (req.nextUrl.searchParams.get('table') || '').trim();
  if (!validName(table)) {
    return NextResponse.json({ ok: false, error: 'table is required' }, { status: 400 });
  }
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
  const table = typeof body?.table === 'string' ? body.table.trim() : '';
  const enabled = body?.enabled === true;
  const query = typeof body?.query === 'string' ? body.query : '';
  if (!validName(table)) {
    return NextResponse.json({ ok: false, error: 'table must be a valid Kusto entity name' }, { status: 400 });
  }
  // Only validate the predicate when enabling — a disable retains the last query.
  let warning: string | undefined;
  if (enabled) {
    const v = validateKustoRlsQuery(query);
    if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });
    warning = v.warning;
  }
  try {
    await alterTableRlsPolicy(g.ctx.database, table, enabled, query);
    const policy = await showTableRlsPolicy(g.ctx.database, table).catch(() => null);
    return NextResponse.json({ ok: true, database: g.ctx.database, table, policy, warning });
  } catch (e: any) {
    return adxError(e);
  }
}
