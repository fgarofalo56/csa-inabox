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
  /**
   * Per-chunk corpus source class (see `corpusSourceClass`). Stored as the class
   * NAME, not a weight: classification is a pure function of the path and can be
   * computed once at index time, while the weight attached to each class is a
   * tunable ranking policy supplied per query.
   */
  sources: Array<CorpusSourceClass>;
}

/** Filename stem of a repo-relative path, with separators turned into spaces. */
export function titleTokensFor(chunk: RankableChunk): Set<string> {
  const base = (chunk.path || '').split('/').pop() || '';
  const stem = base.replace(/\.md$/i, '').replace(/[-_]/g, ' ');
  return new Set(tokenize(`${stem} ${chunk.heading || ''}`));
}

// ── Corpus source classes (#2585 P2 / apex D5) ───────────────────────────────

/**
 * What KIND of document a corpus path is, for ranking purposes.
 *
 * The corpus deliberately mixes three very different bodies of text and, until
 * this classification existed, ranked them as peers:
 *
 * * `product`  — the published CSA Loom docs a user is entitled to be answered
 *                from (`docs/fiab/parity/**`, `concepts/`, `admin/`, …). Every
 *                one of the 20 documents the golden sets expect is one of these.
 * * `reference`— generic Azure / migration reference material (`docs/learn/**`,
 *                `docs/migrations/**`). Real content, but it answers "how does
 *                Azure work", not "how does Loom work", so it should not outrank
 *                a Loom product doc for a question about a Loom surface.
 * * `ledger`   — the ENGINEERING ledger: in-flight plans, audit sweeps, gap
 *                reports, PRPs. Written for the people building Loom, often
 *                describing things that are not built yet or no longer true.
 * * `archive`  — explicitly retired material kept for history.
 *
 * This is the "stop masking user-doc gaps with engineering-ledger RAG hits"
 * lever. It is a DOWN-WEIGHT, never an exclusion: a ledger receipt is still
 * reachable when nothing better exists, which is why `PRPs/active/**` was added
 * to the corpus in the first place (see `loom-docs-index` module header).
 *
 * Pure and path-only, so it is computable at index time and testable without a
 * corpus.
 */
export type CorpusSourceClass = 'product' | 'reference' | 'ledger' | 'archive';

/** Ordered prefix rules; first match wins. Paths are matched case-insensitively. */
const SOURCE_CLASS_RULES: ReadonlyArray<{ test: RegExp; cls: CorpusSourceClass }> = [
  // Explicitly retired.
  { test: /(^|\/)docs\/fiab\/archive\//, cls: 'archive' },
  { test: /(^|\/)docs\/archive\//, cls: 'archive' },
  // Engineering ledger — plans, audits, gap reports, receipts.
  { test: /(^|\/)prps\//, cls: 'ledger' },
  { test: /(^|\/)docs\/fiab\/prp\//, cls: 'ledger' },
  { test: /(^|\/)docs\/fiab\/audit\//, cls: 'ledger' },
  { test: /(^|\/)docs\/fiab\/parity-gap\//, cls: 'ledger' },
  { test: /(^|\/)docs\/fiab\/research\//, cls: 'ledger' },
  // Generic Azure / migration reference, not Loom product documentation.
  { test: /(^|\/)docs\/learn\//, cls: 'reference' },
  { test: /(^|\/)docs\/migrations\//, cls: 'reference' },
];

/** Classify one corpus path. Anything unmatched is `product`. */
export function corpusSourceClass(docPath: string | undefined): CorpusSourceClass {
  const p = (docPath || '').replace(/\\/g, '/').toLowerCase();
  for (const rule of SOURCE_CLASS_RULES) if (rule.test.test(p)) return rule.cls;
  return 'product';
}

/**
 * Score multiplier per source class.
 *
 * MEASURED sweep over the 146 golden rows at top-8 with the shipped ranker
 * (`measure-retrieval.mjs --source-weights ref:ledger:archive`), reading
 * overall hit-rate and the share of returned chunks that came from the ledger:
 *
 * | ref:ledger:archive | overall | `health` | product share | ledger share |
 * |---|---|---|---|---|
 * | 1 : 1 : 1 (before)  | 0.760 | 0.467 | 72.2% | 16.3% |
 * | 0.95 : 0.90 : 0.85  | 0.795 | 0.533 | 83.1% |  8.2% |
 * | **0.90 : 0.75 : 0.70** | **0.808** | **0.600** | **92.5%** | **1.9%** |
 * | 0.85 : 0.60 : 0.50  | 0.808 | 0.600 | 96.2% |  0.4% |
 * | 0.75 : 0.45 : 0.35  | 0.822 | 0.733 | 98.8% |  0.0% |
 * | 0.60 : 0.30 : 0.20  | 0.829 | 0.733 | 100.0% | 0.0% |
 *
 * The score keeps rising as the weights fall, which is exactly the shape that
 * should stop you taking the maximum: past 0.75 the ledger contributes **zero**
 * chunks to any of the 146 windows, i.e. the down-weight has become a delete,
 * and the remaining gain is the metric being fitted rather than retrieval being
 * improved. 0.90/0.75/0.70 is the MILDEST setting that reaches the 0.808
 * plateau while leaving the ledger reachable (1.9% of returned evidence, and
 * `bm25Rank` still returns a ledger chunk when it is the only match — asserted
 * in `docs-ranker.test.ts`).
 */
export const DEFAULT_SOURCE_WEIGHTS: Readonly<Record<CorpusSourceClass, number>> = {
  product: 1,
  reference: 0.9,
  ledger: 0.75,
  archive: 0.7,
};

/** Neutral weights — every class at 1. The flag-off path. */
export const NEUTRAL_SOURCE_WEIGHTS: Readonly<Record<CorpusSourceClass, number>> = {
  product: 1, reference: 1, ledger: 1, archive: 1,
};

/**
 * Weight for one chunk path. Used by the AI Search re-sort, which has documents
 * rather than an index to consult.
 */
export function sourceWeightFor(
  docPath: string | undefined,
  weights: Readonly<Record<CorpusSourceClass, number>> = DEFAULT_SOURCE_WEIGHTS,
): number {
  const w = weights[corpusSourceClass(docPath)];
  return typeof w === 'number' && w > 0 ? w : 1;
}

/** Build the inverted index. Pure; the caller owns caching. */
export function buildBm25Index(chunks: readonly RankableChunk[]): Bm25Index {
  const size = chunks.length;
  const postings = new Map<string, number[]>();
  const lengths = new Float64Array(size);
  const titles: Array<Set<string>> = new Array(size);
  const sources: Array<CorpusSourceClass> = new Array(size);
  let total = 0;
  for (let i = 0; i < size; i++) {
    const c = chunks[i];
    const toks = tokenize(`${c.heading || ''} ${c.content}`);
    lengths[i] = toks.length;
    total += toks.length;
    titles[i] = titleTokensFor(c);
    sources[i] = corpusSourceClass(c.path);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, f] of tf) {
      let arr = postings.get(t);
      if (!arr) { arr = []; postings.set(t, arr); }
      arr.push(i, f);
    }
  }
  return { size, avgdl: size > 0 ? total / size : 0, postings, lengths, titles, sources };
}

// ── Corpus-wide BM25 statistics (#2970) ──────────────────────────────────────

/**
 * The corpus-wide half of a BM25 score: how many chunks exist, how long the
 * average one is, and in how many of them each term appears.
 *
 * WHY THIS TYPE EXISTS — the measured defect (#2970, 2026-08-06)
 * -------------------------------------------------------------
 * `bm25Rank` takes its `size`, `df` and `avgdl` from the {@link Bm25Index} it is
 * handed. On the Cosmos path that index covers the whole ~50k-chunk corpus, so
 * those are corpus statistics and the scores are real BM25. On the AI Search
 * path `loom-docs-index.searchDocs` builds a FRESH index over the per-query
 * candidate window — and every chunk in that window was selected *because* it
 * matches the query. So `df/size` approaches 1 for exactly the query's terms and
 *
 *     idf = log(1 + (size − df + 0.5) / (df + 0.5))
 *
 * collapses toward 0 for all of them at once. The re-ranker loses the ability to
 * tell a rare, discriminating term from a ubiquitous one — which is the entire
 * reason BM25 outranks term-presence counting.
 *
 * `loom-docs-index.ts` called this "the one residual asymmetry" and moved on.
 * Measured over the 153 golden rows at top-8 with the two-stage simulation in
 * `scripts/csa-loom/measure-retrieval.mjs --stage1 100,200,400,800,inf`:
 *
 *   stage-2 statistics      w=100   w=200   w=400   w=800   full corpus
 *   window-local (shipped)  0.797   0.804   0.784   0.850   0.889
 *   corpus-wide (this fix)  0.889   0.889   0.889   0.889   0.889
 *
 * The asymmetry was the whole gap: with corpus-wide statistics a 100-candidate
 * window scores IDENTICALLY to ranking the entire corpus. Note also that the
 * window-local row is NOT monotonic in width (400 is worse than 200) — a
 * ranking whose quality wanders with the candidate count is the signature of
 * distorted statistics rather than of a recall ceiling.
 *
 * Corollary, recorded because it redirects the issue: stage-1 recall was
 * measured at 0.967@100 and 1.000@800, so #2970's hypothesis — that AI Search's
 * `queryType:'simple'` / `searchMode:'any'` was losing the gold document before
 * the re-ranker saw it — is NOT the dominant term. The document was almost
 * always in the window; the re-rank could not tell it was the right one.
 *
 * Per-chunk facts (term frequency, chunk length, title tokens, source class)
 * stay LOCAL to the window — they are properties of the chunk, identical either
 * way. Only the three corpus-wide quantities are substituted.
 */
export interface Bm25CorpusStats {
  /** Total chunks in the corpus (NOT in the candidate window). */
  size: number;
  /** Mean chunk length in tokens across the corpus. */
  avgdl: number;
  /** term → number of corpus chunks containing it. */
  df: Map<string, number>;
}

/**
 * Accumulate corpus-wide statistics one chunk at a time.
 *
 * Streaming on purpose: the corpus is ~50k chunks / ~75 MB of text, and
 * materialising it just to count document frequencies would put that on the heap
 * of every console replica. The caller walks its source files and feeds chunks
 * through, holding only the accumulator.
 */
export function createCorpusStatsAccumulator(): {
  add: (chunk: Pick<RankableChunk, 'heading' | 'content'>) => void;
  finish: () => Bm25CorpusStats;
} {
  const df = new Map<string, number>();
  let size = 0;
  let total = 0;
  return {
    add(chunk) {
      const toks = tokenize(`${chunk.heading || ''} ${chunk.content}`);
      size += 1;
      total += toks.length;
      for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
    },
    finish() {
      return { size, avgdl: size > 0 ? total / size : 0, df };
    },
  };
}

/** Corpus statistics from an in-memory chunk array (tests / offline harness). */
export function buildCorpusStats(chunks: readonly RankableChunk[]): Bm25CorpusStats {
  const acc = createCorpusStatsAccumulator();
  for (const c of chunks) acc.add(c);
  return acc.finish();
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
  /**
   * Per-source-class score multiplier (`corpusSourceClass`). DEFAULT undefined =
   * neutral, so an un-opted caller ranks exactly as before this option existed.
   * Pass `DEFAULT_SOURCE_WEIGHTS` to demote engineering-ledger and generic
   * reference material below published product docs.
   */
  sourceWeights?: Readonly<Record<CorpusSourceClass, number>> | null;
  /**
   * #2970 — corpus-wide `size` / `df` / `avgdl` to score with, instead of the
   * ones derived from `index`.
   *
   * Required whenever `index` covers a QUERY-SELECTED SUBSET rather than the
   * whole corpus (the AI Search candidate window). See {@link Bm25CorpusStats}
   * for the measurement: substituting these recovers the full-corpus hit-rate
   * from a 100-candidate window (0.797 → 0.889 over the golden sets).
   *
   * DEFAULT undefined = use the index's own statistics, so an un-opted caller
   * ranks exactly as before this option existed. A term absent from `df` is
   * treated as `df = 0` (maximally rare) rather than falling back to the local
   * count — a term the corpus does not know is genuinely discriminating, and
   * mixing the two statistic sources within one score is what this fixes.
   */
  corpusStats?: Bm25CorpusStats | null;
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
  // #2970 — corpus-wide statistics when supplied (the AI Search candidate
  // window is a query-selected subset, so its own df/size/avgdl are distorted).
  const stats = opts.corpusStats ?? null;
  const statSize = stats ? stats.size : index.size;
  const avgdl = stats ? stats.avgdl : index.avgdl;
  const scores = new Map<number, number>();
  for (const t of terms) {
    const post = index.postings.get(t);
    if (!post) continue;
    const df = stats ? (stats.df.get(t) ?? 0) : post.length / 2;
    // Lucene/Robertson IDF: strictly positive for every df, so a term present
    // in more than half the corpus still contributes (weakly) instead of
    // subtracting from the score.
    const idf = Math.log(1 + (statSize - df + 0.5) / (df + 0.5));
    for (let j = 0; j < post.length; j += 2) {
      const i = post[j];
      const f = post[j + 1];
      const norm = 1 - BM25_B + BM25_B * (avgdl > 0 ? index.lengths[i] / avgdl : 1);
      scores.set(i, (scores.get(i) || 0) + idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * norm)));
    }
  }
  const titleBoost = opts.titleBoost ?? 0;
  const surfaceTerms = opts.surfaceTerms ?? [];
  const surfaceBoost = opts.surfaceBoost ?? 0;
  const sourceWeights = opts.sourceWeights ?? null;
  const weighted = sourceWeights !== null
    && (['product', 'reference', 'ledger', 'archive'] as const).some((k) => sourceWeights[k] !== 1);
  if (titleBoost > 0 || (surfaceBoost > 0 && surfaceTerms.length > 0) || weighted) {
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
      if (weighted && sourceWeights) {
        const w = sourceWeights[index.sources[i]];
        if (typeof w === 'number' && w > 0) next *= w;
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
