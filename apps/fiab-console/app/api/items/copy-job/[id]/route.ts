/**
 * GET    /api/items/copy-job/[id]   → return persisted copy spec.
 * PUT    /api/items/copy-job/[id]   body { displayName?, description?, state? }
 * DELETE /api/items/copy-job/[id]   → cosmos delete + best-effort pipeline cleanup.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { deletePipeline } from '@/lib/azure/synapse-dev-client';
import {
  deleteOwnedItem, jerr, loadOwnedItem, updateOwnedItem,
} from '../../_lib/item-crud';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'copy-job';
const pipelineName = (id: string) => `loom-copy-${id}`;

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
    // Best-effort: drop the materialised pipeline. Don't fail the delete if it
    // never existed.
    try { await deletePipeline(pipelineName((await ctx.params).id)); } catch { /* ignore */ }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return apiServerError(e);
  }
}
