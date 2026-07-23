/**
 * E5 (loom-next-level ws-copilot-cost.md) — /admin/copilot-quality pure layer.
 *
 * The Copilot quality admin page reads the REAL eval-run / eval-result docs the
 * copilot-evaluator Function (E2, azure-functions/copilot-evaluator) writes to
 * Cosmos `loom-copilot-evals`, plus the E3 per-surface floors
 * (content/evals/eval-floors.json). This module owns every PURE piece the route
 * + client share: per-surface roll-up, trend series, letter grades, floor
 * status, and the "worst questions" ranking. No Azure calls, no React —
 * fully unit-testable (copilot-quality.test.ts).
 *
 * Azure-native, no Microsoft Fabric dependency: these are analytics over the
 * Loom Copilot's own retrieval + AOAI judge path (.claude/rules/*).
 */
import type { CopilotEvalRunDoc, CopilotEvalResultDoc } from '@/lib/azure/copilot-evals-model';
import { gradeAvgScore, type QualityGrade } from '@/lib/admin/agent-quality';

export type { QualityGrade } from '@/lib/admin/agent-quality';

// ── Floors (content/evals/eval-floors.json shape) ────────────────────────────

/** One surface's E3 floor thresholds (any field may be absent). */
export interface EvalFloor {
  retrievalHitRate?: number;
  groundingAvg?: number;
  passRate?: number;
  /** Provisional seed floors (set before any measured run) — labeled honestly. */
  provisional?: boolean;
}

export type EvalFloors = Record<string, EvalFloor>;

// ── Trend + summary shapes (JSON-serializable — cross the route boundary) ─────

/** One run's headline metrics for the per-surface trend sparkline/chart. */
export interface SurfaceTrendPoint {
  runId: string;
  finishedAt: string;
  trigger: CopilotEvalRunDoc['trigger'];
  retrievalHitRate: number;
  /** null in a run where the judge was deferred / judge-less (E2 daily cap). */
  groundingAvg: number | null;
  passRate: number;
  questions: number;
}

export type FloorMetric = 'retrievalHitRate' | 'groundingAvg' | 'passRate';
export type FloorVerdict = 'ok' | 'below' | 'no-floor' | 'not-judged';

/** A single metric measured against its floor. */
export interface FloorStatus {
  metric: FloorMetric;
  value: number | null;
  floor: number | null;
  verdict: FloorVerdict;
}

/** The per-surface roll-up the scorecard + trend render from. */
export interface SurfaceSummary {
  surface: string;
  /** The most recent run's rollup (the scorecard headline). */
  latest: {
    runId: string;
    finishedAt: string;
    startedAt: string;
    trigger: CopilotEvalRunDoc['trigger'];
    judgeModel: string;
    corpusCommit: string;
    totals: CopilotEvalRunDoc['totals'];
  };
  /** Chronological (oldest→newest) trend points across retained runs. */
  trend: SurfaceTrendPoint[];
  /** Composite letter grade for the latest run. */
  grade: QualityGrade;
  /** Per-metric floor comparison for the latest run. */
  floorStatus: FloorStatus[];
  /** True when ANY measured metric is below its floor. */
  belowFloor: boolean;
  /** True when the floors compared against are still the provisional seed. */
  provisionalFloor: boolean;
  /** Runs retained for this surface (trend length). */
  runCount: number;
}

// ── Grades ───────────────────────────────────────────────────────────────────

const round = (n: number, dp: number): number => Number(n.toFixed(dp));

/** Grade a 0..1 retrieval hit-rate (≥0.9 A, ≥0.8 B, ≥0.7 C, ≥0.5 D, else F). */
export function gradeHitRate(hitRate: number): QualityGrade {
  if (hitRate >= 0.9) return 'A';
  if (hitRate >= 0.8) return 'B';
  if (hitRate >= 0.7) return 'C';
  if (hitRate >= 0.5) return 'D';
  return 'F';
}

/** Grade a 0..1 pass-rate (≥0.9 A, ≥0.8 B, ≥0.65 C, ≥0.5 D, else F). */
export function gradePassRate(passRate: number): QualityGrade {
  if (passRate >= 0.9) return 'A';
  if (passRate >= 0.8) return 'B';
  if (passRate >= 0.65) return 'C';
  if (passRate >= 0.5) return 'D';
  return 'F';
}

const GRADE_ORDER: QualityGrade[] = ['F', 'D', 'C', 'B', 'A'];

/** The WORSE of two grades (the composite never over-reports). */
export function worstGrade(a: QualityGrade, b: QualityGrade): QualityGrade {
  return GRADE_ORDER.indexOf(a) <= GRADE_ORDER.indexOf(b) ? a : b;
}

/**
 * Composite grade for a run: the worse of the retrieval-hit-rate grade and the
 * grounding grade. Grounding is only folded in when the run was actually judged
 * (groundingAvg non-null) — a judge-deferred run grades on retrieval alone
 * (deterministic, authoritative) rather than being penalized for having no
 * judge score (E2 daily-cap semantics: deferred = no-change, never a regression).
 */
export function compositeGrade(totals: CopilotEvalRunDoc['totals']): QualityGrade {
  const retrieval = gradeHitRate(totals.retrievalHitRate);
  if (totals.groundingAvg == null) return retrieval;
  return worstGrade(retrieval, gradeAvgScore(totals.groundingAvg));
}

// ── Floor comparison ─────────────────────────────────────────────────────────

/**
 * Compare a run's totals against a surface floor. groundingAvg is skipped
 * ('not-judged') when the run had no judge score — a judge-less run is never
 * failed on a grounding floor it structurally cannot measure. A metric with no
 * floor is 'no-floor'.
 */
export function floorStatusFor(
  totals: CopilotEvalRunDoc['totals'],
  floor: EvalFloor | undefined,
): FloorStatus[] {
  const cmp = (metric: FloorMetric, value: number | null, floorVal: number | undefined): FloorStatus => {
    if (metric === 'groundingAvg' && value == null) {
      return { metric, value: null, floor: floorVal ?? null, verdict: 'not-judged' };
    }
    if (floorVal == null) return { metric, value, floor: null, verdict: 'no-floor' };
    if (value == null) return { metric, value: null, floor: floorVal, verdict: 'not-judged' };
    return { metric, value, floor: floorVal, verdict: value + 1e-9 >= floorVal ? 'ok' : 'below' };
  };
  return [
    cmp('retrievalHitRate', totals.retrievalHitRate, floor?.retrievalHitRate),
    cmp('groundingAvg', totals.groundingAvg, floor?.groundingAvg),
    cmp('passRate', totals.passRate, floor?.passRate),
  ];
}

// ── Per-surface roll-up ──────────────────────────────────────────────────────

const byFinishedDesc = (a: CopilotEvalRunDoc, b: CopilotEvalRunDoc): number =>
  (b.finishedAt || '').localeCompare(a.finishedAt || '');

/**
 * Group every `eval-run` doc by surface, then build the per-surface summary:
 * the latest run's rollup, the chronological trend, the composite grade, and
 * the floor comparison. Runs with a non-'eval-run' docType (results, the judge
 * ledger) are ignored. Surfaces with zero runs simply don't appear (the caller
 * renders an EmptyState). Deterministic ordering: surfaces sorted by name.
 */
export function buildSurfaceSummaries(
  runs: CopilotEvalRunDoc[],
  floors: EvalFloors,
): SurfaceSummary[] {
  const bySurface = new Map<string, CopilotEvalRunDoc[]>();
  for (const r of runs) {
    if (r?.docType !== 'eval-run' || !r.surface || r.surface.startsWith('#')) continue;
    const arr = bySurface.get(r.surface) ?? [];
    arr.push(r);
    bySurface.set(r.surface, arr);
  }

  const out: SurfaceSummary[] = [];
  for (const [surface, surfaceRuns] of bySurface) {
    surfaceRuns.sort(byFinishedDesc);
    const latest = surfaceRuns[0];
    const floor = floors[surface];
    const trend: SurfaceTrendPoint[] = [...surfaceRuns]
      .reverse() // oldest → newest for a left-to-right trend
      .map((r) => ({
        runId: r.runId,
        finishedAt: r.finishedAt,
        trigger: r.trigger,
        retrievalHitRate: r.totals.retrievalHitRate,
        groundingAvg: r.totals.groundingAvg,
        passRate: r.totals.passRate,
        questions: r.totals.questions,
      }));
    out.push({
      surface,
      latest: {
        runId: latest.runId,
        finishedAt: latest.finishedAt,
        startedAt: latest.startedAt,
        trigger: latest.trigger,
        judgeModel: latest.judgeModel,
        corpusCommit: latest.corpusCommit,
        totals: latest.totals,
      },
      trend,
      grade: compositeGrade(latest.totals),
      floorStatus: floorStatusFor(latest.totals, floor),
      belowFloor: floorStatusFor(latest.totals, floor).some((s) => s.verdict === 'below'),
      provisionalFloor: floor?.provisional === true,
      runCount: surfaceRuns.length,
    });
  }
  out.sort((a, b) => a.surface.localeCompare(b.surface));
  return out;
}

// ── Program-wide roll-up (top-of-page banner tiles) ──────────────────────────

export interface QualityOverview {
  surfaces: number;
  runs: number;
  /** Surfaces with ≥1 metric below floor (the alarm count). */
  belowFloor: number;
  /** Mean retrieval hit-rate across the latest run of every surface (0..1). */
  meanHitRate: number | null;
  /** Mean grounding across surfaces whose latest run was judged (1..5). */
  meanGrounding: number | null;
  /** ISO of the most recent run across all surfaces. */
  lastRunAt: string | null;
}

/** Aggregate the per-surface summaries into the page's headline overview. */
export function buildOverview(summaries: SurfaceSummary[]): QualityOverview {
  if (summaries.length === 0) {
    return { surfaces: 0, runs: 0, belowFloor: 0, meanHitRate: null, meanGrounding: null, lastRunAt: null };
  }
  const hitRates = summaries.map((s) => s.latest.totals.retrievalHitRate);
  const grounded = summaries
    .map((s) => s.latest.totals.groundingAvg)
    .filter((g): g is number => g != null);
  const lastRunAt = summaries
    .map((s) => s.latest.finishedAt)
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a))[0] ?? null;
  return {
    surfaces: summaries.length,
    runs: summaries.reduce((n, s) => n + s.runCount, 0),
    belowFloor: summaries.filter((s) => s.belowFloor).length,
    meanHitRate: hitRates.length ? round(hitRates.reduce((a, b) => a + b, 0) / hitRates.length, 3) : null,
    meanGrounding: grounded.length ? round(grounded.reduce((a, b) => a + b, 0) / grounded.length, 2) : null,
    lastRunAt,
  };
}

// ── Worst questions (drill-in ranking) ───────────────────────────────────────

export type WorstReason = 'forbidden-phrase' | 'retrieval-miss' | 'low-grounding' | 'missed-mention' | 'judge-error';

export interface WorstQuestion {
  questionId: string;
  question: string;
  reason: WorstReason;
  retrievalHit: boolean;
  grounding: number | null;
  mrr: number;
  pass: boolean;
  judgeStatus: CopilotEvalResultDoc['judgeStatus'];
  rationale?: string;
  tier: string;
  /** The corpus chunks the retriever SHOULD have surfaced (drill-in evidence). */
  expectedChunks: string[];
  /** The corpus chunks the retriever ACTUALLY surfaced. */
  retrievedChunks: string[];
  /** The model's answer (bounded) — what the judge / guards graded. */
  answer: string;
  /** severity — higher = worse (drives the ranking + badge tone). */
  severity: number;
}

/** Cap a chunk/answer preview so a drill-in payload stays bounded. */
const capLen = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

function classifyResult(r: CopilotEvalResultDoc): { reason: WorstReason; severity: number } | null {
  if (r.forbiddenHit) return { reason: 'forbidden-phrase', severity: 100 };
  if (!r.retrievalHit) return { reason: 'retrieval-miss', severity: 80 };
  if (r.judgeStatus === 'error') return { reason: 'judge-error', severity: 40 };
  if (r.judgeStatus === 'scored' && r.judge && r.judge.grounding < 4) {
    return { reason: 'low-grounding', severity: 60 - r.judge.grounding * 5 };
  }
  if (!r.mentionPass) return { reason: 'missed-mention', severity: 50 };
  return null; // a passing question — not "worst"
}

/**
 * Rank the failing / weak questions of a run for the drill-in table: forbidden
 * phrases first (auto-fail — the no-vaporware / no-fabric assertions), then
 * retrieval misses, low grounding, missed mentions, judge errors. Only
 * non-passing rows surface; ties break by ascending MRR (worse retrieval first)
 * then question id (stable). `limit` caps the list (default 25).
 */
export function worstQuestions(results: CopilotEvalResultDoc[], limit = 25): WorstQuestion[] {
  const ranked: WorstQuestion[] = [];
  for (const r of results) {
    if (r?.docType !== 'eval-result') continue;
    const c = classifyResult(r);
    if (!c) continue;
    ranked.push({
      questionId: r.questionId,
      question: r.question,
      reason: c.reason,
      retrievalHit: r.retrievalHit,
      grounding: r.judge?.grounding ?? null,
      mrr: r.mrr,
      pass: r.pass,
      judgeStatus: r.judgeStatus,
      rationale: r.judge?.rationale,
      tier: r.tier,
      expectedChunks: (r.expectedChunks || []).slice(0, 12),
      retrievedChunks: (r.retrievedChunks || []).slice(0, 12),
      answer: capLen(r.answer || '', 800),
      severity: c.severity,
    });
  }
  ranked.sort((a, b) =>
    b.severity - a.severity || a.mrr - b.mrr || a.questionId.localeCompare(b.questionId),
  );
  return ranked.slice(0, limit);
}

/** A human label for a worst-question reason (client badge text). */
export function worstReasonLabel(reason: WorstReason): string {
  switch (reason) {
    case 'forbidden-phrase': return 'Forbidden phrase';
    case 'retrieval-miss': return 'Retrieval miss';
    case 'low-grounding': return 'Low grounding';
    case 'missed-mention': return 'Missed mention';
    case 'judge-error': return 'Judge error';
  }
}
