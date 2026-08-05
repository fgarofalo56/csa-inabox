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
// E6 — the tier-router eval calls the REAL router the aoai-chat-client hot path
// consults (routeTurnTier), imported from the shared console module (the same
// import azure-clients.ts uses for bestReasoningModelFor — the E2 "shared pure
// modules, import-both" rule; the router carries NO Azure-SDK/config-store dep,
// so this stays a pure, unit-testable import — no coupling replication).
import {
  routeTurnTier,
  MODEL_TIERS,
  TASK_CLASSES,
  type ModelTier,
  type TaskClass,
  type TierSelection,
  type TierPolicyConfigShape,
} from '../../../apps/fiab-console/lib/foundry/model-tier-router';

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
  /**
   * #2979 — is every capability the answer attributes to CSA Loom drawn from a
   * CSA-Loom-authoritative span? Independent of `grounding`, which a claim
   * copied out of the other product's inventory satisfies perfectly.
   *
   * OPTIONAL on purpose. A judge deployment that ignores the new rubric field
   * must not collapse every question into `judgeStatus: 'error'` — that would
   * null out `groundingAvg`, which the E3 gate treats as no-change, and the
   * gate would go green having measured nothing (the failure class this repo
   * keeps finding). When absent the run is scored on grounding alone and the
   * absence is COUNTED in `RunTotals.productFidelityJudged` so a receipt can
   * never quietly hide that the dimension was never returned.
   */
  productFidelity?: number;
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
  /**
   * #2979 — the answer lifted a distinctive span from a labelled other-product
   * (Fabric / Azure-portal inventory) excerpt and presented it as a CSA Loom
   * capability. A deterministic hard fail, ranked with `forbiddenHit`. Absent
   * on docs written before this field existed.
   */
  parityInversionHit?: boolean;
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

// ── Parity-doc provenance (#2979) ────────────────────────────────────────────
//
// WHY THIS SECTION EXISTS
// -----------------------
// A `docs/fiab/parity/*.md` describes TWO products (`.claude/rules/ui-parity.md`
// mandates the shape): a feature-inventory section stating what the OTHER
// product (Fabric / the Azure portal) does, followed by a `Loom coverage`
// section stating what CSA Loom actually does. An answer that lifts a row out
// of the inventory and reports it as a CSA Loom fact is FACTUALLY INVERTED —
// and the grounding judge passed it, because grounding asks "is this claim
// supported by the retrieved context?" and the sentence really is in there. The
// context simply describes a different product.
//
// The measured instance (#2979): `data-agent-013` asks whether tables can be
// picked from a schema tree. `docs/fiab/parity/data-agent.md` says, in its
// inventory, "Schema selection — a browsable schema tree to check specific
// Tables / Views / Functions"; six sections later its Loom-coverage table says
// "| 3 | Schema selection | ❌ | only a comma-separated `tables` text Input …
// no schema tree picker". The Copilot answered "Yes, a browsable schema tree"
// and the row counted as a PASS.
//
// WHAT WAS ACTUALLY BROKEN (the one-line finding)
// -----------------------------------------------
// The provenance signal was already present and was DISCARDED one call before
// the judge. #2969 gives every chunk a `"<title> › <section>"` breadcrumb, and
// the eval probe returns `{id, path, heading, kind, preview}` per chunk — but
// `azure-clients.probeConsole` mapped that to `String(c.preview)`, so
// `buildJudgeMessages` received bare prose with NO path and NO section. The
// judge was being asked to detect a two-product confusion while holding
// evidence stripped of the only labels that distinguish the two products. The
// ANSWER prompt (`lib/copilot/docs-grounding.renderDocExcerpts`) has always
// rendered `path — heading`; only the JUDGE was blind.
//
// LIMIT OF THE DETERMINISTIC LAYER — stated, not papered over
// -----------------------------------------------------------
// The breadcrumb is `title › innermost-heading`; the chunker (docs-chunker.ts)
// breaks on H1–H3 and keeps only the innermost. So an H3 UNDER an inventory H2
// (e.g. `### A. Data sources` under `## Real feature inventory` — exactly the
// data-agent-013 chunk) carries no inventory label. Measured over the corpus:
// 459 H3 sections across 469 parity docs, of which ~75 sit under a "real
// feature inventory" H2 but ~76 sit under Loom-side H2s (`Loom coverage`,
// `Backend per control`, `Build plan`, `Waves`). Guessing "unlabelled H3 in a
// parity doc ⇒ other product" would therefore mislabel roughly one in six —
// far too coarse to hard-fail on. So `unlabelled` is its OWN class: it is
// disclosed to the judge (which can read the prose and compare against the
// sibling Loom-coverage rows) and it NEVER triggers the deterministic verdict.
// Carrying the full ancestor path as a non-searchable chunk field would close
// that gap without touching ranking; it is a follow-up, deliberately not folded
// in here so this PR cannot move retrieval numbers.

/** Breadcrumb separator emitted by the corpus chunker (lib/azure/docs-chunker.ts). */
export const BREADCRUMB_SEP = ' › ';

/** Docs that describe two products side by side (`.claude/rules/ui-parity.md`). */
const COMPARISON_DOC_RE = /(?:^|\/)docs\/fiab\/parity\/[^/]+\.md$|-parity-spec\.md$/i;

/** Section headings that state what the OTHER product does. */
const OTHER_PRODUCT_SECTION_RE = /\binventor(?:y|ies)\b|\bsource ui\b/i;

/** Section headings that state what CSA Loom SHIPS today. */
const LOOM_SECTION_RE =
  /\bloom coverage\b|\bcoverage\b|\bbackend per control\b|\bverification\b|\bbicep\b|\bper-cloud\b|\btests?\b|\bgrade\b|\bfiles\b/i;

/** Section headings that state what CSA Loom PLANS to build (not shipped). */
const LOOM_PLAN_SECTION_RE = /\bbuild plan\b|\bwaves?\b|\bgaps? to build\b|\broadmap\b|\bbacklog\b/i;

/**
 * Provenance of one retrieved excerpt — which product its claims are about.
 *
 *   'other-product' — a labelled feature-inventory / source-UI section: what
 *                     Fabric or the Azure portal does. Background ONLY.
 *   'loom'          — a labelled Loom-coverage / backend / verification section:
 *                     authoritative about what CSA Loom ships.
 *   'loom-plan'     — a build-plan / waves section: PLANNED, not shipped.
 *   'mixed'         — one heading naming both sides (e.g. "Feature inventory →
 *                     Loom coverage → Backend per control").
 *   'unlabelled'    — a comparison doc whose section role is not determinable
 *                     from the breadcrumb (the H3-under-H2 case above).
 *   'general'       — not a comparison doc; ordinary CSA Loom documentation.
 */
export type ExcerptProvenance =
  | 'other-product'
  | 'loom'
  | 'loom-plan'
  | 'mixed'
  | 'unlabelled'
  | 'general';

/** One retrieved chunk as the judge sees it — path + breadcrumb + evidence text. */
export interface RetrievedExcerpt {
  /** Repo-root-relative corpus doc path (`docs/fiab/parity/data-agent.md`). */
  path: string;
  /** The #2969 `"<title> › <section>"` breadcrumb, when the chunk carries one. */
  heading?: string | null;
  /** The evidence slice — the SAME `EVIDENCE_CHARS` prefix the model answered from. */
  content: string;
}

/** The section half of a `"<title> › <section>"` breadcrumb (or the whole thing). */
export function excerptSection(heading?: string | null): string {
  const h = (heading || '').trim();
  if (!h) return '';
  const i = h.lastIndexOf(BREADCRUMB_SEP);
  return i >= 0 ? h.slice(i + BREADCRUMB_SEP.length).trim() : h;
}

/**
 * Classify which product an excerpt's claims are about.
 *
 * Deliberately conservative: a comparison-doc section that does not match a
 * known heading vocabulary is `'unlabelled'`, never guessed into
 * `'other-product'` (see the section header for the measured mislabel rate).
 */
export function classifyExcerptProvenance(e: Pick<RetrievedExcerpt, 'path' | 'heading'>): ExcerptProvenance {
  if (!COMPARISON_DOC_RE.test(String(e.path || ''))) return 'general';
  const section = excerptSection(e.heading);
  if (!section) return 'unlabelled';
  const other = OTHER_PRODUCT_SECTION_RE.test(section);
  const loom = LOOM_SECTION_RE.test(section) || LOOM_PLAN_SECTION_RE.test(section);
  if (other && loom) return 'mixed';
  if (other) return 'other-product';
  if (LOOM_PLAN_SECTION_RE.test(section)) return 'loom-plan';
  if (loom) return 'loom';
  return 'unlabelled';
}

/** Human-readable evidence label the judge keys on. */
const PROVENANCE_LABEL: Record<ExcerptProvenance, string> = {
  'other-product':
    'OTHER PRODUCT (Fabric / Azure portal feature inventory) — background only, NOT a statement about CSA Loom',
  loom: 'CSA LOOM — authoritative for what Loom ships today',
  'loom-plan': 'CSA LOOM ROADMAP — planned, NOT shipped; must not be reported as an existing capability',
  mixed: 'COMPARISON SECTION — contains both the other product\'s inventory and CSA Loom\'s coverage; read the row markers',
  unlabelled:
    'COMPARISON DOC, section role unlabelled — may describe EITHER product; verify against the CSA Loom coverage rows before treating it as a Loom fact',
  general: 'CSA LOOM documentation',
};

// ── Deterministic parity-inversion detector (#2979) ──────────────────────────

/** Word-shingle width for the borrowed-span test. */
const SHINGLE_N = 5;
/** Distinct other-product-only shingles that constitute an inversion. */
const MIN_BORROWED_SHINGLES = 2;

/**
 * Naming the other product is legitimate attribution, and per
 * `lib/copilot/docs-grounding` rule 2 an answer MAY describe an opt-in Fabric /
 * Power BI path. An answer that names it is therefore never a deterministic
 * inversion — it is attributed background, and the judge's `productFidelity`
 * dimension is what grades whether the attribution is correct.
 */
const ATTRIBUTION_RE = /\bfabric\b|\bpower\s*bi\b|\bonelake\b|\bmicrosoft graph\b/i;

/** Normalized word tokens (markdown syntax, punctuation and case removed). */
function tokens(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .replace(/[`*_~|#>[\]()]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** Distinct n-word shingles of `text`. */
function shingles(text: string, n: number = SHINGLE_N): Set<string> {
  const t = tokens(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(' '));
  return out;
}

/**
 * Deterministic backstop for the inversion class: did the answer lift a
 * distinctive span that exists ONLY in a labelled other-product excerpt, while
 * never naming the other product?
 *
 * Precision over recall, on purpose. It fires only when every one of these
 * holds, so it cannot punish a correct answer:
 *   1. a LABELLED `other-product` excerpt is in the retrieved context;
 *   2. the answer reproduces >= MIN_BORROWED_SHINGLES distinct 5-word spans
 *      from it that appear in NO other excerpt (so a span the Loom-coverage
 *      section also contains is never counted — that is shared vocabulary,
 *      not a borrowing);
 *   3. the answer never names the other product, i.e. it presents the borrowed
 *      capability as CSA Loom's own.
 *
 * Its blind spot is the `'unlabelled'` H3 case (see the section header); the
 * judge's `productFidelity` dimension covers that, and the golden negative rows
 * cover the specific capabilities that matter.
 */
export function detectParityInversion(input: {
  answer: string;
  excerpts: RetrievedExcerpt[];
}): { hit: boolean; borrowed: string[]; attributed: boolean } {
  const answer = String(input.answer || '');
  const excerpts = input.excerpts || [];
  const other = excerpts.filter((e) => classifyExcerptProvenance(e) === 'other-product');
  if (other.length === 0) return { hit: false, borrowed: [], attributed: false };

  const attributed = ATTRIBUTION_RE.test(answer);
  if (attributed) return { hit: false, borrowed: [], attributed: true };

  const otherShingles = new Set<string>();
  for (const e of other) for (const s of shingles(e.content)) otherShingles.add(s);
  const elsewhere = new Set<string>();
  for (const e of excerpts) {
    if (classifyExcerptProvenance(e) === 'other-product') continue;
    for (const s of shingles(e.content)) elsewhere.add(s);
  }

  const borrowed: string[] = [];
  for (const s of shingles(answer)) {
    if (otherShingles.has(s) && !elsewhere.has(s)) borrowed.push(s);
  }
  return { hit: borrowed.length >= MIN_BORROWED_SHINGLES, borrowed, attributed: false };
}

// ── LLM judge (grounding-fidelity rubric) ────────────────────────────────────

/** Render one excerpt as labelled evidence: index, provenance, path, breadcrumb, text. */
function renderJudgeExcerpt(e: RetrievedExcerpt, i: number): string {
  const provenance = classifyExcerptProvenance(e);
  const crumb = e.heading ? ` — ${e.heading}` : '';
  return `[${i + 1}] ${e.path}${crumb}\n    provenance: ${PROVENANCE_LABEL[provenance]}\n${e.content}`;
}

/**
 * Build the judge messages: grounding-fidelity rubric — grounding / relevance /
 * completeness / productFidelity each 1–5, strict-JSON reply. The judge sees the
 * retrieved excerpts (the ONLY permitted evidence), each one LABELLED with its
 * path, `<title> › <section>` breadcrumb and product provenance, plus the gold
 * answer and the model answer.
 *
 * `productFidelity` exists because grounding structurally cannot catch the
 * inversion class (#2979): a claim copied out of the Fabric inventory IS
 * supported by the retrieved context, so it scores 5 on grounding while being
 * false about CSA Loom. Grading "which product is this claim about?" as its own
 * dimension keeps grounding meaning what it says and gives the inversion its
 * own, independent failure channel.
 */
export function buildJudgeMessages(
  row: Pick<EvalRow, 'question' | 'expectedAnswer'>,
  answer: string,
  retrievedExcerpts: RetrievedExcerpt[],
): { role: 'system' | 'user'; content: string }[] {
  const excerpts = retrievedExcerpts.length
    ? retrievedExcerpts.map((e, i) => renderJudgeExcerpt(e, i)).join('\n\n')
    : '(no chunks were retrieved)';
  return [
    {
      role: 'system',
      content:
        'You are the CSA Loom Copilot answer judge. CSA Loom is an Azure-native analytics platform — ' +
        'NOT Microsoft Fabric; no feature requires a Fabric capacity or Power BI workspace (Fabric is strictly opt-in). ' +
        'Every question you grade is a question ABOUT CSA LOOM.\n\n' +
        'EVIDENCE PROVENANCE. Each excerpt is labelled with the product its claims are about. ' +
        'Excerpts from docs/fiab/parity/*.md and *-parity-spec.md compare CSA Loom against ANOTHER product: a ' +
        'feature-inventory or source-UI section states what that OTHER product does and is background only, while ' +
        'a "Loom coverage" / "Backend per control" section states what CSA Loom actually ships (rows marked ✅ built, ' +
        '⚠️ honest-gate, ❌ MISSING). A "build plan" / "waves" section is PLANNED work, not shipped. When an excerpt ' +
        'is labelled as unlabelled-role, decide which product it describes by checking it against the CSA Loom ' +
        'coverage rows before believing it about Loom.\n\n' +
        'Grade the candidate answer on a grounding-fidelity rubric, each dimension an integer 1–5:\n' +
        '  grounding       — every claim is supported by the retrieved excerpts (5 = fully grounded; 1 = fabricated).\n' +
        '  relevance       — the answer addresses the question asked (5 = direct; 1 = off-topic).\n' +
        '  completeness    — the answer covers what the reference answer covers (5 = complete; 1 = missing the point).\n' +
        '  productFidelity — every capability the answer attributes to CSA Loom is drawn from a CSA-Loom-authoritative ' +
        'span (5 = correct throughout). Score 1 when the answer reports the OTHER product\'s capability, or a ' +
        'planned/❌-MISSING capability, as something CSA Loom does today — even if that sentence appears verbatim in ' +
        'the excerpts. Describing the other product\'s behaviour AS the other product\'s, or describing an opt-in ' +
        'Fabric / Power BI integration the excerpts document, is correct and scores 5.\n\n' +
        'productFidelity is INDEPENDENT of grounding: a claim lifted from the other product\'s inventory is fully ' +
        'grounded and still wrong about CSA Loom. Do not raise productFidelity because the sentence is present in ' +
        'the context; that is exactly the failure this dimension exists to catch. ' +
        'Penalize grounding separately for any claim the excerpts do not support — especially any claim that ' +
        'Microsoft Fabric, a Fabric capacity, or a Power BI workspace is REQUIRED. ' +
        'Reply with STRICT JSON only: ' +
        '{"grounding":n,"relevance":n,"completeness":n,"productFidelity":n,"rationale":"one sentence"}.',
    },
    {
      role: 'user',
      content:
        `Question about CSA Loom:\n${row.question}\n\n` +
        `Retrieved excerpts (the only permitted evidence; each labelled with the product it describes):\n${excerpts}\n\n` +
        `Reference answer (the true CSA Loom answer):\n${row.expectedAnswer}\n\n` +
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
  // #2979: optional — see JudgeScores.productFidelity for why a missing value
  // is recorded as absent rather than turning the whole question into an error.
  const productFidelity = clampScore(obj.productFidelity);
  return {
    grounding,
    relevance,
    completeness,
    ...(productFidelity === undefined ? {} : { productFidelity }),
    rationale: String(obj.rationale || '').slice(0, 500),
  };
}

// ── Pass + run rollup ────────────────────────────────────────────────────────

/**
 * pass = retrievalHit && mentionPass && !forbiddenHit && !parityInversionHit
 *        && grounding≥4 && (productFidelity≥4 when the judge returned it).
 *
 * `parityInversionHit` is a DETERMINISTIC hard fail, ranked with `forbiddenHit`
 * rather than folded into the judge score: an answer that presents the other
 * product's capability as CSA Loom's is wrong about the product regardless of
 * how well it is grounded (#2979).
 *
 * A deferred/errored judge keeps the deterministic verdict (E3 treats deferred
 * as no-change — never a regression, never a fabricated pass on grounding), and
 * a judge that omitted `productFidelity` is scored on grounding alone; the
 * omission is counted in the rollup, not silently treated as a 5.
 */
export function computePass(r: {
  retrievalHit: boolean;
  mentionPass: boolean;
  forbiddenHit: boolean;
  parityInversionHit?: boolean;
  judgeStatus: EvalResult['judgeStatus'];
  judge?: JudgeScores;
}): boolean {
  const deterministic = r.retrievalHit && r.mentionPass && !r.forbiddenHit && !r.parityInversionHit;
  if (!deterministic) return false;
  if (r.judgeStatus === 'scored' && r.judge) {
    if (r.judge.grounding < 4) return false;
    if (r.judge.productFidelity !== undefined && r.judge.productFidelity < 4) return false;
    return true;
  }
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
  /**
   * #2979 — mean `productFidelity` over the judged questions that actually
   * RETURNED the dimension. `null` when the judge deployment never returned it
   * (see `productFidelityJudged`), which is the honest "not measured" value —
   * never a fabricated 5.
   */
  productFidelityAvg?: number | null;
  /**
   * #2979 — how many judged questions carried a `productFidelity` score. A run
   * with `judged > 0` and `productFidelityJudged === 0` means the judge
   * deployment ignored the rubric field entirely: the inversion channel measured
   * NOTHING that run, and the receipt says so instead of implying coverage.
   */
  productFidelityJudged?: number;
  /**
   * #2979 — questions the deterministic parity-inversion detector hard-failed
   * (the answer presented a labelled other-product capability as CSA Loom's).
   */
  parityInversions?: number;
  /**
   * Which retrieval backend actually answered, counted per question
   * (`{"ai-search": 15}`). Issue #2585: `backend` was captured on every
   * per-question doc but never rolled up, so the CI receipt could not say
   * whether a run was served by AI Search or the Cosmos fallback — and the
   * triage had to INFER it, which made the offline hit-rate model impossible to
   * anchor to a live number. Absent on legacy docs written before this field.
   */
  backends?: Record<string, number>;
  /**
   * How many golden rows this surface ATTEMPTED (its full set size). Issue
   * #2798: `questions` counts rows that produced a score, and rows whose probe
   * call failed were dropped silently — so a surface whose every probe failed
   * rolled up as `questions: 0, retrievalHitRate: 0`, a hard zero that reads
   * EXACTLY like "retrieval found nothing" and was diagnosed as such. With
   * `rowsAttempted` the receipt distinguishes measured-zero from not-measured.
   */
  rowsAttempted?: number;
  /**
   * Probe failures counted by HTTP status (`{"429": 118, "0": 6}`; 0 = a
   * transport/decode failure that never got a status). Same rationale as
   * `backends` (#2585): the CI receipt must SAY why a surface has no scores
   * instead of forcing the next triage to infer it.
   */
  probeErrors?: Record<string, number>;
}

/** Count per-question backends into the run rollup (`{}` when none reported). */
export function rollupBackends(results: Pick<EvalResult, 'backend'>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results) {
    const b = (r.backend || '').trim();
    if (!b) continue;
    out[b] = (out[b] || 0) + 1;
  }
  return out;
}

/**
 * Roll one surface's per-question results up into the `eval-run` totals.
 *
 * `probe` carries what the results array CANNOT: the rows that never produced a
 * result because their probe call failed (#2798). Omit it and the rollup is
 * byte-identical to the pre-#2798 shape.
 */
export function rollupRun(
  results: EvalResult[],
  probe?: { attempted?: number; errors?: Record<string, number> },
): RunTotals {
  const n = results.length;
  const probeInfo: Pick<RunTotals, 'rowsAttempted' | 'probeErrors'> = {};
  if (probe?.attempted !== undefined) probeInfo.rowsAttempted = probe.attempted;
  if (probe?.errors && Object.keys(probe.errors).length) probeInfo.probeErrors = { ...probe.errors };
  if (n === 0) {
    return {
      questions: 0, retrievalHitRate: 0, mrrAvg: 0, groundingAvg: null,
      answerAvg: null, passRate: 0, judged: 0, deferred: 0, autoFailed: 0,
      productFidelityAvg: null, productFidelityJudged: 0, parityInversions: 0,
      backends: {},
      ...probeInfo,
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
  // #2979 — averaged over the judged questions that actually RETURNED the
  // dimension. A judge that never returns it yields null + a zero count, which
  // reads as "not measured"; averaging over the full judged set instead would
  // silently score the missing ones and manufacture coverage that does not exist.
  const fidelityScores = judgedResults
    .map((r) => r.judge!.productFidelity)
    .filter((v): v is number => v !== undefined);
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
    productFidelityAvg: fidelityScores.length ? round3(avg(fidelityScores)) : null,
    productFidelityJudged: fidelityScores.length,
    parityInversions: results.filter((r) => r.parityInversionHit).length,
    backends: rollupBackends(results),
    ...probeInfo,
  };
}

// ── SRCH1 — federated-search relevance evals ─────────────────────────────────

/**
 * One golden federated-search query row (content/evals/search/<domain>.jsonl).
 * `expectedResults` are the item identifiers the /catalog federated search
 * SHOULD surface in its top-K — matched case-insensitively against each
 * returned result's qualified name / display name / id (substring either way,
 * so 'sales lakehouse' matches 'Demo · Sales · sales-lakehouse'). `k` caps the
 * ranking window (default 5).
 */
export interface SearchEvalRow {
  id: string;
  query: string;
  expectedResults: string[];
  k?: number;
}

export interface SearchEvalSet {
  domain: string;
  rows: SearchEvalRow[];
}

/**
 * Load federated-search golden sets from `<root>/search/<domain>.jsonl`. Same
 * strict-parse discipline as loadEvalSets — a malformed line throws. Files
 * starting with '_' (the schema/README) are skipped. `domains` filters.
 */
export function loadSearchEvalSets(fsRoot: string, domains?: string[]): SearchEvalSet[] {
  const dir = path.join(fsRoot, 'search');
  if (!fs.existsSync(dir)) return [];
  const wanted = domains?.map((s) => s.trim().toLowerCase()).filter(Boolean);
  const sets: SearchEvalSet[] = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.jsonl') || f.startsWith('_')) continue;
    const domain = path.basename(f, '.jsonl');
    if (wanted && wanted.length > 0 && !wanted.includes(domain)) continue;
    const lines = fs
      .readFileSync(path.join(dir, f), 'utf-8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const rows: SearchEvalRow[] = lines.map((l, i) => {
      let parsed: unknown;
      try { parsed = JSON.parse(l); } catch { throw new Error(`search/${f}:${i + 1}: invalid JSON`); }
      const r = parsed as SearchEvalRow;
      if (!r.id || !r.query || !Array.isArray(r.expectedResults) || r.expectedResults.length === 0) {
        throw new Error(`search/${f}:${i + 1}: row missing id/query/expectedResults`);
      }
      return { id: r.id, query: r.query, expectedResults: r.expectedResults, k: r.k };
    });
    if (rows.length > 0) sets.push({ domain, rows });
  }
  return sets;
}

/** Normalize a search identifier for matching (lower, trim, strip it:/it_ id prefix, collapse ws). */
export function normalizeSearchId(s: string): string {
  return (s || '').toLowerCase().replace(/^it[:_]/, '').replace(/\s+/g, ' ').trim();
}

/**
 * True when a golden `expected` identifier matches a `retrieved` result. The
 * retrieved side is the RICHER string (the runner joins qualifiedName |
 * displayName | id), so the match is directional: the retrieved result must
 * CONTAIN the full expected identifier (or equal it). A bidirectional substring
 * would false-positive on tiny tokens (any string contains a single letter).
 */
function idMatches(expected: string, retrieved: string): boolean {
  const e = normalizeSearchId(expected);
  const r = normalizeSearchId(retrieved);
  if (!e || !r) return false;
  return r === e || r.includes(e);
}

/**
 * Score one federated-search query: hit@k, MRR, and binary-relevance NDCG@k.
 *   - `retrieved` is the ordered list of returned result identifiers (each entry
 *     already flattened to one matchable string — the runner joins qualified
 *     name / display name so any of them can match).
 *   - hit  — ≥1 expected result appears in the top-k retrieved.
 *   - mrr  — reciprocal rank of the FIRST retrieved position matching any expected.
 *   - ndcg — DCG (rel=1 at a position matching a not-yet-credited expected) over
 *            the ideal DCG (all expected ranked first), @k. 0 when no expected.
 */
export function scoreSearchRelevance(
  expected: string[],
  retrieved: string[],
  k = 5,
): { hit: boolean; mrr: number; ndcg: number; matched: number } {
  const topK = retrieved.slice(0, Math.max(1, k));
  const exp = expected.filter(Boolean);
  if (exp.length === 0) return { hit: false, mrr: 0, ndcg: 0, matched: 0 };

  let firstHitRank = -1;
  let dcg = 0;
  let matched = 0;
  const credited = new Set<number>(); // expected indices already credited
  for (let i = 0; i < topK.length; i++) {
    // A position is relevant if it matches an expected result not yet credited.
    let rel = 0;
    for (let j = 0; j < exp.length; j++) {
      if (credited.has(j)) continue;
      if (idMatches(exp[j], topK[i])) { rel = 1; credited.add(j); matched += 1; break; }
    }
    if (rel === 1) {
      dcg += 1 / Math.log2(i + 2);
      if (firstHitRank < 0) firstHitRank = i;
    }
  }
  const ideal = Math.min(exp.length, topK.length);
  let idcg = 0;
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  const round3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    hit: firstHitRank >= 0,
    mrr: firstHitRank >= 0 ? round3(1 / (firstHitRank + 1)) : 0,
    ndcg: idcg > 0 ? round3(dcg / idcg) : 0,
    matched,
  };
}

/** Per-query scored search result (the `search-result` doc body). */
export interface SearchResult {
  queryId: string;
  domain: string;
  query: string;
  expectedResults: string[];
  retrieved: string[];
  hit: boolean;
  mrr: number;
  ndcg: number;
  matched: number;
  k: number;
  backend?: string;
  latencyMs: number;
}

export interface SearchRunTotals {
  queries: number;
  hitRate: number;
  mrrAvg: number;
  ndcgAvg: number;
}

/** Roll a domain's per-query search results up into the `search-run` totals. */
export function rollupSearchRun(results: SearchResult[]): SearchRunTotals {
  const n = results.length;
  if (n === 0) return { queries: 0, hitRate: 0, mrrAvg: 0, ndcgAvg: 0 };
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const round3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    queries: n,
    hitRate: round3(results.filter((r) => r.hit).length / n),
    mrrAvg: round3(avg(results.map((r) => r.mrr))),
    ndcgAvg: round3(avg(results.map((r) => r.ndcg))),
  };
}

// ── E6 — tier-router decision evals (cost-per-quality) ───────────────────────

/**
 * One labeled tier-routing row (content/evals/_tier-labels.jsonl). The REAL
 * router's decision for `prompt` is scored against `expectedTier` (the tier the
 * labeled `taskClass` maps to under DEFAULT_TASK_TIER_MAP). Azure-native — the
 * router is a pure Loom module, no Fabric/model dependency.
 */
export interface TierLabelRow {
  id: string;
  prompt: string;
  expectedTier: ModelTier;
  taskClass: TaskClass;
}

export interface TierLabelSet {
  rows: TierLabelRow[];
}

/**
 * Load the tier-label golden set from `<root>/_tier-labels.jsonl`. Unlike the
 * surface/search loaders (which deliberately SKIP '_'-prefixed files) this reads
 * the single '_'-prefixed label file by name, so the tier labels never leak into
 * an answer-quality run. Strict-parse: a malformed / invalid-enum line throws —
 * a broken label set fails loudly rather than silently scoring 0.
 */
export function loadTierLabels(fsRoot: string): TierLabelSet {
  const p = path.join(fsRoot, '_tier-labels.jsonl');
  if (!fs.existsSync(p)) return { rows: [] };
  const lines = fs
    .readFileSync(p, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const rows: TierLabelRow[] = lines.map((l, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(l);
    } catch {
      throw new Error(`_tier-labels.jsonl:${i + 1}: invalid JSON`);
    }
    const r = parsed as TierLabelRow;
    if (!r.prompt || !r.expectedTier || !r.taskClass) {
      throw new Error(`_tier-labels.jsonl:${i + 1}: row missing prompt/expectedTier/taskClass`);
    }
    if (!(MODEL_TIERS as readonly string[]).includes(r.expectedTier)) {
      throw new Error(`_tier-labels.jsonl:${i + 1}: invalid expectedTier '${r.expectedTier}'`);
    }
    if (!(TASK_CLASSES as readonly string[]).includes(r.taskClass)) {
      throw new Error(`_tier-labels.jsonl:${i + 1}: invalid taskClass '${r.taskClass}'`);
    }
    return {
      id: r.id || `tier-${String(i + 1).padStart(3, '0')}`,
      prompt: r.prompt,
      expectedTier: r.expectedTier,
      taskClass: r.taskClass,
    };
  });
  return { rows };
}

/**
 * A fully-wired synthetic tier policy: every tier resolves to a DISTINCT
 * placeholder deployment. This isolates the router's LOGICAL decision
 * (classifyTaskClass → DEFAULT_TASK_TIER_MAP) from deployment availability —
 * {@link selectTier} only collapses a desired tier to `standard` when that tier
 * has NO configured deployment, which would mask the routing decision the eval
 * verifies. The task-class → tier mapping is NOT overridden here, so the REAL
 * DEFAULT_TASK_TIER_MAP is exercised end-to-end.
 */
export const TIER_EVAL_CFG: TierPolicyConfigShape = {
  modelTierRoutingEnabled: true,
  modelTiers: { mini: 'eval-mini', standard: 'eval-standard', strong: 'eval-strong' },
};

/**
 * Run the REAL tier router over one labeled prompt. Calls the shared
 * {@link routeTurnTier} — the exact function the unified aoai-chat-client hot
 * path consults per turn — with the fully-wired synthetic policy above, so the
 * returned `.tier` is the router's honest classify→map decision.
 * `escalateOnly:false` so a lightweight→mini downshift is scored as-decided
 * rather than suppressed by the auto-path escalate-only guard (the guard only
 * affects the deployment/routed flag, never the reported tier — passing false is
 * explicit intent, not a behavior change).
 */
export function routeTierForPrompt(prompt: string): TierSelection {
  return routeTurnTier({
    cfg: TIER_EVAL_CFG,
    prompt,
    baseDeployment: 'eval-standard',
    escalateOnly: false,
  });
}

/** The score for ONE tier-routing decision. */
export interface TierDecisionScore {
  /** True when the router's ridden tier equals the labeled expected tier. */
  correct: boolean;
  chosenTier: ModelTier;
  expectedTier: ModelTier;
  taskClass: TaskClass;
  /** The task class the router itself classified the prompt into. */
  chosenTaskClass: TaskClass;
  /** True when the router's classification matches the labeled task class. */
  taskClassCorrect: boolean;
}

/**
 * Score one tier decision — PURE. It takes a precomputed {@link TierSelection}
 * (from {@link routeTierForPrompt}, i.e. the REAL routeTurnTier), so this
 * comparator has ZERO coupling to router internals and is exhaustively testable
 * without invoking the router. `correct` compares the ridden tier to the label.
 */
export function scoreTierDecision(row: TierLabelRow, selection: TierSelection): TierDecisionScore {
  return {
    correct: selection.tier === row.expectedTier,
    chosenTier: selection.tier,
    expectedTier: row.expectedTier,
    taskClass: row.taskClass,
    chosenTaskClass: selection.taskClass,
    taskClassCorrect: selection.taskClass === row.taskClass,
  };
}

/** A tier confusion matrix: matrix[expectedTier][chosenTier] = count. */
export type TierMatrix = Record<ModelTier, Record<ModelTier, number>>;

/** Per labeled task class: tier-decision accuracy. */
export interface TierPerClassStat {
  total: number;
  correct: number;
  accuracy: number;
}

/** The confusion + accuracy roll-up the tier-run doc carries. */
export interface TierConfusion {
  rows: number;
  /** Fraction of rows whose ridden tier equals the expected tier (0..1). */
  tierAccuracy: number;
  /** Fraction of rows whose classified task class equals the labeled one (0..1). */
  taskClassAccuracy: number;
  /** matrix[expectedTier][chosenTier] = count (row = truth, col = prediction). */
  matrix: TierMatrix;
  /** Per labeled task class: tier-decision accuracy. */
  perClass: Record<TaskClass, TierPerClassStat>;
}

/** An empty tier×tier matrix (every cell 0) — deterministic key order. */
function emptyTierMatrix(): TierMatrix {
  const m = {} as TierMatrix;
  for (const e of MODEL_TIERS) {
    m[e] = {} as Record<ModelTier, number>;
    for (const c of MODEL_TIERS) m[e][c] = 0;
  }
  return m;
}

/**
 * Reduce per-row tier scores into the confusion matrix + accuracy. Deterministic;
 * `round3` matches the surface/search rollups. An empty input yields zeroed
 * accuracy with a fully-zeroed matrix (never NaN).
 */
export function reduceTierConfusion(scores: TierDecisionScore[]): TierConfusion {
  const round3 = (x: number) => Math.round(x * 1000) / 1000;
  const matrix = emptyTierMatrix();
  const perClass = {} as Record<TaskClass, TierPerClassStat>;
  for (const tc of TASK_CLASSES) perClass[tc] = { total: 0, correct: 0, accuracy: 0 };
  let correct = 0;
  let taskClassCorrect = 0;
  for (const s of scores) {
    matrix[s.expectedTier][s.chosenTier] += 1;
    if (s.correct) correct += 1;
    if (s.taskClassCorrect) taskClassCorrect += 1;
    const pc = perClass[s.taskClass];
    pc.total += 1;
    if (s.correct) pc.correct += 1;
  }
  for (const tc of TASK_CLASSES) {
    const pc = perClass[tc];
    pc.accuracy = pc.total ? round3(pc.correct / pc.total) : 0;
  }
  const n = scores.length;
  return {
    rows: n,
    tierAccuracy: n ? round3(correct / n) : 0,
    taskClassAccuracy: n ? round3(taskClassCorrect / n) : 0,
    matrix,
    perClass,
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
