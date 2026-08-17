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
 *
 * #3551 — that state.rules write is NOT best-effort. Azure Monitor accepting
 * the rules is only half the install: if the record never reaches state.rules
 * the editor shows an EMPTY rule list while real alert rules bill and fire in
 * Azure, with no error anywhere. So the write is retried with bounded backoff
 * and the returned status reflects whether the record actually landed — per
 * deploy-integrity.md R6, never report success on an unverified outcome.
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

/**
 * Pick the Azure Monitor alert SCOPE this deployment can actually author rules
 * against — the real day-one blocker (a bundle rule's phantom custom metric is
 * NOT: buildRuleQuery composes a column_ifexists query and upsertScheduledQueryRule
 * defaults skipQueryValidation, so a rule over a non-existent table/column still
 * CREATEs 200 and simply returns 0 rows). A scheduledQueryRule needs a scope:
 *   - LOOM_LOG_ANALYTICS_RESOURCE_ID → a log alert over the hub Log Analytics
 *     workspace (the general DEFAULT), or
 *   - LOOM_ADX_ALERT_SCOPE → an Eventhouse/ADX-scoped rule (RTI streams).
 * Prefer Log Analytics; fall back to ADX. When NEITHER is set the rule genuinely
 * cannot be scoped — return an honest gate naming both (per no-vaporware.md),
 * instead of letting each rule fail into a misleading "No alert rules could be
 * created". No Microsoft Fabric is involved on either path.
 */
function pickAlertScope(): { sourceKind: 'log-analytics' | 'adx' } | { missing: string[] } {
  if (process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID?.trim()) return { sourceKind: 'log-analytics' };
  if (process.env.LOOM_ADX_ALERT_SCOPE?.trim()) return { sourceKind: 'adx' };
  return { missing: ['LOOM_LOG_ANALYTICS_RESOURCE_ID', 'LOOM_ADX_ALERT_SCOPE'] };
}

// ── Azure Monitor backend (DEFAULT) ────────────────────────────────────────

/**
 * #3551 — write the authored rules onto the Cosmos item's `state.rules` with a
 * bounded retry, because the Azure Monitor rules genuinely DO exist by this
 * point and losing the record is pure data loss: `state.rules` is the ONLY
 * place the editor's GET (and every per-rule Start/Stop/Edit/Delete handler)
 * looks for a deployed activator's rules.
 *
 * Per deploy-integrity.md R6 this retries with bounded backoff and FAILS CLOSED
 * — it reports the outcome to its caller instead of swallowing it into steps[].
 * The merge is idempotent, matching the rules route's POST pattern
 * (`rules.filter(r => r.id !== rule.id)` then append), so re-running an install
 * updates each rule in place instead of duplicating it, and never discards rules
 * a user added interactively.
 */
const PERSIST_ATTEMPTS = 3;
const PERSIST_BACKOFF_MS = [150, 400];

type PersistOutcome =
  | { ok: true; attempts: number }
  | { ok: false; attempts: number; reason: 'item-not-found' | 'write-failed'; error: string };

async function persistRulesToItem(
  input: any,
  records: MonitorRuleRecord[],
  steps: string[],
): Promise<PersistOutcome> {
  let reason: 'item-not-found' | 'write-failed' = 'write-failed';
  let error = '';
  for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt++) {
    try {
      const items = await itemsContainer();
      // Re-read on EVERY attempt so a retry merges against the CURRENT document
      // (and so an item still replicating is picked up by a later attempt).
      const { resource: cur } = await items.item(input.cosmosItemId, input.workspaceId).read<WorkspaceItem>();
      if (!cur) {
        reason = 'item-not-found';
        error = `item '${input.cosmosItemId}' not found in workspace '${input.workspaceId}' (the Cosmos read returned no document)`;
      } else {
        const existing: MonitorRuleRecord[] = Array.isArray((cur.state as any)?.rules) ? (cur.state as any).rules : [];
        const nextRules = [...existing.filter((r) => !records.some((n) => n.id === r.id)), ...records];
        const next: WorkspaceItem = {
          ...cur,
          state: { ...(cur.state || {}), rules: nextRules },
          updatedAt: new Date().toISOString(),
        };
        await items.item(cur.id, cur.workspaceId).replace(next);
        steps.push(
          `Persisted ${records.length} activator rule(s) to the item state.rules` +
            (attempt > 1 ? ` on attempt ${attempt}/${PERSIST_ATTEMPTS}` : '') +
            ' so the editor + pane are self-sufficient.',
        );
        return { ok: true, attempts: attempt };
      }
    } catch (e: any) {
      reason = 'write-failed';
      error = e?.message || String(e);
    }
    if (attempt < PERSIST_ATTEMPTS) {
      steps.push(`state.rules write attempt ${attempt}/${PERSIST_ATTEMPTS} did not complete (${error}); retrying.`);
      await new Promise((r) => setTimeout(r, PERSIST_BACKOFF_MS[attempt - 1] ?? 400));
    }
  }
  return { ok: false, attempts: PERSIST_ATTEMPTS, reason, error };
}

async function provisionAzureMonitor(input: any, steps: string[]): Promise<ProvisionResult> {
  const content = input.content as any;
  const rules = rulesFromContent(content);
  if (rules.length === 0) {
    return { status: 'created', secondaryIds: { backend: 'azure-monitor' }, steps: [...steps, 'No rules in bundle; activator item created (Azure Monitor backend, no alert rules to author).'] };
  }

  // Resolve the alert scope ONCE up front. When neither a Log Analytics
  // workspace nor an ADX cluster scope is configured, no scheduledQueryRule can
  // be created — surface that as an honest gate naming the exact env vars rather
  // than a per-rule failure that reads as "No alert rules could be created".
  const scope = pickAlertScope();
  if ('missing' in scope) {
    return {
      status: 'remediation',
      gate: {
        reason: 'No Azure Monitor alert scope is configured for this deployment.',
        remediation: `Set ${scope.missing[0]} (Log Analytics workspace ARM resource id — the default log-alert scope) or ${scope.missing[1]} (ADX cluster ARM id — for Eventhouse/RTI rules) so the Activator can scope its scheduled-query rules. (No Microsoft Fabric required.)`,
        link: 'https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-create-log-alert-rule',
      },
      steps,
    };
  }
  const sourceKind = scope.sourceKind;
  steps.push(`Authoring alert rules against the ${sourceKind === 'adx' ? 'Eventhouse/ADX cluster (LOOM_ADX_ALERT_SCOPE)' : 'Log Analytics workspace (LOOM_LOG_ANALYTICS_RESOURCE_ID)'} scope.`);

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
        // Scope the rule against whichever alert host this deployment actually
        // has (Log Analytics preferred, else the ADX cluster) so it CREATEs 200
        // day-one — a bundle rule's phantom custom metric no longer sinks the
        // install (the query is column_ifexists + skipQueryValidation).
        sourceKind,
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

  if (created === 0) {
    return {
      status: 'remediation',
      secondaryIds: { backend: 'azure-monitor', rulesCreated: '0' },
      gate: { reason: 'No alert rules could be created.', remediation: 'See step log for the per-rule errors above.' },
      steps,
    };
  }

  // Persist the authored MonitorRuleRecord[] onto the Cosmos activator item's
  // state.rules — the SAME write path the rules BFF route's POST/PUT/PATCH/DELETE
  // handlers use, and the ONLY place the editor's GET looks for a deployed
  // activator's rules.
  //
  // #3551: this write used to be BEST-EFFORT — a failure was appended to steps[]
  // and the returned status was computed SOLELY from whether Azure Monitor
  // accepted the rules. A lost write therefore produced real scheduledQueryRules,
  // a green 'created', and an editor showing NOTHING, with no error anywhere.
  // Per deploy-integrity.md R6 the write is now retried with bounded backoff and
  // FAILS CLOSED: the returned status reflects whether the record reached
  // state.rules, not only whether Azure Monitor accepted the rules.
  const persisted = await persistRulesToItem(input, records, steps);
  const ruleNames = records.map((r) => r.azureRuleName).join(', ');

  if (!persisted.ok) {
    steps.push(
      `Azure Monitor accepted ${created} alert rule(s) (${ruleNames}) but the record could not be written to the activator item's state.rules after ${persisted.attempts} attempt(s).`,
    );
    // Only what the code ESTABLISHED (deploy-integrity.md R7): the rules were
    // created, and the write did not confirm. The cause is NOT asserted — the
    // underlying error is carried verbatim by resolveInfraResidual.
    return resolveInfraResidual(
      persisted.error,
      `Retry this install step. The retry is idempotent: the scheduledQueryRules are upserted by name, so it will not create duplicate alert rules. ` +
        `Until the record is written the activator's rule list stays empty even though the alert rule(s) exist in Azure Monitor. ` +
        `If the retry keeps failing, check the underlying error below and verify the Console UAMI holds the Cosmos DB Built-in Data Contributor role on the Loom Cosmos account.`,
      {
        reason:
          `Created ${created} Azure Monitor alert rule(s) (${ruleNames}) but could not record them on the activator item: ` +
          (persisted.reason === 'item-not-found'
            ? `reading item '${input.cosmosItemId}' in workspace '${input.workspaceId}' returned no document.`
            : `the Cosmos write did not complete.`),
        link: 'https://learn.microsoft.com/azure/cosmos-db/nosql/security/how-to-grant-data-plane-role-based-access',
        errorPrefix: `Authored ${created} Azure Monitor alert rule(s) but failed to persist state.rules: `,
        resourceId: records[records.length - 1]?.azureRuleName,
        secondaryIds: { backend: 'azure-monitor', rulesCreated: String(created), rulesPersisted: 'false' },
        steps,
      },
    );
  }

  return {
    status: 'created',
    resourceId: records[records.length - 1]?.azureRuleName,
    secondaryIds: { backend: 'azure-monitor', rulesCreated: String(created), rulesPersisted: 'true' },
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
