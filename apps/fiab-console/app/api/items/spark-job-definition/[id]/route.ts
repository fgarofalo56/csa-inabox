/**
 * GET    /api/items/spark-job-definition/[id]   → return persisted item + spec
 * PUT    /api/items/spark-job-definition/[id]   body { displayName?, description?,
 *                                                       state? } → replace fields.
 * DELETE /api/items/spark-job-definition/[id]   → soft cosmos delete.
 *
 * Spec lives in `item.state.spec` and is shaped like:
 *   { file, className?, args?, conf?, pool }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  deleteOwnedItem, jerr, loadOwnedItem, updateOwnedItem,
} from '../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'spark-job-definition';

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  try {
    const item = await loadOwnedItem(ctx.params.id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    return NextResponse.json({ ok: true, item });
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}

export async function PUT(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const body = await req.json().catch(() => ({}));
  try {
    const updated = await updateOwnedItem(ctx.params.id, ITEM_TYPE, session.claims.oid, body);
    if (!updated) return jerr('not found', 404);
    return NextResponse.json({ ok: true, item: updated });
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  try {
    const ok = await deleteOwnedItem(ctx.params.id, ITEM_TYPE, session.claims.oid);
    if (!ok) return jerr('not found', 404);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}
