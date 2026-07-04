/**
 * GET  /api/items/spark-job-definition       — list spark-job-definition items
 *                                              owned by caller's tenant.
 * POST /api/items/spark-job-definition       body { workspaceId, displayName,
 *                                              description?, state? } → create.
 *
 * State persistence only — actual Spark submission is /[id]/submit which
 * forwards to the Synapse dev endpoint (Livy).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createOwnedItem, jerr, listOwnedItems } from '../_lib/item-crud';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'spark-job-definition';

export async function GET() {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  try {
    const items = await listOwnedItems(ITEM_TYPE, session.claims.oid);
    return NextResponse.json({ ok: true, items });
  } catch (e: any) {
    return apiServerError(e);
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
    return apiServerError(e);
  }
}
