/**
 * Generic CRUD for the 'plan' item — the persistence handler the Phase-4
 * editor's useItemState(<type>, id) drives:
 *   GET   /api/items/plan/<id>          → { id, displayName, state, updatedAt }
 *   PATCH /api/items/plan/<id> { state } → persists, returns { updatedAt }
 *   DELETE /api/items/plan/<id>          → removes the item
 *
 * Before this route existed the editor PATCHed a 404 and silently lost every
 * edit while showing a "Saved" badge (no-vaporware grade F). Backed by the
 * shared, tenant-scoped item-crud helpers.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem, deleteOwnedItem } from '../../_lib/item-crud';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'plan';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ id, displayName: '', state: {}, updatedAt: null });
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
    if (!item) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({
      id: item.id,
      displayName: item.displayName,
      description: item.description,
      state: item.state || {},
      updatedAt: item.updatedAt || null,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ error: 'save the item before patching (no id yet)' }, { status: 400 });
  const body = await req.json().catch(() => ({} as any));
  try {
    const updated = await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, {
      displayName: body?.displayName,
      ...('description' in (body || {}) ? { description: body.description } : {}),
      ...(body?.state && typeof body.state === 'object' ? { state: body.state } : {}),
    });
    if (!updated) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, id: updated.id, updatedAt: updated.updatedAt });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    await deleteOwnedItem(id, ITEM_TYPE, s.claims.oid);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return apiServerError(e);
  }
}
