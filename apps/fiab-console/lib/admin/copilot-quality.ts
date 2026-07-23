/**
 * copilot-quality — PURE roll-up / trend / grade helpers for the E5 admin
 * surface (`/admin/copilot-quality`), shared by the BFF route and the client
 * panel and fully unit-tested (no Cosmos, no React).
 *
 * The copilot-evaluator Function (azure-functions/copilot-evaluator, E2) writes
 * `eval-run` + `eval-result` docs to Cosmos `loom-copilot-evals`; this module
 * turns the raw run docs into per-surface scorecards (letter grade + trend +
 * floor status), the "worst questions" ranking, and the overall program stats
 * the page header shows. It reuses the agent-quality letter-grade convention
 * (lib/admin/agent-quality.ts) rather than re-inventing one.
 *
 * NO number is fabricated (no-vaporware.md): a surface with no runs yet returns
 * `null` totals (the UI renders a guided EmptyState), and a metric a judge-less
 * run never produced (`groundingAvg === null`) stays null all the way to the
 * tile — never a 0 that reads as "F".
 */
import type {
  CopilotEvalRunDoc,
  CopilotEvalResultDoc,
} from '@/lib/azure/copilot-evals-model';
import type { QualityGrade } from '@/lib/admin/agent-quality';

export type { QualityGrade } from '@/lib/admin/agent-quality';

/** The run rollup totals as written by the evaluator (mirror of the model). */
export type RunTotals = CopilotEvalRunDoc['totals'];

/** A per-surface floor row from content/evals/eval-floors.json. */
export interface SurfaceFloor {
  retrievalHitRate?: number;
  groundingAvg?: number;
  passRate?: number;
  /** Ratchet metadata — a provisional seed floor (pre-first-run). */
  provisional?: boolean;
}

/** Per-metric floor comparison ('na' = metric or floor absent → advisory). */
export type FloorMark = 'ok' | 'below' | 'na';

export interface FloorStatus {
  retrievalHitRate: FloorMark;
  groundingAvg: FloorMark;
  passRate: FloorMark;
  /** True when ANY compared metric is below its floor. */
  belowFloor: boolean;
}

/** One point on a surface's trend sparkline (oldest → newest). */
export interface TrendPoint {
  runId: string;
  finishedAt: string;
  retrievalHitRate: number;
  groundingAvg: number | null;
  passRate: number;
}

/** Δ of the latest run vs the immediately-previous run for a surface. */
export interface RunDelta {
  retrievalHitRate: number | null;
  groundingAvg: number | null;
  passRate: number | null;
}

/** A lightweight run reference for the history dropdown / trend chart. */
export interface RunRef {
  runId: string;
  finishedAt: string;
  startedAt: string;
  trigger: CopilotEvalRunDoc['trigger'];
  corpusCommit: string;
  judgeModel: string;
  totals: RunTotals;
}

/** The per-surface scorecard the page renders one tile + trend from. */
export interface SurfaceSummary {
  surface: string;
  /** Latest run's totals (null ⇒ no runs for this surface yet). */
  totals: RunTotals | null;
  latestRunId: string | null;
  latestFinishedAt: string | null;
  latestTrigger: CopilotEvalRunDoc['trigger'] | null;
  judgeModel: string | null;
  corpusCommit: string | null;
  runCount: number;
  grade: QualityGrade | null;
  floor: SurfaceFloor | null;
  floorStatus: FloorStatus | null;
  delta: RunDelta | null;
  trend: TrendPoint[];
}

/** Program-wide roll-up for the page header quality card. */
export interface OverallStats {
  surfaces: number;
  surfacesWithRuns: number;
  belowFloor: number;
  /** Mean retrieval hit-rate across surfaces WITH a latest run (null if none). */
  avgRetrievalHitRate: number | null;
  /** Mean judge grounding across surfaces that produced a judged latest run. */
  avgGroundingAvg: number | null;
  /** Mean pass-rate across surfaces with a latest run. */
  avgPassRate: number | null;
  gradeCounts: Record<QualityGrade, number>;
}

// ── grading ──────────────────────────────────────────────────────────────────

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** SRCH1 — a federated-search relevance surface ('search:<domain>') vs a Copilot
 *  RAG surface. E5 splits the scorecard on this so search NDCG never mixes with
 *  Copilot grounding. */
export function isSearchSurface(surface: string): boolean {
  return typeof surface === 'string' && surface.startsWith('search:');
}

/** The domain label for a search surface ('search:catalog' → 'catalog'). */
export function searchDomainLabel(surface: string): string {
  return isSearchSurface(surface) ? surface.slice('search:'.length) : surface;
}

/**
 * A surface's composite letter grade from its latest run totals.
 *
 * The score weights the three quality dimensions the harness measures:
 *   - retrieval hit-rate (deterministic, authoritative even judge-less),
 *   - pass-rate (retrievalHit && mentionPass && !forbiddenHit && grounding≥4),
 *   - judge grounding (0..5 → 0..1) WHEN a run was judged.
 *
 * A judge-less run (`groundingAvg === null`) is graded on the two deterministic
 * dimensions only — never penalized for a deferred/absent judge (E3's
 * no-change-on-deferred contract carried into the grade). Boundaries mirror the
 * agent-quality thresholds (A ≥0.9 … F <0.5).
 */
export function surfaceGrade(totals: RunTotals): QualityGrade {
  const hit = clamp01(totals.retrievalHitRate);
  const pass = clamp01(totals.passRate);
  let composite: number;
  if (totals.groundingAvg !== null && totals.groundingAvg !== undefined) {
    const grounding = clamp01(totals.groundingAvg / 5);
    composite = 0.4 * hit + 0.3 * pass + 0.3 * grounding;
  } else {
    composite = 0.5 * hit + 0.5 * pass;
  }
  if (composite >= 0.9) return 'A';
  if (composite >= 0.8) return 'B';
  if (composite >= 0.65) return 'C';
  if (composite >= 0.5) return 'D';
  return 'F';
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

// ── floor comparison ─────────────────────────────────────────────────────────

/**
 * Compare a run's totals to its per-surface floor. A missing floor value OR a
 * null run metric (judge-less grounding) yields 'na' for that metric — never a
 * false 'below'. The `groundingAvg` floor is on the 1..5 judge scale.
 */
export function floorStatus(totals: RunTotals, floor: SurfaceFloor | null | undefined): FloorStatus {
  const mark = (value: number | null | undefined, min: number | undefined): FloorMark => {
    if (min === undefined || min === null) return 'na';
    if (value === null || value === undefined || !Number.isFinite(value)) return 'na';
    return value + 1e-9 >= min ? 'ok' : 'below';
  };
  const retrievalHitRate = mark(totals.retrievalHitRate, floor?.retrievalHitRate);
  const groundingAvg = mark(totals.groundingAvg, floor?.groundingAvg);
  const passRate = mark(totals.passRate, floor?.passRate);
  return {
    retrievalHitRate,
    groundingAvg,
    passRate,
    belowFloor: [retrievalHitRate, groundingAvg, passRate].includes('below'),
  };
}

// ── run selection / history ──────────────────────────────────────────────────

/** Newest-first sort key for a run (finishedAt, then startedAt, then runId). */
function runOrder(a: CopilotEvalRunDoc, b: CopilotEvalRunDoc): number {
  const af = a.finishedAt || a.startedAt || '';
  const bf = b.finishedAt || b.startedAt || '';
  if (af !== bf) return bf.localeCompare(af);
  return (b.runId || '').localeCompare(a.runId || '');
}

/**
 * Group run docs by surface, newest-first within each surface. Ledger/non-run
 * docs (surface '#ledger', docType !== 'eval-run') are ignored defensively even
 * though the caller queries by docType.
 */
export function runsBySurface(runs: CopilotEvalRunDoc[]): Map<string, CopilotEvalRunDoc[]> {
  const by = new Map<string, CopilotEvalRunDoc[]>();
  for (const r of runs) {
    if (r.docType !== 'eval-run' || !r.surface || r.surface === '#ledger') continue;
    const list = by.get(r.surface) ?? [];
    list.push(r);
    by.set(r.surface, list);
  }
  for (const list of by.values()) list.sort(runOrder);
  return by;
}

/** Trend points (oldest → newest) capped at `limit` most-recent runs. */
export function trendPoints(runsNewestFirst: CopilotEvalRunDoc[], limit = 20): TrendPoint[] {
  return runsNewestFirst
    .slice(0, limit)
    .map((r) => ({
      runId: r.runId,
      finishedAt: r.finishedAt || r.startedAt || '',
      retrievalHitRate: r.totals.retrievalHitRate,
      groundingAvg: r.totals.groundingAvg,
      passRate: r.totals.passRate,
    }))
    .reverse();
}

/** Δ between the two newest runs (null when there is no previous run). */
export function runDelta(runsNewestFirst: CopilotEvalRunDoc[]): RunDelta | null {
  if (runsNewestFirst.length < 2) return null;
  const [latest, prev] = runsNewestFirst;
  const d = (a: number | null, b: number | null): number | null =>
    a === null || a === undefined || b === null || b === undefined ? null : round3(a - b);
  return {
    retrievalHitRate: d(latest.totals.retrievalHitRate, prev.totals.retrievalHitRate),
    groundingAvg: d(latest.totals.groundingAvg, prev.totals.groundingAvg),
    passRate: d(latest.totals.passRate, prev.totals.passRate),
  };
}

// ── per-surface + overall summaries ──────────────────────────────────────────

/**
 * Build one {@link SurfaceSummary} per surface present in EITHER the run set or
 * the floors map (a floored surface with no runs yet still gets a guided,
 * runless tile). `surfaceOrder` (from the eval-set filenames / floors order)
 * keeps the grid stable; extra surfaces are appended alphabetically.
 */
export function buildSurfaceSummaries(
  runs: CopilotEvalRunDoc[],
  floors: Record<string, SurfaceFloor>,
  surfaceOrder?: string[],
): SurfaceSummary[] {
  const by = runsBySurface(runs);
  const names = new Set<string>([...by.keys(), ...Object.keys(floors || {})]);
  const ordered = orderSurfaces([...names], surfaceOrder);
  return ordered.map((surface) => {
    const list = by.get(surface) ?? [];
    const latest = list[0] ?? null;
    const floor = floors?.[surface] ?? null;
    const totals = latest?.totals ?? null;
    return {
      surface,
      totals,
      latestRunId: latest?.runId ?? null,
      latestFinishedAt: latest?.finishedAt ?? null,
      latestTrigger: latest?.trigger ?? null,
      judgeModel: latest?.judgeModel ?? null,
      corpusCommit: latest?.corpusCommit ?? null,
      runCount: list.length,
      grade: totals ? surfaceGrade(totals) : null,
      floor,
      floorStatus: totals ? floorStatus(totals, floor) : null,
      delta: runDelta(list),
      trend: trendPoints(list),
    };
  });
}

function orderSurfaces(names: string[], order?: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of order ?? []) {
    if (names.includes(n) && !seen.has(n)) { out.push(n); seen.add(n); }
  }
  for (const n of names.sort((a, b) => a.localeCompare(b))) {
    if (!seen.has(n)) { out.push(n); seen.add(n); }
  }
  return out;
}

const EMPTY_GRADE_COUNTS: Record<QualityGrade, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };

/** Program-wide roll-up across the per-surface summaries. */
export function overallStats(summaries: SurfaceSummary[]): OverallStats {
  const withRuns = summaries.filter((s) => s.totals);
  const gradeCounts: Record<QualityGrade, number> = { ...EMPTY_GRADE_COUNTS };
  for (const s of withRuns) if (s.grade) gradeCounts[s.grade] += 1;
  const mean = (xs: number[]): number | null =>
    xs.length ? round3(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  const judged = withRuns.filter((s) => s.totals!.groundingAvg !== null);
  return {
    surfaces: summaries.length,
    surfacesWithRuns: withRuns.length,
    belowFloor: withRuns.filter((s) => s.floorStatus?.belowFloor).length,
    avgRetrievalHitRate: mean(withRuns.map((s) => s.totals!.retrievalHitRate)),
    avgGroundingAvg: mean(judged.map((s) => s.totals!.groundingAvg as number)),
    avgPassRate: mean(withRuns.map((s) => s.totals!.passRate)),
    gradeCounts,
  };
}

// ── worst-questions ranking (drill-in) ───────────────────────────────────────

/**
 * Rank per-question results worst-first for the "worst questions" table:
 *   1. forbidden-phrase auto-fails (a mustNotMention hit — the no-vaporware /
 *      no-fabric-dependency assertions) come first;
 *   2. then retrieval misses;
 *   3. then lowest judge grounding (judged rows only);
 *   4. then failing pass, then slowest.
 * Deferred/errored judge rows sort AFTER judged rows at the same deterministic
 * tier (their grounding is unknown, not zero).
 */
export function worstQuestions(
  results: CopilotEvalResultDoc[],
  limit = 15,
): CopilotEvalResultDoc[] {
  const rank = (r: CopilotEvalResultDoc): number => {
    let score = 0;
    if (r.forbiddenHit) score += 10_000;
    if (!r.retrievalHit) score += 1_000;
    if (!r.pass) score += 100;
    // Lower grounding = worse; judged rows only (0..5 → up to 50 pts for g=1).
    if (r.judgeStatus === 'scored' && r.judge) score += (5 - r.judge.grounding) * 10;
    return score;
  };
  return [...results]
    .sort((a, b) => {
      const d = rank(b) - rank(a);
      if (d !== 0) return d;
      return (b.latencyMs || 0) - (a.latencyMs || 0);
    })
    .slice(0, limit);
}

/** Human "3.2/5" or "—" for a nullable judge metric. */
export function fmtScore5(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(1)}/5`;
}

/** Human "90%" or "—" for a nullable 0..1 rate. */
export function fmtPct(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`;
}

/** Signed "+5%" / "−3%" / "" for a nullable 0..1 delta (percentage points). */
export function fmtDeltaPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || Math.abs(v) < 0.005) return '';
  const pts = Math.round(v * 100);
  return `${pts > 0 ? '+' : '−'}${Math.abs(pts)}%`;
}
