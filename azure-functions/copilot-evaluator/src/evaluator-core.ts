/**
 * copilot-evaluator — pure core (no Azure SDK, fully unit-testable).
 *
 * E2 (PRPs/active/loom-next-level/ws-copilot-cost.md): the runtime that
 * executes the E1 golden eval sets (content/evals/<surface>.jsonl) against the
 * REAL Copilot retrieval + AOAI path and writes scored results to Cosmos
 * (`loom-copilot-evals`, PK /surface).
 *
 * Mirrors azure-functions/ops-agent-evaluator: this module holds every
 * decision/scoring function PURE; the thin timer/HTTP wrappers
 * (functions/copilotEvaluator*.ts) wire the real Azure data-plane
 * (console eval-probe HTTP call, AOAI judge, Cosmos writes) around it.
 *
 * Azure-native, no Microsoft Fabric dependency
 * (.claude/rules/no-fabric-dependency.md) — the judge rubric + the E1
 * mustNotMention guards actively ASSERT answers never claim a Fabric
 * capacity is required.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── E1 eval-set row (content/evals/_schema.json) ─────────────────────────────

/** One golden Q/A row from content/evals/<surface>.jsonl (E1 schema). */
export interface EvalRow {
  id: string;
  question: string;
  /** Corpus doc paths (repo-root-relative, optional '#anchor') the retriever SHOULD surface. */
  expectedChunks: string[];
  expectedAnswer: string;
  /** Deterministic grounding guard — case-insensitive substrings the answer MUST contain. */
  mustMention: string[];
  /** Deterministic anti-hallucination guard — substrings the answer must NOT contain. */
  mustNotMention: string[];
  tier: 'mini' | 'standard' | 'strong';
  taskClass: 'lightweight' | 'general' | 'reasoning';
}

export interface EvalSet {
  surface: string;
  rows: EvalRow[];
}

/** What the console's internal eval-probe route returns for one question. */
export interface ProbeResult {
  retrievedChunks: string[];
  answer: string;
  tier: string;
  taskClass?: string;
  backend?: string;
  latencyMs: number;
}

/** LLM-judge grounding-fidelity scores (each 1–5). */
export interface JudgeScores {
  grounding: number;
  relevance: number;
  completeness: number;
  rationale: string;
}

/** Per-question scored result (the Cosmos `eval-result` doc body). */
export interface EvalResult {
  questionId: string;
  surface: string;
  retrievalHit: boolean;
  mrr: number;
  mentionPass: boolean;
  forbiddenHit: boolean;
  /** 'scored' — judged; 'deferred' — daily judge cap reached (retrieval-only,
   *  E3 treats deferred as no-change); 'auto-fail' — forbidden phrase, no judge
   *  spend; 'error' — the judge call failed. */
  judgeStatus: 'scored' | 'deferred' | 'auto-fail' | 'error';
  judge?: JudgeScores;
  pass: boolean;
  latencyMs: number;
  backend?: string;
}

// ── Config gates (honest, no-vaporware) ──────────────────────────────────────

/**
 * Config gate — returns the missing env vars (empty ⇒ fully configured).
 * LOOM_EVAL_PROBE_URL is the console base URL the probe route lives under;
 * LOOM_INTERNAL_TOKEN authenticates the machine-to-machine probe call;
 * LOOM_AOAI_ENDPOINT + a resolvable judge deployment power the LLM judge
 * (judge-less runs still score retrieval — see resolveJudgeDeployment).
 */
export function missingConfig(env: Record<string, string | undefined>): string[] {
  const missing: string[] = [];
  if (!env.LOOM_COSMOS_ENDPOINT) missing.push('LOOM_COSMOS_ENDPOINT');
  if (!env.LOOM_EVAL_PROBE_URL) missing.push('LOOM_EVAL_PROBE_URL');
  if (!env.LOOM_INTERNAL_TOKEN) missing.push('LOOM_INTERNAL_TOKEN');
  return missing;
}

/** Default-ON / opt-out (loom_default_on_opt_out): only an explicit 'false' disables. */
export function evalEnabled(env: Record<string, string | undefined>): boolean {
  return (env.LOOM_COPILOT_EVAL_ENABLED || '').trim().toLowerCase() !== 'false';
}

/**
 * Judge deployment resolution chain (spec E2 env contract):
 *   LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT → LOOM_AOAI_STRONG_DEPLOYMENT
 *   → LOOM_AOAI_MINI_DEPLOYMENT → LOOM_AOAI_DEPLOYMENT.
 * NO model name is ever hardcoded here — the values are deployment names wired
 * by bicep from the per-cloud availability matrix (bestReasoningModelFor).
 * Returns undefined when nothing resolves → the run is retrieval-only with an
 * honest gate log naming the exact vars.
 */
export function resolveJudgeDeployment(env: Record<string, string | undefined>): string | undefined {
  for (const name of [
    'LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT',
    'LOOM_AOAI_STRONG_DEPLOYMENT',
    'LOOM_AOAI_MINI_DEPLOYMENT',
    'LOOM_AOAI_DEPLOYMENT',
  ]) {
    const v = (env[name] || '').trim();
    if (v) return v;
  }
  return undefined;
}

// ── Judge-token daily cap (round-3 F1) ───────────────────────────────────────

/** LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP (default 500 judged Q/day; ≤0 → unlimited off switch is NOT provided — the floor is 1). */
export function judgeDailyCap(env: Record<string, string | undefined>): number {
  const raw = Number((env.LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP || '').trim());
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return 500;
}

/**
 * The cap decision for ONE question, evaluated AFTER the deterministic guards:
 *   - a forbidden phrase → 'auto-fail' (never spends a judge call);
 *   - no judge deployment → 'deferred' (honest judge-less posture);
 *   - cap exhausted → 'deferred' (retrieval-only; E3 treats deferred as no-change);
 *   - otherwise → 'judge' (spend one call).
 */
export function judgeDecision(input: {
  forbiddenHit: boolean;
  judgeDeployment: string | undefined;
  judgedToday: number;
  cap: number;
}): 'auto-fail' | 'deferred' | 'judge' {
  if (input.forbiddenHit) return 'auto-fail';
  if (!input.judgeDeployment) return 'deferred';
  if (input.judgedToday >= input.cap) return 'deferred';
  return 'judge';
}

/** UTC day key for the judge-spend ledger doc (one doc per day). */
export function judgeLedgerDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ── Eval-set loading (E1 JSONL) ──────────────────────────────────────────────

/**
 * Load eval sets from a staged evals dir (one <surface>.jsonl per surface;
 * files starting with '_' — _schema.json, _tier-labels — are not surfaces).
 * `surfaces` filters to a subset; unknown names are ignored (reported by the
 * caller). Malformed lines throw — a broken eval set must fail loudly, not
 * silently score 0.
 */
export function loadEvalSets(fsRoot: string, surfaces?: string[]): EvalSet[] {
  if (!fs.existsSync(fsRoot)) return [];
  const wanted = surfaces?.map((s) => s.trim().toLowerCase()).filter(Boolean);
  const sets: EvalSet[] = [];
  for (const f of fs.readdirSync(fsRoot).sort()) {
    if (!f.endsWith('.jsonl') || f.startsWith('_')) continue;
    const surface = path.basename(f, '.jsonl');
    if (wanted && wanted.length > 0 && !wanted.includes(surface)) continue;
    const lines = fs
      .readFileSync(path.join(fsRoot, f), 'utf-8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const rows: EvalRow[] = lines.map((l, i) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(l);
      } catch {
        throw new Error(`${f}:${i + 1}: invalid JSON`);
      }
      const r = parsed as EvalRow;
      if (!r.id || !r.question || !Array.isArray(r.expectedChunks) || r.expectedChunks.length === 0) {
        throw new Error(`${f}:${i + 1}: row missing id/question/expectedChunks`);
      }
      return {
        ...r,
        mustMention: Array.isArray(r.mustMention) ? r.mustMention : [],
        mustNotMention: Array.isArray(r.mustNotMention) ? r.mustNotMention : [],
      };
    });
    if (rows.length > 0) sets.push({ surface, rows });
  }
  return sets;
}

// ── Retrieval scoring (hit + MRR) ────────────────────────────────────────────

/** Normalize a chunk id to its doc path (strip '#anchor', trim, lower). */
export function chunkPath(id: string): string {
  return (id || '').split('#')[0].trim().toLowerCase().replace(/\\/g, '/');
}

/**
 * Retrieval score for one question:
 *   hit — ≥1 expected chunk's doc path appears among the retrieved chunk paths;
 *   mrr — mean reciprocal rank across expected chunks (1/rank of each expected
 *         chunk's first appearance in the retrieved list, 0 when absent).
 * Anchor fragments are advisory (retrieval returns doc-level chunks) — matching
 * is on the doc path.
 */
export function scoreRetrieval(
  expectedChunks: string[],
  retrievedChunks: string[],
): { hit: boolean; mrr: number } {
  const retrieved = retrievedChunks.map(chunkPath);
  const expected = expectedChunks.map(chunkPath).filter(Boolean);
  if (expected.length === 0) return { hit: false, mrr: 0 };
  let rrSum = 0;
  let hit = false;
  for (const exp of expected) {
    const rank = retrieved.findIndex((r) => r === exp);
    if (rank >= 0) {
      hit = true;
      rrSum += 1 / (rank + 1);
    }
  }
  return { hit, mrr: rrSum / expected.length };
}

// ── Deterministic guards (gate BEFORE the judge — no judge spend on a hit) ───

/**
 * mustMention / mustNotMention checks, case-insensitive substring semantics
 * (the E1 schema contract). A forbidden phrase (`forbiddenHit`) is an
 * auto-fail: it encodes the no-fabric-dependency / no-vaporware rules as
 * assertions and MUST short-circuit the judge (no token spend).
 */
export function deterministicGuards(
  answer: string,
  row: Pick<EvalRow, 'mustMention' | 'mustNotMention'>,
): { mentionPass: boolean; forbiddenHit: boolean; missingMentions: string[]; forbiddenPhrases: string[] } {
  const a = (answer || '').toLowerCase();
  const missingMentions = (row.mustMention || []).filter((m) => !a.includes(m.toLowerCase()));
  const forbiddenPhrases = (row.mustNotMention || []).filter((m) => a.includes(m.toLowerCase()));
  return {
    mentionPass: missingMentions.length === 0,
    forbiddenHit: forbiddenPhrases.length > 0,
    missingMentions,
    forbiddenPhrases,
  };
}

// ── LLM judge (grounding-fidelity rubric) ────────────────────────────────────

/**
 * Build the judge messages: grounding-fidelity rubric — grounding / relevance /
 * completeness each 1–5, strict-JSON reply. The judge sees the retrieved
 * excerpts (the ONLY permitted evidence), the gold answer, and the model
 * answer. The system prompt bakes in the platform ground truth so a judge
 * never rewards a Fabric-dependency hallucination.
 */
export function buildJudgeMessages(
  row: Pick<EvalRow, 'question' | 'expectedAnswer'>,
  answer: string,
  retrievedExcerpts: string[],
): { role: 'system' | 'user'; content: string }[] {
  const excerpts = retrievedExcerpts.length
    ? retrievedExcerpts.map((e, i) => `[${i + 1}] ${e}`).join('\n')
    : '(no chunks were retrieved)';
  return [
    {
      role: 'system',
      content:
        'You are the CSA Loom Copilot answer judge. CSA Loom is an Azure-native analytics platform — ' +
        'NOT Microsoft Fabric; no feature requires a Fabric capacity or Power BI workspace (Fabric is strictly opt-in). ' +
        'Grade the candidate answer on a grounding-fidelity rubric, each dimension an integer 1–5:\n' +
        '  grounding    — every claim is supported by the retrieved excerpts (5 = fully grounded; 1 = fabricated).\n' +
        '  relevance    — the answer addresses the question asked (5 = direct; 1 = off-topic).\n' +
        '  completeness — the answer covers what the reference answer covers (5 = complete; 1 = missing the point).\n' +
        'Penalize grounding for any claim the excerpts do not support — especially any claim that Microsoft Fabric, ' +
        'a Fabric capacity, or a Power BI workspace is required. ' +
        'Reply with STRICT JSON only: {"grounding":n,"relevance":n,"completeness":n,"rationale":"one sentence"}.',
    },
    {
      role: 'user',
      content:
        `Question:\n${row.question}\n\n` +
        `Retrieved excerpts (the only permitted evidence):\n${excerpts}\n\n` +
        `Reference answer:\n${row.expectedAnswer}\n\n` +
        `Candidate answer to grade:\n${answer}`,
    },
  ];
}

/** Clamp to an integer 1–5 (a judge that returns 0/6/floats is normalized, not trusted). */
function clampScore(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(5, Math.max(1, Math.round(n)));
}

/**
 * Parse the judge reply (tolerating ```json fences + surrounding prose).
 * Returns null when no usable scores can be extracted — the caller records
 * judgeStatus 'error', never a fabricated score.
 */
export function parseJudge(text: string): JudgeScores | null {
  const cleaned = (text || '')
    .replace(/^\s*```[a-zA-Z0-9_+-]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        obj = JSON.parse(cleaned.slice(first, last + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  if (!obj) return null;
  const grounding = clampScore(obj.grounding);
  const relevance = clampScore(obj.relevance);
  const completeness = clampScore(obj.completeness);
  if (grounding === undefined || relevance === undefined || completeness === undefined) return null;
  return { grounding, relevance, completeness, rationale: String(obj.rationale || '').slice(0, 500) };
}

// ── Pass + run rollup ────────────────────────────────────────────────────────

/**
 * pass = retrievalHit && mentionPass && !forbiddenHit && grounding≥4 (spec).
 * A deferred/errored judge keeps the deterministic verdict (E3 treats deferred
 * as no-change — never a regression, never a fabricated pass on grounding).
 */
export function computePass(r: {
  retrievalHit: boolean;
  mentionPass: boolean;
  forbiddenHit: boolean;
  judgeStatus: EvalResult['judgeStatus'];
  judge?: JudgeScores;
}): boolean {
  const deterministic = r.retrievalHit && r.mentionPass && !r.forbiddenHit;
  if (!deterministic) return false;
  if (r.judgeStatus === 'scored' && r.judge) return r.judge.grounding >= 4;
  return true; // deferred / error: deterministic-only verdict (judge no-change)
}

export interface RunTotals {
  questions: number;
  retrievalHitRate: number;
  mrrAvg: number;
  groundingAvg: number | null;
  answerAvg: number | null;
  passRate: number;
  judged: number;
  deferred: number;
  autoFailed: number;
}

/** Roll one surface's per-question results up into the `eval-run` totals. */
export function rollupRun(results: EvalResult[]): RunTotals {
  const n = results.length;
  if (n === 0) {
    return {
      questions: 0, retrievalHitRate: 0, mrrAvg: 0, groundingAvg: null,
      answerAvg: null, passRate: 0, judged: 0, deferred: 0, autoFailed: 0,
    };
  }
  const judgedResults = results.filter((r) => r.judgeStatus === 'scored' && r.judge);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const round3 = (x: number) => Math.round(x * 1000) / 1000;
  const groundingAvg = judgedResults.length
    ? round3(avg(judgedResults.map((r) => r.judge!.grounding)))
    : null;
  const answerAvg = judgedResults.length
    ? round3(avg(judgedResults.map((r) => (r.judge!.grounding + r.judge!.relevance + r.judge!.completeness) / 3)))
    : null;
  return {
    questions: n,
    retrievalHitRate: round3(results.filter((r) => r.retrievalHit).length / n),
    mrrAvg: round3(avg(results.map((r) => r.mrr))),
    groundingAvg,
    answerAvg,
    passRate: round3(results.filter((r) => r.pass).length / n),
    judged: judgedResults.length,
    deferred: results.filter((r) => r.judgeStatus === 'deferred').length,
    autoFailed: results.filter((r) => r.judgeStatus === 'auto-fail').length,
  };
}

/** Candidate locations for the staged eval sets, first hit wins:
 *  1. <cwd>/evals                       — the deployed Function package (deploy copies content/evals here);
 *  2. <cwd>/copilot-corpus/evals        — the console-image layout (stage-copilot-corpus.sh);
 *  3. <repo>/content/evals walking up   — a repo checkout (local run / CI). */
export function resolveEvalRoot(cwd: string): string | null {
  const direct = path.join(cwd, 'evals');
  if (fs.existsSync(direct)) return direct;
  const staged = path.join(cwd, 'copilot-corpus', 'evals');
  if (fs.existsSync(staged)) return staged;
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'content', 'evals');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
