/**
 * GET  /api/items/health-check/[id]/rule → { ok, rules: MonitorRuleRecord[] }
 * POST /api/items/health-check/[id]/rule → { ok, rule, backend } | { ok:false, gate }
 *   body: { checkType:'freshness'|'rowcount'|'custom', name?, table?, thresholdMinutes?,
 *           minRows?, customKql?, evaluationFrequency?, windowSize?, email? }
 *
 * Creates a REAL Azure Monitor scheduled-query alert rule (scheduledQueryRules)
 * over the Log Analytics workspace and persists it on the health-check item's
 * state.rules. Azure-native DEFAULT (Fabric Reflex is opt-in via
 * LOOM_ACTIVATOR_BACKEND=fabric). Honest infra-gate when Monitor isn't set up.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { createMonitorActivatorRule, type MonitorRuleRecord } from '@/lib/azure/activator-monitor';
import { MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';
import { buildCheckQuery, CHECK_TYPE_BY_ID } from '../../_lib/check-types';

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
      error: `Azure Monitor not configured: set ${e.missing?.join(' / ') || 'LOOM_LOG_ANALYTICS_RESOURCE_ID / LOOM_ALERT_RG'}.`,
      gate: { reason: 'Health checks create scheduled-query alert rules on Azure Monitor.', remediation: `Set ${e.missing?.join(' / ') || 'LOOM_LOG_ANALYTICS_RESOURCE_ID + LOOM_ALERT_RG'} on the Console. No Microsoft Fabric required.` },
    }, { status: 503 });
  }
  if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
    return NextResponse.json({
      ok: false,
      error: `Azure Monitor ${e.status}: not authorized to create alert rules.`,
      gate: { reason: 'The Console UAMI needs rights on the alert resource group.', remediation: 'Grant the Console UAMI "Monitoring Contributor" on LOOM_ALERT_RG.' },
    }, { status: 403 });
  }
  return null;
}

/**
 * Build a real KQL condition for the chosen check type. Delegates to the shared
 * check-type library (Time / Size / Content / Schema / Status families). The
 * wizard sends a `params` object; legacy callers send flat fields (table /
 * thresholdMinutes / minRows / customKql) which are merged so old clients keep
 * working. A missing / unknown check type falls back to freshness.
 */
function buildQuery(body: any): string | null {
  const checkType = String(body?.checkType || 'freshness');
  const params = { ...(body || {}), ...(body?.params && typeof body.params === 'object' ? body.params : {}) };
  if (CHECK_TYPE_BY_ID[checkType]) return buildCheckQuery(checkType, params);
  // Unknown id → treat as legacy freshness for back-compat.
  return buildCheckQuery('freshness', params);
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ ok: true, rules: [] });
  const hc = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!hc) return err('health-check not found', 404, 'not_found');
  const rules = Array.isArray((hc.state as any)?.rules) ? (hc.state as any).rules : [];
  return NextResponse.json({ ok: true, rules });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the health check before adding a rule (no id yet)', 400, 'no_id');
  const hc = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!hc) return err('health-check not found', 404, 'not_found');
  const body = await req.json().catch(() => ({} as any));
  const query = buildQuery(body);
  if (!query) return err('a custom check requires a KQL condition', 400, 'no_query');
  const name = String(body?.name || `${body?.checkType || 'freshness'}-check`).trim();
  const email = String(body?.email || '').trim();
  const sevRaw = Number(body?.severity);
  const severity = Number.isFinite(sevRaw) && sevRaw >= 0 && sevRaw <= 4 ? Math.round(sevRaw) : undefined;

  let rule: MonitorRuleRecord;
  try {
    // Bind the rule to the item's persisted notification action group (from the
    // Notifications tab) when present; otherwise fall back to a per-rule email.
    const boundActionGroupId = ((hc.state as any)?.actionGroup?.id as string | undefined) || undefined;
    rule = await createMonitorActivatorRule(hc.displayName || 'Health check', {
      name,
      query,
      severity,
      evaluationFrequency: typeof body?.evaluationFrequency === 'string' ? body.evaluationFrequency : 'PT5M',
      windowSize: typeof body?.windowSize === 'string' ? body.windowSize : 'PT15M',
      existingActionGroupId: boundActionGroupId,
      action: email ? { target: email } : undefined,
    });
  } catch (e: any) {
    return monitorGate(e) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  const state = { ...((hc.state || {}) as Record<string, unknown>) };
  const rules: MonitorRuleRecord[] = Array.isArray(state.rules) ? (state.rules as MonitorRuleRecord[]) : [];
  const stamped = { ...rule, checkType: body?.checkType || 'freshness' } as MonitorRuleRecord & Record<string, unknown>;
  state.rules = [...rules.filter((r) => r.id !== rule.id), stamped];
  await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state });
  return NextResponse.json({ ok: true, rule, backend: 'azure-monitor' });
}
