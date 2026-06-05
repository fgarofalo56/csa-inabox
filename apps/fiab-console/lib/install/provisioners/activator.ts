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
 */
import { listActivators, createActivator, addRule, ActivatorError, listRules } from '@/lib/azure/activator-client';
import {
  upsertActionGroup,
  upsertScheduledQueryRule,
  MonitorNotConfiguredError,
  MonitorError,
} from '@/lib/azure/monitor-client';
import type { Provisioner, ProvisionResult } from './types';

/** Sanitize a display name into an ARM resource name (alnum / - / _, ≤ 90). */
function safeRuleName(displayName: string, suffix: string): string {
  const base = displayName.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'loom-activator';
  return `${base}-${suffix}`.slice(0, 90);
}

/** Map a Loom condition operator to its KQL operator. */
function kqlOperator(op?: string): string {
  switch ((op || '').toLowerCase()) {
    case 'gt': case 'greaterthan': case '>': return '>';
    case 'lt': case 'lessthan': case '<': return '<';
    case 'gte': case 'greaterthanorequal': case '>=': return '>=';
    case 'lte': case 'lessthanorequal': case '<=': return '<=';
    case 'ne': case 'notequal': case '!=': return '!=';
    case 'contains': return 'contains';
    case 'eq': case 'equal': case '==': default: return '==';
  }
}

/** Quote a KQL scalar: numbers verbatim, everything else as a string literal. */
function kqlValue(v: any): string {
  if (v === null || v === undefined || v === '') return '""';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return v.trim();
  return `"${String(v).replace(/"/g, '\\"')}"`;
}

/**
 * Build the alert KQL for one rule. If the rule already carries a `query`, use
 * it verbatim. Otherwise compose `<table> | where <property> <op> <value>` from
 * the structured condition (the activator wizard's condProperty/Operator/Value).
 * The alert fires when this query returns ≥1 row (Count > 0).
 */
function buildRuleQuery(rule: any): { query: string; note?: string } {
  if (typeof rule?.query === 'string' && rule.query.trim()) {
    return { query: rule.query.trim() };
  }
  const cond = rule?.condition || {};
  const table =
    rule?.sourceTable || rule?.table || rule?.stream || rule?.eventTable ||
    process.env.LOOM_ACTIVATOR_DEFAULT_TABLE || 'AppEvents_CL';
  const property = cond.property || cond.field || cond.condProperty || 'value';
  const op = kqlOperator(cond.operator || cond.condOperator);
  const value = cond.value ?? cond.condValue ?? 0;
  const query = `${table}\n| where ${property} ${op} ${kqlValue(value)}`;
  const note = rule?.sourceTable || rule?.table
    ? undefined
    : `Alert query targets table '${table}' — set the rule's sourceTable (or LOOM_ACTIVATOR_DEFAULT_TABLE) to point at your data.`;
  return { query, note };
}

/** Extract email recipients from a rule's action (Loom wizard: actKind/actTarget). */
function ruleEmails(rule: any): string[] {
  const action = rule?.action || {};
  const targets: string[] = [];
  for (const v of [action.target, action.actTarget, action.email, action.to, action.recipients]) {
    if (Array.isArray(v)) targets.push(...v);
    else if (typeof v === 'string') targets.push(...v.split(/[;,]/));
  }
  return targets.map((t) => t.trim()).filter((t) => t.includes('@'));
}

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

  // One shared action group built from the union of rule emails.
  const allEmails = Array.from(new Set(rules.flatMap(ruleEmails)));
  let actionGroupId: string | undefined;
  try {
    actionGroupId = await upsertActionGroup({
      name: safeRuleName(input.displayName, 'ag'),
      shortName: (input.displayName || 'loom').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'loom',
      emails: allEmails,
    });
    steps.push(`Action group ready (${allEmails.length} email receiver(s)).`);
  } catch (e: any) {
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
    steps.push(`Action group creation failed (${e?.message || e}); creating rules without notifications.`);
  }

  let created = 0;
  let lastRuleId: string | undefined;
  for (const r of rules) {
    const { query, note } = buildRuleQuery(r);
    if (note) steps.push(note);
    try {
      const id = await upsertScheduledQueryRule({
        name: safeRuleName(input.displayName, (r.name || `rule${created}`).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 16)),
        description: r.description || `Loom activator rule '${r.name || 'rule'}' from ${input.appId}`,
        query,
        severity: typeof r.severity === 'number' ? r.severity : 2,
        actionGroupIds: actionGroupId ? [actionGroupId] : undefined,
      });
      lastRuleId = id;
      created += 1;
      steps.push(`Created Azure Monitor alert rule for '${r.name || 'rule'}'.`);
    } catch (e: any) {
      if (e instanceof MonitorNotConfiguredError) {
        return {
          status: 'remediation',
          gate: {
            reason: 'Azure Monitor alert scope not configured.',
            remediation: `Set ${e.missing.join(' / ')} (the Log Analytics workspace the alert query runs against). No Microsoft Fabric required.`,
            link: 'https://learn.microsoft.com/azure/azure-monitor/logs/log-analytics-workspace-overview',
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

  return {
    status: created > 0 ? 'created' : 'remediation',
    resourceId: lastRuleId,
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
    return { status: 'failed', error: e?.message || String(e), steps };
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
