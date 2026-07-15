/**
 * Generic CRUD for the 'agent-flow' item (W9) — the persistence handler the
 * editor's useItemState('agent-flow', id) drives:
 *   GET   → { id, displayName, description, state, updatedAt }
 *   PATCH   { displayName?, description?, state? }  (owner-scoped upsert)
 *   DELETE  → cosmos delete (+ mirror cleanup via deleteOwnedItem)
 *
 * The item's `state` holds the FlowDag: `instructions`, `tools` (AIF-5 typed
 * tool nodes), `subAgents` (AIF-4 connected sub-agent refs), `flowLayout`, and
 * `runs[]`. Action sub-routes (run / runs) are unaffected. Route-guard
 * compliant via the shared owner-scoped item-crud helpers.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem, deleteOwnedItem } from '../../_lib/item-crud';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'agent-flow';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ id, displayName: '', state: {}, updatedAt: null });
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid, { allowReadRoles: true });
    if (!item) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({
      id: item.id, displayName: item.displayName, description: item.description,
      workspaceId: item.workspaceId,
      state: item.state || {}, updatedAt: item.updatedAt || null,
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
    const ok = await deleteOwnedItem(id, ITEM_TYPE, s.claims.oid);
    if (!ok) return NextResponse.json({ ok: true }); // already gone — converge
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return apiServerError(e);
  }
}
