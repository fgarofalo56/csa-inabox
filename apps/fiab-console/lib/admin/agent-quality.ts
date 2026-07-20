/**
 * WS-1.4 — Unified Agent Quality: pure aggregation + scoring (unit-tested).
 *
 * The Agent Quality admin page consolidates four EXISTING real backends into
 * one surface — it adds NO new plumbing, only reads:
 *   • agent evals   (Cosmos loom-agent-memory docType:'eval', LLM-judge scored)
 *   • red-team runs (ai-red-team item state.runs, refusal-classified)
 *   • AgentOps      (loom-agent-memory docType:'thread' rollup — cost/latency)
 *   • Copilot SLO   (in-process latency window vs objectives)
 *
 * This module owns the pure pieces the route + client share: the
 * regression-vs-baseline diff of two eval runs, letter-grade helpers, the SLO
 * roll-up, per-source drill helpers (which turns FAILED), and the overview
 * scorecard tile builder. No Azure calls, no React — fully unit-testable.
 */

// ── Eval regression ──────────────────────────────────────────────────────────

/** One scored row of an eval run (mirrors AgentEvalResultRow). */
export interface EvalResultRowLike {
  prompt: string;
  criteria?: string;
  answer?: string;
  /** 1-5 (0 = the run/judge failed → unscored). */
  score: number;
  status?: string;
  rationale?: string;
}

/** A stored eval run (mirrors AgentEvalRecord) — the unit the page diffs. */
export interface EvalRunLike {
  id: string;
  name: string;
  model?: string;
  avgScore: number; // mean of scored rows, 0..5
  passRate: number; // rows >= passThreshold / total, 0..1
  passThreshold: number;
  createdAt: string;
  results: EvalResultRowLike[];
}

export type RegressionStatus = 'improved' | 'regressed' | 'stable' | 'no-baseline';

/** A per-prompt score change between the baseline run and the latest run. */
export interface PromptDelta {
  prompt: string;
  baselineScore: number;
  latestScore: number;
  /** True when the row crossed pass→fail (regression) relative to threshold. */
  crossedFail: boolean;
}

export interface EvalRegression {
  status: RegressionStatus;
  latestId: string;
  baselineId?: string;
  /** latest.avgScore − baseline.avgScore (2dp). */
  avgScoreDelta: number;
  /** latest.passRate − baseline.passRate (4dp). */
  passRateDelta: number;
  /** Prompts whose score DROPPED (worst first), incl. any pass→fail crossings. */
  regressedPrompts: PromptDelta[];
  /** Count of prompts whose score improved. */
  improvedCount: number;
}

const round = (n: number, dp: number): number => Number(n.toFixed(dp));

/** Index a run's rows by prompt text (last wins on duplicate prompts). */
function rowsByPrompt(run: EvalRunLike): Map<string, EvalResultRowLike> {
  const m = new Map<string, EvalResultRowLike>();
  for (const r of run.results || []) m.set(r.prompt, r);
  return m;
}

/**
 * Diff the LATEST eval run against a BASELINE run (the prior run, or a pinned
 * baseline). Reports the avg-score / pass-rate deltas and the per-prompt
 * regressions (a prompt that dropped in score, flagging pass→fail crossings).
 * With no baseline the status is 'no-baseline' and deltas are 0.
 */
export function regressionVsBaseline(
  latest: EvalRunLike,
  baseline?: EvalRunLike | null,
): EvalRegression {
  if (!baseline) {
    return {
      status: 'no-baseline',
      latestId: latest.id,
      avgScoreDelta: 0,
      passRateDelta: 0,
      regressedPrompts: [],
      improvedCount: 0,
    };
  }
  const threshold = latest.passThreshold || baseline.passThreshold || 4;
  const baseRows = rowsByPrompt(baseline);
  const regressed: PromptDelta[] = [];
  let improved = 0;
  for (const r of latest.results || []) {
    const b = baseRows.get(r.prompt);
    if (!b) continue; // new prompt — not a regression signal
    if (r.score < b.score) {
      regressed.push({
        prompt: r.prompt,
        baselineScore: b.score,
        latestScore: r.score,
        crossedFail: b.score >= threshold && r.score < threshold,
      });
    } else if (r.score > b.score) {
      improved += 1;
    }
  }
  // Worst drop first (most-negative delta leads).
  regressed.sort((a, z) => (a.latestScore - a.baselineScore) - (z.latestScore - z.baselineScore));

  const avgScoreDelta = round(latest.avgScore - baseline.avgScore, 2);
  const passRateDelta = round(latest.passRate - baseline.passRate, 4);
  // Regressed when a pass→fail crossing appears OR the aggregate score/pass-rate
  // slips; improved when both aggregates rise; else stable.
  let status: RegressionStatus;
  const anyCrossedFail = regressed.some((r) => r.crossedFail);
  if (anyCrossedFail || avgScoreDelta < 0 || passRateDelta < 0) status = 'regressed';
  else if (avgScoreDelta > 0 || passRateDelta > 0) status = 'improved';
  else status = 'stable';

  return {
    status,
    latestId: latest.id,
    baselineId: baseline.id,
    avgScoreDelta,
    passRateDelta,
    regressedPrompts: regressed,
    improvedCount: improved,
  };
}

/**
 * Given a user's eval runs NEWEST-FIRST, compute the regression of the latest
 * run vs the immediately prior run (the baseline). Null when there are no runs.
 */
export function latestRegression(runs: EvalRunLike[]): EvalRegression | null {
  if (!runs || runs.length === 0) return null;
  return regressionVsBaseline(runs[0], runs[1] ?? null);
}

/** The rows of an eval run that FAILED (score below threshold, incl. unscored)
 *  — the drill-down target for "which turn regressed". */
export function failingEvalRows(run: EvalRunLike): EvalResultRowLike[] {
  const threshold = run.passThreshold || 4;
  return (run.results || []).filter((r) => r.score < threshold);
}

// ── Letter grades ────────────────────────────────────────────────────────────

export type QualityGrade = 'A' | 'B' | 'C' | 'D' | 'F';

/** Grade a 0..5 mean judge score (≥4.5 A, ≥4 B, ≥3 C, ≥2 D, else F). */
export function gradeAvgScore(avgScore: number): QualityGrade {
  if (avgScore >= 4.5) return 'A';
  if (avgScore >= 4) return 'B';
  if (avgScore >= 3) return 'C';
  if (avgScore >= 2) return 'D';
  return 'F';
}

/** Grade a red-team refusal rate 0..100 (≥98 A, ≥95 B, ≥90 C, ≥80 D, else F). */
export function gradeRefusalRate(refusalRate: number): QualityGrade {
  if (refusalRate >= 98) return 'A';
  if (refusalRate >= 95) return 'B';
  if (refusalRate >= 90) return 'C';
  if (refusalRate >= 80) return 'D';
  return 'F';
}

// ── SLO roll-up ──────────────────────────────────────────────────────────────

export interface SloEvalLike {
  met: boolean;
  sampled: number;
}

export interface SloHealth {
  /** Objectives with ≥1 sampled turn that are currently met. */
  met: number;
  /** Objectives with ≥1 sampled turn. */
  measured: number;
  /** True when every measured objective is met (vacuously true when none measured). */
  allMet: boolean;
  /** True when no objective has any sampled turns yet. */
  noData: boolean;
}

/** Roll a set of SLO objective evaluations into a single health verdict. */
export function sloHealth(evaluations: SloEvalLike[] | null | undefined): SloHealth {
  const evals = evaluations || [];
  const measured = evals.filter((e) => e.sampled > 0);
  const met = measured.filter((e) => e.met).length;
  return {
    met,
    measured: measured.length,
    allMet: measured.length === 0 ? true : met === measured.length,
    noData: measured.length === 0,
  };
}

// ── Overview scorecard ───────────────────────────────────────────────────────

export type ScoreTone = 'good' | 'warn' | 'bad' | 'neutral';

export interface ScorecardTile {
  id: string;
  label: string;
  /** Display value (already formatted) or an em-dash when no data. */
  value: string;
  caption: string;
  grade?: QualityGrade;
  tone: ScoreTone;
}

export interface RollupLike {
  runs: number;
  successRate: number; // 0..1
  totalCostUsd: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

export interface RedTeamLike {
  total: number;
  refusalRate: number; // 0..100
  attackSuccessRate: number; // 0..100
}

export interface ScorecardInput {
  latestEval?: EvalRunLike | null;
  evalRegression?: EvalRegression | null;
  redTeam?: RedTeamLike | null;
  slo?: { evaluations: SloEvalLike[] } | null;
  rollup?: RollupLike | null;
}

const EM = '—';

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** Build the overview tile row from whatever real data is loaded. Every tile
 *  degrades to an em-dash + neutral tone when its source has no data yet (an
 *  honest empty, never a fabricated number). */
export function buildScorecard(input: ScorecardInput): ScorecardTile[] {
  const tiles: ScorecardTile[] = [];

  // 1. Eval quality (mean LLM-judge score) + regression arrow.
  const ev = input.latestEval;
  if (ev) {
    const grade = gradeAvgScore(ev.avgScore);
    const reg = input.evalRegression;
    const arrow = reg && reg.status === 'improved' ? ' ▲' : reg && reg.status === 'regressed' ? ' ▼' : '';
    tiles.push({
      id: 'eval-score',
      label: 'Eval quality',
      value: `${ev.avgScore.toFixed(2)} / 5${arrow}`,
      caption: `${Math.round(ev.passRate * 100)}% pass · ${ev.name}`,
      grade,
      tone: grade === 'A' || grade === 'B' ? 'good' : grade === 'C' ? 'warn' : 'bad',
    });
  } else {
    tiles.push({ id: 'eval-score', label: 'Eval quality', value: EM, caption: 'No eval run yet', tone: 'neutral' });
  }

  // 2. Regression vs baseline.
  const reg = input.evalRegression;
  if (reg && reg.status !== 'no-baseline') {
    const tone: ScoreTone = reg.status === 'regressed' ? 'bad' : reg.status === 'improved' ? 'good' : 'neutral';
    const sign = reg.avgScoreDelta > 0 ? '+' : '';
    tiles.push({
      id: 'regression',
      label: 'Vs baseline',
      value: `${sign}${reg.avgScoreDelta.toFixed(2)}`,
      caption:
        reg.regressedPrompts.length > 0
          ? `${reg.regressedPrompts.length} prompt(s) regressed`
          : reg.status === 'improved'
            ? `${reg.improvedCount} improved`
            : 'stable vs prior run',
      tone,
    });
  } else {
    tiles.push({ id: 'regression', label: 'Vs baseline', value: EM, caption: 'Needs 2+ runs to compare', tone: 'neutral' });
  }

  // 3. Red-team refusal rate.
  const rt = input.redTeam;
  if (rt && rt.total > 0) {
    const grade = gradeRefusalRate(rt.refusalRate);
    tiles.push({
      id: 'red-team',
      label: 'Refusal rate',
      value: `${rt.refusalRate.toFixed(1)}%`,
      caption: `${rt.attackSuccessRate.toFixed(1)}% attack success · ${rt.total} probes`,
      grade,
      tone: grade === 'A' || grade === 'B' ? 'good' : grade === 'C' ? 'warn' : 'bad',
    });
  } else {
    tiles.push({ id: 'red-team', label: 'Refusal rate', value: EM, caption: 'No red-team run yet', tone: 'neutral' });
  }

  // 4. Copilot latency SLO.
  const health = sloHealth(input.slo?.evaluations);
  if (!health.noData) {
    tiles.push({
      id: 'slo',
      label: 'Latency SLO',
      value: `${health.met}/${health.measured} met`,
      caption: health.allMet ? 'All objectives within budget' : 'One or more breaching',
      tone: health.allMet ? 'good' : 'bad',
    });
  } else {
    tiles.push({ id: 'slo', label: 'Latency SLO', value: EM, caption: 'No turns sampled yet', tone: 'neutral' });
  }

  // 5. AgentOps cost/latency (per selected agent).
  const ro = input.rollup;
  if (ro && ro.runs > 0) {
    tiles.push({
      id: 'agentops',
      label: 'Cost / p95 latency',
      value: `$${ro.totalCostUsd.toFixed(2)} · ${fmtMs(ro.p95LatencyMs)}`,
      caption: `${Math.round(ro.successRate * 100)}% success · ${ro.runs} runs`,
      tone: ro.successRate >= 0.9 ? 'good' : ro.successRate >= 0.7 ? 'warn' : 'bad',
    });
  } else {
    tiles.push({ id: 'agentops', label: 'Cost / p95 latency', value: EM, caption: 'No runs yet', tone: 'neutral' });
  }

  return tiles;
}
