/**
 * AI Search retrieve-then-rerank tests (issue #2929).
 *
 * The #2585 BM25 remediation shipped ONLY in the Cosmos-fallback ranker; the
 * live console uses Azure AI Search, whose `simple`/`any` scoring buried
 * specific gold docs (parity/lakehouse.md, hit-rate ~0.07 on the live gate)
 * under same-named siblings. This suite proves the fix: the AI Search branch of
 * `searchDocs` now over-fetches a WIDE candidate window and re-ranks it through
 * the SAME shared ranker (`rankChunks`) the Cosmos path uses, so both backends
 * produce the same ordering for the same candidate documents — and the gold doc
 * surfaces.
 *
 * DECISIVE BY CONSTRUCTION: the gold doc is given a LOW AI Search @search.score
 * (below the noise/sibling candidates), so it can only reach the top-N via the
 * BM25 re-rank. Revert the wiring (re-sort AI Search's window by @search.score,
 * the pre-#2929 behaviour) and the `gold surfaces to #1` assertion goes RED —
 * because a same-named sibling wins on raw @search.score. See the mutation note
 * on that test.
 *
 * Offline scope (G1 / docs/fiab/copilot-retrieval-remediation.md §7.3): this
 * proves the WIRING — candidates routed through the measured ranker. The live
 * hit-rate confirms only after a `loom-docs` reindex + a real
 * `copilot-quality-evals` run, which the offline harness structurally cannot
 * exercise.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface Cand { path: string; kind: string; heading?: string; content: string; score: number }

const TS = '2026-08-03T00:00:00Z';
const GOLD = 'docs/fiab/parity/lakehouse.md';
const NOISE = 'docs/fiab/topology-migration.md';
const QUERY = 'How does liquid clustering work in the lakehouse?';

/**
 * Candidate documents as AI Search would return them for the query, in
 * descending @search.score order. The gold doc is deliberately at the BOTTOM on
 * @search.score — AI Search buries it under same-named siblings — but its
 * CONTENT (high term frequency of the discriminating query terms `liquid` /
 * `clustering`, short length, product-class path, `lakehouse` filename) makes
 * BM25 + surface-boost + source-weight rank it first.
 */
function candidates(): Cand[] {
  const siblings: Cand[] = Array.from({ length: 8 }, (_, i) => ({
    // Same-named siblings: filename carries `lakehouse` (so the surface boost
    // reaches them too) but the body is a generic overview that never mentions
    // the discriminating query terms — so BM25 leaves them well below the gold.
    path: `docs/fiab/parity/lakehouse-${i}.md`,
    kind: 'docs',
    content: 'lakehouse overview and general platform capabilities',
    score: 8.5 - i * 0.1,
  }));
  return [
    // AI Search's #1: a long migration doc that mentions the query terms ONCE,
    // deep in unrelated prose — high fuzzy @search.score, terrible BM25 (the
    // length normalisation crushes a single mention in ~360 tokens).
    {
      path: NOISE,
      kind: 'docs',
      content: `liquid clustering ${'unrelated migration prose '.repeat(120)}`,
      score: 9.5,
    },
    ...siblings,
    // An engineering-ledger doc that DOES match the terms — must be
    // down-weighted below the product gold doc (source class `ledger` = 0.75).
    {
      path: 'PRPs/active/lake/AUDIT.md',
      kind: 'prp',
      content: 'lakehouse liquid clustering audit receipt',
      score: 7.0,
    },
    // The gold doc — lowest @search.score, richest on the query terms.
    {
      path: GOLD,
      kind: 'docs',
      content:
        'liquid clustering rewrites the delta layout; liquid clustering '
        + 'replaces partitioning; the lakehouse runs liquid clustering automatically',
      score: 1.5,
    },
  ];
}

// ── Cosmos backend mock (used by the equality arm) ───────────────────────────
let corpus: Array<{ id: string; kind: string; path: string; heading?: string; content: string; touchedAt: string }> = [];

function makeCorpusContainer() {
  const container: any = {
    items: {
      upsert: vi.fn(async (d: any) => ({ resource: d })),
      query: vi.fn(() => ({ fetchAll: async () => ({ resources: corpus }) })),
    },
    item: () => ({ read: vi.fn(async () => ({ resource: null })) }),
  };
  container.database = { containers: { createIfNotExists: vi.fn(async () => ({ container })) } };
  return container;
}
let corpusContainer = makeCorpusContainer();
vi.mock('@/lib/azure/cosmos-client', () => ({
  copilotSessionsContainer: async () => corpusContainer,
}));

// ── AI Search fetch mock — returns the candidate window as an AI Search page,
//    and records the requested `top` (the candidate-window width) so a test can
//    assert the over-fetch is WIDE. Closure reads module-level state at call
//    time (same pattern as corpusContainer above). ─────────────────────────────
let aiSearchValue: Cand[] = [];
let lastSearchTop: number | undefined;
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: async (url: string, init?: any) => {
    if (String(url).includes('/docs/search')) {
      try { lastSearchTop = JSON.parse(String(init?.body)).top; } catch { /* ignore */ }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          value: aiSearchValue.map((c) => ({
            id: c.path, kind: c.kind, path: c.path, heading: c.heading,
            content: c.content, url: undefined, touchedAt: TS, '@search.score': c.score,
          })),
        }),
      } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  },
  DEFAULT_SERVER_FETCH_TIMEOUT_MS: 30_000,
}));

// All retrieval kill-switches ON (default per loom_default_on_opt_out).
const flagMock = vi.fn(async () => true);
vi.mock('@/lib/admin/runtime-flags', () => ({ runtimeFlag: (id: string) => flagMock(id as never) }));

vi.mock('@azure/identity', async () => {
  const real = await vi.importActual<any>('@azure/identity');
  class StubCred { async getToken() { return { token: 't', expiresOnTimestamp: Date.now() + 60_000 }; } }
  return { ...real, DefaultAzureCredential: StubCred, ManagedIdentityCredential: StubCred, ChainedTokenCredential: StubCred };
});

import { searchDocs, resetDocsRankerCache, AI_SEARCH_CANDIDATE_WINDOW, __testInternals } from '../loom-docs-index';
import { buildCorpusStats } from '../docs-ranker';

const asChunks = () =>
  candidates().map((c) => ({ id: c.path, kind: c.kind, path: c.path, heading: c.heading, content: c.content, touchedAt: TS }));

beforeEach(() => {
  corpusContainer = makeCorpusContainer();
  resetDocsRankerCache();
  flagMock.mockReset().mockResolvedValue(true);
  aiSearchValue = candidates();
  corpus = asChunks();
  lastSearchTop = undefined;
  delete process.env.LOOM_AI_SEARCH_SERVICE;
  // #2970 — the AI Search path now scores its candidate window against
  // CORPUS-WIDE BM25 statistics rather than the window's own (see
  // docs-ranker.Bm25CorpusStats). In production both backends therefore use the
  // same statistics: the Cosmos path because its index IS the corpus, the AI
  // Search path because those statistics are built from the same bundled corpus
  // the reindex populated Cosmos from. This suite's corpus is synthetic, so it
  // has to say which corpus that is — otherwise the AI Search arm would score
  // against the repo's REAL docs while the Cosmos arm scored against these 11,
  // and the backend-symmetry assertion below would fail for a reason unrelated
  // to what it tests.
  __testInternals.setCorpusStatsForTests(buildCorpusStats(asChunks()));
});

afterEach(() => {
  __testInternals.setCorpusStatsForTests(undefined);
});

describe('searchDocs — AI Search retrieve-then-rerank (#2929)', () => {
  // MUTATION PROOF: the gold doc has the LOWEST @search.score of any candidate,
  // so the pre-#2929 path (which only re-sorted AI Search's window by
  // score × surfaceBoost × sourceWeight) leaves a same-named sibling on top —
  // `docs/fiab/parity/lakehouse-0.md` scores 8.5×1.35 ≈ 11.5 vs the gold's
  // 1.5×1.35 ≈ 2.0. Only routing the candidates through the shared BM25 ranker
  // (which sees the gold's high term frequency + short length) surfaces it.
  it('over-fetches a wide window and surfaces the gold doc to #1', async () => {
    process.env.LOOM_AI_SEARCH_SERVICE = 'loom-search';
    const { hits, backend } = await searchDocs(QUERY, 8, undefined, { surface: 'lakehouse' });
    expect(backend).toBe('ai-search');
    expect(hits[0].path).toBe(GOLD);
    // The gold was NOT AI Search's top candidate — proving the win came from
    // the re-rank, not from AI Search's own ordering.
    expect(aiSearchValue[0].path).not.toBe(GOLD);
    // Scores are re-normalised to the documented 0..1 contract by the ranker.
    expect(hits[0].score).toBeCloseTo(1, 10);
  });

  it('pulls a candidate window at least AI_SEARCH_CANDIDATE_WINDOW wide', async () => {
    process.env.LOOM_AI_SEARCH_SERVICE = 'loom-search';
    await searchDocs(QUERY, 8, undefined, { surface: 'lakehouse' });
    expect(lastSearchTop).toBeGreaterThanOrEqual(AI_SEARCH_CANDIDATE_WINDOW);
  });

  // The core invariant of the reuse: for the SAME candidate documents, the AI
  // Search path and the measured Cosmos path return the SAME top-N ordering.
  it('produces the SAME top-N ordering as the Cosmos path for the same candidates', async () => {
    process.env.LOOM_AI_SEARCH_SERVICE = 'loom-search';
    const ai = await searchDocs(QUERY, 8, undefined, { surface: 'lakehouse' });
    expect(ai.backend).toBe('ai-search');

    resetDocsRankerCache();
    delete process.env.LOOM_AI_SEARCH_SERVICE; // force the Cosmos backend
    const cosmos = await searchDocs(QUERY, 8, undefined, { surface: 'lakehouse' });
    expect(cosmos.backend).toBe('cosmos');

    expect(ai.hits.map((h) => h.path)).toEqual(cosmos.hits.map((h) => h.path));
    expect(ai.hits[0].path).toBe(GOLD);
  });

  // MUTATION PROOF for #2970: the AI Search path must actually CONSULT the
  // corpus statistics. Point them at a corpus in which the discriminating query
  // terms are ubiquitous and the ordering has to change; if `corpusStats` is
  // ever dropped from the `rankChunks` call this assertion cannot move, because
  // the window-local statistics would be identical either way.
  it('the AI Search re-rank actually consults the corpus statistics (#2970)', async () => {
    process.env.LOOM_AI_SEARCH_SERVICE = 'loom-search';
    const withRealStats = await searchDocs(QUERY, 8, undefined, { surface: 'lakehouse' });
    expect(withRealStats.hits[0].path).toBe(GOLD);

    // A corpus where `liquid` and `clustering` appear in EVERY document: they
    // stop discriminating, so the gold doc's advantage on them evaporates.
    resetDocsRankerCache();
    __testInternals.setCorpusStatsForTests(
      buildCorpusStats(
        Array.from({ length: 500 }, (_, i) => ({
          path: `docs/filler-${i}.md`,
          content: 'liquid clustering lakehouse delta partitioning layout rewrite',
        })),
      ),
    );
    const withFlatStats = await searchDocs(QUERY, 8, undefined, { surface: 'lakehouse' });
    expect(withFlatStats.hits.map((h) => h.path)).not.toEqual(withRealStats.hits.map((h) => h.path));
  });

  it('falls back to window-local statistics when no corpus is reachable', async () => {
    // Honest degradation (dev checkout / an image built without the corpus
    // staging step): null stats must rank exactly as the pre-#2970 path did,
    // never throw and never score against a zero-sized corpus.
    process.env.LOOM_AI_SEARCH_SERVICE = 'loom-search';
    __testInternals.setCorpusStatsForTests(null);
    const { hits, backend } = await searchDocs(QUERY, 8, undefined, { surface: 'lakehouse' });
    expect(backend).toBe('ai-search');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toBe(GOLD);
  });

  // With the BM25 kill-switch OFF, the AI Search path reverts to its native
  // order (pre-#2929) — proving the re-rank is gated by `copilot-bm25-retrieval`
  // and the revert target is intact.
  it('honours the copilot-bm25-retrieval kill-switch (OFF = AI Search native order)', async () => {
    process.env.LOOM_AI_SEARCH_SERVICE = 'loom-search';
    flagMock.mockImplementation(async (id: string) => id !== 'copilot-bm25-retrieval');
    const { hits, backend } = await searchDocs(QUERY, 8, undefined, { surface: 'lakehouse' });
    expect(backend).toBe('ai-search');
    // AI Search's own #1 (the high-@search.score noise doc), not the gold.
    expect(hits[0].path).toBe(NOISE);
  });
});

describe('rankChunks — shared re-rank core (#2929, direct)', () => {
  // Pure-function proof (no Next runtime, no backend): the exact function the AI
  // Search branch calls surfaces the gold doc from a candidate set that buries
  // it on any presence-only or score-passthrough ordering.
  it('ranks the gold doc first among AI-Search-shaped candidates', () => {
    const ranked = __testInternals.rankChunks(asChunks() as any, QUERY, 8, {
      bm25: true, surfaceTerms: ['lakehouse'], sourceWeights: true,
    });
    expect(ranked[0].path).toBe(GOLD);
    // Ledger doc is present but down-weighted below the product gold doc.
    const ledgerIdx = ranked.findIndex((h) => h.path === 'PRPs/active/lake/AUDIT.md');
    const goldIdx = ranked.findIndex((h) => h.path === GOLD);
    expect(goldIdx).toBeGreaterThanOrEqual(0);
    expect(goldIdx).toBeLessThan(ledgerIdx);
  });

  // Kill-switch parity: bm25:false restores the byte-identical pre-#2585
  // term-presence ranker. The decisive distinguisher from BM25 is NORMALISATION
  // — BM25 always normalises its top hit to exactly 1.0, while the legacy scorer
  // returns the raw 0..1 term-presence ratio. Flip bm25 → true and this goes RED.
  it('bm25:false falls back to the legacy term-presence ranker (no BM25 normalisation)', () => {
    const ranked = __testInternals.rankChunks(asChunks() as any, QUERY, 8, {
      bm25: false, surfaceTerms: ['lakehouse'], sourceWeights: true,
    });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].score).toBeLessThan(1);
    expect(ranked[0].score).not.toBeCloseTo(1, 5);
    // The surface boost / source weighting are BM25-only knobs — the legacy
    // scores stay the plain 0..1 term-presence ratio.
    expect(ranked.every((h) => h.score > 0 && h.score <= 1)).toBe(true);
  });
});
