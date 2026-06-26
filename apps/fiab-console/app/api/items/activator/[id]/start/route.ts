/**
 * POST /api/items/activator/[id]/start?workspaceId=...
 *
 * Azure-native default (per .claude/rules/no-fabric-dependency.md): re-enable
 * each backing Azure Monitor scheduledQueryRule (PATCH properties.enabled=true)
 * so "start" is a real, observable ARM action — not a bare count. Best-effort
 * per rule; mark the persisted state Active so the editor/pane reflect it on
 * reload. A Fabric Reflex remains an opt-in alternative
 * (LOOM_ACTIVATOR_BACKEND=fabric) and sets every trigger to Active via Fabric
 * REST. No Fabric workspace is required for the default path.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { startReflex, ActivatorError } from '@/lib/azure/activator-client';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { loadContentBackedItem } from '../../../_lib/ai-content-fallback';
import { enableMonitorRule } from '@/lib/azure/activator-monitor';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const useFabric = () => process.env.LOOM_ACTIVATOR_BACKEND === 'fabric';

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  // Azure-native default: re-enable each rule's Azure Monitor scheduledQueryRule
  // (PATCH enabled:true) so "start" actually resumes evaluation. Best-effort per
  // rule; mark the persisted state Active. Mirrors stop/route.ts exactly.
  if (!useFabric()) {
    const item = await loadContentBackedItem(ctx.params.id, 'activator', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'activator not found' }, { status: 404 });
    const rules: any[] = Array.isArray((item.state as any)?.rules) ? (item.state as any).rules : [];
    let updated = 0;
    for (const r of rules) {
      if (!r?.azureRuleName) continue;
      try {
        await enableMonitorRule(r.azureRuleName);
        r.state = 'Active'; updated += 1;
      } catch { /* best-effort */ }
    }
    try {
      const items = await itemsContainer();
      const next: WorkspaceItem = { ...item, state: { ...(item.state || {}), rules }, updatedAt: new Date().toISOString() };
      await items.item(item.id, item.workspaceId).replace(next);
    } catch { /* tolerate */ }
    return NextResponse.json({ ok: true, updated, backend: 'azure-monitor', message: `${updated} Azure Monitor alert rule(s) (re)enabled.` });
  }

  try {
    const r = await startReflex(workspaceId, ctx.params.id);
    return NextResponse.json(r);
  } catch (e: any) {
    const status = e instanceof ActivatorError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
