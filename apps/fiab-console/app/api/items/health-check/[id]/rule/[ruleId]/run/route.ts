/**
 * POST /api/items/health-check/[id]/rule/[ruleId]/run
 *   → run the check's KQL against the Log Analytics workspace NOW and report
 *     whether it would fire (rows > 0). The Azure-native "Run now / test-fire"
 *     for a health check — same query the scheduledQueryRule evaluates.
 *
 * Azure-native DEFAULT — no Microsoft Fabric. Honest infra-gate when the Log
 * Analytics workspace isn't configured / the UAMI lacks read access.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../../../_lib/item-crud';
import { triggerMonitorActivatorRule, type MonitorRuleRecord } from '@/lib/azure/activator-monitor';
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
      error: `Azure Monitor not configured: set ${e.missing?.join(' / ') || 'LOOM_LOG_ANALYTICS_WORKSPACE_ID'}.`,
      gate: { reason: 'Running a check evaluates its KQL against the Log Analytics workspace.', remediation: `Set ${e.missing?.join(' / ') || 'LOOM_LOG_ANALYTICS_WORKSPACE_ID'} on the Console. No Microsoft Fabric required.` },
    }, { status: 503 });
  }
  if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
    return NextResponse.json({
      ok: false,
      error: `Azure Monitor ${e.status}: not authorized to query Log Analytics.`,
      gate: { reason: 'The Console UAMI needs read access to the Log Analytics workspace.', remediation: 'Grant the Console UAMI "Log Analytics Reader" on the workspace.' },
    }, { status: 403 });
  }
  return null;
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string; ruleId: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id, ruleId } = await ctx.params;
  const hc = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!hc) return err('health-check not found', 404, 'not_found');
  const rules: MonitorRuleRecord[] = Array.isArray((hc.state as any)?.rules) ? (hc.state as any).rules : [];
  const rule = rules.find((r) => r.id === ruleId || r.azureRuleName === ruleId) || null;
  if (!rule) return err('rule not found', 404, 'rule_not_found');
  if (!rule.query?.trim()) return err('rule has no query to run', 400, 'no_query');
  try {
    const r = await triggerMonitorActivatorRule(rule.query);
    return NextResponse.json({
      ok: true,
      ruleId: rule.id,
      fired: r.fired,
      count: r.count,
      columns: r.columns,
      rows: r.rows.slice(0, 20),
      backend: 'azure-monitor',
    });
  } catch (e: any) {
    return monitorGate(e) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
