/**
 * Spindle eval suite runner (Palantir AIP-Logic AIP-Evals equivalent).
 *
 * An eval suite is a set of TYPED test cases authored as UI rows (never a JSON
 * blob): each case supplies concrete `inputs` for the function plus a natural
 * `criteria` describing what a correct output looks like. Running the suite:
 *
 *   1. Executes the REAL typed block graph (`runBlockGraph`) for each case —
 *      live Azure OpenAI + Synapse, no mock.
 *   2. Grades each output 1–5 with an LLM judge (`aoaiChatJson` +
 *      `buildJudgePrompt`), reusing the WS-1.4 agent-eval scoring module.
 *   3. Summarises pass-rate / avg-score (`summarizeEval`).
 *
 * The publish-as-REST route calls this INLINE as an evals-in-CI gate: publish is
 * blocked unless the attached suite passes. 100% Azure-native (AOAI) — Gov-safe,
 * no Fabric. Honest gate bubbles up when no AOAI deployment is configured.
 */
import { runBlockGraph, type AipSettings } from './_block-graph';
import { aoaiChatJson, NoAoaiDeploymentError } from '@/lib/azure/aoai-chat-client';
import {
  buildJudgePrompt, clampScore, summarizeEval,
  DEFAULT_PASS_THRESHOLD, MAX_EVAL_PROMPTS,
  type EvalSummary,
} from '@/lib/foundry/agent-eval';

/** One authored eval case: concrete inputs + the grading criteria. */
export interface SpindleEvalCase {
  id?: string;
  name?: string;
  inputs?: Record<string, unknown>;
  criteria?: string;
}

/** Per-case result after running + judging. */
export interface SpindleEvalRow {
  id?: string;
  name?: string;
  inputs?: Record<string, unknown>;
  criteria?: string;
  answer: string;
  score: number;          // 0 = unscored, else 1–5
  rationale?: string;
  status: 'pass' | 'fail' | 'error' | 'gate';
  error?: string;
}

export interface SpindleEvalResult {
  ok: boolean;
  summary: EvalSummary;
  rows: SpindleEvalRow[];
  passed: boolean;        // gate verdict (passRate ≥ minPassRate AND ≥ 1 case)
  passThreshold: number;
  minPassRate: number;
  notDeployed?: boolean;  // honest AOAI gate hit
  ranAt: string;
}

/** Normalise the persisted suite to at most MAX_EVAL_PROMPTS well-formed cases. */
export function normalizeEvalSuite(raw: unknown): SpindleEvalCase[] {
  if (!Array.isArray(raw)) return [];
  const out: SpindleEvalCase[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    const criteria = typeof row.criteria === 'string' ? row.criteria.trim() : '';
    const inputs = row.inputs && typeof row.inputs === 'object' ? (row.inputs as Record<string, unknown>) : {};
    if (!criteria) continue; // a case with no criteria cannot be graded
    out.push({
      id: typeof row.id === 'string' ? row.id : undefined,
      name: typeof row.name === 'string' ? row.name : undefined,
      inputs, criteria,
    });
    if (out.length >= MAX_EVAL_PROMPTS) break;
  }
  return out;
}

/**
 * Run the attached eval suite against the function's persisted block graph.
 * Pure w.r.t. persistence (caller decides whether/where to store the result).
 */
export async function runSpindleEvalSuite(
  state: Record<string, unknown>,
  tenantId: string,
): Promise<SpindleEvalResult> {
  const settings = (state.settings || {}) as AipSettings;
  const passThreshold = clampThreshold(settings.evalThreshold, DEFAULT_PASS_THRESHOLD);
  const minPassRate = clampRate(settings.minPassRate, 1);
  const cases = normalizeEvalSuite(state.evalSuite);
  const ranAt = new Date().toISOString();

  const rows: SpindleEvalRow[] = [];
  let notDeployed = false;

  for (const c of cases) {
    const base: SpindleEvalRow = { id: c.id, name: c.name, inputs: c.inputs, criteria: c.criteria, answer: '', score: 0, status: 'error' };
    // 1) Run the REAL block graph for this case's inputs.
    let answer = '';
    try {
      const run = await runBlockGraph(state, c.inputs || {}, tenantId);
      if (!run.ok) {
        if (run.notDeployed) { notDeployed = true; rows.push({ ...base, status: 'gate', error: run.gate?.remediation || run.error || 'AOAI not configured' }); continue; }
        rows.push({ ...base, status: 'error', error: run.error || 'block graph failed', answer: String(run.output || '') });
        continue;
      }
      answer = String(run.output || '');
    } catch (e) {
      if (e instanceof NoAoaiDeploymentError) { notDeployed = true; rows.push({ ...base, status: 'gate', error: e.message }); continue; }
      rows.push({ ...base, status: 'error', error: e instanceof Error ? e.message : String(e) });
      continue;
    }

    // 2) Grade the output with the LLM judge (reuses WS-1.4 agent-eval scoring).
    try {
      const judgeMessages = buildJudgePrompt({ prompt: c.name || JSON.stringify(c.inputs || {}), criteria: c.criteria, answer });
      const verdict = await aoaiChatJson<{ score?: unknown; rationale?: unknown }>({ messages: judgeMessages });
      const score = clampScore(verdict?.score);
      const rationale = typeof verdict?.rationale === 'string' ? verdict.rationale : undefined;
      rows.push({ ...base, answer, score, rationale, status: score >= passThreshold ? 'pass' : 'fail' });
    } catch (e) {
      if (e instanceof NoAoaiDeploymentError) { notDeployed = true; rows.push({ ...base, answer, status: 'gate', error: e.message }); continue; }
      rows.push({ ...base, answer, status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  const summary = summarizeEval(rows.map((r) => ({ score: r.score, status: r.status })), passThreshold);
  const passed = summary.total > 0 && summary.passRate >= minPassRate && !notDeployed;
  return { ok: !notDeployed, summary, rows, passed, passThreshold, minPassRate, notDeployed: notDeployed || undefined, ranAt };
}

function clampThreshold(v: unknown, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n) : dflt;
}
function clampRate(v: unknown, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : dflt;
}
