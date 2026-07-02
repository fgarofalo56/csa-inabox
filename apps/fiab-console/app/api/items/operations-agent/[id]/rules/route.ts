/**
 * GET    /api/items/operations-agent/[id]/rules
 * POST   /api/items/operations-agent/[id]/rules            body { name, condition?, action?, query?, sourceTable?, severity?, evaluationFrequency?, windowSize?, sourceKind?, adxDatabase?, adxClusterUri? }
 * POST   /api/items/operations-agent/[id]/rules?trigger=<ruleId>   — evaluate the rule's KQL now (would-fire)
 * DELETE /api/items/operations-agent/[id]/rules?ruleId=<id>       — remove the rule (+ its ARM scheduledQueryRule)
 *
 * Triggers for an operations agent = time/data-change actions. Per
 * .claude/rules/no-fabric-dependency.md the DEFAULT backend is Azure-native:
 * each trigger is a real Microsoft.Insights/scheduledQueryRule (+ action group)
 * over Log Analytics, OR — for a rule authored over the agent's Eventhouse — a
 * KQL rule the "Trigger now" path runs against Azure Data Explorer. This route
 * does NOT duplicate that backend: it calls the SAME activator-monitor client
 * (lib/azure/activator-monitor) the /api/items/activator/[id]/rules route uses.
 * It is a distinct route only because that route hard-scopes its item load to
 * itemType 'activator', so it can't persist rules onto an operations-agent item.
 * Rules persist on the ops-agent's own Cosmos state.rules. No Fabric required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import {
  createMonitorActivatorRule,
  triggerMonitorActivatorRule,
  deleteMonitorActivatorRule,
  type MonitorRuleRecord,
} from '@/lib/azure/activator-monitor';
import { MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';
import { monitorGate, type MonitorGateBodies } from '@/lib/azure/monitor-gate';
import { KustoError } from '@/lib/azure/kusto-client';
import { loadOwnedItem } from '../../../_lib/item-crud';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'operations-agent';

/** Honest Azure Monitor infra-gate (NOT a Fabric gate) — mirrors the activator route. */
const monitorGateBodies: MonitorGateBodies = {
  notConfigured: (missing) => ({ error: `Azure Monitor not configured: set ${missing?.join(' / ') || 'LOOM_LOG_ANALYTICS_RESOURCE_ID / LOOM_ALERT_RG'}.`,
      gate: { reason: 'Operations-agent triggers create scheduled-query alert rules on Azure Monitor.', remediation: `Set ${missing?.join(' / ') || 'LOOM_LOG_ANALYTICS_RESOURCE_ID + LOOM_ALERT_RG'} on the Console. No Microsoft Fabric required.` },
    }),
  unauthorized: (status) => ({ error: `Azure Monitor ${status}: not authorized to create alert rules.`,
      gate: { reason: 'The Console UAMI needs rights on the alert resource group.', remediation: 'Grant the Console UAMI "Monitoring Contributor" on LOOM_ALERT_RG so it can create scheduledQueryRules + action groups.' },
    }),
};

/** Honest ADX / Eventhouse (Kusto) infra-gate for trigger-now evaluation. */
function kustoGate(e: any): NextResponse | null {
  if (!(e instanceof KustoError)) return null;
  if (e.status === 401 || e.status === 403) {
    return NextResponse.json({
      ok: false,
      error: `Azure Data Explorer ${e.status}: not authorized to query the Eventhouse cluster.`,
      gate: { reason: 'The Console UAMI needs query rights on the ADX / Eventhouse cluster.', remediation: 'Grant the Console UAMI Database Viewer (or AllDatabasesViewer) on the ADX cluster so it can run the trigger KQL. No Microsoft Fabric required.' },
    }, { status: 403 });
  }
  return NextResponse.json({
    ok: false,
    error: `Azure Data Explorer error: ${e.message}`,
    gate: { reason: 'The Eventhouse / ADX cluster is not reachable for this trigger.', remediation: 'Set LOOM_KUSTO_CLUSTER_URI (and LOOM_KUSTO_DEFAULT_DB) to your Eventhouse cluster, or choose a Log Analytics source. No Microsoft Fabric required.' },
  }, { status: e.status && e.status >= 400 ? e.status : 503 });
}

function persistedRules(item: WorkspaceItem | null): MonitorRuleRecord[] {
  return Array.isArray((item?.state as any)?.rules) ? (item!.state as any).rules : [];
}

async function saveRules(item: WorkspaceItem, rules: MonitorRuleRecord[]): Promise<void> {
  const items = await itemsContainer();
  const next: WorkspaceItem = { ...item, state: { ...(item.state || {}), rules }, updatedAt: new Date().toISOString() };
  await items.item(item.id, item.workspaceId).replace(next);
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    return NextResponse.json({ ok: true, rules: persistedRules(item), backend: 'azure-monitor' });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const triggerId = req.nextUrl.searchParams.get('trigger');

  const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'operations-agent not found' }, { status: 404 });
  const rules = persistedRules(item);

  // Trigger now = run the rule's KQL against its source and report would-fire.
  if (triggerId) {
    const rule = rules.find((r) => r.id === triggerId || r.name === triggerId);
    if (!rule) return NextResponse.json({ ok: false, error: `rule '${triggerId}' not found` }, { status: 404 });
    if (!rule.query && rule.sourceKind !== 'adx') {
      return NextResponse.json({ ok: false, error: `rule '${triggerId}' has no query to run` }, { status: 400 });
    }
    try {
      const out = await triggerMonitorActivatorRule(rule);
      return NextResponse.json({ ok: true, ...out });
    } catch (e: any) {
      return kustoGate(e) || monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  const body = await req.json().catch(() => ({}));
  const name = String(body?.name || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  try {
    const rule = await createMonitorActivatorRule(item.displayName, {
      name,
      condition: body?.condition || undefined,
      action: body?.action || undefined,
      query: typeof body?.query === 'string' ? body.query : undefined,
      sourceTable: typeof body?.sourceTable === 'string' ? body.sourceTable : undefined,
      severity: typeof body?.severity === 'number' ? body.severity : undefined,
      evaluationFrequency: typeof body?.evaluationFrequency === 'string' ? body.evaluationFrequency : undefined,
      windowSize: typeof body?.windowSize === 'string' ? body.windowSize : undefined,
      sourceKind: body?.sourceKind === 'adx' ? 'adx' : (body?.sourceKind === 'log-analytics' ? 'log-analytics' : undefined),
      adxDatabase: typeof body?.adxDatabase === 'string' ? body.adxDatabase : undefined,
      adxClusterUri: typeof body?.adxClusterUri === 'string' ? body.adxClusterUri : undefined,
    });
    const nextRules = [...rules.filter((r) => r.id !== rule.id), rule];
    await saveRules(item, nextRules);
    return NextResponse.json({ ok: true, rule, backend: 'azure-monitor' });
  } catch (e: any) {
    return kustoGate(e) || monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const ruleId = req.nextUrl.searchParams.get('ruleId');
  if (!ruleId) return NextResponse.json({ ok: false, error: 'ruleId required' }, { status: 400 });

  const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'operations-agent not found' }, { status: 404 });
  const rules = persistedRules(item);
  const rule = rules.find((r) => r.id === ruleId || r.name === ruleId || r.azureRuleName === ruleId);
  if (!rule) return NextResponse.json({ ok: false, error: `rule '${ruleId}' not found` }, { status: 404 });

  try {
    if (rule.azureRuleName) await deleteMonitorActivatorRule(rule.azureRuleName);
    await saveRules(item, rules.filter((r) => r.id !== rule.id));
    return NextResponse.json({ ok: true, backend: 'azure-monitor' });
  } catch (e: any) {
    return monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
