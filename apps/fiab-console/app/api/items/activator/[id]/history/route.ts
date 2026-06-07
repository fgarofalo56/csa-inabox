/**
 * GET /api/items/activator/[id]/history?workspaceId=...&days=30
 *
 * Run history / trigger log for an Activator (Reflex). Returns the last-30-days
 * fired/resolved Azure Monitor alert instances for every scheduledQueryRule that
 * backs the activator's rules. Reads the persisted MonitorRuleRecord[] from
 * state.rules on the Cosmos item to discover the azureRuleName values, then calls
 * Microsoft.AlertsManagement/alerts (alertRule filter) per rule and merges.
 *
 * Backend (per .claude/rules/no-fabric-dependency.md): Azure Monitor native only
 * — no Microsoft Fabric / Power BI dependency. MonitorNotConfiguredError →
 * honest 503 gate; 401/403 → honest 403 gate naming the role to grant.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getActivatorHistory,
  type MonitorRuleRecord,
} from '@/lib/azure/activator-monitor';
import { MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';
import { loadContentBackedItem } from '@/app/api/items/_lib/ai-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Honest Azure infra-gate (NOT a Fabric gate) for Monitor errors. */
function monitorGate(e: any): NextResponse | null {
  if (e instanceof MonitorNotConfiguredError) {
    return NextResponse.json({
      ok: false,
      error: `Azure Monitor not configured: set ${e.missing?.join(' / ') || 'LOOM_SUBSCRIPTION_ID'}.`,
      gate: {
        reason: 'Run history reads fired/resolved alert instances from Azure Monitor Alerts Management.',
        remediation: `Set ${e.missing?.join(' / ') || 'LOOM_SUBSCRIPTION_ID'} on the Console. No Microsoft Fabric required.`,
      },
    }, { status: 503 });
  }
  if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
    return NextResponse.json({
      ok: false,
      error: `Azure Monitor ${e.status}: not authorized to read alert history.`,
      gate: {
        reason: 'Run history requires Microsoft.AlertsManagement/alerts/read.',
        remediation: 'Grant the Console UAMI the "Monitoring Reader" built-in role at subscription scope.',
      },
    }, { status: 403 });
  }
  return null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const { id } = await ctx.params;
  const days = Math.min(30, Math.max(1, Number(req.nextUrl.searchParams.get('days') || 30)));

  const item = await loadContentBackedItem(id, 'activator', session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'activator not found' }, { status: 404 });

  const rules: MonitorRuleRecord[] = Array.isArray((item.state as any)?.rules)
    ? (item.state as any).rules
    : [];
  const azureRuleNames = rules.map((r) => r.azureRuleName).filter(Boolean);

  // No Azure Monitor rules provisioned yet → empty history (don't query ARM
  // with no filter, which would return unrelated subscription alerts).
  if (!azureRuleNames.length) {
    return NextResponse.json({
      ok: true,
      events: [],
      backend: 'azure-monitor',
      note: 'No Azure Monitor rules provisioned for this activator yet. Add a rule (it becomes a scheduledQueryRule) — its fired/resolved instances appear here.',
    });
  }

  try {
    const events = await getActivatorHistory(azureRuleNames, { days });
    return NextResponse.json({ ok: true, events, backend: 'azure-monitor' });
  } catch (e: any) {
    return monitorGate(e) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
