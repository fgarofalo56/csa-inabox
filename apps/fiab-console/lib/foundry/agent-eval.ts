/**
 * AIF-13 — agent eval scoring (pure). The eval route runs each prompt through
 * the agent (real Agent Service call), then asks an AOAI judge to score the
 * answer 1-5 against optional criteria. This module owns the pure pieces:
 * normalizing the structured prompt-set, building the judge prompt, and
 * aggregating scores — all unit-tested, no Azure calls.
 */

export interface EvalPrompt {
  prompt: string;
  /** Optional grading criteria for the judge (e.g. "cites a source"). */
  criteria?: string;
}

/** Hard cap so an eval run stays bounded (each prompt is a real agent run). */
export const MAX_EVAL_PROMPTS = 8;
export const DEFAULT_PASS_THRESHOLD = 4;

/**
 * Clean a structured prompt-set from the UI: trim, drop empty rows, cap length,
 * and cap count. NEVER a freeform JSON blob — the UI authors these as rows.
 */
export function normalizePromptSet(rows: EvalPrompt[] | undefined | null): EvalPrompt[] {
  return (rows || [])
    .map((r) => ({
      prompt: String(r?.prompt ?? '').trim(),
      criteria: r?.criteria ? String(r.criteria).trim() : undefined,
    }))
    .filter((r) => r.prompt.length > 0)
    .slice(0, MAX_EVAL_PROMPTS);
}

export interface JudgeMessage { role: 'system' | 'user'; content: string }

/**
 * Build the judge chat messages that score one agent answer 1-5. The judge is
 * instructed to return STRICT JSON {score:1-5, rationale} so the route can parse
 * it with aoaiChatJson.
 */
export function buildJudgePrompt(input: { prompt: string; criteria?: string; answer: string }): JudgeMessage[] {
  const criteriaLine = input.criteria
    ? `Grading criteria: ${input.criteria}`
    : 'Grading criteria: overall correctness, relevance, and helpfulness of the answer to the question.';
  return [
    {
      role: 'system',
      content:
        'You are a strict evaluation judge for an AI agent. Score the agent ANSWER to the ' +
        'QUESTION on an integer scale of 1 (poor) to 5 (excellent) against the grading criteria. ' +
        'Return STRICT JSON {"score": <1-5 integer>, "rationale": "<one sentence>"} and nothing else.',
    },
    {
      role: 'user',
      content: `QUESTION:\n${input.prompt}\n\n${criteriaLine}\n\nAGENT ANSWER:\n${input.answer || '(no answer produced)'}`,
    },
  ];
}

/** Clamp a judge score into the integer 1-5 range; 0 signals "unscored". */
export function clampScore(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') return 0;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 0;
  return Math.min(5, Math.max(1, n));
}

export interface ScoredRow { score: number; status?: string }

export interface EvalSummary {
  total: number;
  scored: number;
  /** Mean over scored (>0) rows, 2dp; 0 when none scored. */
  avgScore: number;
  /** Rows with score >= threshold / total, 4dp; 0 when no rows. */
  passRate: number;
  passThreshold: number;
}

const round = (n: number, dp: number): number => Number(n.toFixed(dp));

/** Aggregate a scored eval run into avg score + pass rate. */
export function summarizeEval(rows: ScoredRow[], passThreshold = DEFAULT_PASS_THRESHOLD): EvalSummary {
  const total = rows.length;
  const scoredRows = rows.filter((r) => r.score > 0);
  const scored = scoredRows.length;
  const avgScore = scored ? round(scoredRows.reduce((a, r) => a + r.score, 0) / scored, 2) : 0;
  const passed = rows.filter((r) => r.score >= passThreshold).length;
  return {
    total,
    scored,
    avgScore,
    passRate: total ? round(passed / total, 4) : 0,
    passThreshold,
  };
}
