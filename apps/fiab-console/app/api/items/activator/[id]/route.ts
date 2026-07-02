/**
 * GET    /api/items/activator/[id]?workspaceId=...
 * PUT    /api/items/activator/[id]?workspaceId=...   body { displayName?, description? }
 * DELETE /api/items/activator/[id]?workspaceId=...
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getActivator, updateActivator, deleteActivator, ActivatorError } from '@/lib/azure/activator-client';
import { deleteMonitorActivatorRule } from '@/lib/azure/activator-monitor';
import { loadContentBackedItem, activatorRuleFromContent } from '../../_lib/ai-content-fallback';
import { loadOwnedItem, deleteOwnedItem, updateOwnedItem } from '../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Per no-fabric-dependency.md the Activator DEFAULTS to the Azure-native backend
// (Cosmos item + Azure Monitor scheduledQueryRules). Fabric Reflexes are opt-in.
const useFabric = () => process.env.LOOM_ACTIVATOR_BACKEND === 'fabric';

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

  // ── Azure Monitor (DEFAULT) ── per no-fabric-dependency.md the activator detail
  // is built from the Cosmos item, NOT from a live Fabric reflex. The audit (B4)
  // flagged the old GET for ALWAYS calling api.fabric.microsoft.com → raw 401/502
  // for a default-backend activator that has no state.content.rule. Build the
  // detail + rule list from the persisted item (state.rules, then state.content
  // bundle fallback) so the editor opens FULLY BUILT-OUT with no Fabric call.
  if (!useFabric()) {
    try {
      const item = await loadOwnedItem(id, 'activator', session.claims.oid);
      if (!item) return NextResponse.json({ ok: false, error: 'activator not found' }, { status: 404 });
      const persisted = Array.isArray((item.state as any)?.rules) ? (item.state as any).rules : [];
      // Prefer live-provisioned rules; fall back to the bundle's state.content.rule.
      const bundleRule = persisted.length === 0 ? activatorRuleFromContent(item) : null;
      const rules = persisted.length > 0 ? persisted : bundleRule ? [bundleRule] : [];
      return NextResponse.json({
        ok: true,
        workspaceId,
        activator: { id: item.id, displayName: item.displayName, description: item.description, type: 'Reflex' },
        rules,
        backend: 'azure-monitor' as const,
        ...(bundleRule ? { source: 'bundle' as const, __loomContent: true as const } : {}),
      });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  // ── Fabric Reflex (opt-in only) ──
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

  // ── Azure Monitor (DEFAULT) ── per no-fabric-dependency.md the activator is a
  // Cosmos-owned item; patch its displayName/description directly (which also
  // re-indexes the search/governance/data-product mirrors) instead of calling
  // api.fabric.microsoft.com on the default path, matching GET/DELETE above.
  const id = (await ctx.params).id;
  if (!useFabric()) {
    try {
      const updated = await updateOwnedItem(id, 'activator', session.claims.oid, {
        displayName: body?.displayName ? String(body.displayName) : undefined,
        description: body?.description ? String(body.description) : undefined,
      });
      if (!updated) return NextResponse.json({ ok: false, error: 'activator not found' }, { status: 404 });
      return NextResponse.json({ ok: true, backend: 'azure-monitor', activator: { id: updated.id, displayName: updated.displayName, description: updated.description, type: 'Reflex' } });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  // ── Fabric Reflex (opt-in only) ──
  try {
    const activator = await updateActivator(workspaceId, id, {
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
  const id = (await ctx.params).id;

  // ── Azure Monitor (DEFAULT) ── the activator is a Cosmos item; delete it and
  // best-effort remove its backing scheduledQueryRules. NO Fabric REST call on
  // the default path (no-fabric-dependency.md — the audit flagged the old code
  // for always hitting api.fabric.microsoft.com → 401 here).
  if (!useFabric()) {
    try {
      const item = await loadOwnedItem(id, 'activator', session.claims.oid);
      if (!item) return NextResponse.json({ ok: false, error: 'activator not found' }, { status: 404 });
      const rules: Array<{ azureRuleName?: string }> = Array.isArray((item.state as any)?.rules) ? (item.state as any).rules : [];
      for (const r of rules) {
        if (r?.azureRuleName) {
          try { await deleteMonitorActivatorRule(r.azureRuleName); } catch { /* best-effort cleanup */ }
        }
      }
      const ok = await deleteOwnedItem(id, 'activator', session.claims.oid);
      if (!ok) return NextResponse.json({ ok: false, error: 'activator not found' }, { status: 404 });
      return NextResponse.json({ ok: true, backend: 'azure-monitor' });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  // ── Fabric Reflex (opt-in only) ──
  try {
    await deleteActivator(workspaceId, id);
    return NextResponse.json({ ok: true, backend: 'fabric' });
  } catch (e: any) {
    const status = e instanceof ActivatorError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
