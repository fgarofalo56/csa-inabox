/**
 * Azure-native Activator runtime backend (DEFAULT) — per
 * .claude/rules/no-fabric-dependency.md.
 *
 * A Loom Activator rule (condition + action) maps to a real Azure Monitor
 * scheduledQueryRule that runs a KQL query over the Log Analytics workspace and
 * fires its action group (email) when the query returns rows. This is the SAME
 * mapping the install-time provisioner (lib/install/provisioners/activator.ts)
 * uses, lifted here so the LIVE editor's rule CRUD also defaults to Azure
 * Monitor instead of calling api.fabric.microsoft.com. A Fabric Reflex remains
 * an opt-in alternative (LOOM_ACTIVATOR_BACKEND=fabric); when it is not selected
 * Loom uses this path silently — no Fabric workspace required.
 *
 * The pure KQL/email helpers are duplicated from the provisioner (small, pure,
 * stable) so the runtime path has zero coupling to install code.
 */
import {
  upsertActionGroup,
  upsertScheduledQueryRule,
  patchScheduledQueryRule,
  deleteScheduledQueryRule,
  queryLogs,
  listAlertHistory,
  type AlertHistoryEvent,
  type SmsReceiverInput,
  type WebhookReceiverInput,
  type LogicAppReceiverInput,
} from './monitor-client';
// ADX / Eventhouse (Real-Time Intelligence) runtime backend for the Activator.
// RTI streams land in Azure Data Explorer / Eventhouse, NOT Log Analytics, so a
// rule authored over Eventhouse data must run its KQL against the ADX cluster to
// ever fire. These are the real query-plane helpers (no mocks) — see
// kusto-client.ts for how the cluster/db resolve from LOOM_KUSTO_*.
import {
  executeQuery,
  normalizeClusterUri,
  defaultDatabase as kustoDefaultDatabase,
} from './kusto-client';

// Re-export so the BFF route imports its activator surface from one module.
export type { AlertHistoryEvent };

// ── pure helpers (mirror of provisioners/activator.ts) ──────────────────────
export function safeRuleName(displayName: string, suffix: string): string {
  const base = (displayName || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'loom-activator';
  return `${base}-${suffix}`.slice(0, 90);
}

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

function kqlValue(v: any): string {
  if (v === null || v === undefined || v === '') return '""';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return v.trim();
  return `"${String(v).replace(/"/g, '\\"')}"`;
}

/** Build the alert KQL. Verbatim `query` wins; else compose from the structured
 *  condition (property/operator/value). Fires when the query returns ≥1 row. */
export function buildRuleQuery(rule: any): { query: string; note?: string } {
  if (typeof rule?.query === 'string' && rule.query.trim()) return { query: rule.query.trim() };
  const cond = rule?.condition || {};
  const table =
    rule?.sourceTable || rule?.table || rule?.stream || rule?.eventTable ||
    process.env.LOOM_ACTIVATOR_DEFAULT_TABLE || 'AppEvents';
  const property = cond.property || cond.field || cond.condProperty || 'value';
  const op = kqlOperator(cond.operator || cond.condOperator);
  const value = cond.value ?? cond.condValue ?? 0;
  // column-safe predicate: resolve `property` via column_ifexists (falling back
  // to the App Insights Properties custom-dimension bag) so the rule VALIDATES
  // and provisions against a real table whose literal column may not exist —
  // instead of a SEM0100 that surfaces as a 502. Numeric comparisons coerce the
  // resolved scalar with todouble(); non-numeric ops compare as string.
  const safeCol = `column_ifexists("${property}", tostring(parse_json(tostring(column_ifexists("Properties", dynamic({}))))["${property}"]))`;
  const numericOp = ['>', '>=', '<', '<=', '==', '!='].includes(op);
  const lhs = numericOp && typeof value === 'number' ? `todouble(${safeCol})` : safeCol;
  const query = `${table}\n| extend _v = ${lhs}\n| where _v ${op} ${kqlValue(value)}`;
  const note = rule?.sourceTable || rule?.table
    ? undefined
    : `Alert query targets table '${table}' — set the rule's sourceTable (or LOOM_ACTIVATOR_DEFAULT_TABLE) to point at your data.`;
  return { query, note };
}

/**
 * Build the alert KQL for an Eventhouse / ADX (Real-Time Intelligence) source.
 *
 * Same contract as {@link buildRuleQuery} (fires when the query returns ≥1 row)
 * but targets a Kusto database directly — RTI streams land in ADX / Eventhouse,
 * not Log Analytics, so this is the query the Trigger/Preview + scheduled path
 * runs against the cluster via kusto-client.executeQuery. A verbatim `query`
 * wins; otherwise it is composed from the structured condition against the
 * chosen table. `column_ifexists(...)` resolves the property against the real
 * ADX table schema so a rule VALIDATES even when the literal column is absent
 * (predicate is simply false → no rows → won't fire) instead of erroring.
 */
export function buildAdxRuleQuery(rule: any): { query: string; note?: string } {
  if (typeof rule?.query === 'string' && rule.query.trim()) return { query: rule.query.trim() };
  const cond = rule?.condition || {};
  const table =
    rule?.sourceTable || rule?.table || rule?.stream || rule?.eventTable ||
    process.env.LOOM_ACTIVATOR_DEFAULT_TABLE || 'Events';
  const property = cond.property || cond.field || cond.condProperty || 'value';
  const op = kqlOperator(cond.operator || cond.condOperator);
  const value = cond.value ?? cond.condValue ?? 0;
  const safeCol = `column_ifexists("${property}", dynamic(null))`;
  const numericOp = ['>', '>=', '<', '<=', '==', '!='].includes(op);
  const lhs = numericOp && typeof value === 'number' ? `todouble(${safeCol})` : safeCol;
  const query = `${table}\n| extend _v = ${lhs}\n| where _v ${op} ${kqlValue(value)}`;
  const note = rule?.sourceTable || rule?.table
    ? undefined
    : `Alert query targets Eventhouse table '${table}' — set the rule's source table to point at your KQL/ADX data.`;
  return { query, note };
}

function ruleEmails(rule: any): string[] {
  const action = rule?.action || {};
  const targets: string[] = [];
  for (const v of [action.target, action.actTarget, action.email, action.to, action.recipients, action?.config?.to]) {
    if (Array.isArray(v)) targets.push(...v);
    else if (typeof v === 'string') targets.push(...v.split(/[;,]/));
  }
  return targets.map((t) => t.trim()).filter((t) => t.includes('@'));
}

/** Webhook receivers from a rule's action config (Webhook / Teams-via-webhook actions). */
function ruleWebhooks(rule: any): WebhookReceiverInput[] {
  const cfg = rule?.action?.config || {};
  const uris: string[] = [];
  for (const k of ['webhookUrl', 'url', 'triggerUrl', 'serviceUri']) {
    const v = cfg[k];
    if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) uris.push(v.trim());
  }
  // de-dupe
  return Array.from(new Set(uris)).map((serviceUri) => ({ serviceUri, useCommonAlertSchema: true }));
}

/** SMS receiver from a rule's action config (SMS action). */
function ruleSmsReceivers(rule: any): SmsReceiverInput[] {
  const cfg = rule?.action?.config || {};
  const phone = String(cfg.phoneNumber || cfg.phone || '').replace(/[^0-9]/g, '');
  if (!phone) return [];
  const countryCode = String(cfg.countryCode || '1').replace(/[^0-9]/g, '') || '1';
  return [{ countryCode, phoneNumber: phone }];
}

/** Logic App receiver from a rule's action config (LogicApp action). */
function ruleLogicAppReceivers(rule: any): LogicAppReceiverInput[] {
  const cfg = rule?.action?.config || {};
  const resourceId = String(cfg.logicAppResourceId || '').trim();
  const callbackUrl = String(cfg.callbackUrl || '').trim();
  if (!resourceId || !callbackUrl) return [];
  return [{ resourceId, callbackUrl, useCommonAlertSchema: true }];
}

// ── runtime ──────────────────────────────────────────────────────────────
export interface MonitorRuleInput {
  name?: string;
  condition?: any;
  action?: any;
  query?: string;
  sourceTable?: string;
  severity?: number;
  /** ISO-8601 schedule, e.g. PT5M. How often the alert query is evaluated. */
  evaluationFrequency?: string;
  /** ISO-8601 lookback window the query spans, e.g. PT15M. Must be ≥ frequency. */
  windowSize?: string;
  /** ARM id of an EXISTING action group to attach instead of creating one from
   *  the rule's action config (the editor's pick-existing flow). */
  existingActionGroupId?: string;
  /** Which backend the rule's data lives in and the trigger/preview evaluates
   *  against. 'log-analytics' (Azure Monitor scheduledQueryRule over LA — the
   *  original path) or 'adx' (Eventhouse / KQL Database — the RTI DEFAULT).
   *  Absent ⇒ treated as 'log-analytics' for backward compatibility. */
  sourceKind?: 'log-analytics' | 'adx';
  /** ADX/Eventhouse database the rule's table lives in (sourceKind='adx'). When
   *  absent the kusto-client's LOOM_KUSTO_DEFAULT_DB is used. */
  adxDatabase?: string;
  /** Optional ADX cluster URI override (a discovered Eventhouse cluster). When
   *  absent the kusto-client's LOOM_KUSTO_CLUSTER_URI default is used. */
  adxClusterUri?: string;
}

export interface MonitorRuleRecord {
  id: string;
  name: string;
  query: string;
  azureRuleName: string;
  condition?: any;
  action?: any;
  actionGroupId?: string;
  /** Summary of the receivers attached to this rule's action group (for the UI). */
  actionGroupReceivers?: { emails: number; sms: number; webhooks: number; logicApps: number };
  severity: number;
  evaluationFrequency: string;
  windowSize: string;
  /** Whether the backing scheduledQueryRule is evaluating ('Active') or paused
   *  ('Disabled'). Toggled by enable/disable via an in-place ARM PATCH. */
  state: 'Active' | 'Disabled';
  backend: 'azure-monitor';
  /** Data-source backend the rule evaluates against — 'log-analytics' (Azure
   *  Monitor scheduledQueryRule) or 'adx' (Eventhouse / KQL Database, run via
   *  kusto-client). Absent on legacy records ⇒ treated as 'log-analytics'. */
  sourceKind?: 'log-analytics' | 'adx';
  /** ADX/Eventhouse database (sourceKind='adx') the Trigger/Preview re-runs against. */
  adxDatabase?: string;
  /** Optional ADX cluster URI override (sourceKind='adx'). */
  adxClusterUri?: string;
  /** Whether continuous, hands-off scheduled evaluation is wired. LA rules are
   *  always true (Azure Monitor evaluates them). ADX rules are true ONLY when an
   *  ADX-scoped alert host is provisioned (LOOM_ADX_ALERT_SCOPE); otherwise false
   *  and the rule evaluates on-demand via Trigger/Preview (see `note`). */
  scheduled?: boolean;
  createdAt: string;
  /** Last enable/disable timestamp, when the rule has been toggled. */
  updatedAt?: string;
  note?: string;
}

/** Create (or update) the runtime backend for a Loom activator rule.
 *
 *  - sourceKind='log-analytics' (the original path): a real Azure Monitor
 *    scheduledQueryRule (+ action group) over the LA workspace. Evaluates
 *    continuously via Azure Monitor.
 *  - sourceKind='adx' (Eventhouse / KQL Database — the RTI DEFAULT): the rule's
 *    KQL runs against the ADX cluster (kusto-client). Trigger/Preview evaluates
 *    it on-demand against REAL Eventhouse data. Continuous, hands-off scheduled
 *    evaluation is wired ONLY when an ADX-scoped alert host is provisioned
 *    (LOOM_ADX_ALERT_SCOPE = ADX cluster ARM id); otherwise the record carries
 *    an honest note (per no-vaporware.md) and `scheduled: false`.
 *
 *  Throws MonitorNotConfiguredError/MonitorError which the route maps to an
 *  honest Azure infra-gate (NOT a Fabric gate). */
export async function createMonitorActivatorRule(
  activatorDisplayName: string,
  input: MonitorRuleInput,
): Promise<MonitorRuleRecord> {
  const sourceKind: 'log-analytics' | 'adx' = input.sourceKind === 'adx' ? 'adx' : 'log-analytics';
  const { query, note } = sourceKind === 'adx' ? buildAdxRuleQuery(input) : buildRuleQuery(input);

  // Pick-existing flow: attach a known action group as-is. Otherwise compose a
  // new action group from the rule's action config (email / SMS / webhook /
  // Logic App). All four receiver kinds are real ARM receivers — no Fabric.
  // The action group is backend-agnostic: it wires notifications for both the LA
  // scheduledQueryRule and an ADX-scoped rule when a host is provisioned.
  let actionGroupId: string | undefined = input.existingActionGroupId?.trim() || undefined;
  let receivers: MonitorRuleRecord['actionGroupReceivers'];
  if (!actionGroupId) {
    const emails = ruleEmails(input);
    const webhooks = ruleWebhooks(input);
    const smsArr = ruleSmsReceivers(input);
    const logicApps = ruleLogicAppReceivers(input);
    const hasReceivers = emails.length || webhooks.length || smsArr.length || logicApps.length;
    if (hasReceivers) {
      actionGroupId = await upsertActionGroup({
        name: safeRuleName(activatorDisplayName, 'ag'),
        shortName: (activatorDisplayName || 'loom').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'loom',
        emails,
        smsReceivers: smsArr,
        webhookReceivers: webhooks,
        logicAppReceivers: logicApps,
      });
      receivers = { emails: emails.length, sms: smsArr.length, webhooks: webhooks.length, logicApps: logicApps.length };
    }
  }
  const ruleSuffix = (input.name || 'rule').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 16) || 'rule';
  const azureRuleName = safeRuleName(activatorDisplayName, ruleSuffix);
  const severity = typeof input.severity === 'number' ? input.severity : 3;
  const evaluationFrequency = input.evaluationFrequency || 'PT5M';
  const windowSize = input.windowSize || 'PT5M';

  // ── Eventhouse / ADX (Real-Time Intelligence) source ──
  if (sourceKind === 'adx') {
    // Continuous scheduled eval on ADX needs an ADX-scoped alert host. When the
    // operator has provisioned one (LOOM_ADX_ALERT_SCOPE = the ADX cluster ARM
    // resource id, with the alert identity granted Database Viewer) we create a
    // real scheduledQueryRule scoped to that cluster (skipQueryValidation — the
    // KQL targets ADX, not LA). Otherwise the rule evaluates on-demand via
    // Trigger/Preview and the record carries an HONEST gate note.
    const adxScope = process.env.LOOM_ADX_ALERT_SCOPE?.trim();
    let scheduled = false;
    let scheduleNote: string;
    if (adxScope) {
      await upsertScheduledQueryRule({
        name: azureRuleName,
        description: `Loom Activator rule '${input.name || 'rule'}' (Eventhouse / ADX)`,
        query,
        severity,
        evaluationFrequency,
        windowSize,
        scopes: [adxScope],
        skipQueryValidation: true,
        actionGroupIds: actionGroupId ? [actionGroupId] : undefined,
      });
      scheduled = true;
      scheduleNote = 'Continuous evaluation runs on the ADX-scoped Azure Monitor alert host (LOOM_ADX_ALERT_SCOPE).';
    } else {
      scheduleNote =
        'Continuous scheduled evaluation for Eventhouse / ADX sources is on-demand: use Trigger/Preview to evaluate the rule now against real ADX data. ' +
        'For hands-off scheduled evaluation, set LOOM_ADX_ALERT_SCOPE to the ADX cluster resource id (and grant the alert identity Database Viewer). ' +
        'Log-Analytics-sourced rules evaluate continuously via Azure Monitor.';
    }
    return {
      id: azureRuleName,
      name: input.name || azureRuleName,
      query,
      azureRuleName,
      condition: input.condition,
      action: input.action,
      actionGroupId,
      ...(receivers ? { actionGroupReceivers: receivers } : {}),
      severity,
      evaluationFrequency,
      windowSize,
      state: 'Active',
      backend: 'azure-monitor',
      sourceKind: 'adx',
      ...(input.adxDatabase ? { adxDatabase: input.adxDatabase } : {}),
      ...(input.adxClusterUri ? { adxClusterUri: input.adxClusterUri } : {}),
      scheduled,
      createdAt: new Date().toISOString(),
      note: [note, scheduleNote].filter(Boolean).join(' '),
    };
  }

  // ── Log Analytics source (Azure Monitor scheduledQueryRule) ──
  await upsertScheduledQueryRule({
    name: azureRuleName,
    description: `Loom Activator rule '${input.name || 'rule'}'`,
    query,
    severity,
    evaluationFrequency,
    windowSize,
    actionGroupIds: actionGroupId ? [actionGroupId] : undefined,
  });
  return {
    id: azureRuleName,
    name: input.name || azureRuleName,
    query,
    azureRuleName,
    condition: input.condition,
    action: input.action,
    actionGroupId,
    ...(receivers ? { actionGroupReceivers: receivers } : {}),
    severity,
    evaluationFrequency,
    windowSize,
    state: 'Active',
    backend: 'azure-monitor',
    sourceKind: 'log-analytics',
    scheduled: true,
    createdAt: new Date().toISOString(),
    ...(note ? { note } : {}),
  };
}

/** Enable a Loom activator rule = un-pause its scheduledQueryRule (PATCH
 *  properties.enabled=true). Azure-native; no Fabric. Throws
 *  MonitorNotConfiguredError/MonitorError which the route maps to an honest
 *  Azure infra-gate. */
export async function enableMonitorRule(azureRuleName: string): Promise<void> {
  await patchScheduledQueryRule(azureRuleName, true);
}

/** Disable a Loom activator rule = pause its scheduledQueryRule (PATCH
 *  properties.enabled=false). The rule stays defined (query/scope/action group
 *  intact) but stops evaluating until re-enabled. Azure-native; no Fabric. */
export async function disableMonitorRule(azureRuleName: string): Promise<void> {
  await patchScheduledQueryRule(azureRuleName, false);
}

/** Delete a Loom activator rule = remove its scheduledQueryRule from ARM. A 404
 *  (already gone) is treated as success by the underlying client. Azure-native;
 *  no Fabric. The route is responsible for also splicing the record out of the
 *  Cosmos item's state.rules. */
export async function deleteMonitorActivatorRule(azureRuleName: string): Promise<void> {
  await deleteScheduledQueryRule(azureRuleName);
}

/** "Trigger now" / "Preview" on the Azure-native backend = run the rule's KQL
 *  right now and report whether it would fire (rows > 0).
 *
 *  Branches on the rule's source kind:
 *   - 'adx' (Eventhouse / KQL Database — RTI DEFAULT): runs the KQL against the
 *     real ADX cluster via kusto-client.executeQuery (cluster/db resolved from
 *     LOOM_KUSTO_* unless the rule carries an override). This is the path that
 *     makes rules authored over Eventhouse/RTI streams actually evaluate.
 *   - 'log-analytics' (or legacy rules with no sourceKind): runs against the LA
 *     workspace via queryLogs — unchanged.
 *
 *  Throws KustoError / MonitorNotConfiguredError / MonitorError which the route
 *  maps to an honest 503/gate (e.g. LOOM_KUSTO_* unset ⇒ degrades cleanly). */
export async function triggerMonitorActivatorRule(
  rule: {
    query?: string;
    sourceKind?: string;
    sourceTable?: string;
    condition?: any;
    adxDatabase?: string;
    adxClusterUri?: string;
  } | string,
): Promise<{ columns: string[]; rows: unknown[][]; count: number; fired: boolean; backend: 'adx' | 'log-analytics'; query: string }> {
  // Back-compat: a bare query string routes to the Log Analytics path.
  const r = typeof rule === 'string' ? { query: rule } : (rule || {});
  const isAdx = String((r as any).sourceKind || '').toLowerCase() === 'adx';

  if (isAdx) {
    const built = buildAdxRuleQuery(r);
    const database = ((r as any).adxDatabase && String((r as any).adxDatabase).trim()) || kustoDefaultDatabase();
    const clusterUri = normalizeClusterUri((r as any).adxClusterUri) || undefined;
    const res = await executeQuery(database, built.query, clusterUri ? { clusterUri } : undefined);
    return {
      columns: res.columns,
      rows: res.rows.slice(0, 50),
      count: res.rowCount,
      fired: res.rowCount > 0,
      backend: 'adx',
      query: built.query,
    };
  }

  const q = String((r as any).query || '').trim();
  const res = await queryLogs(q, 'PT1H');
  return {
    columns: res.columns,
    rows: res.rows.slice(0, 50),
    count: res.rowCount,
    fired: res.rowCount > 0,
    backend: 'log-analytics',
    query: q,
  };
}

/** Run history / trigger log — fetch the fired/resolved Azure Monitor alert
 *  instances for a set of activator rules. Each rule is identified by its
 *  azureRuleName (the scheduledQueryRule name on ARM). Results are fanned out
 *  one call per rule, merged, and sorted newest-first. Throws
 *  MonitorNotConfiguredError/MonitorError which the route maps to an honest
 *  Azure infra-gate (NOT a Fabric gate). */
export async function getActivatorHistory(
  azureRuleNames: string[],
  opts?: { days?: number },
): Promise<AlertHistoryEvent[]> {
  const names = Array.from(new Set(azureRuleNames.filter(Boolean)));
  if (!names.length) return [];
  const perRule = await Promise.all(
    names.map((name) => listAlertHistory({ alertRule: name, days: opts?.days })),
  );
  const merged = perRule.flat();
  merged.sort(
    (a, b) => new Date(b.startDateTime).getTime() - new Date(a.startDateTime).getTime(),
  );
  return merged;
}
