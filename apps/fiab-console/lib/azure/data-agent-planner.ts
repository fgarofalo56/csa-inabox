/**
 * WS-5.5 — Reasoning-mode data agents: the PURE plan / verify layer.
 *
 * A data agent's default path is a single grounded turn (propose query → run it →
 * re-ground). For a HARD, multi-hop question that is not enough: the answer has
 * to be decomposed into ordered sub-questions, each executed against a real
 * source, then the final answer VERIFIED against those step results. This module
 * holds the deterministic, side-effect-free half of that loop so it is fully
 * unit-testable with no Azure/LLM round-trip:
 *
 *   • {@link isMultiHop} / {@link shouldPlan} — decide when a turn earns the
 *     planner→execute→verify loop vs. the cheap single-shot path.
 *   • {@link parsePlan} / {@link sequenceSteps} — parse the reasoning model's
 *     PLAN JSON into an ordered, capped, de-duplicated step list.
 *   • {@link parseVerify} — parse the VERIFY model's verdict + grounded final
 *     answer.
 *
 * The runtime half (LLM calls, real source execution, tier routing) lives in
 * `data-agent-reasoning.ts` and consumes these functions. Grounding: an agentic
 * planner→act→verify loop on a reasoning tier (Azure OpenAI reasoning models).
 */

/** One ordered step of a reasoning plan: consult ONE source with a sub-query. */
export interface PlanStep {
  /** 1-based order (re-normalised by {@link sequenceSteps}). */
  step: number;
  /** Name of the attached source this step consults (matched leniently at run). */
  source: string;
  /** The concrete sub-question / sub-query to run for this step. */
  subQuery: string;
  /** Why this step is needed (optional, surfaced in the UI trace). */
  rationale?: string;
}

/** A parsed reasoning plan. */
export interface AgentPlan {
  steps: PlanStep[];
  /** The raw model text the plan was parsed from (for debugging / trace). */
  raw: string;
}

/** The verdict of the VERIFY pass over the executed step results. */
export type VerifyVerdict = 'pass' | 'partial' | 'fail';

/** Parsed VERIFY output: does the final answer follow from the step results? */
export interface VerifyResult {
  verdict: VerifyVerdict;
  reason: string;
  /** The final answer the verifier grounded ONLY in the real step results. */
  finalAnswer?: string;
  raw: string;
}

/** Hard cap on plan length — bounds latency + cost of the execute phase. */
export const MAX_PLAN_STEPS = 5;

// ── Trigger heuristics ───────────────────────────────────────────────────────

/**
 * Multi-hop signals: a question that must be decomposed into >1 grounded step.
 * Conjunctions / comparisons / per-dimension breakdowns / "then" dependencies,
 * OR two-plus explicit questions, OR a long compound prompt. Pure + explainable
 * (the learned decomposer is a later deepening).
 */
const MULTIHOP_RE =
  /\b(?:and then|then\b|after that|compare|comparison|versus|\bvs\.?\b|correlat|combine|join(?:ing|ed)?\b|both\b|as well as|followed by|for each|per\s+\w+|break\s?down\s+by|group(?:ed)?\s+by|trend|over time|by (?:region|month|quarter|year|category|product|customer|segment|department)|which .*\band\b|how (?:many|much) .*\band\b|difference between)\b/i;

/**
 * True when `question` reads as multi-hop and worth an explicit plan. A larger
 * number of attached sources lowers the bar (cross-source questions are the
 * canonical multi-hop case). Pure.
 */
export function isMultiHop(question: string, sourceCount = 1): boolean {
  const q = (question || '').trim();
  if (!q) return false;
  const questionMarks = (q.match(/\?/g) || []).length;
  if (questionMarks >= 2) return true;
  if (q.length > 180) return true;
  if (MULTIHOP_RE.test(q)) return true;
  // Two+ attached sources + a reasonably substantive question → likely spans them.
  if (sourceCount >= 2 && q.length > 60) return true;
  return false;
}

/**
 * Decide whether a turn earns the planner→execute→verify loop.
 *
 * Requires at least one attached source (nothing to execute against otherwise),
 * a `reasoning` task class when one is supplied (a simple/lightweight turn is
 * NEVER forced through the expensive loop), and a multi-hop-looking question.
 * Pure — the route classifies + counts sources and calls this.
 */
export function shouldPlan(
  question: string,
  opts: { taskClass?: string; sourceCount?: number } = {},
): boolean {
  const sourceCount = opts.sourceCount ?? 0;
  if (sourceCount < 1) return false;
  if (opts.taskClass && opts.taskClass !== 'reasoning') return false;
  return isMultiHop(question, sourceCount);
}

// ── Plan parsing ─────────────────────────────────────────────────────────────

/** Extract the LAST fenced ```json block's parsed object, else null. */
function lastJsonBlock(content: string): unknown {
  const blocks = [...String(content || '').matchAll(/```json\s*\n([\s\S]*?)```/gi)];
  const last = blocks[blocks.length - 1];
  const rawJson = last ? last[1] : undefined;
  // Fallback: a bare {...} / [...] with no fence (some models skip the fence).
  const candidate = rawJson ?? (String(content || '').match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/)?.[1]);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    return null;
  }
}

function toStr(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

/**
 * Parse a reasoning model's PLAN output into a {@link AgentPlan}. Accepts either
 * `{"plan":[{step,source,subQuery,rationale}]}` or a bare array of the same
 * shape. Tolerant of `sub_query` / `query` / `question` aliases and a missing
 * `step` (index order is used). Steps with no sub-query are dropped. Never
 * throws — a non-parseable response yields an empty plan (the caller then falls
 * back to a single grounded pass).
 */
export function parsePlan(content: string): AgentPlan {
  const obj = lastJsonBlock(content);
  const arr: unknown[] = Array.isArray(obj)
    ? obj
    : obj && typeof obj === 'object' && Array.isArray((obj as any).plan)
      ? (obj as any).plan
      : obj && typeof obj === 'object' && Array.isArray((obj as any).steps)
        ? (obj as any).steps
        : [];
  const steps: PlanStep[] = [];
  arr.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as Record<string, unknown>;
    const subQuery = toStr(r.subQuery ?? r.sub_query ?? r.query ?? r.question ?? r.task);
    if (!subQuery) return;
    const stepNum = Number.isFinite(Number(r.step)) ? Number(r.step) : i + 1;
    steps.push({
      step: stepNum,
      source: toStr(r.source ?? r.name ?? r.tool),
      subQuery,
      rationale: toStr(r.rationale ?? r.reason ?? r.why) || undefined,
    });
  });
  return { steps, raw: String(content || '') };
}

/**
 * Order, de-duplicate and cap a raw step list: sort by the model's `step`
 * ordinal (stable for ties), drop exact `source+subQuery` duplicates, cap at
 * {@link MAX_PLAN_STEPS}, and renumber sequentially from 1 so the trace is
 * clean. Pure.
 */
export function sequenceSteps(steps: PlanStep[]): PlanStep[] {
  const ordered = [...(steps || [])]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.step - b.s.step) || (a.i - b.i))
    .map(({ s }) => s);
  const seen = new Set<string>();
  const out: PlanStep[] = [];
  for (const s of ordered) {
    const key = `${s.source.toLowerCase()}::${s.subQuery.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...s, step: out.length + 1 });
    if (out.length >= MAX_PLAN_STEPS) break;
  }
  return out;
}

// ── Verify parsing ───────────────────────────────────────────────────────────

/** Coerce a free-form verdict token to the closed {@link VerifyVerdict} set. */
function normalizeVerdict(v: unknown): VerifyVerdict {
  const t = toStr(v).toLowerCase();
  if (/(^|\b)(pass|passed|correct|yes|true|verified|supported)(\b|$)/.test(t)) return 'pass';
  if (/(^|\b)(fail|failed|no|false|unsupported|insufficient|contradict)/.test(t)) return 'fail';
  return 'partial';
}

/**
 * Parse the VERIFY pass output into a {@link VerifyResult}. Accepts
 * `{"verdict":"pass|partial|fail","reason":"…","finalAnswer":"…"}` in a fenced
 * or bare JSON block. When no structured verdict can be parsed the result is an
 * honest `partial` (we never claim `pass` we couldn't read) and the whole model
 * text is used as the reason/answer. Never throws.
 */
export function parseVerify(content: string): VerifyResult {
  const obj = lastJsonBlock(content);
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const r = obj as Record<string, unknown>;
    if (r.verdict != null || r.reason != null || r.finalAnswer != null) {
      return {
        verdict: normalizeVerdict(r.verdict),
        reason: toStr(r.reason ?? r.explanation) || 'No reason given.',
        finalAnswer: toStr(r.finalAnswer ?? r.final_answer ?? r.answer) || undefined,
        raw: String(content || ''),
      };
    }
  }
  const text = String(content || '').trim();
  return {
    verdict: 'partial',
    reason: text ? 'Verifier returned unstructured output; treating as partial.' : 'No verification output.',
    finalAnswer: text || undefined,
    raw: text,
  };
}
