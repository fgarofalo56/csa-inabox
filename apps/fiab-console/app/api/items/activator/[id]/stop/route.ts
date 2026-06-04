/**
 * POST /api/items/activator/[id]/stop?workspaceId=...
 *
 * Real Fabric REST. Sets every trigger on the reflex to Stopped.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { stopReflex, ActivatorError } from '@/lib/azure/activator-client';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { loadContentBackedItem } from '../../../_lib/ai-content-fallback';
import { upsertScheduledQueryRule } from '@/lib/azure/monitor-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const useFabric = () => process.env.LOOM_ACTIVATOR_BACKEND === 'fabric';

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  // Azure-native default: disable each rule's Azure Monitor scheduledQueryRule
  // (re-PUT with enabled:false) so "stop" actually halts evaluation. Best-effort
  // per rule; mark the persisted state Stopped.
  if (!useFabric()) {
    const item = await loadContentBackedItem(ctx.params.id, 'activator', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'activator not found' }, { status: 404 });
    const rules: any[] = Array.isArray((item.state as any)?.rules) ? (item.state as any).rules : [];
    let updated = 0;
    for (const r of rules) {
      if (!r?.azureRuleName || !r?.query) continue;
      try {
        await upsertScheduledQueryRule({ name: r.azureRuleName, query: r.query, severity: r.severity ?? 3, actionGroupIds: r.actionGroupId ? [r.actionGroupId] : undefined, enabled: false });
        r.state = 'Stopped'; updated += 1;
      } catch { /* best-effort */ }
    }
    try {
      const items = await itemsContainer();
      const next: WorkspaceItem = { ...item, state: { ...(item.state || {}), rules }, updatedAt: new Date().toISOString() };
      await items.item(item.id, item.workspaceId).replace(next);
    } catch { /* tolerate */ }
    return NextResponse.json({ ok: true, updated, backend: 'azure-monitor', message: `${updated} Azure Monitor alert rule(s) disabled.` });
  }

  try {
    const r = await stopReflex(workspaceId, ctx.params.id);
    return NextResponse.json(r);
  } catch (e: any) {
    const status = e instanceof ActivatorError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
