/**
 * ops-agent-evaluator — pure core (no Azure SDK, fully unit-testable).
 *
 * The timer trigger (functions/opsAgentEvaluator.ts) wires the real Azure
 * data-plane (Cosmos read, ADX query, AOAI reasoning, Logic App dispatch) around
 * these pure helpers so the decision logic can be tested without a live cloud.
 *
 * Azure-native, no Microsoft Fabric / Power Automate dependency
 * (.claude/rules/no-fabric-dependency.md).
 */

/** A persisted operations-agent trigger (mirror of MonitorRuleRecord's fields
 *  the evaluator needs). */
export interface OpsAgentRule {
  id: string;
  name: string;
  query?: string;
  sourceKind?: 'adx' | 'log-analytics';
  adxDatabase?: string;
  adxClusterUri?: string;
  /** When true a fired trigger routes through a human approval (Teams card via
   *  the bound Logic App) BEFORE any action; when false the action is autonomous. */
  requireApproval?: boolean;
  action?: { kind?: string; config?: Record<string, unknown> };
}

/** An operations-agent Cosmos item (only the fields the evaluator reads). */
export interface OpsAgentItem {
  id: string;
  displayName: string;
  workspaceId: string;
  state?: {
    systemPrompt?: string;
    model?: string;
    eventhouse?: string;
    rules?: OpsAgentRule[];
    [k: string]: unknown;
  };
}

/** The decision the evaluator reaches for a single fired trigger. */
export type EvaluatorDecision =
  | { kind: 'skip'; reason: string }
  | { kind: 'approval'; ruleName: string; recommendation: string }
  | { kind: 'autonomous'; ruleName: string; recommendation: string };

/**
 * Config gate — the evaluator is honest about what it needs (no-vaporware).
 * Returns the list of missing env vars (empty ⇒ fully configured).
 */
export function missingConfig(env: Record<string, string | undefined>): string[] {
  const missing: string[] = [];
  if (!env.LOOM_COSMOS_ENDPOINT) missing.push('LOOM_COSMOS_ENDPOINT');
  if (!env.LOOM_AOAI_ENDPOINT) missing.push('LOOM_AOAI_ENDPOINT');
  return missing;
}

/** Only ADX-sourced triggers are evaluated by this Function: Log-Analytics
 *  triggers evaluate continuously via Azure Monitor already and fire their own
 *  action group, so the evaluator would double-fire them. */
export function evaluableRules(item: OpsAgentItem): OpsAgentRule[] {
  const rules = item.state?.rules;
  if (!Array.isArray(rules)) return [];
  return rules.filter((r) => (r.sourceKind ?? 'log-analytics') === 'adx' && !!(r.query || '').trim());
}

/** Compose the AOAI reasoning prompt for a fired trigger, grounded on the
 *  agent's instructions + the fired rows. Pure — the caller runs it through AOAI. */
export function buildReasoningMessages(
  item: OpsAgentItem,
  rule: OpsAgentRule,
  firedRows: { columns: string[]; rows: unknown[][]; count: number },
): { role: 'system' | 'user'; content: string }[] {
  const instructions = String(item.state?.systemPrompt || 'You monitor operational signals and recommend actions when a condition breaches.').trim();
  const sample = firedRows.rows.slice(0, 20);
  const table = [firedRows.columns.join(' | '), ...sample.map((r) => r.map((c) => String(c)).join(' | '))].join('\n');
  return [
    {
      role: 'system',
      content:
        'You are the CSA Loom Operations Agent reasoning companion. CSA Loom is an Azure-native platform (NOT Microsoft Fabric). ' +
        'A monitoring trigger has fired against real Eventhouse (Azure Data Explorer) data. Interpret WHAT happened and recommend a ' +
        'single concrete operational action in 2-3 sentences. Ground every claim in the fired rows — never invent numbers.\n\n' +
        `Agent instructions:\n${instructions}`,
    },
    {
      role: 'user',
      content:
        `Trigger "${rule.name}" fired with ${firedRows.count} matching row(s). ` +
        `The agent's action is: ${rule.action?.kind || 'Teams notification'}.\n\n` +
        `Fired rows (first ${sample.length}):\n${table}\n\n` +
        'Interpret the situation and recommend the action to take.',
    },
  ];
}

/**
 * Turn a fired trigger + its AOAI recommendation into a routing decision:
 * an approval-gated action (requireApproval=true) or an autonomous action.
 */
export function decide(rule: OpsAgentRule, recommendation: string): EvaluatorDecision {
  const rec = recommendation.trim();
  if (!rec) return { kind: 'skip', reason: 'no recommendation produced' };
  return rule.requireApproval
    ? { kind: 'approval', ruleName: rule.name, recommendation: rec }
    : { kind: 'autonomous', ruleName: rule.name, recommendation: rec };
}
