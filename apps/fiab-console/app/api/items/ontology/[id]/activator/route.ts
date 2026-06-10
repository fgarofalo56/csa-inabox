/**
 * GET  /api/items/ontology/[id]/activator
 *   → { ok, workspaceId, activatorId?, activatorName?, rules? }
 *     When the ontology has an activatorId, its rules are read from the Cosmos
 *     activator item (the Azure-native default store).
 *
 * POST /api/items/ontology/[id]/activator  body:
 *   { entityType, sourceItemId?, sourceKind?, ruleName?, sourceTable?,
 *     evaluationFrequency?, windowSize?, action?: { target } }
 *   → { ok, activatorId, ruleId, backend, gate? }
 *
 * Wires the OntologyEditor's "Activator triggers" surface. Creates a REAL
 * Azure Monitor scheduledQueryRule (via createMonitorActivatorRule) that fires
 * when an entity-change event for the bound entity type appears in the Log
 * Analytics workspace. The first POST lazily creates the backing Cosmos
 * activator item and records its id on the ontology (state.activatorId).
 *
 * Per .claude/rules/no-fabric-dependency.md the DEFAULT is the Azure-native
 * Monitor backend — no Fabric Activator / Reflex required. A Fabric Reflex is
 * an opt-in alternative selected with LOOM_ACTIVATOR_BACKEND=fabric, but this
 * route always uses the Azure-native path (it persists rules on the Cosmos
 * activator item, identical to the activator/[id]/rules default branch).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { loadOwnedItem, updateOwnedItem, createOwnedItem } from '../../../_lib/item-crud';
import {
  createMonitorActivatorRule, type MonitorRuleRecord,
} from '@/lib/azure/activator-monitor';
import { MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';
import { buildEntityChangeQuery } from '@/lib/editors/_family-utils';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ontology';

function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
}

/** Honest Azure infra-gate (NOT a Fabric gate) for Monitor errors. */
function monitorGate(e: any): NextResponse | null {
  if (e instanceof MonitorNotConfiguredError) {
    return NextResponse.json({
      ok: false,
      error: `Azure Monitor not configured: set ${e.missing?.join(' / ') || 'LOOM_LOG_ANALYTICS_RESOURCE_ID / LOOM_ALERT_RG'}.`,
      gate: { reason: 'The Azure-native Activator creates scheduled-query alert rules on Azure Monitor.', remediation: `Set ${e.missing?.join(' / ') || 'LOOM_LOG_ANALYTICS_RESOURCE_ID + LOOM_ALERT_RG'} on the Console. No Microsoft Fabric required.` },
    }, { status: 503 });
  }
  if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
    return NextResponse.json({
      ok: false,
      error: `Azure Monitor ${e.status}: not authorized to create alert rules.`,
      gate: { reason: 'The Console UAMI needs rights on the alert resource group.', remediation: 'Grant the Console UAMI "Monitoring Contributor" on LOOM_ALERT_RG so it can create scheduledQueryRules + action groups.' },
    }, { status: 403 });
  }
  return null;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ ok: true, workspaceId: null, activatorId: null, rules: [] });

  const onto = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!onto) return err('ontology not found', 404, 'not_found');
  const state = (onto.state || {}) as Record<string, unknown>;
  const activatorId = (state.activatorId as string) || null;
  if (!activatorId) return NextResponse.json({ ok: true, workspaceId: onto.workspaceId, activatorId: null, rules: [] });

  const act = await loadOwnedItem(activatorId, 'activator', session.claims.oid);
  const rules = Array.isArray((act?.state as any)?.rules) ? (act!.state as any).rules : [];
  return NextResponse.json({
    ok: true,
    workspaceId: onto.workspaceId,
    activatorId,
    activatorName: act?.displayName || null,
    rules,
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the ontology before creating a trigger (no id yet)', 400, 'no_id');

  const body = await req.json().catch(() => ({} as any));
  const entityType = String(body?.entityType || '').trim();
  if (!entityType) return err('entityType is required', 400, 'missing_entity_type');
  const sourceKind = body?.sourceKind === 'warehouse' ? 'warehouse' : 'lakehouse';
  const sourceItemId = String(body?.sourceItemId || '').trim();
  const ruleName = String(body?.ruleName || `${entityType}-change`).trim() || `${entityType}-change`;
  const sourceTable = typeof body?.sourceTable === 'string' && body.sourceTable.trim() ? body.sourceTable.trim() : undefined;
  const evaluationFrequency = typeof body?.evaluationFrequency === 'string' ? body.evaluationFrequency : 'PT5M';
  const windowSize = typeof body?.windowSize === 'string' ? body.windowSize : 'PT5M';
  const action = body?.action && typeof body.action === 'object' ? body.action : undefined;

  const onto = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!onto) return err('ontology not found', 404, 'not_found');
  const state = { ...((onto.state || {}) as Record<string, unknown>) };

  // 1. Lazily create the backing Azure-native (Cosmos) activator item.
  let activatorId = (state.activatorId as string) || '';
  if (!activatorId) {
    const created = await createOwnedItem(session, 'activator', {
      workspaceId: onto.workspaceId,
      displayName: `Ontology triggers — ${onto.displayName || 'Ontology'}`,
      description: `Entity-change triggers for ontology ${onto.id}`,
      state: { content: { kind: 'activator' }, rules: [], sourceOntologyId: onto.id },
    });
    if (!created.ok) return err(created.error, created.status, 'activator_create_failed');
    activatorId = created.item.id;
    state.activatorId = activatorId;
    state.activatorWorkspaceId = onto.workspaceId;
    await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state });
  }

  // 2. Create the real Azure Monitor scheduledQueryRule for the entity change.
  const act = await loadOwnedItem(activatorId, 'activator', session.claims.oid);
  if (!act) return err('backing activator not found', 404, 'activator_not_found');
  const query = buildEntityChangeQuery(entityType, sourceKind, sourceItemId);
  let rule: MonitorRuleRecord;
  try {
    rule = await createMonitorActivatorRule(act.displayName, {
      name: ruleName,
      query,
      sourceTable,
      evaluationFrequency,
      windowSize,
      action,
    });
  } catch (e: any) {
    return monitorGate(e) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  // 3. Persist the rule onto the Cosmos activator item (same store the
  //    activator/[id]/rules default branch reads from).
  const rules: MonitorRuleRecord[] = Array.isArray((act.state as any)?.rules) ? (act.state as any).rules : [];
  // Stamp ontology provenance alongside the monitor rule record (extra fields
  // ride along in the Cosmos state.rules array; the rules route reads them back
  // as-is). Cast keeps the object an open record for the extra keys.
  const stampedRule = { ...rule, entityType, sourceItemId, sourceOntologyId: onto.id } as MonitorRuleRecord & Record<string, unknown>;
  const nextRules = [...rules.filter((r) => r.id !== rule.id), stampedRule];
  const items = await itemsContainer();
  const nextItem: WorkspaceItem = { ...act, state: { ...(act.state || {}), rules: nextRules }, updatedAt: new Date().toISOString() };
  await items.item(act.id, act.workspaceId).replace(nextItem);

  return NextResponse.json({ ok: true, activatorId, ruleId: rule.id, rule, backend: 'azure-monitor' });
}
