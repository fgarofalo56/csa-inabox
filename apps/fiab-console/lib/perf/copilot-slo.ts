/**
 * PSR-8 — Copilot turn-latency SLO (pure, browser-safe, unit-tested).
 *
 * Defines the service-level OBJECTIVES for the Copilot experience — a streaming
 * first-token budget and a full-turn budget — plus an evaluator that turns a
 * window of measured turns into an SLO verdict (met? + burn). PSR-1 already
 * MEASURES `copilot-first-token` / `copilot-full-turn` (perf-metrics + the
 * benchmark runner) and `perf-budgets.json` gates their p95 in CI; this module
 * is the missing OBJECTIVE half — the target a user-facing SLO badge + the
 * tier-router's latency-pressure protection (see model-tier-router) read.
 *
 * Targets are env-tunable (admin-plane, default-ON with sensible defaults that
 * match the CI budget ceilings so the gate and the SLO never disagree):
 *   LOOM_COPILOT_SLO_FIRST_TOKEN_MS  — streaming first-token p95 budget (5000)
 *   LOOM_COPILOT_SLO_FULL_TURN_MS    — full-turn p95 budget            (30000)
 *
 * NO Fabric / Power BI dependency — the numbers come from the Azure OpenAI turns
 * the Loom Copilot already runs (no-vaporware.md, no-fabric-dependency.md).
 * Grounding: SRE SLO / error-budget practice + Azure OpenAI streaming latency
 * guidance (https://learn.microsoft.com/azure/ai-services/openai/how-to/latency).
 */

/** Default streaming first-token budget (ms) — matches perf-budgets `copilot-first-token`. */
export const DEFAULT_FIRST_TOKEN_BUDGET_MS = 5_000;
/** Default full-turn budget (ms) — matches perf-budgets `copilot-full-turn`. */
export const DEFAULT_FULL_TURN_BUDGET_MS = 30_000;
/**
 * Objective: the fraction of turns that must clear the budget for the SLO to be
 * "met" (a p95-style objective — 95% of turns under budget). 0..1.
 */
export const DEFAULT_SLO_OBJECTIVE = 0.95;

/** A Copilot latency SLO — one row of the objective table. */
export interface CopilotSloTarget {
  /** Stable id (aligns with the perf metric / budget id). */
  id: 'copilot-first-token' | 'copilot-full-turn';
  label: string;
  /** The per-turn budget (ms) a sample must clear to count as "good". */
  budgetMs: number;
  /** Fraction of turns that must be good (0..1). */
  objective: number;
  learnUrl: string;
  description: string;
}

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Resolve the live SLO targets (env-tunable; default-ON with budget-matched defaults). */
export function copilotSloTargets(): CopilotSloTarget[] {
  const objective = (() => {
    const n = Number(process.env.LOOM_COPILOT_SLO_OBJECTIVE);
    return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_SLO_OBJECTIVE;
  })();
  return [
    {
      id: 'copilot-first-token',
      label: 'Copilot first-token (streaming)',
      budgetMs: envMs('LOOM_COPILOT_SLO_FIRST_TOKEN_MS', DEFAULT_FIRST_TOKEN_BUDGET_MS),
      objective,
      learnUrl: 'https://learn.microsoft.com/azure/ai-services/openai/how-to/latency',
      description:
        'Time to the FIRST streamed token of a Copilot turn — the "is it thinking?" latency a user feels. Streaming keeps this well under the full-turn budget.',
    },
    {
      id: 'copilot-full-turn',
      label: 'Copilot full turn',
      budgetMs: envMs('LOOM_COPILOT_SLO_FULL_TURN_MS', DEFAULT_FULL_TURN_BUDGET_MS),
      objective,
      learnUrl: 'https://learn.microsoft.com/fabric/get-started/copilot-fabric-overview',
      description:
        'End-to-end latency of a full Copilot turn (all tokens + any tool calls) — the total time to a complete answer.',
    },
  ];
}

/** The verdict for one SLO over a window of measured turns. */
export interface SloEvaluation {
  id: CopilotSloTarget['id'];
  budgetMs: number;
  objective: number;
  /** Turns observed in the window. */
  sampled: number;
  /** Turns that cleared the budget. */
  good: number;
  /** good / sampled (0..1); 1 when no samples (nothing has breached). */
  attainment: number;
  /** True when attainment >= objective (or no samples yet). */
  met: boolean;
  /**
   * Error-budget burn: how much of the allowed failure budget (1 - objective)
   * has been consumed, as a multiple. < 1 is healthy; > 1 means the SLO is
   * breaching faster than the budget allows. 0 when no samples.
   */
  burn: number;
}

/**
 * Evaluate one SLO target against a window of measured turn latencies (ms).
 * Pure — no clock, no env, no I/O (targets are resolved by the caller). A turn
 * is "good" when its latency is <= the budget.
 */
export function evaluateSlo(target: CopilotSloTarget, samplesMs: readonly number[]): SloEvaluation {
  const sampled = samplesMs.length;
  const good = samplesMs.reduce((n, ms) => (Number.isFinite(ms) && ms <= target.budgetMs ? n + 1 : n), 0);
  const attainment = sampled > 0 ? good / sampled : 1;
  const met = attainment >= target.objective;
  const allowedFailRate = Math.max(1e-9, 1 - target.objective);
  const actualFailRate = sampled > 0 ? 1 - attainment : 0;
  const burn = sampled > 0 ? actualFailRate / allowedFailRate : 0;
  return { id: target.id, budgetMs: target.budgetMs, objective: target.objective, sampled, good, attainment, met, burn };
}

/** Evaluate every Copilot SLO from a per-id map of measured samples. */
export function evaluateCopilotSlos(
  samplesById: Partial<Record<CopilotSloTarget['id'], readonly number[]>>,
): SloEvaluation[] {
  return copilotSloTargets().map((t) => evaluateSlo(t, samplesById[t.id] ?? []));
}
