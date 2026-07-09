/**
 * prep-for-ai-model.ts — PURE, Cosmos-free shapes + normalizers for the
 * semantic-model "Prep for AI" surface (Fabric-parity G5).
 *
 * "Prep for AI" curates how a Loom-native semantic model is presented to a
 * data agent / Copilot:
 *   1. AI data schema  — which tables/columns are EXPOSED to AI (default-ON per
 *      loom_default_on_opt_out; an entry only appears here once a human hides
 *      something). This is distinct from a column's report-visibility isHidden.
 *   2. AI instructions — free-text grounding the agent applies for this model.
 *   3. Verified Answers — curated natural-language question → DAX pairs, each
 *      validated by actually running the DAX against the Azure-native tabular
 *      backend (Synapse serverless / opt-in AAS XMLA) — no Power BI / Fabric.
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md): every field here
 * persists Azure-native on the Cosmos item (`state.prepForAi`) and is consumed by
 * the Loom-native data-agent grounding path — there is NO Power BI "Prep for AI"
 * dependency and no fabricWorkspaceId gate. This module holds only pure logic so
 * it unit-tests without any Cosmos / Azure import.
 */

export interface AiColumnFlag {
  column: string;
  /** false = hidden from AI. Absent column entry = exposed (default-ON). */
  exposed: boolean;
}

export interface AiTableFlag {
  table: string;
  /** false = the whole table is hidden from AI. Absent table entry = exposed. */
  exposed: boolean;
  columns: AiColumnFlag[];
}

export interface VerifiedAnswer {
  id: string;
  question: string;
  /** DAX query (EVALUATE-form) that answers the question. */
  dax: string;
  /** Result of the most recent "Run to verify" against the real backend. */
  lastVerifiedAt?: string;
  lastVerifiedOk?: boolean;
  /** Human-readable outcome (row count on success; the honest gate/error on failure). */
  lastVerifiedNote?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PrepForAiState {
  aiInstructions: string;
  schema: AiTableFlag[];
  verifiedAnswers: VerifiedAnswer[];
}

export const EMPTY_PREP_FOR_AI: PrepForAiState = { aiInstructions: '', schema: [], verifiedAnswers: [] };

const MAX_INSTRUCTIONS = 15_000;
const MAX_QUESTION = 500;
const MAX_DAX = 8_000;
const MAX_ANSWERS = 200;
/** Model object name as returned in TMSL (letters/digits/space/underscore/dot/dash). */
const OBJECT_NAME = /^[A-Za-z0-9_. -]{1,200}$/;

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function genId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `va-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Coerce an unknown persisted blob into a well-formed PrepForAiState. */
export function normalizePrepForAi(raw: unknown): PrepForAiState {
  const r = (raw || {}) as Record<string, unknown>;
  return {
    aiInstructions: str(r.aiInstructions).slice(0, MAX_INSTRUCTIONS),
    schema: normalizeSchema(r.schema),
    verifiedAnswers: Array.isArray(r.verifiedAnswers)
      ? r.verifiedAnswers.map((a) => normalizeVerifiedAnswer(a)).filter((a): a is VerifiedAnswer => a !== null).slice(0, MAX_ANSWERS)
      : [],
  };
}

/** Validate/normalize the AI-schema expose flags (drops malformed entries). */
export function normalizeSchema(raw: unknown): AiTableFlag[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: AiTableFlag[] = [];
  for (const t of raw) {
    const tt = (t || {}) as Record<string, unknown>;
    const table = str(tt.table).trim();
    if (!table || !OBJECT_NAME.test(table) || seen.has(table)) continue;
    seen.add(table);
    const colsRaw = Array.isArray(tt.columns) ? tt.columns : [];
    const colSeen = new Set<string>();
    const columns: AiColumnFlag[] = [];
    for (const c of colsRaw) {
      const cc = (c || {}) as Record<string, unknown>;
      const column = str(cc.column).trim();
      if (!column || !OBJECT_NAME.test(column) || colSeen.has(column)) continue;
      colSeen.add(column);
      columns.push({ column, exposed: cc.exposed !== false });
    }
    out.push({ table, exposed: tt.exposed !== false, columns });
  }
  return out;
}

/** Normalize one verified-answer payload. Returns null when unusable. */
export function normalizeVerifiedAnswer(raw: unknown, now = new Date().toISOString()): VerifiedAnswer | null {
  const r = (raw || {}) as Record<string, unknown>;
  const question = str(r.question).trim().slice(0, MAX_QUESTION);
  const dax = str(r.dax).trim().slice(0, MAX_DAX);
  if (!question || !dax) return null;
  const id = str(r.id).trim() || genId();
  const lastVerifiedOk = typeof r.lastVerifiedOk === 'boolean' ? r.lastVerifiedOk : undefined;
  return {
    id,
    question,
    dax,
    lastVerifiedAt: str(r.lastVerifiedAt).trim() || undefined,
    lastVerifiedOk,
    lastVerifiedNote: str(r.lastVerifiedNote).trim().slice(0, 500) || undefined,
    createdAt: str(r.createdAt).trim() || now,
    updatedAt: now,
  };
}

/** Upsert a verified answer by id (preserves createdAt of the existing row). */
export function upsertVerifiedAnswer(state: PrepForAiState, answer: VerifiedAnswer): PrepForAiState {
  const existing = state.verifiedAnswers.find((a) => a.id === answer.id);
  const merged: VerifiedAnswer = existing ? { ...answer, createdAt: existing.createdAt } : answer;
  const verifiedAnswers = state.verifiedAnswers.filter((a) => a.id !== answer.id);
  verifiedAnswers.push(merged);
  return { ...state, verifiedAnswers: verifiedAnswers.slice(0, MAX_ANSWERS) };
}

/** Remove a verified answer by id. */
export function removeVerifiedAnswer(state: PrepForAiState, id: string): PrepForAiState {
  return { ...state, verifiedAnswers: state.verifiedAnswers.filter((a) => a.id !== id) };
}

/**
 * Convert curated Verified Answers into data-agent few-shot example pairs.
 * Includes any answer with a non-empty DAX that has NOT explicitly failed
 * verification (lastVerifiedOk === false) — so a curated-but-not-yet-run pair
 * still grounds the agent, while a pair proven wrong is excluded. Deduped by
 * question (case-insensitive).
 */
export function verifiedAnswersToExamples(
  answers: VerifiedAnswer[] | undefined,
): Array<{ question: string; query: string }> {
  if (!Array.isArray(answers)) return [];
  const out: Array<{ question: string; query: string }> = [];
  const seen = new Set<string>();
  for (const a of answers) {
    if (!a || !a.dax || !a.dax.trim() || !a.question || !a.question.trim()) continue;
    if (a.lastVerifiedOk === false) continue;
    const key = a.question.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ question: a.question.trim(), query: a.dax.trim() });
  }
  return out;
}

/**
 * Summarize the AI-exposed schema as a grounding sentence, ONLY when a human has
 * hidden something (any table exposed:false, or any column exposed:false).
 * Returns '' when nothing is hidden (the default-ON case adds no noise).
 */
export function exposedSchemaGrounding(schema: AiTableFlag[] | undefined): string {
  if (!Array.isArray(schema) || schema.length === 0) return '';
  const hiddenTables = schema.filter((t) => t.exposed === false).map((t) => t.table);
  const hiddenCols: string[] = [];
  for (const t of schema) {
    if (t.exposed === false) continue;
    for (const c of t.columns) if (c.exposed === false) hiddenCols.push(`${t.table}[${c.column}]`);
  }
  if (hiddenTables.length === 0 && hiddenCols.length === 0) return '';
  const parts: string[] = [];
  if (hiddenTables.length) parts.push(`Do NOT use these tables (hidden from AI): ${hiddenTables.join(', ')}.`);
  if (hiddenCols.length) parts.push(`Do NOT use these columns (hidden from AI): ${hiddenCols.join(', ')}.`);
  return parts.join(' ');
}

/**
 * Compose the full grounding text a data-agent semantic-model source should
 * carry, layering AI instructions + exposed-schema guidance onto the source's
 * existing per-source instructions. Pure — used by the consumption wiring.
 */
export function composeSourceGrounding(base: string, prep: PrepForAiState): string {
  const lines: string[] = [];
  if (base && base.trim()) lines.push(base.trim());
  if (prep.aiInstructions && prep.aiInstructions.trim()) {
    lines.push('## AI instructions (Prep for AI)');
    lines.push(prep.aiInstructions.trim());
  }
  const sg = exposedSchemaGrounding(prep.schema);
  if (sg) {
    lines.push('## AI-exposed schema (Prep for AI)');
    lines.push(sg);
  }
  return lines.join('\n\n');
}
