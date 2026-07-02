/**
 * POST /api/items/activator/[id]/start?workspaceId=...
 *
 * Azure-native default (per .claude/rules/no-fabric-dependency.md): re-enable
 * each backing Azure Monitor scheduledQueryRule (PATCH properties.enabled=true)
 * so "start" is a real, observable ARM action — not a bare count. Unscheduled
 * Eventhouse/ADX rules (no ARM rule when LOOM_ADX_ALERT_SCOPE is unset) resume
 * by flipping the persisted enabled flag — they evaluate on-demand via
 * Trigger/Preview — and the response says so honestly. Mark the persisted
 * state Active so the editor/pane reflect it on
 * reload. A Fabric Reflex remains an opt-in alternative
 * (LOOM_ACTIVATOR_BACKEND=fabric) and sets every trigger to Active via Fabric
 * REST. No Fabric workspace is required for the default path.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { startReflex, ActivatorError } from '@/lib/azure/activator-client';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { loadContentBackedItem } from '../../../_lib/ai-content-fallback';
import { enableMonitorRule, isOnDemandAdxRule } from '@/lib/azure/activator-monitor';
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
  // (PATCH enabled:true) so "start" actually resumes evaluation. UNSCHEDULED
  // Eventhouse/ADX rules (scheduled !== true — no ARM rule exists, the PATCH
  // would 404 and silently no-op) resume by flipping the persisted enabled flag:
  // they evaluate on-demand via Trigger/Preview. Mirrors stop/route.ts exactly.
  if (!useFabric()) {
    const item = await loadContentBackedItem(ctx.params.id, 'activator', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'activator not found' }, { status: 404 });
    const rules: any[] = Array.isArray((item.state as any)?.rules) ? (item.state as any).rules : [];
    let armUpdated = 0; let onDemand = 0; let failed = 0;
    for (const r of rules) {
      if (!r?.azureRuleName) continue;
      if (isOnDemandAdxRule(r)) {
        r.state = 'Active'; r.updatedAt = new Date().toISOString(); onDemand += 1;
        continue;
      }
      try {
        await enableMonitorRule(r.azureRuleName);
        r.state = 'Active'; r.updatedAt = new Date().toISOString(); armUpdated += 1;
      } catch { failed += 1; /* honest: reported in the response, not silently dropped */ }
    }
    let persisted = true;
    try {
      const items = await itemsContainer();
      const next: WorkspaceItem = { ...item, state: { ...(item.state || {}), rules }, updatedAt: new Date().toISOString() };
      await items.item(item.id, item.workspaceId).replace(next);
    } catch { persisted = false; }
    const updated = armUpdated + onDemand;
    const parts: string[] = [];
    if (armUpdated) parts.push(`${armUpdated} Azure Monitor alert rule(s) (re)enabled`);
    if (onDemand) parts.push(`${onDemand} on-demand Eventhouse/ADX rule(s) enabled — no scheduled ARM rule (LOOM_ADX_ALERT_SCOPE unset); they evaluate via Trigger/Preview`);
    if (failed) parts.push(`${failed} rule(s) failed to enable on ARM`);
    if (!persisted) parts.push('warning: rule state could not be persisted to Cosmos — reload may show stale state');
    return NextResponse.json({
      ok: true, updated, armUpdated, onDemand, failed, backend: 'azure-monitor',
      message: parts.length ? `${parts.join('; ')}.` : 'No rules to start.',
    });
  }

  try {
    const r = await startReflex(workspaceId, ctx.params.id);
    return NextResponse.json(r);
  } catch (e: any) {
    const status = e instanceof ActivatorError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
