/**
 * Generic CRUD for the 'digital-twin' item (FGC-12) — the persistence handler
 * the Digital Twin Builder editor's useItemState('digital-twin', id) drives:
 *   GET   /api/items/digital-twin/<id>          → { id, displayName, state, updatedAt }
 *   PATCH /api/items/digital-twin/<id> { state } → persists the twin model, returns { updatedAt }
 *   DELETE /api/items/digital-twin/<id>          → removes the item
 *
 * Owner/tenant-scoped via the shared item-crud helpers (no cross-tenant read).
 * The persisted `state` is the TwinModel (entities/relationships/mappings) —
 * Azure-native, Cosmos-backed; NO Microsoft Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem, deleteOwnedItem } from '../../_lib/item-crud';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'digital-twin';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ id, displayName: '', state: {}, updatedAt: null });
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid, { allowReadRoles: true });
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
