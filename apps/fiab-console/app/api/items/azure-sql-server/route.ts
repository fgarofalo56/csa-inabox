/**
 * GET  /api/items/azure-sql-server            — list all Microsoft.Sql/servers in the loom subscription
 * POST /api/items/azure-sql-server            — persist a server pointer item in cosmos (caller-tagged)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listServers, AzureSqlError } from '@/lib/azure/azure-sql-client';
import { createOwnedItem, jerr, listOwnedItems } from '../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'azure-sql-server';

export async function GET() {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  try {
    const [servers, items] = await Promise.all([
      listServers().catch((e) => { throw e; }),
      listOwnedItems(ITEM_TYPE, session.claims.oid).catch(() => []),
    ]);
    return NextResponse.json({ ok: true, servers, items });
  } catch (e: any) {
    const status = e instanceof AzureSqlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const body = await req.json().catch(() => ({}));
  const r = await createOwnedItem(session, ITEM_TYPE, body);
  if (!r.ok) return jerr(r.error, r.status);
  return NextResponse.json({ ok: true, item: r.item }, { status: 201 });
}
