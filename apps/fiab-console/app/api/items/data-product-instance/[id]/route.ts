/**
 * GET /api/items/data-product-instance/[id] — fetch a persisted instance.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, jerr } from '../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const item = await loadOwnedItem(ctx.params.id, 'data-product-instance', session.claims.oid);
  if (!item) return jerr('not found', 404);
  return NextResponse.json({ ok: true, item });
}
