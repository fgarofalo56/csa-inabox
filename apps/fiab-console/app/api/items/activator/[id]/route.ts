/**
 * GET    /api/items/activator/[id]?workspaceId=...
 * PUT    /api/items/activator/[id]?workspaceId=...   body { displayName?, description? }
 * DELETE /api/items/activator/[id]?workspaceId=...
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getActivator, updateActivator, deleteActivator, ActivatorError } from '@/lib/azure/activator-client';
import { loadContentBackedItem, activatorRuleFromContent } from '../../_lib/ai-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Bundle fallback: a bundle-installed activator is a Cosmos item whose
 * ActivatorContent.rule lives in state.content but has no live Fabric reflex
 * yet. Surface the reflex detail + its single rule built-out from state.content
 * so the editor opens FULLY BUILT-OUT instead of erroring when the live reflex
 * is absent. The rule list / Start / Stop / trigger paths still hit the live
 * Fabric backend (or the /rules bundle fallback). Returns null when this item
 * carries no activator content.
 */
async function loomActivator(id: string, tenantId: string, workspaceId: string) {
  const item = await loadContentBackedItem(id, 'activator', tenantId);
  if (!item) return null;
  const rule = activatorRuleFromContent(item);
  if (!rule) return null;
  return NextResponse.json({
    ok: true,
    workspaceId,
    activator: { id: item.id, displayName: item.displayName, description: item.description, type: 'Reflex' },
    rules: [rule],
    source: 'bundle' as const,
    __loomContent: true as const,
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const id = (await ctx.params).id;
  try {
    const activator = await getActivator(workspaceId, id);
    return NextResponse.json({ ok: true, workspaceId, activator });
  } catch (e: any) {
    // Live Fabric reflex absent — surface the bundle-installed activator's rule
    // from state.content so the editor renders the reflex rather than an error.
    const resp = await loomActivator(id, session.claims.oid, workspaceId);
    if (resp) return resp;
    const status = e instanceof ActivatorError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  try {
    const activator = await updateActivator(workspaceId, (await ctx.params).id, {
      displayName: body?.displayName ? String(body.displayName) : undefined,
      description: body?.description ? String(body.description) : undefined,
    });
    return NextResponse.json({ ok: true, activator });
  } catch (e: any) {
    const status = e instanceof ActivatorError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    await deleteActivator(workspaceId, (await ctx.params).id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e instanceof ActivatorError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
