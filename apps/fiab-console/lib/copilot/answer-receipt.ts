/**
 * N10 — Answer Receipt assembler.
 *
 * Every agentic Copilot answer earns a RECEIPT: the plan the loop followed, the
 * exact SQL / KQL / Cypher / Gremlin / DAX it executed with real row counts, the
 * grounding sources + graph paths + metrics it used, which model TIER answered,
 * the token cost, the per-phase timings, and a Verified ✓ / Unverified ⚠ /
 * Refused ⛔ badge. For a CDO/auditor this is the buy signal; in an IL5 / air-gap
 * boundary the receipt IS the compliance artifact (see the IL5 note at the foot).
 *
 * This is ASSEMBLY, not invention. It composes signals Loom already produces:
 *   • turn-trace.ts   → per-turn plan steps + raw tool_call/tool_result steps
 *   • tool-citations  → grounding sources (Citation shape) already on the trace
 *   • phase-timer.ts  → per-phase ms (classify / prompt-build / llm / tools)
 *   • cost-estimate   → the $ estimate already computed onto the final step
 *   • the verify verdict → N9's Verified-Query-Result signal (VQR)
 *
 * The Verified ✓ tier is gated behind an OPTIONAL verification signal that does
 * NOT exist on this branch yet (N9's VQR lands AFTER this item). Absent that
 * signal the badge renders Unverified ⚠ — and it lights up automatically, with
 * zero rework, the moment a `verification` field appears on the final step (a
 * pure field check, no code path change). Refused ⛔ renders when the loop
 * refused (a content-safety / guardrail / egress block). Everything else is
 * Unverified ⚠.
 *
 * Pure + defensive: reads only REAL trace fields, never fabricates. Any missing
 * or malformed input degrades gracefully (empty arrays / undefined), never
 * throws — an assembler hiccup must never break an answer.
 */

import type { PhaseTiming } from './phase-timer';

/** The three receipt verdicts, rendered as ✓ / ⚠ / ⛔. */
export type ReceiptVerdict = 'verified' | 'unverified' | 'refused';

/** Query dialect a tool executed. `query` = a recognizable query we can't dialect-tag. */
export type QueryLanguage = 'sql' | 'kql' | 'cypher' | 'gremlin' | 'gql' | 'dax' | 'query';

/** One exact query the loop executed against a real backend + its row count. */
export interface ReceiptQuery {
  /** Tool that ran the query (e.g. 'warehouse_run_query', 'kql_execute'). */
  tool: string;
  language: QueryLanguage;
  /** The EXACT query text the model sent (never paraphrased). */
  text: string;
  /** Rows returned (from the tool result's rowCount or rows.length), when known. */
  rowCount?: number;
  ok: boolean;
  durationMs?: number;
  error?: string;
}

/** A grounding source the answer cited (docs / schema / memory / knowledge). */
export interface ReceiptSource {
  id: string;
  path: string;
  kind: string;
  heading?: string;
  url?: string;
}

/** One tool invocation rolled into the receipt (name · server · timing · status). */
export interface ReceiptTool {
  name: string;
  serverName?: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}

/**
 * N9's Verified-Query-Result signal (VQR) — the optional field this receipt
 * gates Verified ✓ behind. ABSENT on this branch; defined here so the badge
 * lights automatically once N9 stamps it onto the final step. `verdict:
 * 'verified'` is the only value that earns the ✓.
 */
export interface VerificationSignal {
  verdict?: 'verified' | 'unverified';
  /** The Verified-Answer / curated-query id the answer matched (surfaced in the receipt). */
  verifiedAnswerId?: string;
  /** How it was verified (e.g. 'verified-answers', 'query-replay'). */
  method?: string;
  /** Similarity / confidence score, when the verifier reports one. */
  score?: number;
  /** The canonical question the answer matched, when reported. */
  matchedQuestion?: string;
}

/** The assembled, render-ready + persist-ready receipt for ONE agentic answer. */
export interface AnswerReceipt {
  /** The persisted Cosmos doc id — set once the receipt is persisted. */
  id?: string;
  /** The user prompt that produced this answer. */
  prompt: string;
  /** The plan the loop narrated (reasoning `thought` steps; the prompt seed is dropped). */
  planSteps: string[];
  /** Exact SQL/KQL/Cypher/Gremlin/DAX executed, with row counts. */
  queries: ReceiptQuery[];
  /** Grounding sources the answer cited. */
  sources: ReceiptSource[];
  /** Total rows/paths returned by graph queries (cypher/gremlin/gql) — the graph paths used. */
  graphPaths: number;
  /** Distinct semantic-model measures / metrics the answer probed, when the trace exposes them. */
  metrics: string[];
  /** Every tool the loop called. */
  tools: ReceiptTool[];
  /** Per-phase wall-clock ms (classify / prompt-build / llm / tools). */
  phaseTimings: PhaseTiming[];
  /** End-to-end turn latency ms (falls back to the sum of phase timings). */
  totalMs?: number;
  /** Deployment/model that answered. */
  model?: string;
  /** Which routing tier answered (mini / standard / strong). */
  modelTier?: string;
  /** The classified task class for the turn (lightweight / general / reasoning). */
  taskClass?: string;
  /** Real token counts (never estimated). */
  tokens: { prompt?: number; completion?: number; total?: number };
  /** Estimated USD (list price over the REAL token counts). */
  costUsd?: number;
  /** The badge: ✓ verified / ⚠ unverified / ⛔ refused. */
  verdict: ReceiptVerdict;
  /** Convenience mirrors of {@link verdict}. */
  verified: boolean;
  refused: boolean;
  /** Why the loop refused, when it did (content-safety / guardrail reason). */
  refusalReason?: string;
  /** N9's VQR signal, when present. */
  verification?: VerificationSignal;
  /** ISO timestamp the receipt was assembled. */
  createdAt: string;
}

/**
 * Trace-shaped input the assembler reads. {@link TurnTrace} (turn-trace.ts)
 * satisfies this structurally; the orchestrator and the client transcript build
 * the same shape from their in-scope signals. Every field is optional so a thin
 * turn (no tools, no cost) still assembles a valid receipt.
 */
export interface ReceiptTraceLike {
  prompt?: string;
  /** Raw per-turn steps (thought / tool_call / tool_result / final / error). */
  steps?: Array<Record<string, unknown>>;
  model?: string;
  modelTier?: string;
  taskClass?: string;
  routedTier?: string;
  usage?: Record<string, number>;
  costUsd?: number;
  /** turn-trace names it `latencyMs`; the final step names it `turnLatencyMs`. Either works. */
  latencyMs?: number;
  turnLatencyMs?: number;
  phaseTimings?: PhaseTiming[];
  citations?: Array<Record<string, unknown>>;
  /** Pre-rolled tool detail (carries serverName); falls back to steps when absent. */
  tools?: Array<{ name?: unknown; serverName?: unknown; durationMs?: unknown; ok?: unknown; error?: unknown }>;
  /** Terminal error message for the turn, when any. */
  error?: string;
}

export interface AssembleReceiptOptions {
  /** The persisted Cosmos doc id, threaded back so the receipt surfaces its own id. */
  receiptId?: string;
  /** Explicit verification signal (N9). Overrides any signal found on the final step. */
  verification?: VerificationSignal;
  /** Deterministic timestamp (tests); defaults to now. */
  createdAt?: string;
}

// ── Helpers (all pure, all defensive) ────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Query-arg keys we recognize, in priority order → the base dialect. */
const QUERY_ARG_KEYS: ReadonlyArray<readonly [string, QueryLanguage]> = [
  ['kql', 'kql'],
  ['cypher', 'cypher'],
  ['gremlin', 'gremlin'],
  ['gql', 'gql'],
  ['dax', 'dax'],
  ['sql', 'sql'],
  ['expression', 'dax'],
  ['query', 'query'],
];

/** Graph dialects — their row counts are graph PATHS traversed. */
const GRAPH_LANGS = new Set<QueryLanguage>(['cypher', 'gremlin', 'gql']);

/**
 * Resolve the dialect from the tool name first (authoritative — a DAX tool
 * passes its expression under an `sql` arg), then the matched arg key.
 */
function resolveLanguage(toolName: string, argLang: QueryLanguage): QueryLanguage {
  const t = toolName.toLowerCase();
  if (/dax/.test(t)) return 'dax';
  if (/kql|kusto|adx/.test(t)) return 'kql';
  if (/gremlin/.test(t)) return 'gremlin';
  if (/cypher/.test(t)) return 'cypher';
  if (/\bgql\b|graph_query|graphql/.test(t)) return 'gql';
  if (/\b(sql|warehouse|lakehouse|tsql|synapse)\b/.test(t)) return argLang === 'query' ? 'sql' : argLang;
  return argLang;
}

/** Pull the first recognizable query string + its base dialect out of tool args. */
function queryFromArgs(args: unknown): { text: string; lang: QueryLanguage } | null {
  if (!isRecord(args)) return null;
  for (const [key, lang] of QUERY_ARG_KEYS) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return { text: v, lang };
  }
  return null;
}

/** Row count from a tool result: explicit rowCount, else rows/paths array length. */
function rowCountFromResult(result: unknown): number | undefined {
  if (!isRecord(result)) return undefined;
  const rc = num(result.rowCount);
  if (rc !== undefined) return rc;
  if (Array.isArray(result.rows)) return result.rows.length;
  if (Array.isArray(result.paths)) return result.paths.length;
  return undefined;
}

/** Distinct metric/measure names a tool result (or DAX arg) surfaced. */
function metricsFromResult(result: unknown, acc: Set<string>): void {
  if (!isRecord(result)) return;
  const one = result.measure ?? result.metric;
  if (typeof one === 'string' && one.trim()) acc.add(one.trim());
  for (const key of ['measures', 'metrics'] as const) {
    const arr = result[key];
    if (Array.isArray(arr)) {
      for (const m of arr) {
        if (typeof m === 'string' && m.trim()) acc.add(m.trim());
        else if (isRecord(m) && typeof m.name === 'string' && m.name.trim()) acc.add(m.name.trim());
      }
    }
  }
}

/** Codes / messages that mark a REFUSAL (vs. a transient failure). */
const REFUSAL_CODE = /content_safety|guardrail|shield|egress|refus|blocked|policy/i;
const REFUSAL_MSG = /refus|blocked by|content safety|guardrail|not permitted|policy (violation|block)|air-?gap/i;

/** Detect a refusal from the trace's error step / terminal error. */
function detectRefusal(t: ReceiptTraceLike): { refused: boolean; reason?: string } {
  const steps = Array.isArray(t.steps) ? t.steps : [];
  for (const s of steps) {
    if (isRecord(s) && s.kind === 'error') {
      const code = str(s.code);
      const msg = str(s.error);
      if (REFUSAL_CODE.test(code) || REFUSAL_MSG.test(msg)) return { refused: true, reason: msg || code };
    }
  }
  if (t.error && REFUSAL_MSG.test(t.error)) return { refused: true, reason: t.error };
  return { refused: false };
}

/** The verification signal N9 will stamp onto the final step (absent today). */
function verificationFromSteps(steps: Array<Record<string, unknown>> | undefined): VerificationSignal | undefined {
  if (!Array.isArray(steps)) return undefined;
  const final = steps.find((s) => isRecord(s) && s.kind === 'final');
  const v = final && isRecord(final) ? (final as Record<string, unknown>).verification : undefined;
  if (isRecord(v)) {
    const verdict = v.verdict === 'verified' || v.verdict === 'unverified' ? v.verdict : undefined;
    return {
      verdict,
      verifiedAnswerId: v.verifiedAnswerId ? str(v.verifiedAnswerId) : undefined,
      method: v.method ? str(v.method) : undefined,
      score: num(v.score),
      matchedQuestion: v.matchedQuestion ? str(v.matchedQuestion) : undefined,
    };
  }
  return undefined;
}

/** Map a trace citation (Citation shape) to a ReceiptSource. */
function sourceFromCitation(c: Record<string, unknown>): ReceiptSource | null {
  const id = str(c.id) || str(c.path);
  if (!id) return null;
  return {
    id,
    path: str(c.path) || id,
    kind: str(c.kind) || 'source',
    heading: c.heading ? str(c.heading) : undefined,
    url: c.url ? str(c.url) : undefined,
  };
}

/** Derive the tool roll-up from the trace's pre-rolled tools or its raw steps. */
function toolsFrom(t: ReceiptTraceLike): ReceiptTool[] {
  if (Array.isArray(t.tools) && t.tools.length) {
    return t.tools.map((x) => ({
      name: str(x.name),
      serverName: x.serverName ? str(x.serverName) : undefined,
      durationMs: num(x.durationMs) ?? 0,
      ok: x.ok !== false,
      error: x.error ? str(x.error) : undefined,
    }));
  }
  const steps = Array.isArray(t.steps) ? t.steps : [];
  return steps
    .filter((s) => isRecord(s) && s.kind === 'tool_result')
    .map((s) => ({
      name: str(s.name),
      durationMs: num(s.durationMs) ?? 0,
      ok: !s.error,
      error: s.error ? str(s.error) : undefined,
    }));
}

/**
 * Assemble the receipt for one agentic answer. Pure — reads only real trace
 * fields, degrades gracefully, never throws.
 */
export function assembleAnswerReceipt(
  t: ReceiptTraceLike,
  opts: AssembleReceiptOptions = {},
): AnswerReceipt {
  const steps = (Array.isArray(t.steps) ? t.steps : []).filter(isRecord);

  // Plan steps: reasoning `thought` narration, minus the "User prompt:" seed.
  const planSteps = steps
    .filter((s) => s.kind === 'thought')
    .map((s) => str(s.content).trim())
    .filter((c) => c && !/^User prompt:/i.test(c));

  // Queries: pair each tool_call carrying a query arg with its tool_result by callId.
  const resultByCall = new Map<string, Record<string, unknown>>();
  for (const s of steps) {
    if (s.kind === 'tool_result') {
      const id = str(s.callId);
      if (id) resultByCall.set(id, s);
    }
  }
  const queries: ReceiptQuery[] = [];
  const metricNames = new Set<string>();
  let graphPaths = 0;
  for (const s of steps) {
    if (s.kind === 'tool_result') metricsFromResult(s.result, metricNames);
    if (s.kind !== 'tool_call') continue;
    const q = queryFromArgs(s.args);
    if (!q) continue;
    const tool = str(s.name);
    const language = resolveLanguage(tool, q.lang);
    const res = resultByCall.get(str(s.callId));
    const rowCount = res ? rowCountFromResult(res.result) : undefined;
    const error = res && res.error ? str(res.error) : undefined;
    const durationMs = res ? num(res.durationMs) : undefined;
    if (GRAPH_LANGS.has(language) && typeof rowCount === 'number') graphPaths += rowCount;
    queries.push({ tool, language, text: q.text, rowCount, ok: !error, durationMs, error });
  }

  // Sources: de-duplicate mapped citations by id.
  const sources: ReceiptSource[] = [];
  const seenSource = new Set<string>();
  for (const c of Array.isArray(t.citations) ? t.citations : []) {
    if (!isRecord(c)) continue;
    const src = sourceFromCitation(c);
    if (src && !seenSource.has(src.id)) {
      seenSource.add(src.id);
      sources.push(src);
    }
  }

  const phaseTimings = Array.isArray(t.phaseTimings) ? t.phaseTimings : [];
  const totalMs =
    t.turnLatencyMs ??
    t.latencyMs ??
    (phaseTimings.length ? phaseTimings.reduce((a, p) => a + (num(p.ms) ?? 0), 0) : undefined);

  const usage = isRecord(t.usage) ? t.usage : {};
  const tokens = {
    prompt: num(usage.promptTokens),
    completion: num(usage.completionTokens),
    total: num(usage.totalTokens),
  };

  const verification = opts.verification ?? verificationFromSteps(steps);
  const { refused, reason } = detectRefusal(t);
  const verdict: ReceiptVerdict = refused
    ? 'refused'
    : verification?.verdict === 'verified'
      ? 'verified'
      : 'unverified';

  return {
    id: opts.receiptId,
    prompt: str(t.prompt),
    planSteps,
    queries,
    sources,
    graphPaths,
    metrics: [...metricNames],
    tools: toolsFrom(t),
    phaseTimings,
    totalMs,
    model: t.model,
    modelTier: t.modelTier,
    taskClass: t.taskClass,
    tokens,
    costUsd: num(t.costUsd),
    verdict,
    verified: verdict === 'verified',
    refused,
    refusalReason: reason,
    verification,
    createdAt: opts.createdAt ?? new Date().toISOString(),
  };
}

/** Short human label + glyph for a verdict — shared by the panel + any badge. */
export const VERDICT_META: Record<ReceiptVerdict, { label: string; glyph: string; tip: string }> = {
  verified: {
    label: 'Verified',
    glyph: '✓',
    tip: 'This answer matched a verified query result / curated Verified Answer — the exact query was replayed and its rows confirmed.',
  },
  unverified: {
    label: 'Unverified',
    glyph: '⚠',
    tip: 'The answer ran real queries against real backends, but no verified-answer signal confirmed it. Review the queries and row counts below.',
  },
  refused: {
    label: 'Refused',
    glyph: '⛔',
    tip: 'The loop refused to answer — a content-safety, guardrail, or egress policy blocked the turn.',
  },
};

/*
 * IL5 / air-gap note (SOVEREIGN MOAT): this assembler is pure and boundary-free —
 * it reads only the persisted trace already produced by the in-boundary
 * orchestrator (in-VNet AOAI, Cosmos-persisted steps). It calls no external
 * service, so it runs identically DISCONNECTED in an IL5 / air-gapped enclave.
 * In that boundary the receipt IS the compliance artifact: the exact in-VNet
 * SQL/KQL/Cypher executed, the row counts, the grounding sources, the model
 * tier, and the verdict — the auditable record a CDO/ISSO reviews without any
 * connected dependency. Nothing here degrades when the boundary is sealed.
 */
