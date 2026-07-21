/**
 * WS-1.5 — Eval regression alert (pure config builder).
 *
 * Builds the KQL query and ScheduledQueryRuleInput for the Azure Monitor
 * continuous-eval regression alert. The KQL targets the Log Analytics workspace
 * where Loom agent-eval results are indexed (via the Cosmos diagnostic-settings
 * export or a custom table). The rule is created via monitor-client's
 * upsertScheduledQueryRule — no new bicep resource needed.
 *
 * REAL backend: the alert rule is a Microsoft.Insights/scheduledQueryRules
 * resource that evaluates every 15 minutes over a 1-hour window. It fires when
 * ANY eval run's avgScore has dropped below the configured threshold (default 4.0),
 * signalling a regression vs. the baseline.
 *
 * No new Cosmos container, no new bicep, no new env var required:
 *   • The query scope is LOOM_LOG_ANALYTICS_RESOURCE_ID (existing).
 *   • The alert RG is LOOM_ALERT_RG / LOOM_ADMIN_RG (existing).
 *   • LOOM_SUBSCRIPTION_ID (existing).
 *   • The action group is optional (LOOM_EVAL_MONITOR_ACTION_GROUP_ID, a custom
 *     env var the operator can set — but the alert is functional without it).
 *
 * All configuration here is pure — no Azure calls (those are in monitor-client).
 */

import type { ScheduledQueryRuleInput } from '@/lib/azure/monitor-client';

// ── Alert configuration ───────────────────────────────────────────────────────

export const EVAL_ALERT_NAME = 'loom-eval-regression-alert';
export const DEFAULT_EVAL_SCORE_THRESHOLD = 4.0;
/** Evaluation frequency / window ISO durations (every 15 min, 1h window). */
export const EVAL_ALERT_FREQUENCY = 'PT15M';
export const EVAL_ALERT_WINDOW = 'PT1H';

export interface EvalAlertConfig {
  /** Azure Monitor alert rule name (default: 'loom-eval-regression-alert'). */
  name?: string;
  /** Avg-score threshold below which an alert fires (default 4.0). */
  scoreThreshold?: number;
  /** Whether the rule is enabled (default true). */
  enabled?: boolean;
  /** ARM ids of action groups to fire (optional — alert fires even without one). */
  actionGroupIds?: string[];
  /** Cosmos / LA custom table name holding eval results (default 'LoomAgentEval_CL'). */
  tableName?: string;
}

/**
 * The KQL query for the eval regression scheduled-query alert.
 *
 * The query counts eval records whose avgScore fell below the threshold in the
 * evaluation window. When the count is > 0 the alert fires.
 *
 * Note: `skipQueryValidation = true` (the monitor-client default) is set so the
 * rule is created even before the custom log table exists on a fresh estate —
 * Azure Monitor validates the query at run time instead.
 */
export function buildEvalAlertKql(tableName: string, scoreThreshold: number): string {
  // Custom log tables end in _CL by convention. The KQL counts rows where
  // avgScore_d < threshold, indicating a regression in the current window.
  return (
    `${tableName}\n` +
    `| where TimeGenerated > ago(1h)\n` +
    `| where avgScore_d < ${scoreThreshold.toFixed(2)}\n` +
    `| summarize RegressionCount = count()\n` +
    `| where RegressionCount > 0`
  );
}

/**
 * Build the ScheduledQueryRuleInput for the eval regression alert.
 * Pass to monitor-client's `upsertScheduledQueryRule`.
 */
export function buildEvalAlertInput(cfg: EvalAlertConfig = {}): ScheduledQueryRuleInput {
  const name = cfg.name || EVAL_ALERT_NAME;
  const threshold = typeof cfg.scoreThreshold === 'number' ? cfg.scoreThreshold : DEFAULT_EVAL_SCORE_THRESHOLD;
  const tableName = cfg.tableName || 'LoomAgentEval_CL';
  return {
    name,
    description:
      `CSA Loom eval regression alert: fires when any agent eval run avgScore falls below ` +
      `${threshold.toFixed(2)} in the past hour. Indicates a model regression vs baseline. ` +
      `Managed by CSA Loom Admin → Agent Quality → Eval Depth.`,
    query: buildEvalAlertKql(tableName, threshold),
    operator: 'GreaterThan',
    threshold: 0,
    severity: 2, // Warning (0=Critical, 4=Verbose)
    evaluationFrequency: EVAL_ALERT_FREQUENCY,
    windowSize: EVAL_ALERT_WINDOW,
    enabled: cfg.enabled ?? true,
    actionGroupIds: cfg.actionGroupIds,
    skipQueryValidation: true, // Table may not exist on a fresh estate (monitors at run time).
  };
}

// ── Env-var helpers ───────────────────────────────────────────────────────────

/**
 * Read the optional action-group ARM id from the env (operator-set, not
 * bicep-emitted — the alert is functional without a notification channel).
 */
export function readEvalActionGroupId(): string | undefined {
  const v = process.env.LOOM_EVAL_MONITOR_ACTION_GROUP_ID;
  return v && v.trim() ? v.trim() : undefined;
}
