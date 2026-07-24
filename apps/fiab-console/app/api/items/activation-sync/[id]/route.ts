/**
 * GET    /api/items/activation-sync/[id]   → persisted spec (owner-scoped).
 * PUT    /api/items/activation-sync/[id]   body { displayName?, description?, state? } → save.
 * DELETE /api/items/activation-sync/[id]   → cosmos delete.
 *
 * PUT coerces `state` through coerceSpec so the item can never persist freeform
 * config — only dropdown-constrained enums + sanitized mapping pairs survive.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { deleteOwnedItem, jerr, updateOwnedItem } from '../../_lib/item-crud';
import { apiOk, apiServerError } from '@/lib/api/respond';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { coerceSpec } from '@/lib/activation/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'activation-sync';

export const GET = withWorkspaceOwner(ITEM_TYPE, (_req, { item }) => apiOk({ item }));

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const body = await req.json().catch(() => ({}));
  try {
    const patch: Record<string, unknown> = { ...body };
    if (body?.state !== undefined) patch.state = coerceSpec(body.state);
    const updated = await updateOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid, patch);
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
