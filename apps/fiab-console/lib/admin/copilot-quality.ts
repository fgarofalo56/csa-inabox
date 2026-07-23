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
import type {
  CopilotEvalRunDoc, CopilotEvalResultDoc, CopilotSearchRunDoc, CopilotTierRunDoc,
} from '@/lib/azure/copilot-evals-model';
import { gradeAvgScore, type QualityGrade } from '@/lib/admin/agent-quality';
import { MODEL_TIERS, TIER_LABELS, TASK_CLASS_LABELS, type ModelTier, type TaskClass } from '@/lib/foundry/model-tier-router';
import { tierPriceCoeff } from '@/lib/copilot/cost-estimate';

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

// ── SRCH1 — federated-search relevance roll-up ───────────────────────────────

/** One domain's E3 search floor thresholds. */
export interface SearchFloor {
  searchHitRate?: number;
  ndcg?: number;
  provisional?: boolean;
}
export type SearchFloors = Record<string, SearchFloor>;

export interface SearchTrendPoint {
  runId: string;
  finishedAt: string;
  trigger: CopilotSearchRunDoc['trigger'];
  hitRate: number;
  ndcgAvg: number;
  queries: number;
}

export type SearchFloorMetric = 'searchHitRate' | 'ndcg';

export interface SearchFloorStatus {
  metric: SearchFloorMetric;
  value: number;
  floor: number | null;
  verdict: FloorVerdict;
}

/** Per-domain search-relevance summary the "Search relevance" tab renders. */
export interface SearchSummary {
  domain: string;
  latest: {
    runId: string;
    finishedAt: string;
    trigger: CopilotSearchRunDoc['trigger'];
    k: number;
    totals: CopilotSearchRunDoc['totals'];
  };
  trend: SearchTrendPoint[];
  grade: QualityGrade;
  floorStatus: SearchFloorStatus[];
  belowFloor: boolean;
  provisionalFloor: boolean;
  runCount: number;
}

/** Grade a 0..1 NDCG (≥0.9 A, ≥0.8 B, ≥0.7 C, ≥0.5 D, else F) — same bands as hit-rate. */
export const gradeNdcg = gradeHitRate;

/** Composite search grade = worse of hit-rate and NDCG grades. */
export function compositeSearchGrade(totals: CopilotSearchRunDoc['totals']): QualityGrade {
  return worstGrade(gradeHitRate(totals.hitRate), gradeNdcg(totals.ndcgAvg));
}

/** Compare a search run's totals against a domain floor. */
export function searchFloorStatusFor(
  totals: CopilotSearchRunDoc['totals'],
  floor: SearchFloor | undefined,
): SearchFloorStatus[] {
  const cmp = (metric: SearchFloorMetric, value: number, floorVal: number | undefined): SearchFloorStatus => {
    if (floorVal == null) return { metric, value, floor: null, verdict: 'no-floor' };
    return { metric, value, floor: floorVal, verdict: value + 1e-9 >= floorVal ? 'ok' : 'below' };
  };
  return [
    cmp('searchHitRate', totals.hitRate, floor?.searchHitRate),
    cmp('ndcg', totals.ndcgAvg, floor?.ndcg),
  ];
}

const bySearchFinishedDesc = (a: CopilotSearchRunDoc, b: CopilotSearchRunDoc): number =>
  (b.finishedAt || '').localeCompare(a.finishedAt || '');

/** Group `search-run` docs by domain and build the per-domain summary. */
export function buildSearchSummaries(
  runs: CopilotSearchRunDoc[],
  floors: SearchFloors,
): SearchSummary[] {
  const byDomain = new Map<string, CopilotSearchRunDoc[]>();
  for (const r of runs) {
    if (r?.docType !== 'search-run' || !r.domain) continue;
    const arr = byDomain.get(r.domain) ?? [];
    arr.push(r);
    byDomain.set(r.domain, arr);
  }
  const out: SearchSummary[] = [];
  for (const [domain, domainRuns] of byDomain) {
    domainRuns.sort(bySearchFinishedDesc);
    const latest = domainRuns[0];
    const floor = floors[domain];
    const trend: SearchTrendPoint[] = [...domainRuns].reverse().map((r) => ({
      runId: r.runId, finishedAt: r.finishedAt, trigger: r.trigger,
      hitRate: r.totals.hitRate, ndcgAvg: r.totals.ndcgAvg, queries: r.totals.queries,
    }));
    out.push({
      domain,
      latest: { runId: latest.runId, finishedAt: latest.finishedAt, trigger: latest.trigger, k: latest.k, totals: latest.totals },
      trend,
      grade: compositeSearchGrade(latest.totals),
      floorStatus: searchFloorStatusFor(latest.totals, floor),
      belowFloor: searchFloorStatusFor(latest.totals, floor).some((s) => s.verdict === 'below'),
      provisionalFloor: floor?.provisional === true,
      runCount: domainRuns.length,
    });
  }
  out.sort((a, b) => a.domain.localeCompare(b.domain));
  return out;
}

// ── E6 — tier-router decision roll-up (cost-per-quality) ─────────────────────

/** The E6 tier-accuracy floor (single-metric). Keyed 'router' in eval-floors.json. */
export interface TierFloor {
  tierAccuracy?: number;
  provisional?: boolean;
}
export type TierFloors = Record<string, TierFloor>;

export interface TierTrendPoint {
  runId: string;
  finishedAt: string;
  trigger: CopilotTierRunDoc['trigger'];
  tierAccuracy: number;
  taskClassAccuracy: number;
  rows: number;
}

export interface TierFloorStatus {
  metric: 'tierAccuracy';
  value: number;
  floor: number | null;
  verdict: FloorVerdict;
}

/** One confusion-matrix row for the heatmap (expected tier × chosen-tier counts). */
export interface TierMatrixRow {
  /** The labeled (expected) tier this row is the truth for. */
  expectedTier: ModelTier;
  /** Chosen-tier counts in fixed MODEL_TIERS order. */
  cells: { chosenTier: ModelTier; count: number }[];
  /** Row total (labeled rows expecting this tier). */
  total: number;
}

/** Per-task-class tier-decision accuracy (drives the per-class bars). */
export interface TierPerClassRow {
  taskClass: TaskClass;
  label: string;
  total: number;
  correct: number;
  accuracy: number;
}

/** The per-run tier-routing summary the "Tier routing" tab renders. */
export interface TierSummary {
  latest: {
    runId: string;
    finishedAt: string;
    trigger: CopilotTierRunDoc['trigger'];
    totals: CopilotTierRunDoc['totals'];
  };
  trend: TierTrendPoint[];
  grade: QualityGrade;
  floorStatus: TierFloorStatus;
  belowFloor: boolean;
  provisionalFloor: boolean;
  runCount: number;
  /** Confusion matrix rows (truth × prediction) for the heatmap. */
  matrix: TierMatrixRow[];
  /** Per-task-class tier accuracy rows. */
  perClass: TierPerClassRow[];
}

/** Compare a tier run's accuracy against the 'router' floor. */
export function tierFloorStatusFor(
  totals: CopilotTierRunDoc['totals'],
  floor: TierFloor | undefined,
): TierFloorStatus {
  const value = totals.tierAccuracy;
  if (floor?.tierAccuracy == null) return { metric: 'tierAccuracy', value, floor: null, verdict: 'no-floor' };
  return {
    metric: 'tierAccuracy',
    value,
    floor: floor.tierAccuracy,
    verdict: value + 1e-9 >= floor.tierAccuracy ? 'ok' : 'below',
  };
}

const byTierFinishedDesc = (a: CopilotTierRunDoc, b: CopilotTierRunDoc): number =>
  (b.finishedAt || '').localeCompare(a.finishedAt || '');

/** Expand a tier-run's `matrix` into fixed-order heatmap rows (never NaN gaps). */
function tierMatrixRows(matrix: CopilotTierRunDoc['totals']['matrix']): TierMatrixRow[] {
  return MODEL_TIERS.map((expectedTier) => {
    const cells = MODEL_TIERS.map((chosenTier) => ({
      chosenTier,
      count: matrix?.[expectedTier]?.[chosenTier] ?? 0,
    }));
    return { expectedTier, cells, total: cells.reduce((n, c) => n + c.count, 0) };
  });
}

/** Expand a tier-run's `perClass` into labeled rows (fixed task-class order). */
function tierPerClassRows(perClass: CopilotTierRunDoc['totals']['perClass']): TierPerClassRow[] {
  const classes: TaskClass[] = ['lightweight', 'general', 'reasoning'];
  return classes.map((taskClass) => {
    const s = perClass?.[taskClass] ?? { total: 0, correct: 0, accuracy: 0 };
    return { taskClass, label: TASK_CLASS_LABELS[taskClass], total: s.total, correct: s.correct, accuracy: s.accuracy };
  });
}

/**
 * Build the single-router tier summary from the retained `tier-run` docs: the
 * latest run's confusion + accuracy, the accuracy trend, the composite grade
 * (accuracy bands, reusing gradeHitRate), and the 'router' floor status. Returns
 * null when no tier runs exist (the tab renders a guided EmptyState).
 */
export function buildTierSummary(
  runs: CopilotTierRunDoc[],
  floors: TierFloors,
): TierSummary | null {
  const tierRuns = runs.filter((r) => r?.docType === 'tier-run' && r.surface === 'tier:router');
  if (tierRuns.length === 0) return null;
  tierRuns.sort(byTierFinishedDesc);
  const latest = tierRuns[0];
  const floor = floors.router;
  const status = tierFloorStatusFor(latest.totals, floor);
  const trend: TierTrendPoint[] = [...tierRuns].reverse().map((r) => ({
    runId: r.runId,
    finishedAt: r.finishedAt,
    trigger: r.trigger,
    tierAccuracy: r.totals.tierAccuracy,
    taskClassAccuracy: r.totals.taskClassAccuracy,
    rows: r.totals.rows,
  }));
  return {
    latest: { runId: latest.runId, finishedAt: latest.finishedAt, trigger: latest.trigger, totals: latest.totals },
    trend,
    grade: gradeHitRate(latest.totals.tierAccuracy),
    floorStatus: status,
    belowFloor: status.verdict === 'below',
    provisionalFloor: floor?.provisional === true,
    runCount: tierRuns.length,
    matrix: tierMatrixRows(latest.totals.matrix),
    perClass: tierPerClassRows(latest.totals.perClass),
  };
}

/**
 * Cost-per-quality per routing tier: judged grounding (0..5, the answer-quality
 * mean) per estimated $ — `qualityPerDollar = (grounding / 5) / tierPriceCoeff`.
 * A higher value = more grounded quality per list-price dollar, which is why
 * routing a lightweight turn onto the cheap `mini` tier wins. `meanGrounding` is
 * the program-wide judged grounding (null when no run has been judged yet → the
 * ratio is null, shown as "—" rather than a fabricated number).
 */
export interface TierCostQualityRow {
  tier: ModelTier;
  label: string;
  /** Blended $/1K-token list-price coefficient for the tier. */
  coeff: number;
  /** (grounding/5) / coeff — higher is better; null when grounding is unmeasured. */
  qualityPerDollar: number | null;
}

export function tierCostPerQuality(meanGrounding: number | null): TierCostQualityRow[] {
  return MODEL_TIERS.map((tier) => {
    const coeff = tierPriceCoeff(tier);
    const q = meanGrounding == null || coeff <= 0 ? null : round((meanGrounding / 5) / coeff, 1);
    return { tier, label: TIER_LABELS[tier], coeff, qualityPerDollar: q };
  });
}
