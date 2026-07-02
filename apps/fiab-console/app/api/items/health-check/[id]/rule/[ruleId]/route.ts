/**
 * PATCH  /api/items/health-check/[id]/rule/[ruleId]  body { enabled:boolean }
 *   → enable / disable the backing Azure Monitor scheduledQueryRule in place
 *     (properties.enabled), preserving its query / scope / action group, and
 *     mirror the new state onto the health-check item's state.rules.
 * DELETE /api/items/health-check/[id]/rule/[ruleId]
 *   → delete the scheduledQueryRule from ARM and splice it from state.rules.
 *
 * `ruleId` is the persisted MonitorRuleRecord.id (== its azureRuleName). Real
 * Azure Monitor lifecycle (Microsoft.Insights/scheduledQueryRules). Azure-native
 * DEFAULT — no Microsoft Fabric. Honest infra-gate when Monitor isn't set up.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../../_lib/item-crud';
import {
  enableMonitorRule,
  disableMonitorRule,
  deleteMonitorActivatorRule,
  type MonitorRuleRecord,
} from '@/lib/azure/activator-monitor';
import { MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';
import { monitorGate, type MonitorGateBodies } from '@/lib/azure/monitor-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'health-check';

function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
}
const monitorGateBodies: MonitorGateBodies = {
  notConfigured: (missing) => ({ error: `Azure Monitor not configured: set ${missing?.join(' / ') || 'LOOM_SUBSCRIPTION_ID / LOOM_ALERT_RG'}.`,
      gate: { reason: 'Health-check rules are Azure Monitor scheduled-query alert rules.', remediation: `Set ${missing?.join(' / ') || 'LOOM_SUBSCRIPTION_ID + LOOM_ALERT_RG'} on the Console. No Microsoft Fabric required.` },
    }),
  unauthorized: (status) => ({ error: `Azure Monitor ${status}: not authorized to manage alert rules.`,
      gate: { reason: 'The Console UAMI needs rights on the alert resource group.', remediation: 'Grant the Console UAMI "Monitoring Contributor" on LOOM_ALERT_RG.' },
    }),
};

async function findRule(id: string, oid: string, ruleId: string) {
  const hc = await loadOwnedItem(id, ITEM_TYPE, oid);
  if (!hc) return { hc: null as any, rule: null as MonitorRuleRecord | null, rules: [] as MonitorRuleRecord[] };
  const rules: MonitorRuleRecord[] = Array.isArray((hc.state as any)?.rules) ? (hc.state as any).rules : [];
  const rule = rules.find((r) => r.id === ruleId || r.azureRuleName === ruleId) || null;
  return { hc, rule, rules };
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; ruleId: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id, ruleId } = await ctx.params;
  const body = await req.json().catch(() => ({} as any));
  const enabled = body?.enabled !== false;
  const { hc, rule, rules } = await findRule(id, s.claims.oid, ruleId);
  if (!hc) return err('health-check not found', 404, 'not_found');
  if (!rule) return err('rule not found', 404, 'rule_not_found');
  try {
    if (enabled) await enableMonitorRule(rule.azureRuleName);
    else await disableMonitorRule(rule.azureRuleName);
  } catch (e: any) {
    return monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
  const nextState = { ...((hc.state || {}) as Record<string, unknown>) };
  nextState.rules = rules.map((r) =>
    r.id === rule.id ? { ...r, state: enabled ? 'Active' : 'Disabled', updatedAt: new Date().toISOString() } : r,
  );
  await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state: nextState });
  return NextResponse.json({ ok: true, ruleId: rule.id, state: enabled ? 'Active' : 'Disabled', backend: 'azure-monitor' });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string; ruleId: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id, ruleId } = await ctx.params;
  const { hc, rule, rules } = await findRule(id, s.claims.oid, ruleId);
  if (!hc) return err('health-check not found', 404, 'not_found');
  if (!rule) return err('rule not found', 404, 'rule_not_found');
  try {
    await deleteMonitorActivatorRule(rule.azureRuleName);
  } catch (e: any) {
    return monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
  const nextState = { ...((hc.state || {}) as Record<string, unknown>) };
  nextState.rules = rules.filter((r) => r.id !== rule.id);
  await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state: nextState });
  return NextResponse.json({ ok: true, deleted: rule.id, backend: 'azure-monitor' });
}
