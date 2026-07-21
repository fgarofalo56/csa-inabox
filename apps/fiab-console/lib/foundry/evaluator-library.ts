/**
 * WS-1.5 — Built-in evaluator library (pure, unit-tested).
 *
 * Provides TYPED ENUM evaluators (never freeform config):
 *   • groundedness    — answer is grounded in provided context/sources
 *   • relevance       — answer addresses the question asked
 *   • tool-call-accuracy — agent invoked the right tools with correct args
 *   • task-adherence  — agent followed the task instructions end-to-end
 *
 * Each evaluator exposes:
 *   • buildEvaluatorPrompt() — chat messages for the AOAI LLM judge
 *   • EVALUATOR_META          — display label, description, scoring rubric
 *   • clusterFailures()       — keyword-frequency clustering of failing rows
 *
 * All logic is pure (no Azure calls) — fully unit-testable.
 * The AOAI judge call is the caller's (route's) responsibility, reusing aoaiChatJson.
 *
 * See .claude/rules/no-vaporware.md, loom-no-freeform-config.md.
 */

import type { JudgeMessage } from './agent-eval';

// ── Evaluator enum ────────────────────────────────────────────────────────────

/**
 * The four built-in evaluator types (typed enum — never a freeform string).
 * Maps to the mlflow.evaluate-style evaluator names.
 */
export type EvaluatorType =
  | 'groundedness'
  | 'relevance'
  | 'tool-call-accuracy'
  | 'task-adherence';

export const EVALUATOR_TYPES: readonly EvaluatorType[] = [
  'groundedness',
  'relevance',
  'tool-call-accuracy',
  'task-adherence',
] as const;

export interface EvaluatorMeta {
  type: EvaluatorType;
  label: string;
  description: string;
  /** What a score of 1 vs 5 means for this dimension. */
  rubricSummary: string;
}

/** Display metadata for each built-in evaluator. */
export const EVALUATOR_META: Record<EvaluatorType, EvaluatorMeta> = {
  groundedness: {
    type: 'groundedness',
    label: 'Groundedness',
    description: 'Measures whether the answer is supported by the provided context / sources.',
    rubricSummary: '1 = hallucinated / contradicts context · 5 = fully grounded with citations',
  },
  relevance: {
    type: 'relevance',
    label: 'Relevance',
    description: 'Measures how well the answer addresses the question asked.',
    rubricSummary: '1 = off-topic or tangential · 5 = directly and completely answers the question',
  },
  'tool-call-accuracy': {
    type: 'tool-call-accuracy',
    label: 'Tool-call accuracy',
    description: 'Measures whether the agent invoked the right tools with correct arguments.',
    rubricSummary: '1 = wrong tool or bad args · 5 = correct tools, correct args, right order',
  },
  'task-adherence': {
    type: 'task-adherence',
    label: 'Task adherence',
    description: 'Measures whether the agent followed the task instructions end-to-end.',
    rubricSummary: '1 = ignored instructions · 5 = completed all instruction steps correctly',
  },
};

// ── Judge prompt builders ─────────────────────────────────────────────────────

export interface EvaluatorPromptInput {
  evaluatorType: EvaluatorType;
  question: string;
  answer: string;
  /** Required for `groundedness` — the context / retrieved documents. */
  context?: string;
  /** Required for `tool-call-accuracy` — serialized tool-call log. */
  toolCalls?: string;
  /** Optional task instructions for `task-adherence`. */
  instructions?: string;
}

/** System prompt fragment shared by all evaluators. */
const JUDGE_SYSTEM_PREFIX =
  'You are a strict, impartial LLM evaluation judge for a data agent. ' +
  'Score the ANSWER on the integer scale 1 (very poor) to 5 (excellent) for the dimension below. ' +
  'Return STRICT JSON {"score": <1-5 integer>, "rationale": "<1-3 sentences>"} and nothing else. ' +
  'Do not include markdown fences or any text outside the JSON object.';

function groundednessPrompt(input: EvaluatorPromptInput): JudgeMessage[] {
  const ctx = input.context
    ? `CONTEXT / RETRIEVED SOURCES:\n${input.context}`
    : 'CONTEXT: (none provided — penalise heavily if the answer references facts not in the question)';
  return [
    {
      role: 'system',
      content:
        `${JUDGE_SYSTEM_PREFIX}\n\nDIMENSION: Groundedness — the answer must be supported by the context, ` +
        'must not hallucinate facts absent from the context, and must not contradict the context. ' +
        '1 = hallucinated or contradicts context · 3 = partially supported · 5 = fully grounded.',
    },
    {
      role: 'user',
      content: `QUESTION:\n${input.question}\n\n${ctx}\n\nAGENT ANSWER:\n${input.answer || '(no answer)'}`,
    },
  ];
}

function relevancePrompt(input: EvaluatorPromptInput): JudgeMessage[] {
  return [
    {
      role: 'system',
      content:
        `${JUDGE_SYSTEM_PREFIX}\n\nDIMENSION: Relevance — the answer must directly address the question. ` +
        '1 = completely off-topic · 3 = partially relevant · 5 = fully on-target, no superfluous content.',
    },
    {
      role: 'user',
      content: `QUESTION:\n${input.question}\n\nAGENT ANSWER:\n${input.answer || '(no answer)'}`,
    },
  ];
}

function toolCallAccuracyPrompt(input: EvaluatorPromptInput): JudgeMessage[] {
  const log = input.toolCalls
    ? `TOOL-CALL LOG:\n${input.toolCalls}`
    : 'TOOL-CALL LOG: (none provided — if the question required tool use, penalise accordingly)';
  return [
    {
      role: 'system',
      content:
        `${JUDGE_SYSTEM_PREFIX}\n\nDIMENSION: Tool-call accuracy — the agent must invoke the RIGHT tools ` +
        'with CORRECT arguments in the RIGHT order to satisfy the task. ' +
        '1 = wrong tool / bad args · 3 = partially correct · 5 = perfect tool selection, correct args, correct order.',
    },
    {
      role: 'user',
      content: `QUESTION:\n${input.question}\n\n${log}\n\nFINAL AGENT ANSWER:\n${input.answer || '(no answer)'}`,
    },
  ];
}

function taskAdherencePrompt(input: EvaluatorPromptInput): JudgeMessage[] {
  const instr = input.instructions
    ? `TASK INSTRUCTIONS:\n${input.instructions}`
    : 'TASK INSTRUCTIONS: (none specified — score on overall task completeness)';
  return [
    {
      role: 'system',
      content:
        `${JUDGE_SYSTEM_PREFIX}\n\nDIMENSION: Task adherence — the agent must follow ALL task instructions ` +
        'and complete every requested step. ' +
        '1 = ignored instructions / missed the task · 3 = partially followed · 5 = all steps completed correctly.',
    },
    {
      role: 'user',
      content: `QUESTION:\n${input.question}\n\n${instr}\n\nAGENT ANSWER:\n${input.answer || '(no answer)'}`,
    },
  ];
}

/**
 * Build the judge chat messages for a given evaluator type.
 * Returns exactly 2 messages: [system, user].
 */
export function buildEvaluatorPrompt(input: EvaluatorPromptInput): JudgeMessage[] {
  switch (input.evaluatorType) {
    case 'groundedness':        return groundednessPrompt(input);
    case 'relevance':           return relevancePrompt(input);
    case 'tool-call-accuracy':  return toolCallAccuracyPrompt(input);
    case 'task-adherence':      return taskAdherencePrompt(input);
    default: {
      const _exhaustive: never = input.evaluatorType;
      throw new Error(`Unknown evaluatorType: ${_exhaustive}`);
    }
  }
}

// ── One-click judge result ────────────────────────────────────────────────────

export interface JudgeScoreResult {
  evaluatorType: EvaluatorType;
  /** Integer 1-5 (0 = unscored / judge failed). */
  score: number;
  rationale: string;
  /** ISO timestamp of scoring. */
  scoredAt: string;
}

/** Parse a raw AOAI judge JSON response into a typed score result. */
export function parseJudgeResponse(
  raw: Record<string, unknown>,
  evaluatorType: EvaluatorType,
): JudgeScoreResult {
  const rawScore = raw?.score ?? raw?.Score;
  const n = Math.round(Number(rawScore));
  const score = Number.isFinite(n) && n >= 1 && n <= 5 ? n : 0;
  const rationale = String(raw?.rationale ?? raw?.Rationale ?? '').slice(0, 500) || '(no rationale)';
  return { evaluatorType, score, rationale, scoredAt: new Date().toISOString() };
}

// ── Multi-evaluator batch result ──────────────────────────────────────────────

export interface BatchEvalResult {
  question: string;
  answer: string;
  scores: JudgeScoreResult[];
  /** Mean score across all scored (>0) dimensions (0 when none scored). */
  avgScore: number;
}

/** Aggregate per-evaluator score results into a batch summary. */
export function summarizeBatchEval(
  question: string,
  answer: string,
  scores: JudgeScoreResult[],
): BatchEvalResult {
  const scored = scores.filter((s) => s.score > 0);
  const avgScore = scored.length
    ? Number((scored.reduce((a, s) => a + s.score, 0) / scored.length).toFixed(2))
    : 0;
  return { question, answer, scores, avgScore };
}

// ── Failure cluster analysis ──────────────────────────────────────────────────

export interface FailureCluster {
  /** Representative theme label derived from the dominant keyword. */
  theme: string;
  /** Number of failing rows in this cluster. */
  count: number;
  /** A sample of failing prompts (up to 3). */
  samples: string[];
  /** Evaluator types that contributed to this cluster's failures. */
  evaluatorTypes: EvaluatorType[];
}

/** A failing row for cluster input. */
export interface FailingRow {
  prompt: string;
  evaluatorType?: EvaluatorType;
  score: number;
  rationale?: string;
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'it', 'in', 'on', 'of', 'to', 'for', 'and',
  'or', 'but', 'with', 'from', 'at', 'by', 'as', 'be', 'was', 'are',
  'this', 'that', 'what', 'how', 'why', 'when', 'where', 'which',
  'do', 'does', 'did', 'get', 'has', 'have', 'had', 'not', 'no', 'yes',
  'can', 'will', 'would', 'should', 'could', 'may', 'might', 'shall',
]);

/** Tokenise a prompt to lowercase alpha words, filtering stop words. */
function keywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Keyword-frequency cluster of failing eval rows.
 *
 * Groups failing rows by their most frequent shared keyword (a lightweight
 * stand-in for k-means topic clustering that runs synchronously without an
 * Azure call). Up to `maxClusters` theme clusters + one catch-all.
 *
 * Clusters are returned sorted by count (largest first) — the Admin surface
 * shows the most prevalent failure themes at the top.
 */
export function clusterFailures(rows: FailingRow[], maxClusters = 6): FailureCluster[] {
  if (!rows || rows.length === 0) return [];

  // Build a keyword frequency map across all failing prompts.
  const freq = new Map<string, number>();
  for (const r of rows) {
    for (const kw of keywords(r.prompt)) {
      freq.set(kw, (freq.get(kw) || 0) + 1);
    }
  }

  // Pick the top N keywords by frequency as cluster centres.
  const centres = [...freq.entries()]
    .sort((a, z) => z[1] - a[1])
    .slice(0, maxClusters)
    .map(([kw]) => kw);

  if (centres.length === 0) {
    return [{
      theme: '(uncategorised)',
      count: rows.length,
      samples: rows.slice(0, 3).map((r) => r.prompt.slice(0, 120)),
      evaluatorTypes: [...new Set(rows.map((r) => r.evaluatorType).filter((t): t is EvaluatorType => !!t))],
    }];
  }

  // Assign each row to the first cluster whose centre keyword appears in it.
  const clusterMap = new Map<string, FailingRow[]>();
  for (const c of centres) clusterMap.set(c, []);
  const uncategorised: FailingRow[] = [];

  for (const r of rows) {
    const kws = new Set(keywords(r.prompt));
    const match = centres.find((c) => kws.has(c));
    if (match) clusterMap.get(match)!.push(r);
    else uncategorised.push(r);
  }

  const clusters: FailureCluster[] = [];
  for (const [theme, members] of clusterMap.entries()) {
    if (members.length === 0) continue;
    clusters.push({
      theme,
      count: members.length,
      samples: members.slice(0, 3).map((r) => r.prompt.slice(0, 120)),
      evaluatorTypes: [...new Set(members.map((r) => r.evaluatorType).filter((t): t is EvaluatorType => !!t))],
    });
  }
  if (uncategorised.length > 0) {
    clusters.push({
      theme: '(uncategorised)',
      count: uncategorised.length,
      samples: uncategorised.slice(0, 3).map((r) => r.prompt.slice(0, 120)),
      evaluatorTypes: [...new Set(uncategorised.map((r) => r.evaluatorType).filter((t): t is EvaluatorType => !!t))],
    });
  }

  return clusters.sort((a, z) => z.count - a.count);
}
