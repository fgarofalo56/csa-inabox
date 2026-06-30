/**
 * GET /api/items/health-check/[id]/history?days=14
 *   → fired / resolved Azure Monitor alert instances (Microsoft.AlertsManagement)
 *     for every scheduledQueryRule backing this health check, newest-first.
 *
 * Azure-native DEFAULT — no Microsoft Fabric. Honest infra-gate when Monitor
 * isn't configured / the UAMI lacks Monitoring Reader.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { getActivatorHistory, type MonitorRuleRecord } from '@/lib/azure/activator-monitor';
import { MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'health-check';

function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
}
function monitorGate(e: any): NextResponse | null {
  if (e instanceof MonitorNotConfiguredError) {
    return NextResponse.json({
      ok: false,
      error: `Azure Monitor not configured: set ${e.missing?.join(' / ') || 'LOOM_SUBSCRIPTION_ID'}.`,
      gate: { reason: 'Fired-alert history comes from Azure Monitor AlertsManagement.', remediation: `Set ${e.missing?.join(' / ') || 'LOOM_SUBSCRIPTION_ID'} on the Console. No Microsoft Fabric required.` },
    }, { status: 503 });
  }
  if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
    return NextResponse.json({
      ok: false,
      error: `Azure Monitor ${e.status}: not authorized to read alert history.`,
      gate: { reason: 'The Console UAMI needs Monitoring Reader at subscription scope.', remediation: 'Grant the Console UAMI "Monitoring Reader" on the subscription.' },
    }, { status: 403 });
  }
  return null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ ok: true, events: [] });
  const hc = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!hc) return err('health-check not found', 404, 'not_found');
  const rules: MonitorRuleRecord[] = Array.isArray((hc.state as any)?.rules) ? (hc.state as any).rules : [];
  const names = rules.map((r) => r.azureRuleName).filter(Boolean) as string[];
  if (!names.length) return NextResponse.json({ ok: true, events: [] });
  const daysRaw = Number(new URL(req.url).searchParams.get('days'));
  const days = Number.isFinite(daysRaw) ? Math.min(30, Math.max(1, Math.round(daysRaw))) : 14;
  try {
    const events = await getActivatorHistory(names, { days });
    return NextResponse.json({ ok: true, events, backend: 'azure-monitor' });
  } catch (e: any) {
    return monitorGate(e) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
