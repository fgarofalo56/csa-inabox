/**
 * Phase 2 — Activator (Reflex) provisioner.
 *
 * Per .claude/rules/no-fabric-dependency.md the Loom Activator NEVER requires a
 * real Fabric workspace. It defaults to the Azure-native **Azure Monitor**
 * backend: each Loom activator rule (condition + action) becomes a real
 * Microsoft.Insights/scheduledQueryRules alert that runs a KQL query over the
 * configured Log Analytics workspace and fires an action group built from the
 * rule's action (email). A Fabric Reflex is an opt-in alternative selected via
 * LOOM_ACTIVATOR_BACKEND=fabric + a bound workspace; if fabric is selected but
 * no workspace is bound, we transparently fall back to Azure Monitor — no gate.
 *
 * Honest Azure gate (not a Fabric gate): when LOOM_LOG_ANALYTICS_RESOURCE_ID /
 * LOOM_SUBSCRIPTION_ID aren't set, the rule(s) can't be scoped — we surface the
 * exact env var to set; the item still installs to Cosmos.
 *   https://learn.microsoft.com/rest/api/monitor/scheduled-query-rules
 *
 * The Azure Monitor path delegates each rule to the CANONICAL
 * createMonitorActivatorRule() in lib/azure/activator-monitor.ts — the SAME
 * function the live editor / rules BFF route uses — so the MonitorRuleRecord
 * shape we persist to the Cosmos item's state.rules is byte-identical to what
 * the editor, pane, and rules route consume. A deployed (catalog / use-case)
 * activator therefore behaves exactly like a net-new one: every per-rule
 * Start/Stop/Enable/Disable/Delete/Trigger action keys off a real backing
 * scheduledQueryRule recorded in state.rules (no empty array, no stub).
 */
import { listActivators, createActivator, addRule, ActivatorError, listRules } from '@/lib/azure/activator-client';
import { MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';
import {
  createMonitorActivatorRule,
  type MonitorRuleRecord,
} from '@/lib/azure/activator-monitor';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import type { Provisioner, ProvisionResult } from './types';
import { resolveInfraResidual } from './types';

function rulesFromContent(content: any): any[] {
  if (content?.kind === 'activator' && content.rule) return [content.rule];
  if (Array.isArray(content?.rules)) return content.rules;
  return [];
}

// ── Azure Monitor backend (DEFAULT) ────────────────────────────────────────
async function provisionAzureMonitor(input: any, steps: string[]): Promise<ProvisionResult> {
  const content = input.content as any;
  const rules = rulesFromContent(content);
  if (rules.length === 0) {
    return { status: 'created', secondaryIds: { backend: 'azure-monitor' }, steps: [...steps, 'No rules in bundle; activator item created (Azure Monitor backend, no alert rules to author).'] };
  }

  // Author each bundle rule via the CANONICAL Azure Monitor runtime helper so
  // the persisted record == exactly what the editor / pane / rules route read
  // (single source of truth — no local upsertActionGroup/upsertScheduledQueryRule
  // duplication). createMonitorActivatorRule builds the rule's action group from
  // its action config (email / SMS / webhook / Logic App) and the scheduledQuery
  // rule, returning a full MonitorRuleRecord (id == azureRuleName, query, state,
  // severity, schedule, …).
  const records: MonitorRuleRecord[] = [];
  for (const r of rules) {
    try {
      // The bundle's ActivatorContent.rule.condition is {metric, op, threshold}
      // (lib/apps/content-bundles/types.ts:267), but buildRuleQuery() (which
      // createMonitorActivatorRule composes the alert KQL with) only understands
      // the canonical {property, operator, value} — it has NO metric/op/threshold
      // alias, and ActivatorContent.rule has no verbatim `query` to short-circuit
      // on. Passing the bundle condition through unchanged would therefore ALWAYS
      // fall to buildRuleQuery's defaults (property='value', operator='==',
      // value=0) and persist a semantically WRONG KQL plus a condition shape the
      // editor's Edit (openEditRule reads cond.property/cond.field) can't read.
      // Normalize BYTE-IDENTICALLY to the bundle projection (ai-content-fallback.ts:
      // 283-287) so the persisted MonitorRuleRecord == that fallback's row; the
      // record's condition (createMonitorActivatorRule sets condition: input.condition)
      // is then itself the normalized shape.
      const cond =
        r.condition &&
        (r.condition.metric !== undefined || r.condition.op !== undefined || r.condition.threshold !== undefined)
          ? { property: r.condition.metric, operator: r.condition.op, value: r.condition.threshold }
          : r.condition;
      const rec = await createMonitorActivatorRule(input.displayName, {
        name: r.name,
        condition: cond,
        action: r.action,
        query: typeof r.query === 'string' ? r.query : undefined,
        sourceTable: typeof r.sourceTable === 'string' ? r.sourceTable : undefined,
        severity: typeof r.severity === 'number' ? r.severity : undefined,
        evaluationFrequency: typeof r.evaluationFrequency === 'string' ? r.evaluationFrequency : undefined,
        // A bundle's ActivatorContent.rule (content-bundles/types.ts) carries only
        // `window` — it has NO `windowSize` — so the deployed rule's intended
        // lookback was silently dropped to the PT5M default. Honor the bundle
        // `window` while still respecting an explicit `windowSize` from the
        // array-form `content.rules` (which may carry the canonical field name).
        windowSize: typeof r.windowSize === 'string' ? r.windowSize : (typeof r.window === 'string' ? r.window : undefined),
      });
      records.push(rec);
      if (rec.note) steps.push(rec.note);
      steps.push(`Created Azure Monitor alert rule for '${r.name || 'rule'}'.`);
    } catch (e: any) {
      // Keep the existing honest Azure infra-gates verbatim — createMonitorActivatorRule
      // throws the SAME error types (MonitorNotConfiguredError / MonitorError) as the
      // local path it replaces. Neither is a Fabric gate.
      if (e instanceof MonitorNotConfiguredError) {
        return {
          status: 'remediation',
          gate: {
            reason: 'Azure Monitor not configured for this deployment.',
            remediation: `Set ${e.missing.join(' / ')} so the Activator can create alert rules + action groups. (No Microsoft Fabric required.)`,
            link: 'https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-create-log-alert-rule',
          },
          steps,
        };
      }
      if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
        return {
          status: 'remediation',
          gate: {
            reason: `Azure Monitor ${e.status}: cannot create the alert rule.`,
            remediation: 'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the "Monitoring Contributor" role on the alert resource group so it can create scheduledQueryRules + action groups.',
            link: 'https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#monitoring-contributor',
          },
          steps,
        };
      }
      steps.push(`Failed to create alert rule for '${r.name || 'rule'}': ${e?.message || String(e)}`);
    }
  }

  const created = records.length;

  // Option B persistence: write the authored MonitorRuleRecord[] back onto the
  // Cosmos activator item's state.rules using the SAME write path the rules BFF
  // route proves works (itemsContainer().item(id, workspaceId).read/replace).
  // Best-effort — a persistence failure is logged into steps[] and NEVER throws,
  // so it cannot sink the install. (Without this, a deployed activator lands
  // with an empty state.rules and every editor/pane action reads as dead/404.)
  if (created > 0) {
    try {
      const items = await itemsContainer();
      const { resource: cur } = await items.item(input.cosmosItemId, input.workspaceId).read<WorkspaceItem>();
      if (cur) {
        const next: WorkspaceItem = { ...cur, state: { ...(cur.state || {}), rules: records }, updatedAt: new Date().toISOString() };
        await items.item(cur.id, cur.workspaceId).replace(next);
        steps.push(`Persisted ${created} activator rule(s) to the item state.rules so the editor + pane are self-sufficient.`);
      } else {
        steps.push('Authored alert rules but the activator item was not found to persist state.rules (editor falls back to the bundle projection).');
      }
    } catch (e: any) {
      steps.push(`Authored alert rules but failed to persist state.rules (editor falls back to the bundle projection): ${e?.message || String(e)}`);
    }
  }

  return {
    status: created > 0 ? 'created' : 'remediation',
    resourceId: records[records.length - 1]?.azureRuleName,
    secondaryIds: { backend: 'azure-monitor', rulesCreated: String(created) },
    ...(created === 0 ? { gate: { reason: 'No alert rules could be created.', remediation: 'See step log for the per-rule errors above.' } } : {}),
    steps,
  };
}

// ── Fabric Reflex backend (opt-in: LOOM_ACTIVATOR_BACKEND=fabric + bound ws) ─
async function provisionFabricReflex(input: any, steps: string[], ws: string): Promise<ProvisionResult> {
  let reflexId: string | undefined;
  let isExisting = false;
  try {
    const existing = await listActivators(ws);
    const match = existing.find((a) => (a.displayName || '').toLowerCase() === input.displayName.toLowerCase());
    if (match?.id) {
      reflexId = match.id;
      isExisting = true;
      steps.push(`Found existing reflex ${match.id}; reusing.`);
    } else {
      const created = await createActivator(ws, { displayName: input.displayName, description: `Installed from ${input.appId}` });
      reflexId = created.id;
      steps.push(`Created reflex ${created.id}.`);
    }
  } catch (e: any) {
    if (e instanceof ActivatorError && (e.status === 401 || e.status === 403)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Activator ${e.status}: ${e.message}`,
          remediation: 'Enable tenant setting "Service principals can use Fabric APIs" + add Console UAMI to the Fabric workspace as Contributor.',
          link: `https://app.fabric.microsoft.com/groups/${ws}/settings`,
        },
        steps,
      };
    }
    return resolveInfraResidual(e, 'Add the Console UAMI to the Fabric workspace as Contributor and enable the tenant setting "Service principals can use Fabric APIs" so it can create/list Activator (Reflex) items.', { link: `https://app.fabric.microsoft.com/groups/${ws}/settings`, steps });
  }

  const rules = rulesFromContent(input.content);
  if (reflexId && rules.length > 0) {
    let existingRuleNames = new Set<string>();
    try {
      const rl = await listRules(ws, reflexId);
      existingRuleNames = new Set(rl.map((r) => (r.name || '').toLowerCase()));
    } catch { /* preview endpoint may 404 — fine */ }
    for (const r of rules) {
      if (existingRuleNames.has((r.name || '').toLowerCase())) {
        steps.push(`Rule '${r.name}' already exists; skipping.`);
        continue;
      }
      try {
        await addRule(ws, reflexId, { name: r.name, condition: r.condition || {}, action: r.action || {} });
        steps.push(`Added rule '${r.name}'.`);
      } catch (e: any) {
        steps.push(`Failed to add rule '${r.name}': ${e?.message || String(e)}`);
      }
    }
  }

  return { status: isExisting ? 'exists' : 'created', resourceId: reflexId, secondaryIds: { backend: 'fabric', fabricWorkspaceId: ws }, steps };
}

export const activatorProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = input.target.fabricWorkspaceId;
  const backend = input.target.activatorBackend || 'azure-monitor';

  if (backend === 'fabric' && ws) {
    steps.push('Provisioning activator on the Fabric Reflex backend (opt-in).');
    return provisionFabricReflex(input, steps, ws);
  }
  if (backend === 'fabric' && !ws) {
    steps.push('LOOM_ACTIVATOR_BACKEND=fabric but no Fabric workspace bound — falling back to the Azure-native Azure Monitor backend.');
  } else {
    steps.push('Provisioning activator on the Azure-native Azure Monitor backend.');
  }
  return provisionAzureMonitor(input, steps);
};
