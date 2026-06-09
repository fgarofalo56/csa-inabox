/**
 * Activator Copilot tools — real Azure Monitor operations called by the
 * Activator persona (lib/azure/copilot-personas.ts → ACTIVATOR_PERSONA).
 *
 * Five ToolDefs, registered into the main LoomToolRegistry. Every handler
 * calls a real backend — there is NO mock data and NO Fabric dependency
 * (.claude/rules/no-fabric-dependency.md, .claude/rules/no-vaporware.md):
 *
 *   activator_author_rule        NL → structured ScheduledQueryRule draft
 *                                (pure transformer; no backend call)
 *   activator_suggest_threshold  queryLogs() → p50/p95/p99 of the REAL
 *                                historical per-window distribution
 *   activator_create_rule        createMonitorActivatorRule() → ARM PUT
 *                                Microsoft.Insights/scheduledQueryRules
 *                                (gated on confirm=true)
 *   activator_list_rules         listScheduledQueryRules() (real ARM list)
 *   activator_describe_history   getActivatorHistory() →
 *                                Microsoft.AlertsManagement/alerts
 *
 * MonitorNotConfiguredError / MonitorError propagate as an honest Azure
 * infra-gate (surfaces the exact env var to set) — never a Fabric gate.
 */

import { queryLogs, listScheduledQueryRules } from '../azure/monitor-client';
import {
  createMonitorActivatorRule,
  getActivatorHistory,
  type MonitorRuleInput,
} from '../azure/activator-monitor';
import type { ToolDef } from '../azure/copilot-orchestrator';

// ── JSON-schema helpers (mirror copilot-orchestrator.ts) ────────────────────
const S_STRING = { type: 'string' } as const;
const S_NUMBER = { type: 'number' } as const;
const S_BOOL = { type: 'boolean' } as const;
function obj(props: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

// ── pure NL → draft helpers ─────────────────────────────────────────────────

/** Map a NL operator phrase to an Azure Monitor criteria operator + KQL symbol. */
function mapOperator(raw?: string): { armOperator: string; kqlOp: string } {
  const s = (raw || '').toLowerCase();
  if (/\b(below|under|less than|drops?|fewer|fell|<)\b/.test(s) || s === 'lessthan' || s === 'lt')
    return { armOperator: 'LessThan', kqlOp: '<' };
  if (/\b(equal|equals|==|=)\b/.test(s) && !/exceed|above|over/.test(s))
    return { armOperator: 'Equal', kqlOp: '==' };
  // default: exceed / above / over / spike / greater than
  return { armOperator: 'GreaterThan', kqlOp: '>' };
}

interface RuleDraft {
  sourceTable: string;
  /** KQL filter that selects the events of interest (no leading "| where"). */
  whereClause?: string;
  /** Aggregate expression, e.g. count() or avg(CounterValue). */
  summarizeExpr: string;
  /** Alias for the aggregated metric column in the query. */
  metricColumn: string;
  armOperator: string;
  kqlOp: string;
  severity: number;
  evaluationFrequency: string;
  windowSize: string;
  binMinutes: number;
  description: string;
}

/**
 * Heuristic NL → draft transformer. Recognises the common signal families and
 * maps each to a real Log Analytics table + filter + metric. This is a
 * deterministic code-generator (like the existing buildRuleQuery), not fake
 * data — the resulting query runs against the real workspace downstream.
 */
function draftFromIntent(nlIntent: string, override?: Partial<RuleDraft>): RuleDraft {
  const t = (nlIntent || '').toLowerCase();
  const { armOperator, kqlOp } = mapOperator(t);

  let sourceTable = 'AppEvents_CL';
  let whereClause: string | undefined;
  let summarizeExpr = 'count()';
  let metricColumn = 'eventCount';
  let severity = 2;

  if (/\b(failed|failure|invalid|denied|unauthor)\w*\b.*\b(sign[- ]?ins?|logins?|logons?|log[- ]?ins?|auth\w*)\b|\b(sign[- ]?ins?|logins?|logons?)\b.*\bfail/.test(t)) {
    sourceTable = 'SigninLogs';
    whereClause = "ResultType != '0'";
    summarizeExpr = 'count()';
    metricColumn = 'failedSignIns';
    severity = 2;
  } else if (/\b(sign[- ]?ins?|logins?|logons?)\b/.test(t)) {
    sourceTable = 'SigninLogs';
    summarizeExpr = 'count()';
    metricColumn = 'signIns';
    severity = 3;
  } else if (/\b(cpu|processor)\b/.test(t)) {
    sourceTable = 'Perf';
    whereClause = "CounterName == '% Processor Time'";
    summarizeExpr = 'avg(CounterValue)';
    metricColumn = 'avgCpu';
    severity = 2;
  } else if (/\b(memory|ram)\b/.test(t)) {
    sourceTable = 'Perf';
    whereClause = "CounterName == 'Available MBytes'";
    summarizeExpr = 'avg(CounterValue)';
    metricColumn = 'avgAvailableMb';
    severity = 2;
  } else if (/\b(pipeline|adf|data factory)\b/.test(t)) {
    sourceTable = 'AzureDiagnostics';
    whereClause = "Category == 'PipelineRuns' and status_s == 'Failed'";
    summarizeExpr = 'count()';
    metricColumn = 'failedRuns';
    severity = 1;
  } else if (/\b(error|exception|5\d\d|http)\b/.test(t)) {
    sourceTable = 'AppRequests';
    whereClause = 'Success == false';
    summarizeExpr = 'count()';
    metricColumn = 'failedRequests';
    severity = 2;
  }

  return {
    sourceTable: override?.sourceTable || sourceTable,
    whereClause: override?.whereClause ?? whereClause,
    summarizeExpr: override?.summarizeExpr || summarizeExpr,
    metricColumn: override?.metricColumn || metricColumn,
    armOperator: override?.armOperator || armOperator,
    kqlOp: override?.kqlOp || kqlOp,
    severity: override?.severity ?? severity,
    evaluationFrequency: override?.evaluationFrequency || 'PT5M',
    windowSize: override?.windowSize || 'PT5M',
    binMinutes: override?.binMinutes ?? 5,
    description: override?.description || `Alert on "${nlIntent.trim()}"`,
  };
}

/** Build the historical-sampling KQL (bins the metric per window over N days). */
function buildSamplingKql(p: {
  sourceTable: string;
  whereClause?: string;
  summarizeExpr: string;
  binMinutes: number;
  lookbackDays: number;
}): string {
  const where = p.whereClause?.trim() ? `\n| where ${p.whereClause.trim()}` : '';
  return [
    p.sourceTable,
    `| where TimeGenerated > ago(${p.lookbackDays}d)`,
    where.replace(/^\n/, ''),
    `| summarize metricVal = ${p.summarizeExpr} by bin(TimeGenerated, ${p.binMinutes}m)`,
    `| summarize p50 = percentile(metricVal, 50), p95 = percentile(metricVal, 95), p99 = percentile(metricVal, 99), meanVal = avg(metricVal), maxVal = max(metricVal), sampleWindows = count()`,
  ].filter(Boolean).join('\n');
}

/**
 * Build the ALERT KQL. The platform scopes the query to windowSize, so no
 * TimeGenerated filter is needed — we summarize the metric over the window and
 * keep only breaching windows (embedding the data-derived threshold). The
 * scheduledQueryRule fires when ≥1 row is returned.
 */
function buildAlertKql(p: {
  sourceTable: string;
  whereClause?: string;
  summarizeExpr: string;
  metricColumn: string;
  kqlOp: string;
  threshold: number;
}): string {
  const where = p.whereClause?.trim() ? `\n| where ${p.whereClause.trim()}` : '';
  return [
    p.sourceTable + where,
    `| summarize ${p.metricColumn} = ${p.summarizeExpr}`,
    `| where ${p.metricColumn} ${p.kqlOp} ${p.threshold}`,
  ].join('\n');
}

function num(v: unknown, dflt: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// ── tool builders ───────────────────────────────────────────────────────────

export function buildActivatorTools(): ToolDef[] {
  const tools: ToolDef[] = [];

  // 1) author — NL → structured draft (pure; no backend call)
  tools.push({
    name: 'activator_author_rule',
    service: 'Activator',
    description:
      'Author a draft Azure Monitor scheduled-query alert rule from a natural-language description ' +
      '(e.g. "alert when failed logins exceed normal"). Returns the source Log Analytics table, an ' +
      'optional KQL filter (whereClause), the metric expression (summarizeExpr), the metric column name, ' +
      'the comparison operator, and default severity/evaluationFrequency/windowSize. The threshold is ' +
      'NOT set here — call activator_suggest_threshold next to derive it from real historical data. ' +
      'Pass optional overrides (sourceTable, whereClause, summarizeExpr) when you already know the schema.',
    parameters: obj({
      nlIntent: S_STRING,
      sourceTable: S_STRING,
      whereClause: S_STRING,
      summarizeExpr: S_STRING,
      severity: S_NUMBER,
      evaluationFrequency: S_STRING,
      windowSize: S_STRING,
    }, ['nlIntent']),
    handler: async (args) => {
      const draft = draftFromIntent(String(args.nlIntent || ''), {
        sourceTable: args.sourceTable ? String(args.sourceTable) : undefined,
        whereClause: args.whereClause !== undefined ? String(args.whereClause) : undefined,
        summarizeExpr: args.summarizeExpr ? String(args.summarizeExpr) : undefined,
        severity: args.severity !== undefined ? num(args.severity, 2) : undefined,
        evaluationFrequency: args.evaluationFrequency ? String(args.evaluationFrequency) : undefined,
        windowSize: args.windowSize ? String(args.windowSize) : undefined,
      });
      return {
        sourceTable: draft.sourceTable,
        whereClause: draft.whereClause ?? null,
        summarizeExpr: draft.summarizeExpr,
        metricColumn: draft.metricColumn,
        operator: draft.armOperator,
        kqlOp: draft.kqlOp,
        severity: draft.severity,
        evaluationFrequency: draft.evaluationFrequency,
        windowSize: draft.windowSize,
        binMinutes: draft.binMinutes,
        description: draft.description,
        next: 'Call activator_suggest_threshold with sourceTable, whereClause, summarizeExpr, binMinutes to derive the threshold from real historical data.',
      };
    },
  });

  // 2) suggest_threshold — real KQL percentile sampling
  tools.push({
    name: 'activator_suggest_threshold',
    service: 'Activator',
    description:
      'Run a REAL KQL query against the Log Analytics workspace to derive a recommended alert threshold ' +
      'from historical data. Bins the metric per evaluation window over the lookback period and returns ' +
      'p50/p95/p99/mean/max plus a suggestedThreshold (ceil of the chosen percentile, p95 by default). ' +
      'Use the sourceTable/whereClause/summarizeExpr/binMinutes from activator_author_rule.',
    parameters: obj({
      sourceTable: S_STRING,
      whereClause: S_STRING,
      summarizeExpr: S_STRING,
      binMinutes: S_NUMBER,
      lookbackDays: S_NUMBER,
      percentile: S_NUMBER,
    }, ['sourceTable']),
    handler: async (args) => {
      const sourceTable = String(args.sourceTable || '').trim();
      if (!sourceTable) throw new Error('sourceTable is required');
      const summarizeExpr = String(args.summarizeExpr || 'count()').trim() || 'count()';
      const whereClause = args.whereClause !== undefined ? String(args.whereClause) : undefined;
      const binMinutes = Math.max(1, num(args.binMinutes, 5));
      const lookbackDays = Math.max(1, num(args.lookbackDays, 7));
      const pct = [50, 95, 99].includes(num(args.percentile, 95)) ? num(args.percentile, 95) : 95;

      const kql = buildSamplingKql({ sourceTable, whereClause, summarizeExpr, binMinutes, lookbackDays });
      const result = await queryLogs(kql, `P${lookbackDays}D`);

      const cols = result.columns;
      const row = result.rows[0] || [];
      const cell = (name: string): number => {
        const i = cols.indexOf(name);
        const v = i >= 0 ? row[i] : undefined;
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? n : 0;
      };
      const sampleWindows = cell('sampleWindows');
      if (!sampleWindows) {
        return {
          sourceTable,
          query: kql,
          sampleWindows: 0,
          suggestedThreshold: 5,
          note: 'No historical windows found for this table/filter — the threshold is a heuristic estimate. Tune it after observing real traffic.',
        };
      }
      const stats = { p50: cell('p50'), p95: cell('p95'), p99: cell('p99'), mean: cell('meanVal'), max: cell('maxVal') };
      const chosen = pct === 50 ? stats.p50 : pct === 99 ? stats.p99 : stats.p95;
      // Always alert ABOVE typical noise: at least chosen, never below 1.
      const suggestedThreshold = Math.max(1, Math.ceil(chosen));
      return {
        sourceTable,
        query: kql,
        lookbackDays,
        binMinutes,
        sampleWindows,
        ...stats,
        percentile: pct,
        suggestedThreshold,
        note: `Suggested threshold ${suggestedThreshold} = p${pct} of ${sampleWindows} real ${binMinutes}-minute windows over the last ${lookbackDays} days.`,
      };
    },
  });

  // 3) create_rule — real ARM provisioning, gated on confirm
  tools.push({
    name: 'activator_create_rule',
    service: 'Activator',
    description:
      'Provision a REAL Azure Monitor scheduled-query alert rule (Microsoft.Insights/scheduledQueryRules) ' +
      'after the user approves the draft. Embeds the data-derived threshold into the alert KQL and creates ' +
      'an action group from the notification action (email / Teams-or-webhook / SMS). MUST be called with ' +
      'confirm=true — without it the tool returns needsConfirmation and provisions nothing. Returns the ARM ' +
      'resource id + Azure Portal deep-link so the user can verify the rule is live.',
    parameters: obj({
      name: S_STRING,
      activatorName: S_STRING,
      sourceTable: S_STRING,
      whereClause: S_STRING,
      summarizeExpr: S_STRING,
      metricColumn: S_STRING,
      operator: S_STRING,
      threshold: S_NUMBER,
      severity: S_NUMBER,
      evaluationFrequency: S_STRING,
      windowSize: S_STRING,
      actionKind: { type: 'string', enum: ['none', 'Email', 'Teams', 'Webhook', 'SMS'] },
      actionTarget: S_STRING,
      existingActionGroupId: S_STRING,
      confirm: S_BOOL,
    }, ['name', 'sourceTable', 'summarizeExpr', 'metricColumn', 'threshold']),
    handler: async (args) => {
      if (!args.confirm) {
        return {
          ok: false,
          needsConfirmation: true,
          message:
            'This will create a real Azure Monitor alert rule. Present the draft to the user and call ' +
            'activator_create_rule again with confirm=true once they approve.',
        };
      }
      const name = String(args.name || '').trim();
      if (!name) throw new Error('name is required');
      const sourceTable = String(args.sourceTable || '').trim();
      const summarizeExpr = String(args.summarizeExpr || 'count()').trim() || 'count()';
      const metricColumn = String(args.metricColumn || 'metricVal').trim() || 'metricVal';
      const threshold = num(args.threshold, 0);
      const { kqlOp } = mapOperator(String(args.operator || 'GreaterThan'));
      const whereClause = args.whereClause !== undefined ? String(args.whereClause) : undefined;

      const query = buildAlertKql({ sourceTable, whereClause, summarizeExpr, metricColumn, kqlOp, threshold });

      // Map the notification action into the shape createMonitorActivatorRule reads.
      const actionKind = String(args.actionKind || 'none');
      const actionTarget = String(args.actionTarget || '').trim();
      let action: Record<string, unknown> | undefined;
      if (actionKind !== 'none' && actionTarget) {
        if (actionKind === 'Email') action = { kind: 'Email', target: actionTarget };
        else if (actionKind === 'SMS') action = { kind: 'SMS', config: { phoneNumber: actionTarget } };
        else action = { kind: actionKind, config: { webhookUrl: actionTarget } }; // Teams / Webhook
      }

      const input: MonitorRuleInput = {
        name,
        query,
        severity: num(args.severity, 2),
        evaluationFrequency: String(args.evaluationFrequency || 'PT5M'),
        windowSize: String(args.windowSize || 'PT5M'),
        ...(action ? { action } : {}),
        ...(args.existingActionGroupId ? { existingActionGroupId: String(args.existingActionGroupId) } : {}),
      };

      const record = await createMonitorActivatorRule(String(args.activatorName || name), input);
      // Deep-link to the rule's Azure Portal overview. The ARM resource id is
      // /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Insights/
      // scheduledQueryRules/{name}; fall back to the Alerts blade if env unset.
      const sub = process.env.LOOM_SUBSCRIPTION_ID || '';
      const rg = process.env.LOOM_ALERT_RG || process.env.LOOM_ADMIN_RG || '';
      const portalUrl = sub && rg
        ? `https://portal.azure.com/#@/resource/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Insights/scheduledQueryRules/${encodeURIComponent(record.azureRuleName)}/overview`
        : 'https://portal.azure.com/#view/Microsoft_Azure_Monitoring/AlertsManagementSummaryBlade';
      return {
        ok: true,
        ruleId: record.id,
        azureRuleName: record.azureRuleName,
        query: record.query,
        threshold,
        severity: record.severity,
        evaluationFrequency: record.evaluationFrequency,
        windowSize: record.windowSize,
        actionGroupId: record.actionGroupId ?? null,
        actionGroupReceivers: record.actionGroupReceivers ?? null,
        portalUrl,
        note:
          'Rule created. Verify it in Azure Portal → Monitor → Alerts → Alert rules ' +
          `(scheduledQueryRule "${record.azureRuleName}").` + (record.note ? ` ${record.note}` : ''),
      };
    },
  });

  // 4) list_rules — real ARM list
  tools.push({
    name: 'activator_list_rules',
    service: 'Activator',
    description:
      'List the Azure Monitor scheduled-query alert rules in the Loom alert resource group (real ARM list). ' +
      'Use to check for a duplicate rule name before creating, or to report what alert rules exist.',
    parameters: obj({}),
    handler: async () => {
      const rules = await listScheduledQueryRules();
      return rules.map((r) => ({
        name: r.name,
        id: r.id,
        enabled: r.enabled,
        severity: r.severity,
        operator: r.operator,
        threshold: r.threshold,
        evaluationFrequency: r.evaluationFrequency,
        windowSize: r.windowSize,
        query: r.query,
      }));
    },
  });

  // 5) describe_history — real alert-instance history
  tools.push({
    name: 'activator_describe_history',
    service: 'Activator',
    description:
      'Fetch the real fired/resolved history (Microsoft.AlertsManagement/alerts) for one or more scheduled-query ' +
      'alert rules by their Azure rule name(s). Use to answer "has this rule fired?" / "show recent alerts".',
    parameters: obj({
      ruleNames: { type: 'array', items: S_STRING },
      ruleName: S_STRING,
      days: S_NUMBER,
    }),
    handler: async (args) => {
      const names: string[] = [];
      if (Array.isArray(args.ruleNames)) names.push(...args.ruleNames.map((x: unknown) => String(x)));
      if (args.ruleName) names.push(String(args.ruleName));
      const events = await getActivatorHistory(names, { days: args.days !== undefined ? num(args.days, 7) : undefined });
      return events.map((e) => ({
        alertRule: e.alertRule,
        monitorCondition: e.monitorCondition,
        alertState: e.alertState,
        severity: e.severity,
        startDateTime: e.startDateTime,
        matchingRows: e.payload?.matchingRowsCount ?? null,
      }));
    },
  });

  return tools;
}
