/**
 * loom-semantic-contract — doc shapes + MIG1 versioned-migration registration +
 * the PURE (side-effect-free, Azure-free) matching layer for N9.
 *
 * N9 elevates the semantic-model / metric-view from a grounding HINT to a
 * GOVERNED CONTRACT:
 *   • a METRIC REGISTRY — every governed metric with an owner, description,
 *     synonyms, grain, and the source metric-view / measure it compiles from;
 *   • a VERIFIED QUERY REPOSITORY (VQR) — approved question→query pairs a data
 *     steward has blessed;
 *   • refuse-not-guess — the data agent retrieves a verified query FIRST, routes
 *     an unmatched-but-metric-grounded question through generation, and REFUSES
 *     an out-of-contract question with a guided message instead of fabricating.
 *
 * This module is a LEAF: it imports ONLY `cosmos-migrations` (no cosmos-client,
 * no data-agent) so cosmos-client can import it at module scope to register the
 * migrator chain before any read materializes — exactly the copilot-evals-model
 * precedent. The Cosmos-touching store lives in `semantic-contract.ts`; the
 * runtime wiring in `data-agent-reasoning.ts`.
 *
 * CROSS-WIRE (N15): N15's future metrics service compiles FROM this contract
 * store — N9 OWNS the metric-definition substrate. The exported `MetricDoc`
 * shape is the canonical metric definition; keep it clean/stable for N15.
 *
 * CURRENT SCHEMA VERSION: 1 (every doc is stamped `schemaVersion: 1` at write).
 * A future breaking shape change bumps SEMANTIC_CONTRACT_SCHEMA_VERSION to N+1
 * and registers its `fromVersion: N` migrator in
 * {@link registerSemanticContractMigrators} (called at module scope). Per MIG1
 * there is deliberately NO v1 migrator today.
 *
 * Per-cloud: identical all clouds (pure metadata + TDS/KQL, no Fabric). IL5: the
 * store is in-boundary Cosmos and the matcher is pure — full capability runs
 * DISCONNECTED in an air-gapped IL5 enclave; the REFUSAL behavior IS the
 * compliance posture (an agent that cannot ground a question against the
 * governed contract declines rather than hallucinates, and the receipt is the
 * audit artifact).
 */

import { registerMigrator, type DocMigrator } from './cosmos-migrations';

export const SEMANTIC_CONTRACT_CONTAINER = 'loom-semantic-contract';
export const SEMANTIC_CONTRACT_SCHEMA_VERSION = 1;

/**
 * Confidence a verified-query match must clear to be trusted verbatim. Code
 * default (NO new required env var — FLAG0/code-default preferred over env per
 * the MASTER conventions). Tuned so a near-paraphrase of an approved question
 * hits while an unrelated question falls through to metric-grounding / refusal.
 */
export const VQR_MATCH_THRESHOLD = 0.72;

/** Minimum metric-match score for a question to be considered "in-contract"
 *  (metric-grounded generation) rather than refused. */
export const METRIC_MATCH_MIN = 0.5;

/** The source a governed metric compiles from. */
export type MetricSourceKind = 'metric-view' | 'measure';

/** A governed metric definition (the N15 metric-definition substrate). */
export interface MetricDoc {
  /** Cosmos id — `metric:<metricId>` (unique within the tenant partition). */
  id: string;
  /** PK — owner oid (owner-scoped, mirrors the Prep-for-AI owner scoping). */
  tenantId: string;
  docType: 'metric';
  schemaVersion: number;
  /** Stable metric key (kebab/snake, e.g. `net_revenue`). */
  metricId: string;
  /** Human display name (e.g. "Net Revenue"). */
  label: string;
  /** Steward / owner (UPN, email, or display name). */
  owner: string;
  /** What the metric means — the governed definition text. */
  description: string;
  /** Alternate phrasings a user might ask by ("sales", "top line", "turnover"). */
  synonyms: string[];
  /** The grain the metric is defined at (e.g. "per order", "daily by region"). */
  grain: string;
  /** metric-view | measure. */
  sourceKind: MetricSourceKind;
  /** The bound source: a metric-view item id, or `<model>::<measure>`. */
  sourceRef: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy?: string;
}

/** One verified question→query pair (the VQR). Only APPROVED rows are trusted. */
export interface VerifiedQueryDoc {
  /** Cosmos id — `vqr:<uuid>`. */
  id: string;
  /** PK — owner oid. */
  tenantId: string;
  docType: 'vqr';
  schemaVersion: number;
  /** The natural-language question this verified query answers. */
  question: string;
  /** The approved query (SQL / KQL / DAX) run verbatim on a VQR hit. */
  query: string;
  /** Query language, for the runtime + the trace. */
  queryLang: 'sql' | 'kql' | 'dax' | 'sparksql';
  /** The source the query runs against (matched leniently against agent sources by name). */
  sourceName: string;
  /** draft until a steward approves it; only `approved` rows are retrieved at run. */
  status: 'draft' | 'approved';
  /** Monotonic version — bumped on every re-approval (edit → re-approve). */
  version: number;
  /** Optional metric this VQR is associated with (metricId). */
  metricId?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  approvedAt?: string;
  approvedBy?: string;
  approvedByOid?: string;
}

// ── Pure matching layer (no Azure, fully unit-testable) ──────────────────────

/** English stopwords dropped before token overlap so scoring keys on content. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'by', 'is', 'are', 'was',
  'were', 'be', 'and', 'or', 'what', 'whats', 'which', 'how', 'many', 'much',
  'me', 'my', 'our', 'we', 'show', 'give', 'get', 'tell', 'about', 'do', 'does',
  'did', 'can', 'could', 'please', 'over', 'per', 'each', 'with', 'from', 'that',
]);

/** Normalize a phrase to a de-duplicated set of content tokens. Pure. */
export function normalizeTokens(s: string): string[] {
  const raw = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t));
  return Array.from(new Set(raw));
}

/**
 * Similarity of two questions in [0,1]. Exact normalized-token-set equality →
 * 1.0; otherwise a Jaccard overlap of the content-token sets. Pure + symmetric.
 */
export function scoreSimilarity(a: string, b: string): number {
  const ta = normalizeTokens(a);
  const tb = normalizeTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const sa = new Set(ta);
  const sb = new Set(tb);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  if (union === 0) return 0;
  const jaccard = inter / union;
  // Exact content-set match reads as a perfect hit even with stopword/word-order
  // differences ("what is total revenue" ≡ "total revenue").
  if (inter === sa.size && inter === sb.size) return 1;
  return jaccard;
}

/** Best verified-query match for a question (highest similarity). Pure. */
export function bestVerifiedMatch(
  question: string,
  vqrs: VerifiedQueryDoc[],
): { vqr: VerifiedQueryDoc; confidence: number } | null {
  let best: { vqr: VerifiedQueryDoc; confidence: number } | null = null;
  for (const vqr of vqrs) {
    if (vqr.status !== 'approved') continue; // refuse-not-guess: only trust approved
    const confidence = scoreSimilarity(question, vqr.question);
    if (!best || confidence > best.confidence) best = { vqr, confidence };
  }
  return best;
}

/**
 * Metric-match score of a question against one metric, in [0,1]. A synonym /
 * label phrase whose content tokens are ALL present in the question scores 1;
 * otherwise the max token-overlap fraction over the metric's label + synonyms.
 * Pure.
 */
export function metricMatchScore(question: string, metric: MetricDoc): number {
  const qTokens = new Set(normalizeTokens(question));
  if (qTokens.size === 0) return 0;
  const phrases = [metric.label, metric.metricId.replace(/[_-]+/g, ' '), ...(metric.synonyms || [])];
  let best = 0;
  for (const phrase of phrases) {
    const pt = normalizeTokens(phrase);
    if (pt.length === 0) continue;
    let hit = 0;
    for (const t of pt) if (qTokens.has(t)) hit++;
    const frac = hit / pt.length;
    // A full multi-token phrase match ("net revenue" fully present) is decisive.
    const score = frac === 1 ? 1 : frac;
    if (score > best) best = score;
  }
  return best;
}

/** Best metric match for a question. Pure. */
export function bestMetricMatch(
  question: string,
  metrics: MetricDoc[],
): { metric: MetricDoc; confidence: number } | null {
  let best: { metric: MetricDoc; confidence: number } | null = null;
  for (const metric of metrics) {
    const confidence = metricMatchScore(question, metric);
    if (!best || confidence > best.confidence) best = { metric, confidence };
  }
  return best;
}

/**
 * Resolve a free-text term to a metric via its synonym / label / id index.
 * Returns the first metric that lists the term (or whose label/id equals it),
 * case-insensitively. Pure — the store passes its loaded metric list.
 */
export function resolveSynonymIn(term: string, metrics: MetricDoc[]): MetricDoc | null {
  const needle = String(term || '').trim().toLowerCase();
  if (!needle) return null;
  for (const m of metrics) {
    if (m.label.toLowerCase() === needle || m.metricId.toLowerCase() === needle) return m;
    if ((m.synonyms || []).some((s) => s.trim().toLowerCase() === needle)) return m;
  }
  return null;
}

// ── MIG1 registration ────────────────────────────────────────────────────────

/**
 * MIG1 registration point for this container's migrator chain. v1 is current —
 * the chain is empty. The FIRST breaking change adds:
 *
 *   const v1toV2: DocMigrator = (doc) => ({ ...doc, …, schemaVersion: 2 });
 *   registerMigrator(SEMANTIC_CONTRACT_CONTAINER, 1, v1toV2);
 *
 * plus the optional backfill script
 * `scripts/csa-loom/cosmos-backfill-loom-semantic-contract.mjs`.
 */
export function registerSemanticContractMigrators(): void {
  // v1 → (none yet). Keeping the registerMigrator reference live reserves the
  // wiring for the first real migration without claiming the one-owner-per-step
  // v1 slot with an inert migrator (the MIG1 convention, per copilot-evals-model).
  const register: (containerId: string, fromVersion: number, migrate: DocMigrator) => void = registerMigrator;
  void register;
}

registerSemanticContractMigrators();
