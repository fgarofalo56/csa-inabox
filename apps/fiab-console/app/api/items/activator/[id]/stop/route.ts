/**
 * POST /api/items/activator/[id]/stop?workspaceId=...
 *
 * Azure-native default: pause each rule's Azure Monitor scheduledQueryRule via
 * an in-place ARM PATCH (properties.enabled=false) — symmetric with
 * start/route.ts and preserving the rule's query, SCOPES (Log Analytics or the
 * ADX alert host), and action group. Never re-upsert here: a re-PUT without the
 * record's scopes would recreate a scoped ADX rule against the default LA
 * workspace with ADX KQL (wrong scope; fails LA validation). Unscheduled
 * Eventhouse/ADX rules (no ARM rule when LOOM_ADX_ALERT_SCOPE is unset) pause
 * by flipping the persisted enabled flag — they evaluate on-demand via
 * Trigger/Preview. Fabric opt-in: real Fabric REST sets every trigger Stopped.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { stopReflex, ActivatorError } from '@/lib/azure/activator-client';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { loadContentBackedItem } from '../../../_lib/ai-content-fallback';
import { disableMonitorRule, isOnDemandAdxRule } from '@/lib/azure/activator-monitor';
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
  // via an in-place ARM PATCH (properties.enabled=false — preserves query,
  // scopes, and action group) so "stop" actually halts evaluation. Unscheduled
  // Eventhouse/ADX rules have NO ARM rule — flip the persisted enabled flag
  // instead. Mark the persisted state Disabled. Mirrors start/route.ts exactly.
  if (!useFabric()) {
    const item = await loadContentBackedItem(ctx.params.id, 'activator', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'activator not found' }, { status: 404 });
    const rules: any[] = Array.isArray((item.state as any)?.rules) ? (item.state as any).rules : [];
    let armUpdated = 0; let onDemand = 0; let failed = 0;
    for (const r of rules) {
      if (!r?.azureRuleName) continue;
      if (isOnDemandAdxRule(r)) {
        r.state = 'Disabled'; r.updatedAt = new Date().toISOString(); onDemand += 1;
        continue;
      }
      try {
        await disableMonitorRule(r.azureRuleName);
        r.state = 'Disabled'; r.updatedAt = new Date().toISOString(); armUpdated += 1;
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
    if (armUpdated) parts.push(`${armUpdated} Azure Monitor alert rule(s) disabled`);
    if (onDemand) parts.push(`${onDemand} on-demand Eventhouse/ADX rule(s) disabled — no scheduled ARM rule (LOOM_ADX_ALERT_SCOPE unset); enabled flag updated`);
    if (failed) parts.push(`${failed} rule(s) failed to disable on ARM`);
    if (!persisted) parts.push('warning: rule state could not be persisted to Cosmos — reload may show stale state');
    return NextResponse.json({
      ok: true, updated, armUpdated, onDemand, failed, backend: 'azure-monitor',
      message: parts.length ? `${parts.join('; ')}.` : 'No rules to stop.',
    });
  }

  try {
    const r = await stopReflex(workspaceId, ctx.params.id);
    return NextResponse.json(r);
  } catch (e: any) {
    const status = e instanceof ActivatorError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
