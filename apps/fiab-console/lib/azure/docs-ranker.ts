/**
 * docs-ranker — ranking primitives for the Copilot docs-retrieval corpus.
 *
 * Extracted + rebuilt for issue #2585 (P0/P1). The Cosmos-fallback ranker this
 * replaces (`rankSubstring`, kept below as the flag-off path) was boolean
 * TERM-PRESENCE: no IDF, no term frequency, no length normalisation, stopwords
 * retained, and substring rather than token matching. Measured consequences
 * (docs/fiab/copilot-quality-triage.md §2.1): 14,229–26,862 chunks score > 0
 * for a single question, 1–16 of them TIED at the top score, and ties break by
 * store order — i.e. arbitrarily. Doc-level hit-rate@5 over the golden sets was
 * 0.185; a principled BM25 over the identical corpus scores 0.568.
 *
 * Everything here is PURE and dependency-free on purpose:
 *   - unit-testable without Azure, Cosmos or AI Search;
 *   - importable by `scripts/csa-loom/measure-retrieval.mjs` under Node's
 *     native type-stripping, so the offline hit-rate harness measures THIS
 *     module rather than a re-implementation of it (a port can agree with
 *     itself while both disagree with production).
 *
 * Keep this file erasable-syntax-only (no enum / namespace / parameter
 * properties) or the measurement harness stops being able to import it.
 */

// ── Tokenisation ─────────────────────────────────────────────────────────────

/**
 * Stopwords dropped before scoring. `rankSubstring` kept every one of these and
 * weighted "how" exactly as heavily as "lakehouse", which is most of why its
 * candidate set ran to five figures.
 */
export const RANKER_STOPWORDS: ReadonlySet<string> = new Set(
  ('a an the and or but if then else for of to in on at by with from as is are was were be been being '
    + 'do does did how what when where which who why can could should would will shall may might must '
    + 'i you it its this that these those not no yes about into over under more most some any all my '
    + 'your our their there here also using use used').split(/\s+/),
);

/** Minimum token length kept (matches the pre-existing `t.length > 2` rule). */
export const MIN_TOKEN_LENGTH = 3;

/**
 * Lowercase word tokens, stopwords and sub-3-char tokens removed. TOKENS, not
 * substrings: `text.includes('report')` used to match "reported"/"reporting",
 * which is the other half of the huge candidate sets.
 */
export function tokenize(text: string | undefined): string[] {
  const m = (text || '').toLowerCase().match(/[a-z0-9_]+/g);
  if (!m) return [];
  return m.filter((t) => t.length >= MIN_TOKEN_LENGTH && !RANKER_STOPWORDS.has(t));
}

// ── BM25 ─────────────────────────────────────────────────────────────────────

/** The minimum shape the ranker needs from a corpus chunk. */
export interface RankableChunk {
  path: string;
  heading?: string;
  content: string;
}

/** Okapi BM25 term-frequency saturation. */
export const BM25_K1 = 1.2;
/** Okapi BM25 length-normalisation strength. */
export const BM25_B = 0.75;

/**
 * An immutable inverted index over one corpus snapshot. Building it is O(corpus)
 * and must be amortised across queries (see `loom-docs-index.searchCosmos`).
 */
export interface Bm25Index {
  /** Number of indexed chunks. */
  size: number;
  /** Mean chunk length in tokens (the `b` normalisation denominator). */
  avgdl: number;
  /** term → flat postings list `[chunkIdx, termFreq, chunkIdx, termFreq, …]`. */
  postings: Map<string, number[]>;
  /** Per-chunk token count. */
  lengths: Float64Array;
  /** Per-chunk filename + heading token set (only used when a title boost is on). */
  titles: Array<Set<string>>;
}

/** Filename stem of a repo-relative path, with separators turned into spaces. */
export function titleTokensFor(chunk: RankableChunk): Set<string> {
  const base = (chunk.path || '').split('/').pop() || '';
  const stem = base.replace(/\.md$/i, '').replace(/[-_]/g, ' ');
  return new Set(tokenize(`${stem} ${chunk.heading || ''}`));
}

/** Build the inverted index. Pure; the caller owns caching. */
export function buildBm25Index(chunks: readonly RankableChunk[]): Bm25Index {
  const size = chunks.length;
  const postings = new Map<string, number[]>();
  const lengths = new Float64Array(size);
  const titles: Array<Set<string>> = new Array(size);
  let total = 0;
  for (let i = 0; i < size; i++) {
    const c = chunks[i];
    const toks = tokenize(`${c.heading || ''} ${c.content}`);
    lengths[i] = toks.length;
    total += toks.length;
    titles[i] = titleTokensFor(c);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, f] of tf) {
      let arr = postings.get(t);
      if (!arr) { arr = []; postings.set(t, arr); }
      arr.push(i, f);
    }
  }
  return { size, avgdl: size > 0 ? total / size : 0, postings, lengths, titles };
}

/** One scored chunk position from `bm25Rank`. */
export interface RankedIndexHit {
  /** Position in the array the index was built from. */
  index: number;
  /** Raw BM25 score (unbounded above; compare only within one result set). */
  score: number;
}

export interface Bm25RankOptions {
  /**
   * Multiplier applied when query terms appear in the chunk's filename/heading:
   * `score *= 1 + titleBoost * (matchedTitleTerms / queryTerms)`.
   *
   * DEFAULT 0 — deliberately OFF. Measured over the golden sets (triage §P0.3),
   * a boost of 2.0 is worth only +0.020 overall and is NOT uniformly positive:
   * it costs `kql-database` −0.133 and `health` −0.067 (their gold documents do
   * not carry the question's vocabulary in their filenames) while helping
   * `help` +0.150 and `report` +0.134. It is a tuned parameter, not a free win.
   */
  titleBoost?: number;
  /**
   * Per-surface topical boost: `score *= 1 + surfaceBoost` for chunks whose
   * path or heading carries a term of the current surface's topic. DEFAULT 0.
   */
  surfaceTerms?: readonly string[];
  surfaceBoost?: number;
}

/**
 * Score every chunk that shares ≥1 term with the query and return the top `top`
 * by descending score. Unmatched chunks are never visited — the postings walk
 * touches only the query's terms, so this is far cheaper than the full-corpus
 * `map(...).filter(...)` scan it replaces despite doing strictly more work.
 */
export function bm25Rank(
  index: Bm25Index,
  query: string,
  top: number,
  opts: Bm25RankOptions = {},
): RankedIndexHit[] {
  if (top <= 0 || index.size === 0) return [];
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const scores = new Map<number, number>();
  for (const t of terms) {
    const post = index.postings.get(t);
    if (!post) continue;
    const df = post.length / 2;
    // Lucene/Robertson IDF: strictly positive for every df, so a term present
    // in more than half the corpus still contributes (weakly) instead of
    // subtracting from the score.
    const idf = Math.log(1 + (index.size - df + 0.5) / (df + 0.5));
    for (let j = 0; j < post.length; j += 2) {
      const i = post[j];
      const f = post[j + 1];
      const norm = 1 - BM25_B + BM25_B * (index.avgdl > 0 ? index.lengths[i] / index.avgdl : 1);
      scores.set(i, (scores.get(i) || 0) + idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * norm)));
    }
  }
  const titleBoost = opts.titleBoost ?? 0;
  const surfaceTerms = opts.surfaceTerms ?? [];
  const surfaceBoost = opts.surfaceBoost ?? 0;
  if (titleBoost > 0 || (surfaceBoost > 0 && surfaceTerms.length > 0)) {
    const surfaceSet = new Set(surfaceTerms);
    for (const [i, s] of scores) {
      let next = s;
      if (titleBoost > 0) {
        let matched = 0;
        for (const t of terms) if (index.titles[i].has(t)) matched += 1;
        if (matched > 0) next *= 1 + titleBoost * (matched / terms.length);
      }
      if (surfaceBoost > 0 && surfaceSet.size > 0) {
        let onTopic = false;
        for (const t of index.titles[i]) {
          if (surfaceSet.has(t)) { onTopic = true; break; }
        }
        if (onTopic) next *= 1 + surfaceBoost;
      }
      scores.set(i, next);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, top)
    .map(([index_, score]) => ({ index: index_, score }));
}

// ── Per-document diversification (P1) ────────────────────────────────────────

/** Default cap on chunks from any one document inside the returned window. */
export const DEFAULT_MAX_CHUNKS_PER_DOC = 2;

/**
 * Collapse a rank-ordered chunk list so no single document occupies more than
 * `maxPerDoc` of the `top` slots, then backfill from the deferred chunks (still
 * in rank order) if the cap left the window short.
 *
 * Why: retrieval returns 5 CHUNKS but hit-rate is scored per DOCUMENT, and the
 * top-5 window measured only 4.2–4.75 distinct documents (triage §2.2) — up to
 * a fifth of the recall window spent re-reading one file. Backfilling rather
 * than truncating means this can only ever widen the document set: the returned
 * count is unchanged, and a corpus with fewer than `top` distinct documents
 * degrades to the undiversified order.
 */
export function diversifyByDocument<T extends { path: string }>(
  ranked: readonly T[],
  top: number,
  maxPerDoc: number = DEFAULT_MAX_CHUNKS_PER_DOC,
): T[] {
  if (top <= 0) return [];
  if (maxPerDoc <= 0 || ranked.length <= top) return ranked.slice(0, top);
  const picked: T[] = [];
  const deferred: T[] = [];
  const perDoc = new Map<string, number>();
  for (const hit of ranked) {
    if (picked.length >= top) break;
    const key = (hit.path || '').toLowerCase();
    const seen = perDoc.get(key) || 0;
    if (seen >= maxPerDoc) { deferred.push(hit); continue; }
    perDoc.set(key, seen + 1);
    picked.push(hit);
  }
  for (const hit of deferred) {
    if (picked.length >= top) break;
    picked.push(hit);
  }
  return picked;
}

// ── Surface scoping (P1b) ────────────────────────────────────────────────────

/**
 * Topic terms for a Copilot surface, derived MECHANICALLY from the surface slug
 * (`kql-database` → `kql`, `database`). Deliberately not hand-curated: a
 * hand-written map would be tuned by someone who has already seen which
 * documents the golden sets expect, which fits the metric instead of improving
 * retrieval. Sub-3-char and stopword segments drop out via `tokenize`.
 */
export function surfaceTopicTerms(surface: string | undefined | null): string[] {
  if (!surface) return [];
  return [...new Set(tokenize(String(surface).replace(/[-_/]+/g, ' ')))];
}

/**
 * Default surface-boost strength. A MULTIPLIER, never a filter: a hard
 * surface filter would make a cross-cutting question unanswerable from a
 * neighbouring document, and `help` — which spans the whole product — has no
 * meaningful topical slice at all.
 *
 * 0.35 chosen from a measured sweep over the golden sets at top-8
 * (0.15 → 0.705, 0.35 → 0.760, 1.0 → 0.760). 0.35 reaches the plateau while
 * still leaving `cost` at 1.000, which a boost of 1.0 costs (0.833).
 */
export const DEFAULT_SURFACE_BOOST = 0.35;

/**
 * Score multiplier for one chunk under the current surface. `1` when there is
 * no surface, no topic terms, or the chunk is off-topic — so an unspecified
 * surface is exactly the un-boosted ranking.
 *
 * Shared by BOTH retrieval backends so they agree on what "on-topic" means:
 * the Cosmos/BM25 path folds it into scoring (it can therefore promote a
 * document from anywhere in the corpus), while the AI Search path can only
 * apply it as a re-sort of the over-fetched window. That asymmetry is real and
 * is documented at the call site.
 */
export function surfaceBoostFactor(
  surfaceTerms: readonly string[],
  chunk: RankableChunk,
  boost: number = DEFAULT_SURFACE_BOOST,
): number {
  if (boost <= 0 || surfaceTerms.length === 0) return 1;
  const titles = titleTokensFor(chunk);
  for (const t of surfaceTerms) if (titles.has(t)) return 1 + boost;
  return 1;
}

// ── Legacy ranker (flag-off path) ────────────────────────────────────────────

/**
 * The pre-#2585 Cosmos-fallback scorer, preserved verbatim so the
 * `copilot-bm25-retrieval` kill-switch reverts to BYTE-IDENTICAL behaviour
 * rather than to an approximation of it. Boolean term presence, headings
 * counted twice, normalised to 0..1. Do not "improve" this — its only job is to
 * be what shipped before.
 */
export function rankSubstring(query: string, content: string, heading?: string): number {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter((t) => t.length > 2);
  if (terms.length === 0) return 0;
  const text = `${heading || ''}\n${content}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) score += 1;
    if (heading && heading.toLowerCase().includes(term)) score += 1;
  }
  return score / (terms.length * 2);
}
