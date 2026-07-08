/**
 * GET    /api/items/ai-enrichment/[id]   → return the persisted enrichment item.
 * PUT    /api/items/ai-enrichment/[id]   body { displayName?, description?, state? }
 * DELETE /api/items/ai-enrichment/[id]   → cosmos delete.
 *
 * The item's `state` holds the enrichment config (source warehouse/catalog/
 * schema/table/column, operation + options, output column, batch/concurrency,
 * model tier) plus `state.runs[]` — the persisted run history (AIF-7).
 * Owner-scoped via loadOwnedItem / updateOwnedItem (route-guard compliant).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  deleteOwnedItem, jerr, loadOwnedItem, updateOwnedItem,
} from '../../_lib/item-crud';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ai-enrichment';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  try {
    const item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    return NextResponse.json({ ok: true, item });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const body = await req.json().catch(() => ({}));
  try {
    const updated = await updateOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid, body);
    if (!updated) return jerr('not found', 404);
    return NextResponse.json({ ok: true, item: updated });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  try {
    const ok = await deleteOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid);
    if (!ok) return jerr('not found', 404);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return apiServerError(e);
  }
}
