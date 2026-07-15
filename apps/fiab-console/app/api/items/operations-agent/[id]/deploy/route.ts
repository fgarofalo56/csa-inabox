/**
 * POST /api/items/operations-agent/[id]/deploy
 *
 * Deploys an operations agent. Per .claude/rules/no-fabric-dependency.md the
 * PRIMARY, Azure-native deploy target is Azure Monitor:
 *
 *   1. MONITOR (primary) — every persisted trigger (state.rules[]) is (re-)upserted
 *      as a REAL Microsoft.Insights/scheduledQueryRule + action group via the
 *      SAME activator-monitor backend the Triggers tab uses (upsertScheduledQueryRule
 *      + upsertActionGroup under the hood). This is idempotent: deploy guarantees
 *      every trigger the agent owns is live on ARM. When Monitor isn't configured
 *      the route returns an honest 501 gate naming the exact env var (no Fabric).
 *
 *   2. REASONING COMPANION (optional) — when the Azure AI Foundry Agent Service is
 *      configured (LOOM_FOUNDRY_PROJECT_ENDPOINT / _PROJECT_ID), the agent's
 *      instructions + model + tools are ALSO published as a Foundry agent that
 *      interprets a fired event and recommends an action. This is best-effort and
 *      NON-fatal: an unconfigured Foundry is reported as `reasoning.skipped`, never
 *      an error, because Monitor alone is a complete Azure-native deploy.
 *
 * On success the deployment receipt (monitor rule ids + optional foundryAgentId +
 * lastDeployedAt) is persisted back to the Cosmos item.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import {
  createOrUpdateAgent,
  FoundryAgentNotConfiguredError,
  FoundryAgentError,
  getProjectId,
  type FoundryAgentBody,
} from '@/lib/azure/foundry-agent-client';
import {
  createMonitorActivatorRule,
  type MonitorRuleRecord,
} from '@/lib/azure/activator-monitor';
import { MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { migrateLegacyTools, toolsToFoundryTools } from '@/lib/copilot/agent-tool-catalog';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'operations-agent';

/** Build a Foundry-Agent-Service-compatible name from a Loom item id. */
function foundryAgentName(itemId: string): string {
  const base = `loom-ops-${itemId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const trimmed = base.replace(/^-+|-+$/g, '').slice(0, 63);
  return trimmed.replace(/^-+|-+$/g, '') || `loom-ops-${itemId.slice(0, 8)}`;
}

function stateToolsToFoundry(raw: unknown): Array<Record<string, unknown>> {
  return toolsToFoundryTools(migrateLegacyTools(raw));
}

function persistedRules(item: WorkspaceItem): MonitorRuleRecord[] {
  return Array.isArray((item.state as any)?.rules) ? (item.state as any).rules : [];
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  let item: WorkspaceItem | null;
  try {
    item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid);
  } catch (e: any) {
    return apiServerError(e, 'cosmos error');
  }
  if (!item) {
    return NextResponse.json({ ok: false, error: 'operations-agent item not found' }, { status: 404 });
  }

  const state = (item.state || {}) as Record<string, unknown>;
  const rules = persistedRules(item);

  // ── PRIMARY: deploy every trigger to Azure Monitor (real scheduledQueryRules
  //    + action groups). Idempotent re-upsert of the persisted rules. ──
  const deployedRuleIds: string[] = [];
  const ruleErrors: { rule: string; error: string }[] = [];
  let monitorGate: { error: string; hint: string } | null = null;
  const nextRules: MonitorRuleRecord[] = [];

  for (const rule of rules) {
    try {
      const fresh = await createMonitorActivatorRule(item.displayName, {
        name: rule.name,
        condition: rule.condition,
        action: rule.action,
        query: rule.query,
        severity: rule.severity,
        evaluationFrequency: rule.evaluationFrequency,
        windowSize: rule.windowSize,
        existingActionGroupId: rule.actionGroupId,
        sourceKind: rule.sourceKind,
        adxDatabase: rule.adxDatabase,
        adxClusterUri: rule.adxClusterUri,
        ruleKind: rule.ruleKind,
        objectKey: rule.objectKey,
        propertyConditionType: rule.propertyConditionType,
        changePercent: rule.changePercent,
        rangeMin: rule.rangeMin,
        rangeMax: rule.rangeMax,
        noDataMinutes: rule.noDataMinutes,
        timestampColumn: rule.timestampColumn,
      });
      // Preserve the operations-agent approval channel across the re-upsert.
      const merged: MonitorRuleRecord = { ...fresh, requireApproval: rule.requireApproval };
      nextRules.push(merged);
      deployedRuleIds.push(merged.azureRuleName || merged.id);
    } catch (e: any) {
      // A Monitor-not-configured error is a whole-deploy gate (all rules share
      // the same backend) — surface the honest env-var gate once and stop.
      if (e instanceof MonitorNotConfiguredError) {
        monitorGate = {
          error: e.message,
          hint: 'Set LOOM_LOG_ANALYTICS_RESOURCE_ID + LOOM_ALERT_RG on the Console and grant its UAMI "Monitoring Contributor" on the alert resource group. No Microsoft Fabric required.',
        };
        break;
      }
      ruleErrors.push({ rule: rule.name, error: e instanceof MonitorError ? `${e.message} (${e.status})` : (e?.message || String(e)) });
      nextRules.push(rule); // keep the prior record when a single rule fails
    }
  }

  if (monitorGate) {
    return NextResponse.json({
      ok: false,
      deferred: true,
      error: monitorGate.error,
      hint: monitorGate.hint,
      target: 'azure-monitor',
    }, { status: 501 });
  }

  // ── COMPANION: publish the reasoning agent to Azure AI Foundry (optional). ──
  const FOUNDRY_SKIP_HINT = 'Azure AI Foundry Agent Service not configured — set LOOM_FOUNDRY_PROJECT_ENDPOINT / LOOM_FOUNDRY_PROJECT_ID to add the reasoning companion. Azure Monitor triggers are fully deployed without it.';
  let reasoning:
    | { deployed: true; agentId: string; projectId: string }
    | { deployed: false; skipped: true; hint: string }
    | { deployed: false; error: string } = { deployed: false, skipped: true, hint: FOUNDRY_SKIP_HINT };

  const systemPrompt = String(state.systemPrompt || '').trim();
  const model = String(state.model || '').trim();
  if (systemPrompt && model) {
    const agentName = foundryAgentName(item.id);
    const metadata: Record<string, string> = {
      loomItemId: item.id,
      loomItemType: ITEM_TYPE,
      loomWorkspaceId: item.workspaceId,
    };
    if (typeof state.eventhouse === 'string' && state.eventhouse) metadata.loomEventhouseId = state.eventhouse.slice(0, 512);
    if (typeof state.ontology === 'string' && state.ontology) metadata.loomOntologyId = state.ontology.slice(0, 512);
    const body: FoundryAgentBody = {
      name: agentName,
      model,
      instructions: systemPrompt,
      tools: stateToolsToFoundry(state.tools),
      description: `Loom operations-agent reasoning companion: ${item.displayName}`.slice(0, 512),
      metadata,
      kind: 'prompt',
    };
    try {
      const projectId = getProjectId();
      await createOrUpdateAgent(projectId, agentName, body);
      reasoning = { deployed: true, agentId: agentName, projectId };
    } catch (e: any) {
      if (e instanceof FoundryAgentNotConfiguredError) {
        reasoning = { deployed: false, skipped: true, hint: e.hint || FOUNDRY_SKIP_HINT };
      } else if (e instanceof FoundryAgentError) {
        reasoning = { deployed: false, error: `${e.message} (${e.status})` };
      } else {
        reasoning = { deployed: false, error: e?.message || String(e) };
      }
    }
  }

  // ── Persist the deployment receipt back to Cosmos. ──
  const now = new Date().toISOString();
  const nextState: Record<string, unknown> = {
    ...state,
    rules: nextRules,
    monitorRuleIds: deployedRuleIds,
    lastDeployedAt: now,
  };
  if ('deployed' in reasoning && reasoning.deployed) {
    nextState.foundryAgentId = reasoning.agentId;
    nextState.foundryProjectId = reasoning.projectId;
  }
  let resource: WorkspaceItem | undefined;
  try {
    const items = await itemsContainer();
    const res = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>({
      ...item, state: nextState, updatedAt: now,
    });
    resource = res.resource ?? undefined;
  } catch (e: any) {
    return apiServerError(e, 'failed to persist deploy receipt');
  }

  return NextResponse.json({
    ok: true,
    target: 'azure-monitor',
    monitor: {
      rulesDeployed: deployedRuleIds.length,
      ruleIds: deployedRuleIds,
      ...(ruleErrors.length ? { errors: ruleErrors } : {}),
      ...(deployedRuleIds.length === 0 ? { note: 'No triggers to deploy yet — add a trigger on the Triggers tab (each becomes a real Azure Monitor scheduledQueryRule).' } : {}),
    },
    reasoning,
    lastDeployedAt: now,
    item: resource,
  });
}
