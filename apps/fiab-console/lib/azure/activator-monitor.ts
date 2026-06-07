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
  queryLogs,
} from './monitor-client';

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

function ruleEmails(rule: any): string[] {
  const action = rule?.action || {};
  const targets: string[] = [];
  for (const v of [action.target, action.actTarget, action.email, action.to, action.recipients, action?.config?.to]) {
    if (Array.isArray(v)) targets.push(...v);
    else if (typeof v === 'string') targets.push(...v.split(/[;,]/));
  }
  return targets.map((t) => t.trim()).filter((t) => t.includes('@'));
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
}

export interface MonitorRuleRecord {
  id: string;
  name: string;
  query: string;
  azureRuleName: string;
  condition?: any;
  action?: any;
  actionGroupId?: string;
  severity: number;
  evaluationFrequency: string;
  windowSize: string;
  state: 'Active';
  backend: 'azure-monitor';
  createdAt: string;
  note?: string;
}

/** Create (or update) the Azure Monitor scheduledQueryRule + action group for a
 *  Loom activator rule. Throws MonitorNotConfiguredError/MonitorError which the
 *  route maps to an honest Azure infra-gate (NOT a Fabric gate). */
export async function createMonitorActivatorRule(
  activatorDisplayName: string,
  input: MonitorRuleInput,
): Promise<MonitorRuleRecord> {
  const { query, note } = buildRuleQuery(input);
  const emails = ruleEmails(input);
  let actionGroupId: string | undefined;
  if (emails.length) {
    actionGroupId = await upsertActionGroup({
      name: safeRuleName(activatorDisplayName, 'ag'),
      shortName: (activatorDisplayName || 'loom').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'loom',
      emails,
    });
  }
  const ruleSuffix = (input.name || 'rule').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 16) || 'rule';
  const azureRuleName = safeRuleName(activatorDisplayName, ruleSuffix);
  const severity = typeof input.severity === 'number' ? input.severity : 3;
  const evaluationFrequency = input.evaluationFrequency || 'PT5M';
  const windowSize = input.windowSize || 'PT5M';
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
    severity,
    evaluationFrequency,
    windowSize,
    state: 'Active',
    backend: 'azure-monitor',
    createdAt: new Date().toISOString(),
    ...(note ? { note } : {}),
  };
}

/** "Trigger now" on the Azure-native backend = run the rule's KQL against the
 *  LA workspace right now and report whether it would fire (rows > 0). */
export async function triggerMonitorActivatorRule(
  query: string,
): Promise<{ columns: string[]; rows: unknown[][]; count: number; fired: boolean }> {
  const r = await queryLogs(query, 'PT1H');
  return { columns: r.columns, rows: r.rows.slice(0, 50), count: r.rowCount, fired: r.rowCount > 0 };
}
