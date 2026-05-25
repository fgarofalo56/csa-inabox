/**
 * GET  /api/items/environment       — list environment items owned by tenant.
 * POST /api/items/environment       body { workspaceId, displayName,
 *                                       description?, state? } → create.
 *
 * `state` shape: { requirements: string, conf: Record<string,string>, jars: string[] }
 * Apply-to-pool is performed by the editor calling
 *   PUT /api/items/synapse-spark-pool/[poolName]
 * with the merged librarySpec — no extra route needed here.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createOwnedItem, jerr, listOwnedItems } from '../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'environment';

export async function GET() {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  try {
    const items = await listOwnedItems(ITEM_TYPE, session.claims.oid);
    return NextResponse.json({ ok: true, items });
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const body = await req.json().catch(() => ({}));
  try {
    const r = await createOwnedItem(session, ITEM_TYPE, body);
    if (!r.ok) return jerr(r.error, r.status);
    return NextResponse.json({ ok: true, item: r.item }, { status: 201 });
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}
