/**
 * GET /api/items/azure-sql-managed-instance — list MIs in the subscription
 * POST                                       — persist a pointer item
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listManagedInstances, AzureSqlError } from '@/lib/azure/azure-sql-client';
import { createOwnedItem, jerr } from '../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'azure-sql-managed-instance';

export async function GET() {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  try {
    const instances = await listManagedInstances();
    return NextResponse.json({ ok: true, instances });
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
