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
  readActionGroupReceivers,
  LOOM_MANAGED_RECEIVER_KINDS,
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
// Trigger-model depth (FGC-13): Event / Split-Event / Property rule kinds with
// per-object grouping + stateful change detection. The compiler is pure KQL
// (valid on both ADX and Log Analytics), so both source paths reuse it.
import {
  compileTriggerModelKql,
  coerceRuleKind,
  type ActivatorRuleKind,
  type PropertyConditionType,
  type TriggerModelInput,
} from './activator-trigger-model';
import { trimEdges } from '@/lib/util/trim';

// Re-export so the BFF route imports its activator surface from one module.
export type { AlertHistoryEvent };

// ── pure helpers (mirror of provisioners/activator.ts) ──────────────────────
export function safeRuleName(displayName: string, suffix: string): string {
  const base = trimEdges((displayName || '').replace(/[^A-Za-z0-9_-]+/g, '-'), '-').slice(0, 70) || 'loom-activator';
  return `${base}-${suffix}`.slice(0, 90);
}

/** ARM tag keys stamped on every scheduledQueryRule Loom authors. The item id is
 *  the ONLY authoritative join key back to the Loom item: the resource group is
 *  deployment-wide, and the rule NAME is derived from a user-controlled display
 *  name that can change (or be chosen to collide) after the rule is created. */
export const LOOM_RULE_TAG_ITEM_ID = 'loom-item-id';
export const LOOM_RULE_TAG_ITEM_TYPE = 'loom-item-type';

/** The deterministic ARM name suffix for a Loom-facing rule name. */
export function ruleNameSuffix(ruleName: string | undefined): string {
  return (ruleName || 'rule').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 16) || 'rule';
}

/**
 * The EXACT scheduledQueryRule name `createMonitorActivatorRule` authors for
 * (activator display name, Loom rule name). Exported so a reader can re-derive
 * it and compare for equality instead of guessing from a prefix.
 */
export function expectedAzureRuleName(activatorDisplayName: string, ruleName: string | undefined): string {
  return safeRuleName(activatorDisplayName, ruleNameSuffix(ruleName));
}

/** The Loom-facing rule name stamped into the ARM description by
 *  {@link createMonitorActivatorRule}, or null when the marker is absent (i.e.
 *  the rule was not authored by the Loom Activator). Lives next to the writer so
 *  the marker and its parser cannot drift apart. */
export function loomRuleNameFromDescription(description?: string): string | null {
  return /Loom Activator rule '([^']*)'/.exec(description || '')?.[1] ?? null;
}

/** The subset of a live ARM scheduledQueryRule the ownership test reads. */
export interface RuleOwnershipProbe {
  name?: string;
  description?: string;
  tags?: Record<string, string> | null;
}

/**
 * Does this LIVE Azure Monitor rule belong to THIS Loom activator item?
 *
 * This is a write-authorizing decision, not a display filter: a claimed rule is
 * recorded on the item, and DELETE / enable / disable then act on the live
 * resource. So it answers only on evidence that is authoritative:
 *
 *  1. A `loom-item-id` tag — conclusive both ways. Ours ⇒ claimed (even if the
 *     activator has since been renamed); someone else's ⇒ refused outright, no
 *     matter what the name looks like.
 *  2. No Loom tag (every rule authored before the tag existed — precisely the
 *     #3551 recovery population) ⇒ BOTH the `Loom Activator rule '<name>'`
 *     description marker AND `name === expectedAzureRuleName(displayName, that
 *     name)` must hold. Equality against the name this item's own authoring path
 *     would have produced, never a prefix: 'Model Drift Alert' + rule 'churn' is
 *     Model-Drift-Alert-churn, which is NOT the Model-Drift-Alert-Prod-churn that
 *     the separate activator 'Model Drift Alert Prod' owns.
 *
 * Fails CLOSED. A rule whose Loom name contains an apostrophe (the description
 * marker is single-quoted, so the parse is lossy), or one belonging to an
 * activator that was renamed before it was tagged, is left unclaimed rather than
 * claimed on a guess.
 */
export function ruleBelongsToItem(
  rule: RuleOwnershipProbe,
  item: { id: string; displayName?: string },
): boolean {
  const taggedItemId = rule.tags?.[LOOM_RULE_TAG_ITEM_ID];
  if (taggedItemId) return taggedItemId === item.id;
  if (typeof rule.name !== 'string' || !rule.name) return false;
  const named = loomRuleNameFromDescription(rule.description);
  if (named === null) return false;
  return rule.name === expectedAzureRuleName(item.displayName || '', named);
}

/**
 * Normalize a schedule/window duration to the ISO-8601 form Azure Monitor
 * scheduledQueryRules require (PT5M / PT1H / P1D). The Loom editor already emits
 * ISO strings, but content-bundle rules carry human shorthand ('5m', '1h',
 * '15m', '1d') — passing those straight to ARM fails with "The string '5m' is
 * not a valid TimeSpan value." and sinks the whole activator install. This
 * coerces the common shorthands (and bare numbers ⇒ minutes) so both callers
 * produce a valid duration; anything already ISO-8601 (starts with P) passes
 * through uppercased. Falls back to the provided default when unparseable.
 */
export function toIsoDuration(v: string | undefined, fallback: string): string {
  const s = (v || '').trim();
  if (!s) return fallback;
  if (/^p/i.test(s)) return s.toUpperCase(); // already ISO-8601 (PT5M, P1D, …)
  const m = s.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/i);
  if (!m) return fallback;
  const n = m[1];
  const unit = (m[2] || 'm').toLowerCase();
  if (/^s/.test(unit)) return `PT${n}S`;
  if (/^h/.test(unit)) return `PT${n}H`;
  if (/^d/.test(unit)) return `P${n}D`;
  return `PT${n}M`; // minutes (default)
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
  // Escape backslashes FIRST, then double-quotes, so a trailing backslash in
  // the input can't escape the closing quote and break out of the KQL literal.
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Extract the typed trigger model (FGC-13) from a rule. The kind lives at the
 *  rule top level; the property/operator/value/change fields live either on the
 *  rule or inside `condition` (the wizard nests them under condition). Returns
 *  null for a plain Event rule so the legacy flat builder handles it verbatim. */
export function triggerModelFromRule(rule: any, defaultTable: string): TriggerModelInput | null {
  const kind: ActivatorRuleKind = coerceRuleKind(rule?.ruleKind);
  if (kind === 'event') return null;
  const cond = rule?.condition || {};
  return {
    ruleKind: kind,
    objectKey: (rule?.objectKey ?? cond.objectKey ?? '') || '',
    property: (cond.property ?? cond.field ?? rule?.property ?? 'value') || 'value',
    propertyConditionType: (rule?.propertyConditionType ?? cond.propertyConditionType) as PropertyConditionType | undefined,
    operator: cond.operator ?? rule?.operator,
    value: cond.value ?? rule?.value,
    changePercent: rule?.changePercent ?? cond.changePercent,
    rangeMin: rule?.rangeMin ?? cond.rangeMin,
    rangeMax: rule?.rangeMax ?? cond.rangeMax,
    noDataMinutes: rule?.noDataMinutes ?? cond.noDataMinutes,
    table: rule?.sourceTable || rule?.table || rule?.stream || rule?.eventTable || defaultTable,
    timestampColumn: rule?.timestampColumn ?? cond.timestampColumn,
  };
}

/** Build the alert KQL. Verbatim `query` wins; else, when a trigger-model rule
 *  kind is set (Split-Event / Property — FGC-13), compile the per-object /
 *  stateful KQL; else compose from the flat structured condition
 *  (property/operator/value). Fires when the query returns ≥1 row. */
export function buildRuleQuery(rule: any): { query: string; note?: string } {
  if (typeof rule?.query === 'string' && rule.query.trim()) return { query: rule.query.trim() };
  const defaultTableLA = rule?.sourceTable || rule?.table || process.env.LOOM_ACTIVATOR_DEFAULT_TABLE || 'AppEvents';
  const tm = triggerModelFromRule(rule, defaultTableLA);
  if (tm) {
    return {
      query: compileTriggerModelKql(tm),
      note: rule?.sourceTable || rule?.table ? undefined
        : `Trigger-model rule targets table '${tm.table}' — set the rule's sourceTable to point at your data.`,
    };
  }
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
  const defaultTableAdx = rule?.sourceTable || rule?.table || process.env.LOOM_ACTIVATOR_DEFAULT_TABLE || 'Events';
  const tm = triggerModelFromRule(rule, defaultTableAdx);
  if (tm) {
    return {
      query: compileTriggerModelKql(tm),
      note: rule?.sourceTable || rule?.table ? undefined
        : `Trigger-model rule targets Eventhouse table '${tm.table}' — set the rule's source table to point at your KQL/ADX data.`,
    };
  }
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
  /** Cosmos id of the Loom activator item that owns this rule. Stamped onto the
   *  ARM resource as the `loom-item-id` tag so a later read can join a live rule
   *  back to its item on an IDENTITY rather than on the derived, user-controlled
   *  rule name (which two different activators can produce a prefix collision
   *  on, and which a rename invalidates). Callers should always pass it. */
  loomItemId?: string;
  /** ISO-8601 schedule, e.g. PT5M. How often the alert query is evaluated. */
  evaluationFrequency?: string;
  /** ISO-8601 lookback window the query spans, e.g. PT15M. Must be ≥ frequency. */
  windowSize?: string;
  /** ARM id of an EXISTING action group to attach instead of creating one from
   *  the rule's action config (the editor's pick-existing flow). */
  existingActionGroupId?: string;
  /**
   * Addresses to bind when the rule's own action names no deliverable
   * destination (#4113). The platform ALWAYS has one for an interactive
   * caller — the signed-in operator's — and `auto-bind-by-default.md` §5 is
   * explicit that a value the platform holds must not become a user step.
   * Empty/absent means the caller genuinely has none, and the record then says
   * so rather than pretending a group was wired.
   */
  fallbackEmails?: string[];
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
  // ── Trigger-model depth (FGC-13) ──
  /** Event | Split-Event | Property. Absent ⇒ 'event' (the flat comparison). */
  ruleKind?: ActivatorRuleKind;
  /** Object-key column to group by (device_id/asset_id) for Split-Event / Property rules. */
  objectKey?: string;
  /** Property-rule condition type (Becomes/Increases-by/Decreases-by/Exits-range/No-data-for). */
  propertyConditionType?: PropertyConditionType;
  /** Percent threshold for increases-by / decreases-by. */
  changePercent?: number;
  /** Inclusive bounds for exits-range. */
  rangeMin?: number;
  rangeMax?: number;
  /** Minutes of silence for no-data-for (heartbeat/absence). */
  noDataMinutes?: number;
  /** Event-time column for per-object ordering + heartbeat. */
  timestampColumn?: string;
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
  /**
   * How many receivers the rule's action group carries, BY KIND.
   *
   * #4113 — this used to be the four kinds `upsertActionGroup` composes, which
   * meant a group whose only receiver was an `armRoleReceiver` (the platform's
   * own escalation shape) summed to zero and read as "notifies nobody". `other`
   * carries every remaining kind in
   * `monitor-client.ACTION_GROUP_RECEIVER_KINDS` so the total is a total.
   */
  actionGroupReceivers?: { emails: number; sms: number; webhooks: number; logicApps: number; other?: number };
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
  // ── Trigger-model depth (FGC-13) — persisted so Edit re-opens the wizard in
  //    the same kind/condition and Trigger recompiles the same per-object KQL. ──
  ruleKind?: ActivatorRuleKind;
  objectKey?: string;
  propertyConditionType?: PropertyConditionType;
  changePercent?: number;
  rangeMin?: number;
  rangeMax?: number;
  noDataMinutes?: number;
  timestampColumn?: string;
  /** Whether continuous, hands-off scheduled evaluation is wired. LA rules are
   *  always true (Azure Monitor evaluates them). ADX rules are true ONLY when an
   *  ADX-scoped alert host is provisioned (LOOM_ADX_ALERT_SCOPE); otherwise false
   *  and the rule evaluates on-demand via Trigger/Preview (see `note`). */
  scheduled?: boolean;
  /** Operations-agent approval channel (G3). When true the ops-agent evaluator
   *  Function routes a fired trigger through a human approval (Teams
   *  adaptive-card via the bound Logic App) BEFORE any autonomous action runs;
   *  when false/absent the action fires directly (autonomous). Persisted on the
   *  rule so the evaluator + the Triggers UI agree on the mode. */
  requireApproval?: boolean;
  createdAt: string;
  /** Last enable/disable timestamp, when the rule has been toggled. */
  updatedAt?: string;
  note?: string;
}

export interface ActionGroupBindInput {
  activatorDisplayName: string;
  /** ARM id of a group to attach (the editor's pick-existing flow). */
  existingActionGroupId?: string;
  emails: string[];
  smsReceivers: SmsReceiverInput[];
  webhookReceivers: WebhookReceiverInput[];
  logicAppReceivers: LogicAppReceiverInput[];
  /** Used ONLY when nothing above yields a receiver. */
  fallbackEmails: string[];
}

export interface ActionGroupBindResult {
  actionGroupId?: string;
  receivers?: MonitorRuleRecord['actionGroupReceivers'];
  /**
   * What was actually done. `unreadable` is deliberately distinct from every
   * other value: it means the group exists and we could not see inside it, and
   * per `deploy-integrity.md` R7 that is not a pass and not a zero.
   */
  outcome: 'attached' | 'created' | 'repaired' | 'unreadable' | 'none';
  /** Human-readable, asserting only what was established. */
  note?: string;
}

/** Count a live receiver read into the record's by-kind shape. */
function countsFromRead(read: { byKind: Record<string, any[]> }): MonitorRuleRecord['actionGroupReceivers'] {
  const managed = new Set<string>(LOOM_MANAGED_RECEIVER_KINDS as readonly string[]);
  let other = 0;
  for (const [kind, arr] of Object.entries(read.byKind)) {
    if (!managed.has(kind)) other += (arr || []).length;
  }
  return {
    emails: (read.byKind.emailReceivers || []).length,
    sms: (read.byKind.smsReceivers || []).length,
    webhooks: (read.byKind.webhookReceivers || []).length,
    logicApps: (read.byKind.logicAppReceivers || []).length,
    other,
  };
}

/**
 * Resolve the action group a rule fires into, and GUARANTEE the answer is a
 * measured one (#4113).
 *
 * The two things this replaces both produced a rule that notified nobody while
 * reporting success:
 *
 *   - attaching a caller-supplied `existingActionGroupId` without ever reading
 *     it, so an empty group looked identical to an on-call one; and
 *   - creating no group at all when the rule's action derived no receivers,
 *     which is precisely the case a fallback exists to cover.
 *
 * The REPAIR writes back to the group's OWN ARM id, and `upsertActionGroup` is
 * read-modify-write, so a repair cannot clobber an `armRoleReceiver` the
 * platform (or the operator) put there.
 *
 * Never invents a receiver: with no derived destination AND no fallback the
 * outcome is `none` and the note says so, because there is nothing to bind.
 */
export async function bindActionGroup(input: ActionGroupBindInput): Promise<ActionGroupBindResult> {
  const { emails, smsReceivers, webhookReceivers, logicAppReceivers } = input;
  const derived = emails.length + smsReceivers.length + webhookReceivers.length + logicAppReceivers.length;
  const groupName = safeRuleName(input.activatorDisplayName, 'ag');
  const shortName = (input.activatorDisplayName || 'loom').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'loom';
  const target = input.existingActionGroupId || groupName;

  let read: Awaited<ReturnType<typeof readActionGroupReceivers>>;
  // WHEN THE READ IS NEEDED. It is what makes SKIP A and SKIP B impossible, and
  // it is needed for exactly those two: an attached group whose contents are
  // unknown, and a rule that derived no destination and must decide whether
  // falling back would clobber a group that is already fine. The other two
  // shapes are settled without an ARM round trip:
  //   - derived receivers, no group handed in ⇒ the WRITE is already
  //     read-modify-write (`upsertActionGroup`), so a second GET buys nothing;
  //   - nothing derived and no fallback ⇒ there is nothing to bind at all.
  if (!input.existingActionGroupId) {
    if (derived > 0) {
      const upserted = await upsertActionGroup({
        name: groupName,
        shortName,
        emails,
        smsReceivers,
        webhookReceivers,
        logicAppReceivers,
      });
      return {
        actionGroupId: upserted,
        // `other` is deliberately ABSENT rather than 0: the group was not read,
        // so any non-composed receiver on it is UNKNOWN, not zero (R7). The
        // total is still > 0, so reachability is established either way.
        receivers: { emails: emails.length, sms: smsReceivers.length, webhooks: webhookReceivers.length, logicApps: logicAppReceivers.length },
        outcome: 'created',
      };
    }
    if (input.fallbackEmails.length === 0) {
      return {
        outcome: 'none',
        note:
          'No action group was created: this rule declared no deliverable destination and no fallback address was available, ' +
          'so it would notify nobody.',
      };
    }
  }
  try {
    read = await readActionGroupReceivers(target);
  } catch (e: any) {
    if (input.existingActionGroupId) {
      // Attached but UNREAD. Say exactly that — an unread group is not an empty
      // one, and repairing it blind would write a body built from a state we
      // never observed.
      return {
        actionGroupId: input.existingActionGroupId,
        outcome: 'unreadable',
        note:
          `Attached action group ${input.existingActionGroupId}, but its receivers could not be read (${e?.message || String(e)}), ` +
          'so whether this rule reaches anyone was NOT established. Grant the Console UAMI "Monitoring Reader" on the alert resource group to confirm it.',
      };
    }
    // NO group was handed in, so `target` is the name of the group LOOM would
    // create for this activator, and the read failed for something other than
    // "it is not there" (`readActionGroupReceivers` turns a clean 404 into
    // `exists:false`, not a throw).
    //
    // #4354 review, finding 5. This used to `throw`, which made a 403 on the
    // action-group READ fail the whole rule creation — a behaviour change
    // nothing asked for: before #4113 there was no read here at all, so the
    // rule was created (wired to nobody, silently). Neither extreme is right.
    // Refusing to WRITE on an unreadable group stays — writing a body derived
    // from a state we never saw is exactly the deletion #4113 fixed — but the
    // rule itself is still created, and the outcome says, in the record the
    // user sees, that no action group was bound and why. That is the honest
    // middle: the pre-#4113 behaviour, no longer silent.
    return {
      outcome: 'unreadable',
      note:
        `No action group was bound: reading '${target}' — the group Loom would create for this activator — failed ` +
        `(${e?.message || String(e)}), and it is not a "does not exist" answer, so this rule's group was neither ` +
        'created nor confirmed and the rule notifies nobody until it is. Grant the Console UAMI "Monitoring Contributor" ' +
        'on the alert resource group (LOOM_ALERT_RG) and re-open this activator to bind it.',
    };
  }

  // The group already reaches someone. Attach it and record what it carries —
  // including the kinds Loom does not compose, which is the whole point.
  if (read.exists && read.total > 0) {
    return {
      actionGroupId: read.id || input.existingActionGroupId || undefined,
      receivers: countsFromRead(read),
      outcome: 'attached',
      note: input.existingActionGroupId ? undefined : `Reused existing action group '${groupName}' (${read.total} receiver(s)).`,
    };
  }

  // Nothing there (or no group yet). Bind what the rule declared; failing that,
  // the platform's fallback address.
  const useFallback = derived === 0;
  const bindEmails = useFallback ? input.fallbackEmails : emails;
  if (useFallback && bindEmails.length === 0) {
    return {
      ...(input.existingActionGroupId ? { actionGroupId: input.existingActionGroupId } : {}),
      ...(input.existingActionGroupId ? { receivers: countsFromRead(read) } : {}),
      outcome: 'none',
      note:
        (input.existingActionGroupId
          ? `Action group ${input.existingActionGroupId} has no receivers of any kind, and `
          : 'No action group was created: ') +
        'this rule declared no deliverable destination and no fallback address was available, so it would notify nobody.',
    };
  }

  const actionGroupId = await upsertActionGroup({
    name: input.existingActionGroupId || groupName,
    shortName,
    emails: bindEmails,
    smsReceivers: useFallback ? [] : smsReceivers,
    webhookReceivers: useFallback ? [] : webhookReceivers,
    logicAppReceivers: useFallback ? [] : logicAppReceivers,
  });
  const receivers: MonitorRuleRecord['actionGroupReceivers'] = {
    emails: bindEmails.length,
    sms: useFallback ? 0 : smsReceivers.length,
    webhooks: useFallback ? 0 : webhookReceivers.length,
    logicApps: useFallback ? 0 : logicAppReceivers.length,
    // Preserved by the read-modify-write, so they are still on the group.
    other: countsFromRead(read)!.other ?? 0,
  };
  const repaired = read.exists;
  return {
    actionGroupId,
    receivers,
    outcome: repaired ? 'repaired' : 'created',
    note: repaired
      ? `Action group '${read.id || target}' carried ZERO receivers; bound ${bindEmails.length} address(es)` +
        (useFallback ? ' from the platform fallback' : ' from the rule\'s own destinations') + '.'
      : undefined,
  };
}

/**
 * Bring an EXISTING action group back to reachable — the estate-repair half of
 * #4113.
 *
 * `createMonitorActivatorRule` only runs on create/edit, so fixing the bind
 * there repairs NEW rules and leaves every already-deployed one exactly as
 * broken as it was (11 of 13 live Commercial groups carried zero receivers).
 * This is the entry point an open-time reconcile calls for an existing rule.
 *
 * Reads first, and does nothing at all when the group already reaches someone —
 * by ANY receiver kind, so an `armRoleReceiver`-only group is left alone rather
 * than "repaired" over. Uses the SAME private derivation the create path uses,
 * so a repaired group is wired identically to a freshly created one.
 */
export async function repairActionGroupIfUnreachable(
  activatorDisplayName: string,
  actionGroupId: string,
  action: unknown,
  fallbackEmails: string[],
): Promise<ActionGroupBindResult> {
  const input = { action } as MonitorRuleInput;
  return bindActionGroup({
    activatorDisplayName,
    existingActionGroupId: actionGroupId,
    emails: ruleEmails(input),
    smsReceivers: ruleSmsReceivers(input),
    webhookReceivers: ruleWebhooks(input),
    logicAppReceivers: ruleLogicAppReceivers(input),
    fallbackEmails: (fallbackEmails || []).map((e) => String(e || '').trim()).filter(Boolean),
  });
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
  // Trigger-model fields (FGC-13) persisted onto the record so Edit re-opens the
  // wizard in the same kind/condition and Trigger recompiles the same KQL.
  const triggerModelFields = (() => {
    const kind = coerceRuleKind(input.ruleKind);
    if (kind === 'event') return {} as Partial<MonitorRuleRecord>;
    return {
      ruleKind: kind,
      ...(input.objectKey ? { objectKey: input.objectKey } : {}),
      ...(input.propertyConditionType ? { propertyConditionType: input.propertyConditionType } : {}),
      ...(typeof input.changePercent === 'number' ? { changePercent: input.changePercent } : {}),
      ...(typeof input.rangeMin === 'number' ? { rangeMin: input.rangeMin } : {}),
      ...(typeof input.rangeMax === 'number' ? { rangeMax: input.rangeMax } : {}),
      ...(typeof input.noDataMinutes === 'number' ? { noDataMinutes: input.noDataMinutes } : {}),
      ...(input.timestampColumn ? { timestampColumn: input.timestampColumn } : {}),
    } as Partial<MonitorRuleRecord>;
  })();

  // Pick-existing flow: attach a known action group. Otherwise compose a new
  // one from the rule's action config (email / SMS / webhook / Logic App). All
  // four receiver kinds are real ARM receivers — no Fabric. The action group is
  // backend-agnostic: it wires notifications for both the LA scheduledQueryRule
  // and an ADX-scoped rule when a host is provisioned.
  //
  // #4113 — TWO paths used to leave a rule wired to nobody, silently:
  //
  //   Skip A  an `existingActionGroupId` was attached AS-IS, with no read. The
  //           record carried no receiver counts, so `receiverTotal` answered
  //           UNKNOWN and no control could tell an on-call group from an empty
  //           one. 11 of 13 live Commercial groups were empty.
  //   Skip B  when the action derived no receivers, NO group was created at
  //           all. The rule evaluated, fired, routed, and notified nobody.
  //
  // Both now go through `bindActionGroup`, which READS the group, REPAIRS it
  // when it reaches nobody, and reports what it actually found.
  let actionGroupId: string | undefined = input.existingActionGroupId?.trim() || undefined;
  let receivers: MonitorRuleRecord['actionGroupReceivers'];
  // What the bind actually established, carried onto the record. Discarding it
  // was how `outcome:'none'` and `outcome:'unreadable'` became invisible: the
  // rule came back looking ordinary while nothing had been bound (R7).
  let bindNote: string | undefined;
  {
    const emails = ruleEmails(input);
    const webhooks = ruleWebhooks(input);
    const smsArr = ruleSmsReceivers(input);
    const logicApps = ruleLogicAppReceivers(input);
    const fallback = (input.fallbackEmails || []).map((e) => String(e || '').trim()).filter(Boolean);
    const bound = await bindActionGroup({
      activatorDisplayName,
      existingActionGroupId: actionGroupId,
      emails,
      smsReceivers: smsArr,
      webhookReceivers: webhooks,
      logicAppReceivers: logicApps,
      fallbackEmails: fallback,
    });
    actionGroupId = bound.actionGroupId;
    receivers = bound.receivers;
    bindNote = bound.note;
  }
  const ruleSuffix = ruleNameSuffix(input.name);
  const azureRuleName = safeRuleName(activatorDisplayName, ruleSuffix);
  // Ownership tag — the authoritative join key back to the Loom item for any
  // later read of the deployment-wide alert resource group.
  const loomTags = input.loomItemId
    ? { [LOOM_RULE_TAG_ITEM_ID]: input.loomItemId, [LOOM_RULE_TAG_ITEM_TYPE]: 'activator' }
    : undefined;
  const severity = typeof input.severity === 'number' ? input.severity : 3;
  // Normalize to ISO-8601 — bundle rules carry shorthand ('5m'/'1h') that ARM
  // rejects as an invalid TimeSpan; the editor already emits ISO (passes through).
  const evaluationFrequency = toIsoDuration(input.evaluationFrequency, 'PT5M');
  const windowSize = toIsoDuration(input.windowSize, 'PT5M');

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
        ...(loomTags ? { tags: loomTags } : {}),
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
      ...triggerModelFields,
      scheduled,
      createdAt: new Date().toISOString(),
      note: [note, bindNote, scheduleNote].filter(Boolean).join(' '),
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
    ...(loomTags ? { tags: loomTags } : {}),
    actionGroupIds: actionGroupId ? [actionGroupId] : undefined,
  });
  const laNote = [note, bindNote].filter(Boolean).join(' ');
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
    ...triggerModelFields,
    scheduled: true,
    createdAt: new Date().toISOString(),
    ...(laNote ? { note: laNote } : {}),
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

/** True when a rule is an UNSCHEDULED Eventhouse / ADX rule — sourceKind 'adx'
 *  with no ADX-scoped alert host provisioned (`scheduled !== true`, i.e.
 *  LOOM_ADX_ALERT_SCOPE was unset at create time) — so NO Azure Monitor
 *  scheduledQueryRule exists on ARM for it. Lifecycle actions
 *  (start/stop/enable/disable) must flip the persisted enabled flag on the
 *  Cosmos record instead of PATCHing ARM (which would 404 and silently no-op),
 *  and stop must NEVER re-upsert it: a re-PUT without the record's scopes would
 *  recreate the rule against the default Log Analytics workspace with ADX KQL
 *  (wrong scope; fails LA query validation). */
export function isOnDemandAdxRule(
  rule: { sourceKind?: string; scheduled?: boolean } | null | undefined,
): boolean {
  return !!rule && String(rule.sourceKind || '').toLowerCase() === 'adx' && rule.scheduled !== true;
}

// ── on-demand run history (Trigger / Preview evaluations) ───────────────────
/** One persisted on-demand evaluation (Trigger now / Preview) of an activator
 *  rule. Scheduled rules leave fired/resolved alert instances in Azure Monitor
 *  Alerts Management; on-demand ADX rules (the RTI default when
 *  LOOM_ADX_ALERT_SCOPE is unset) do NOT — so each evaluation is recorded on
 *  the Cosmos activator item (state.runHistory, capped) and the /history route
 *  merges them into its response with source:'on-demand'. */
export interface OnDemandRunRecord {
  ruleId: string;
  ruleName: string;
  /** ISO timestamp of the evaluation. */
  at: string;
  /** Rows the rule's KQL returned. */
  rowCount: number;
  /** Whether the rule would have fired (rows > 0). */
  fired: boolean;
  /** Query plane the evaluation ran against. */
  backend: 'adx' | 'log-analytics';
}

/** Cap on persisted on-demand evaluations per activator item (newest first) so
 *  the Cosmos document stays bounded. */
export const RUN_HISTORY_CAP = 100;

/** Prepend a run to an item's persisted on-demand history (state.runHistory),
 *  newest first, capped at {@link RUN_HISTORY_CAP}. Pure — the caller persists
 *  the returned array onto the Cosmos item. */
export function appendRunHistory(state: unknown, run: OnDemandRunRecord): OnDemandRunRecord[] {
  const prev: OnDemandRunRecord[] = Array.isArray((state as any)?.runHistory)
    ? (state as any).runHistory.filter((r: any) => r && typeof r.at === 'string')
    : [];
  return [run, ...prev].slice(0, RUN_HISTORY_CAP);
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
