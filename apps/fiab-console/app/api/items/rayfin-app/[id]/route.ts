/**
 * CRUD for the 'rayfin-app' item.
 *   GET /api/items/rayfin-app/<id>           → { id, displayName, state, updatedAt }
 *   PUT /api/items/rayfin-app/<id> { state }  → persists, returns { updatedAt }
 *   DELETE …
 *
 * The RayfinAppEditor authors a Rayfin app spec + emits the @microsoft/rayfin
 * SDK model and CLI commands (the honest "generate artifact" pattern, like the
 * deploy planner emitting bicep) and persists the spec via state.spec. The
 * route was missing, so the editor's Save PUT 404'd and the spec was lost on
 * reload (no-vaporware grade-F per the 2026-06-04 audit). The editor uses PUT
 * with body { state: { spec } } and reads j.state.spec back. Backed by the
 * shared tenant-scoped item-crud helpers.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem, deleteOwnedItem } from '../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'rayfin-app';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ id, displayName: '', state: {}, updatedAt: null });
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
    if (!item) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({
      id: item.id, displayName: item.displayName, description: item.description,
      state: item.state || {}, updatedAt: item.updatedAt || null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

async function persist(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ error: 'save the item before patching (no id yet)' }, { status: 400 });
  const body = await req.json().catch(() => ({} as any));
  try {
    const updated = await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, {
      displayName: body?.displayName,
      ...(body?.state && typeof body.state === 'object' ? { state: body.state } : {}),
    });
    if (!updated) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, id: updated.id, updatedAt: updated.updatedAt });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

export const PUT = persist;
export const PATCH = persist;

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    await deleteOwnedItem(id, ITEM_TYPE, s.claims.oid);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
