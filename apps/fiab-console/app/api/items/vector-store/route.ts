/**
 * GET  /api/items/vector-store — list owned items of type vector-store
 * POST /api/items/vector-store — persist a new vector-store item; state is freeform per type
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createOwnedItem, jerr, listOwnedItems } from '../_lib/item-crud';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'vector-store';
export async function GET() {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const items = await listOwnedItems(ITEM_TYPE, session.claims.oid).catch(() => []);
  return NextResponse.json({ ok: true, items });
}
export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const body = await req.json().catch(() => ({}));
  const r = await createOwnedItem(session, ITEM_TYPE, body);
  if (!r.ok) return jerr(r.error, r.status);
  return NextResponse.json({ ok: true, item: r.item }, { status: 201 });
}
