/**
 * lib/azure/dq-item-run.ts — W11 (data-quality item type) run records.
 *
 * The standalone `data-quality` item is a per-item, workspace-scoped run
 * configuration over the shared, tenant-global Data Quality Rule Engine
 * (lib/azure/data-quality-client `runDqRules`): it pins a backend + target
 * (ADX / Databricks / Synapse) and an optional table filter, RUNS the tenant's
 * enabled rules against that target, and keeps its own run history. This module
 * is the pure, unit-testable core the item's run route composes (the heavy
 * engine + Cosmos wiring stay in the route). Azure-native, no Fabric dependency.
 */
import type { DqRunResult, DqRuleResult } from '@/lib/azure/data-quality-client';

/** One persisted data-quality item run (mirrors the DqRunRecord / SyntheticRun shape). */
export interface DqItemRun {
  id: string;
  ranAt: string;
  backend: string;
  target: string;
  score: number | null;
  ruleCount: number;
  passingRules: number;
  /** error-severity fails = rules that ran and did not pass. */
  failingRules: number;
  status: 'passed' | 'failed' | 'no_rules' | 'errored';
  breakdown: DqRuleResult[];
  durationMs: number;
  ranBy: string;
}

const MAX_DQ_ITEM_RUNS = 50;

/**
 * Classify a run outcome from the engine result:
 *   • no_rules — the target matched no enabled rules (nothing to score).
 *   • errored — rules matched but none could run (every percentage null).
 *   • failed  — at least one rule ran and did not pass.
 *   • passed  — every rule that ran passed.
 */
export function dqRunStatus(result: DqRunResult): DqItemRun['status'] {
  if (result.ruleCount === 0) return 'no_rules';
  const ran = result.breakdown.filter((r) => r.percentage != null);
  if (ran.length === 0) return 'errored';
  return ran.every((r) => r.passed) ? 'passed' : 'failed';
}

/** Count rules that ran and did not pass (the actionable failures). */
export function failingRuleCount(result: DqRunResult): number {
  return result.breakdown.filter((r) => r.percentage != null && !r.passed).length;
}

/** Build a persisted run record from the engine result. */
export function dqItemRunFromResult(
  result: DqRunResult,
  meta: { durationMs: number; ranBy: string },
): DqItemRun {
  return {
    id: crypto.randomUUID(),
    ranAt: result.computedAt,
    backend: result.backend,
    target: result.target,
    score: result.score,
    ruleCount: result.ruleCount,
    passingRules: result.passingRules,
    failingRules: failingRuleCount(result),
    status: dqRunStatus(result),
    breakdown: result.breakdown,
    durationMs: meta.durationMs,
    ranBy: meta.ranBy,
  };
}

/** Prepend a run onto the history, newest-first and bounded. */
export function appendDqItemRun(prev: DqItemRun[] | undefined, run: DqItemRun): DqItemRun[] {
  const list = Array.isArray(prev) ? prev : [];
  return [run, ...list].slice(0, MAX_DQ_ITEM_RUNS);
}
