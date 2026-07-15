/**
 * PSR-8 — process-wide rolling window of recent Copilot full-turn latencies,
 * feeding the tier-router's latency-SLO protection (model-tier-router
 * `latencyBurn`) and the perf surface's live SLO badge.
 *
 * State lives in module scope → per-ACA-replica, resets with the process —
 * exactly like `cache-counters` / the in-process cache tier. The tier router
 * reads the CURRENT burn (recent breach rate ÷ allowed budget) to decide
 * whether to shave a tier off a non-reasoning turn; the perf page reads the
 * attainment for the SLO badge.
 *
 * NO Fabric / Power BI dependency — Loom-internal timing only.
 */

import { copilotSloTargets, evaluateSlo, type SloEvaluation } from './copilot-slo';

/** Max turns retained in the rolling window (oldest evicted). */
const WINDOW = 100;

const fullTurnMs: number[] = [];
const firstTokenMs: number[] = [];

/** Record a completed Copilot full-turn latency (ms). Best-effort; ignores bad input. */
export function recordCopilotTurn(ms: number, firstToken?: number): void {
  if (Number.isFinite(ms) && ms >= 0) {
    fullTurnMs.push(ms);
    if (fullTurnMs.length > WINDOW) fullTurnMs.shift();
  }
  if (typeof firstToken === 'number' && Number.isFinite(firstToken) && firstToken >= 0) {
    firstTokenMs.push(firstToken);
    if (firstTokenMs.length > WINDOW) firstTokenMs.shift();
  }
}

/**
 * The CURRENT full-turn SLO burn over the rolling window (0 when no samples).
 * < 1 healthy; > 1 breaching — the tier router downshifts a non-reasoning turn
 * when this exceeds 1 (see model-tier-router `latencyBurn`).
 */
export function recentFullTurnBurn(): number {
  const target = copilotSloTargets().find((t) => t.id === 'copilot-full-turn');
  if (!target) return 0;
  return evaluateSlo(target, fullTurnMs).burn;
}

/** Live SLO evaluations over the rolling window (for the perf SLO badge). */
export function recentCopilotSloEvaluations(): SloEvaluation[] {
  return copilotSloTargets().map((t) =>
    evaluateSlo(t, t.id === 'copilot-first-token' ? firstTokenMs : fullTurnMs),
  );
}

/** Rolling-window sample counts (diagnostics). */
export function copilotLatencyWindow(): { fullTurn: number; firstToken: number } {
  return { fullTurn: fullTurnMs.length, firstToken: firstTokenMs.length };
}

/** TEST HOOK — clear the rolling window. */
export function _resetCopilotLatency(): void {
  fullTurnMs.length = 0;
  firstTokenMs.length = 0;
}
