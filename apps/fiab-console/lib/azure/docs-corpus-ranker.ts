/**
 * Corpus-level ranking for the Help Copilot retrieval path — the ONE pipeline
 * both backends run (issue #2585 P0, wired to AI Search for #2929).
 *
 * WHY THIS IS ITS OWN MODULE (#4498 round 4)
 * ------------------------------------------
 * Split out of `loom-docs-index.ts`, which this PR's added commentary had pushed
 * to 1588 LOC — past the 1500-line monolith-creep threshold in
 * `scripts/ci/check-file-size.mjs`, reddening `node:test suites`. That guard's
 * own escalation policy names splitting by bounded context as the preferred fix
 * and treats an allowlist entry as an exception request; asking for an exception
 * for bloat this PR itself created, on a file `main` keeps at 1213, is the
 * weakest possible case for one.
 *
 * This block was chosen because THIS PR DOES NOT TOUCH IT, so the move is pure
 * motion that leaves the code under active review undisturbed. The extraction
 * was performed by script rather than retyped, so the moved lines are the same
 * bytes; the only edits are the three `export` keywords that privates crossing a
 * module boundary now need, and this header.
 *
 * LAYERING — this module sits ABOVE `docs-ranker` and BESIDE `loom-docs-corpus`.
 * It deliberately does NOT live in `docs-ranker.ts`: that file carries a
 * documented purity contract (no Azure/Cosmos/AI-Search imports, erasable syntax
 * only) so `scripts/csa-loom/measure-retrieval.mjs` can import it under Node
 * type-stripping, and `loom-docs-corpus` already imports it — putting a
 * `resetCorpusStatsCache` caller there would close a runtime cycle
 * (docs-ranker -> loom-docs-corpus -> docs-ranker).
 *
 * `loom-docs-index` re-exports `DocHit`, `resetDocsRankerCache` and
 * `AI_SEARCH_CANDIDATE_WINDOW`, so every existing importer is unchanged.
 */
import {
  DEFAULT_SOURCE_WEIGHTS,
  DEFAULT_SURFACE_BOOST,
  bm25Rank,
  buildBm25Index,
  rankSubstring,
  type Bm25CorpusStats,
  type Bm25Index,
} from './docs-ranker';
import { resetCorpusStatsCache, type DocChunk } from './loom-docs-corpus';


export interface DocHit extends DocChunk {
  /** 0..1 normalized relevance */
  score: number;
}

// ---------- Cosmos-fallback ranking (issue #2585 P0) ----------

/**
 * BM25 needs corpus-wide statistics (document frequency, mean chunk length), so
 * unlike the per-chunk `rankSubstring` it cannot be evaluated one row at a time.
 * The index is therefore built once per corpus SNAPSHOT and reused across
 * queries: building it over the ~50k-chunk corpus costs ~850 ms, ranking against
 * it costs microseconds because the postings walk touches only the query's own
 * terms instead of scanning every chunk.
 *
 * Cache key = chunk count + an order-independent hash of the chunk ids, so a
 * reindex (new/removed/renamed chunks) invalidates it automatically without a
 * process restart, and Cosmos returning rows in a different order does not.
 * Content-only edits that keep every id stable are picked up on the next
 * `resetDocsRankerCache()` (called by `reindex`) or process roll.
 */
let bm25Cache: { signature: string; index: Bm25Index } | null = null;

/** FNV-1a over one id — cheap, and combined order-independently below. */
function idHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function corpusSignature(chunks: DocChunk[]): string {
  let sum = 0;
  let xor = 0;
  for (const c of chunks) {
    const h = idHash(c.id || c.path);
    sum = (sum + h) >>> 0;
    xor ^= h;
  }
  return `${chunks.length}:${sum}:${xor >>> 0}`;
}

/**
 * Drop the memoised BM25 index AND the memoised corpus statistics (called after
 * a reindex; exported for tests). Both are snapshots of a corpus that has just
 * changed, so they have to fall together — dropping only one would leave the AI
 * Search re-rank scoring fresh chunks against stale document frequencies.
 */
export function resetDocsRankerCache(): void {
  bm25Cache = null;
  resetCorpusStatsCache();
}

export function bm25IndexFor(chunks: DocChunk[]): Bm25Index {
  const signature = corpusSignature(chunks);
  if (bm25Cache && bm25Cache.signature === signature) return bm25Cache.index;
  const index = buildBm25Index(chunks);
  bm25Cache = { signature, index };
  return index;
}

/**
 * How many candidates to pull before per-document diversification trims back to
 * `top`. Without an over-fetch the diversifier has nothing to backfill from and
 * is a no-op.
 */
export const RETRIEVAL_OVERFETCH = 4;

/**
 * How wide a candidate window to pull from AI Search before the shared ranker
 * re-orders it (#2929). AI Search's `simple`/`any` scoring decides only which
 * documents are CANDIDATES here — NOT their final order — so this must be wide
 * enough that a specific gold document (buried by AI Search under same-named
 * siblings) is still inside the window for `rankChunks` to surface. 100 covers
 * the observed miss (`parity/lakehouse.md` sat well below AI Search's top ~32,
 * giving hit-rate ~0.07); it is never smaller than the diversification
 * over-fetch. AI Search caps `top` at 1000, so this is comfortably in range.
 */
export const AI_SEARCH_CANDIDATE_WINDOW = 100;

/**
 * The ONE ranking pipeline both retrieval backends run (issue #2585 ranker,
 * wired to the AI Search path for #2929). Given a set of candidate chunks it
 * returns the top `top` as DocHits under BM25 (IDF · TF-saturation · length
 * normalisation) + the surface boost + source-class weighting — identical
 * knobs, identical code — normalised to the documented 0..1 `DocHit.score`.
 *
 * Extracted from `searchCosmos` so the AI Search path can REUSE it verbatim
 * rather than re-sorting AI Search's short returned window by a multiplier: for
 * the SAME candidate documents the two backends now produce the SAME ordering,
 * so the offline-measured Cosmos numbers (measure-retrieval.mjs, ~0.83) carry
 * to the live AI Search path.
 *
 * `buildIndex` is injectable ONLY so the Cosmos path can keep its
 * corpus-signature memoiser (`bm25IndexFor`): it always ranks the SAME full
 * ~50k-chunk corpus, so the ~850 ms index build must be amortised across
 * queries. The AI Search path ranks a small, per-query candidate window, so it
 * uses the default fresh `buildBm25Index` — there is nothing stable to cache
 * and a per-window build is microseconds.
 */
export function rankChunks(
  resources: DocChunk[],
  query: string,
  top: number,
  opts: {
    bm25: boolean;
    surfaceTerms?: readonly string[];
    sourceWeights: boolean;
    /**
     * #2970 — corpus-wide BM25 statistics. MUST be supplied when `resources` is
     * a query-selected subset (the AI Search candidate window); omitted on the
     * Cosmos path, whose index already covers the whole corpus.
     */
    corpusStats?: Bm25CorpusStats | null;
  },
  buildIndex: (chunks: DocChunk[]) => Bm25Index = buildBm25Index,
): DocHit[] {
  if (opts.bm25 === false) {
    // Kill-switch path — byte-identical to the pre-#2585 ranker.
    return resources
      .map((r) => ({ ...r, score: rankSubstring(query, r.content, r.heading) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, top);
  }
  const index = buildIndex(resources);
  const ranked = bm25Rank(index, query, top, {
    surfaceTerms: opts.surfaceTerms,
    surfaceBoost: opts.surfaceTerms?.length ? DEFAULT_SURFACE_BOOST : 0,
    // #2585 P2 — rank published product docs above the engineering ledger.
    sourceWeights: opts.sourceWeights ? DEFAULT_SOURCE_WEIGHTS : null,
    corpusStats: opts.corpusStats ?? null,
  });
  // Normalise to the 0..1 `DocHit.score` contract (BM25 is unbounded above and
  // only comparable within one result set) — citations and the Copilot tool
  // render this number.
  const max = ranked.length > 0 ? ranked[0].score : 1;
  return ranked.map((r) => ({ ...resources[r.index], score: max > 0 ? r.score / max : 0 }));
}
