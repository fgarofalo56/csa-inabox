/**
 * vector-rerank — PURE, dependency-free reranking of vector/hybrid search
 * candidates (WS-2.2, Databricks Vector Search parity).
 *
 * Retrieval (vector k-NN, or hybrid vector+BM25) is recall-oriented: it returns
 * a broad candidate set ranked by a single similarity signal. A *reranker* is
 * the precision stage on top — it re-scores that candidate set with additional
 * signals and trims to the final `k`. This mirrors Databricks Vector Search's
 * "hybrid + rerank" and Azure AI Search's L2 semantic reranker.
 *
 * Two rerankers are available in Loom:
 *   1. AI Search native L2 semantic reranker (`queryType=semantic`) — used when
 *      the service tier supports it; it emits `@search.rerankerScore`.
 *   2. This portable **fusion reranker** — works on EVERY backend (AI Search,
 *      pgvector, Cosmos vCore) and needs no extra service. It blends the
 *      normalized retrieval score with a lexical-overlap score of the query
 *      terms against each candidate's text, so exact keyword matches the pure
 *      vector k-NN under-ranks are surfaced. It also consumes the native
 *      `@search.rerankerScore` as the retrieval signal when present, so the two
 *      stages compose rather than fight.
 *
 * This file is pure so the ranking math is unit-testable in isolation (no
 * network, no Azure SDK) — the diff/scoring is deterministic and byte-stable.
 */

/** A single search candidate as returned by any backend's search result. */
export interface RerankCandidate {
  id?: string | number;
  /** The document's textual content (used for the lexical-overlap signal). */
  content?: string;
  /** AI Search hybrid/RRF score. */
  '@search.score'?: number;
  /** AI Search L2 semantic reranker score (0..4). Preferred when present. */
  '@search.rerankerScore'?: number;
  /** pgvector / vCore similarity score. */
  score?: number;
  [k: string]: unknown;
}

export interface RerankedItem {
  /** The original candidate, untouched. */
  doc: RerankCandidate;
  /** Retrieval signal after min-max normalization to [0,1]. */
  retrievalScore: number;
  /** Lexical query-term overlap in [0,1]. */
  lexicalScore: number;
  /** Blended rerank score in [0,1] — the sort key. */
  rerankScore: number;
}

export interface RerankOptions {
  /** Weight of the (normalized) retrieval signal. Default 0.7. */
  retrievalWeight?: number;
  /** Weight of the lexical-overlap signal. Default 0.3. */
  lexicalWeight?: number;
  /** Field(s) to pull candidate text from, in order. Default ['content','text','chunk','title']. */
  contentFields?: string[];
}

const DEFAULT_CONTENT_FIELDS = ['content', 'text', 'chunk', 'title', 'name'] as const;

/** The raw retrieval signal for a candidate: prefer the native semantic reranker
 *  score, then the hybrid/RRF score, then a backend similarity score. */
export function retrievalScoreOf(c: RerankCandidate): number {
  const r = c['@search.rerankerScore'];
  if (typeof r === 'number' && Number.isFinite(r)) return r;
  const s = c['@search.score'];
  if (typeof s === 'number' && Number.isFinite(s)) return s;
  const b = c.score;
  if (typeof b === 'number' && Number.isFinite(b)) return b;
  return 0;
}

/** Extract candidate text from the first populated content field. */
export function candidateText(c: RerankCandidate, fields: readonly string[] = DEFAULT_CONTENT_FIELDS): string {
  for (const f of fields) {
    const v = c[f];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

/** Significant (length > 2) lowercased query terms, deduped. */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of (query || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length > 2 && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/** Fraction of distinct query terms that appear in `content` — [0,1]. Empty
 *  query (no significant terms) yields 0 so the retrieval signal dominates. */
export function lexicalOverlap(query: string, content: string): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  const text = (content || '').toLowerCase();
  let hits = 0;
  for (const t of terms) if (text.includes(t)) hits += 1;
  return hits / terms.length;
}

/** Min-max normalize an array of numbers to [0,1]. A flat array (max===min)
 *  maps every element to 1 so a single-candidate / tied set keeps its retrieval
 *  weight rather than collapsing to 0. */
export function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return [];
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) return values.map(() => 1);
  const span = max - min;
  return values.map((v) => (v - min) / span);
}

/**
 * Fusion reranker. Blends the min-max-normalized retrieval score with the
 * lexical-overlap score of `queryText`, sorts descending, and returns the top
 * `k`. Stable on ties by original retrieval order (the input is assumed already
 * retrieval-ranked). Pure + deterministic.
 */
export function rerankByFusion(
  candidates: RerankCandidate[],
  queryText: string,
  k: number,
  opts: RerankOptions = {},
): RerankedItem[] {
  const wR = opts.retrievalWeight ?? 0.7;
  const wL = opts.lexicalWeight ?? 0.3;
  const fields = opts.contentFields ?? [...DEFAULT_CONTENT_FIELDS];
  const wSum = wR + wL || 1;

  const rawRetrieval = candidates.map(retrievalScoreOf);
  const normRetrieval = minMaxNormalize(rawRetrieval);

  const scored: Array<RerankedItem & { _idx: number }> = candidates.map((doc, i) => {
    const lexicalScore = lexicalOverlap(queryText, candidateText(doc, fields));
    const rerankScore = (wR * normRetrieval[i] + wL * lexicalScore) / wSum;
    return { doc, retrievalScore: normRetrieval[i], lexicalScore, rerankScore, _idx: i };
  });

  scored.sort((a, b) => (b.rerankScore - a.rerankScore) || (a._idx - b._idx));
  const top = k > 0 ? scored.slice(0, k) : scored;
  return top.map(({ _idx, ...rest }) => rest);
}
