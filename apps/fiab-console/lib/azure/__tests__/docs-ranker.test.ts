/**
 * docs-ranker — unit tests (issue #2585 P0/P1).
 *
 * Each test names the DEFECT it catches. None of them asserts the ranker
 * against the ranker: every expectation is either an externally-computed BM25
 * value, a structural property that the old ranker demonstrably violated, or a
 * hand-built corpus whose correct answer is obvious by inspection.
 */
import { describe, it, expect } from 'vitest';
import {
  tokenize,
  buildBm25Index,
  bm25Rank,
  buildCorpusStats,
  createCorpusStatsAccumulator,
  diversifyByDocument,
  rankSubstring,
  surfaceTopicTerms,
  surfaceBoostFactor,
  titleTokensFor,
  corpusSourceClass,
  sourceWeightFor,
  DEFAULT_SOURCE_WEIGHTS,
  NEUTRAL_SOURCE_WEIGHTS,
  BM25_K1,
  BM25_B,
  RANKER_STOPWORDS,
} from '../docs-ranker';

const chunk = (path: string, content: string, heading?: string) => ({ path, content, heading });

describe('tokenize', () => {
  // Catches: stopwords surviving into scoring — the pre-#2585 ranker kept
  // "how"/"does"/"the" and weighted them exactly as heavily as "lakehouse".
  it('drops stopwords and sub-3-character tokens', () => {
    expect(tokenize('How does the lakehouse work?')).toEqual(['lakehouse', 'work']);
    expect(RANKER_STOPWORDS.has('how')).toBe(true);
  });

  // Catches: a regression back to substring matching. `text.includes('report')`
  // matched "reported"/"reporting"; token matching must not.
  it('emits whole tokens, so "report" does not match "reporting"', () => {
    expect(tokenize('reporting reported report')).toEqual(['reporting', 'reported', 'report']);
    expect(tokenize('reporting')).not.toContain('report');
  });

  it('is null-safe', () => {
    expect(tokenize(undefined)).toEqual([]);
    expect(tokenize('')).toEqual([]);
  });
});

describe('buildBm25Index', () => {
  // Catches: a broken postings/length build. Values are counted by hand from
  // the two chunks below, not read back out of the ranker.
  it('records document frequency and mean length independently of query time', () => {
    const idx = buildBm25Index([
      chunk('a.md', 'lakehouse lakehouse delta'), // 3 tokens
      chunk('b.md', 'delta warehouse'), // 2 tokens
    ]);
    expect(idx.size).toBe(2);
    expect(idx.avgdl).toBeCloseTo(2.5, 10);
    // 'delta' appears in both chunks → 2 postings pairs; 'lakehouse' in one.
    expect(idx.postings.get('delta')!.length / 2).toBe(2);
    expect(idx.postings.get('lakehouse')!.length / 2).toBe(1);
    // …with term frequency 2, which the old presence-only scorer could not see.
    expect(idx.postings.get('lakehouse')).toEqual([0, 2]);
  });
});

describe('bm25Rank', () => {
  // Catches: a missing/incorrect IDF. This is the single defect that made the
  // old ranker score 14k-27k chunks per question. The expected value is
  // computed from the Okapi formula by hand below — NOT from bm25Rank.
  it('scores a rare term far above a corpus-wide one (IDF)', () => {
    const corpus = [
      chunk('rare.md', 'lakehouse'),
      ...Array.from({ length: 99 }, (_, i) => chunk(`common-${i}.md`, 'platform')),
    ];
    corpus[0] = chunk('rare.md', 'lakehouse platform');
    const idx = buildBm25Index(corpus);
    const rare = bm25Rank(idx, 'lakehouse', 1)[0];
    const common = bm25Rank(idx, 'platform', 1)[0];

    const N = 100;
    const idfRare = Math.log(1 + (N - 1 + 0.5) / (1 + 0.5));
    const idfCommon = Math.log(1 + (N - 100 + 0.5) / (100 + 0.5));
    expect(idfRare).toBeGreaterThan(idfCommon * 10);
    expect(rare.score).toBeGreaterThan(common.score * 10);
  });

  // Catches: a missing term-frequency saturation term. Independently computed.
  it('matches the Okapi BM25 closed form on a two-document corpus', () => {
    const corpus = [
      chunk('a.md', 'delta delta delta'), // len 3, tf 3
      chunk('b.md', 'warehouse'), // len 1
    ];
    const idx = buildBm25Index(corpus);
    const [top] = bm25Rank(idx, 'delta', 1);

    const N = 2;
    const df = 1;
    const avgdl = 2;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const norm = 1 - BM25_B + BM25_B * (3 / avgdl);
    const expected = idf * ((3 * (BM25_K1 + 1)) / (3 + BM25_K1 * norm));

    expect(top.index).toBe(0);
    expect(top.score).toBeCloseTo(expected, 10);
  });

  // Catches: no length normalisation. A 2000-token page that mentions the term
  // once must not outrank a short page that is ABOUT the term.
  it('prefers a short on-topic chunk over a long chunk that merely mentions the term', () => {
    const idx = buildBm25Index([
      chunk('long.md', `${'filler '.repeat(500)}shortcuts`),
      chunk('short.md', 'shortcuts shortcuts'),
    ]);
    const ranked = bm25Rank(idx, 'shortcuts', 2);
    expect(ranked[0].index).toBe(1);
  });

  // Catches: reintroduction of arbitrary store-order tie-breaking. Equal scores
  // must resolve deterministically (by index), never by insertion accident.
  it('breaks exact ties deterministically', () => {
    const idx = buildBm25Index([chunk('a.md', 'delta'), chunk('b.md', 'delta'), chunk('c.md', 'delta')]);
    const a = bm25Rank(idx, 'delta', 3).map((r) => r.index);
    const b = bm25Rank(idx, 'delta', 3).map((r) => r.index);
    expect(a).toEqual([0, 1, 2]);
    expect(a).toEqual(b);
  });

  it('returns nothing for an all-stopword or empty query', () => {
    const idx = buildBm25Index([chunk('a.md', 'delta')]);
    expect(bm25Rank(idx, 'how do I', 5)).toEqual([]);
    expect(bm25Rank(idx, '', 5)).toEqual([]);
    expect(bm25Rank(idx, 'delta', 0)).toEqual([]);
  });

  // Catches: the title boost silently becoming default-on. It is measured to
  // COST kql-database -0.133 and health -0.067, so it must stay opt-in.
  it('applies no filename/heading boost unless one is explicitly requested', () => {
    const idx = buildBm25Index([
      chunk('other.md', 'delta delta'),
      chunk('delta.md', 'delta'),
    ]);
    expect(bm25Rank(idx, 'delta', 1)[0].index).toBe(0);
    expect(bm25Rank(idx, 'delta', 1, { titleBoost: 5 })[0].index).toBe(1);
  });

  // Catches: the surface boost being applied when no surface is in play, and
  // the boost failing to promote an on-topic document.
  it('promotes an on-topic document only when surface terms are supplied', () => {
    const corpus = [
      chunk('topology-migration.md', 'share access grant share access grant'),
      chunk('lakehouse.md', 'share access grant'),
    ];
    const idx = buildBm25Index(corpus);
    expect(bm25Rank(idx, 'share access grant', 1)[0].index).toBe(0);
    const scoped = bm25Rank(idx, 'share access grant', 1, {
      surfaceTerms: surfaceTopicTerms('lakehouse'),
      surfaceBoost: 1,
    });
    expect(scoped[0].index).toBe(1);
  });
});

describe('diversifyByDocument', () => {
  // Catches: the top-K window collapsing onto one document. The measured
  // top-5 window held only 4.2-4.75 distinct documents.
  it('caps chunks per document and backfills from the next document', () => {
    const ranked = [
      chunk('a.md', ''), chunk('a.md', ''), chunk('a.md', ''), chunk('a.md', ''),
      chunk('b.md', ''), chunk('c.md', ''),
    ];
    const out = diversifyByDocument(ranked, 4, 2);
    expect(out.map((c) => c.path)).toEqual(['a.md', 'a.md', 'b.md', 'c.md']);
  });

  // Catches: diversification TRUNCATING the window instead of backfilling —
  // i.e. returning fewer hits than asked for and losing recall.
  it('never returns fewer results than the undiversified window would', () => {
    const ranked = [chunk('a.md', ''), chunk('a.md', ''), chunk('a.md', ''), chunk('a.md', '')];
    const out = diversifyByDocument(ranked, 3, 1);
    expect(out).toHaveLength(3);
    expect(out.map((c) => c.path)).toEqual(['a.md', 'a.md', 'a.md']);
  });

  // Catches: reordering that is not rank-stable within a document group.
  it('preserves relative rank order among the kept results', () => {
    const ranked = [
      { path: 'a.md', tag: 1 }, { path: 'b.md', tag: 2 },
      { path: 'a.md', tag: 3 }, { path: 'a.md', tag: 4 }, { path: 'c.md', tag: 5 },
    ];
    expect(diversifyByDocument(ranked, 4, 2).map((r) => r.tag)).toEqual([1, 2, 3, 5]);
  });

  it('is case-insensitive on the document path and a no-op at maxPerDoc <= 0', () => {
    const ranked = [chunk('A.md', ''), chunk('a.md', ''), chunk('b.md', '')];
    expect(diversifyByDocument(ranked, 2, 1).map((c) => c.path)).toEqual(['A.md', 'b.md']);
    expect(diversifyByDocument(ranked, 2, 0).map((c) => c.path)).toEqual(['A.md', 'a.md']);
  });
});

describe('surface scoping', () => {
  // Catches: a hand-curated surface->topic map creeping in. The mapping must
  // stay mechanically derived from the slug, or it is fitted to the golden set.
  it('derives topic terms mechanically from the surface slug', () => {
    expect(surfaceTopicTerms('kql-database')).toEqual(['kql', 'database']);
    expect(surfaceTopicTerms('lakehouse')).toEqual(['lakehouse']);
    expect(surfaceTopicTerms('health')).toEqual(['health']);
    expect(surfaceTopicTerms(undefined)).toEqual([]);
    expect(surfaceTopicTerms(null)).toEqual([]);
  });

  // Catches: the boost turning into a filter. An off-topic chunk must keep its
  // score (factor exactly 1), never be dropped or penalised.
  it('is a multiplier on on-topic chunks and exactly 1 otherwise', () => {
    const terms = surfaceTopicTerms('lakehouse');
    expect(surfaceBoostFactor(terms, chunk('docs/fiab/parity/lakehouse.md', 'x'), 0.35)).toBeCloseTo(1.35, 10);
    expect(surfaceBoostFactor(terms, chunk('docs/fiab/topology-migration.md', 'x'), 0.35)).toBe(1);
    expect(surfaceBoostFactor([], chunk('docs/fiab/parity/lakehouse.md', 'x'), 0.35)).toBe(1);
    expect(surfaceBoostFactor(terms, chunk('docs/fiab/parity/lakehouse.md', 'x'), 0)).toBe(1);
  });

  it('matches the surface in a heading as well as a filename', () => {
    const terms = surfaceTopicTerms('lakehouse');
    expect(surfaceBoostFactor(terms, chunk('docs/other.md', 'x', 'Lakehouse shortcuts'))).toBeGreaterThan(1);
  });

  it('tokenises the filename stem and heading, dropping the extension', () => {
    expect([...titleTokensFor(chunk('docs/fiab/parity/kql-database.md', ''))].sort())
      .toEqual(['database', 'kql']);
  });
});

describe('corpus source weighting (#2585 P2)', () => {
  it('classifies the engineering ledger, reference material and archives apart from product docs', () => {
    expect(corpusSourceClass('docs/fiab/parity/monitor.md')).toBe('product');
    expect(corpusSourceClass('docs/fiab/admin/health.md')).toBe('product');
    expect(corpusSourceClass('docs/fiab/concepts/what-is-csa-loom.md')).toBe('product');
    expect(corpusSourceClass('PRPs/active/loom-apex/PRP.md')).toBe('ledger');
    expect(corpusSourceClass('PRPs/completed/csa-loom-pillar/PRP-17-operations-docs.md')).toBe('ledger');
    expect(corpusSourceClass('docs/fiab/prp/data-marketplace.md')).toBe('ledger');
    expect(corpusSourceClass('docs/fiab/audit/anything.md')).toBe('ledger');
    expect(corpusSourceClass('docs/fiab/parity-gap/lakehouse.md')).toBe('ledger');
    expect(corpusSourceClass('docs/fiab/research/brownfield-attach-design.md')).toBe('ledger');
    expect(corpusSourceClass('docs/fiab/archive/TEST_SCRIPT_2026_05_27.md')).toBe('archive');
    expect(corpusSourceClass('docs/learn/07-troubleshooting/README.md')).toBe('reference');
    expect(corpusSourceClass('docs/migrations/snowflake/security-migration.md')).toBe('reference');
  });

  it('is case- and separator-insensitive, and defaults unknown paths to product', () => {
    expect(corpusSourceClass('PRPs\\active\\x.md')).toBe('ledger');
    expect(corpusSourceClass('DOCS/LEARN/x.md')).toBe('reference');
    expect(corpusSourceClass('docs/something-new/x.md')).toBe('product');
    expect(corpusSourceClass(undefined)).toBe('product');
  });

  // Catches: the weights being tuned until the ledger disappears. Measured, past
  // ~0.75 the ledger contributes ZERO chunks to any of the 146 golden windows —
  // at which point the down-weight has silently become a delete and the extra
  // hit-rate is the metric being fitted.
  it('keeps the shipped weights mild enough to stay a down-weight', () => {
    expect(DEFAULT_SOURCE_WEIGHTS.product).toBe(1);
    for (const cls of ['reference', 'ledger', 'archive'] as const) {
      expect(DEFAULT_SOURCE_WEIGHTS[cls]).toBeLessThan(1);
      expect(DEFAULT_SOURCE_WEIGHTS[cls]).toBeGreaterThanOrEqual(0.7);
    }
    expect(sourceWeightFor('docs/fiab/parity/monitor.md')).toBe(1);
    expect(sourceWeightFor('PRPs/active/x.md')).toBe(DEFAULT_SOURCE_WEIGHTS.ledger);
    expect(sourceWeightFor('PRPs/active/x.md', NEUTRAL_SOURCE_WEIGHTS)).toBe(1);
  });

  // The load-bearing behaviour: a product doc that ties a ledger doc now wins.
  it('breaks a tie in favour of the published product doc', () => {
    const corpus = [
      chunk('PRPs/active/loom-apex/PRP.md', 'monitor alert authoring is planned'),
      chunk('docs/fiab/parity/monitor.md', 'monitor alert authoring is planned'),
    ];
    const index = buildBm25Index(corpus);
    // Identical text, so un-weighted the tie breaks by store order -> the ledger.
    expect(bm25Rank(index, 'monitor alert authoring', 2)[0].index).toBe(0);
    const weighted = bm25Rank(index, 'monitor alert authoring', 2, { sourceWeights: DEFAULT_SOURCE_WEIGHTS });
    expect(corpus[weighted[0].index].path).toBe('docs/fiab/parity/monitor.md');
  });

  // Catches: the down-weight becoming an exclusion. A ledger receipt must still
  // be returned when it is genuinely the best match — that is why PRPs/active
  // is in the corpus at all.
  it('still returns a ledger document when nothing better matches', () => {
    const corpus = [
      chunk('docs/fiab/parity/monitor.md', 'unrelated prose about dashboards'),
      chunk('PRPs/active/loom-apex/AUDIT.md', 'the audit receipt records the resourcegraph fastpath'),
    ];
    const index = buildBm25Index(corpus);
    const ranked = bm25Rank(index, 'audit receipt resourcegraph', 5, { sourceWeights: DEFAULT_SOURCE_WEIGHTS });
    expect(ranked.length).toBeGreaterThan(0);
    expect(corpus[ranked[0].index].path).toBe('PRPs/active/loom-apex/AUDIT.md');
  });

  it('is exactly the un-weighted ranking when no weights are supplied', () => {
    const corpus = [
      chunk('PRPs/active/a.md', 'monitor alerts'),
      chunk('docs/fiab/parity/monitor.md', 'monitor alerts'),
    ];
    const index = buildBm25Index(corpus);
    const plain = bm25Rank(index, 'monitor alerts', 2);
    const neutral = bm25Rank(index, 'monitor alerts', 2, { sourceWeights: NEUTRAL_SOURCE_WEIGHTS });
    expect(neutral.map((r) => r.index)).toEqual(plain.map((r) => r.index));
    expect(neutral.map((r) => r.score)).toEqual(plain.map((r) => r.score));
  });
});

describe('rankSubstring (kill-switch path)', () => {
  // Catches: "improving" the legacy scorer. Its ONLY contract is to be what
  // shipped before, so the flag-off revert is byte-identical, not an
  // approximation. These expectations are the old formula computed by hand.
  it('is unchanged boolean term presence with headings double-counted', () => {
    // 2 terms; both present in content, neither in the heading → 2 / (2*2).
    expect(rankSubstring('lakehouse shortcuts', 'lakehouse shortcuts here', 'Overview')).toBeCloseTo(0.5, 10);
    // Both present in the heading too → 4 / (2*2).
    expect(rankSubstring('lakehouse shortcuts', 'body', 'lakehouse shortcuts')).toBeCloseTo(1, 10);
    // Terms of length <= 2 are dropped, leaving no terms at all.
    expect(rankSubstring('a b', 'a b', undefined)).toBe(0);
  });

  it('still matches substrings — the defect BM25 replaces, preserved for revert fidelity', () => {
    expect(rankSubstring('report', 'reporting pipeline', undefined)).toBeGreaterThan(0);
  });
});

// ── #2970 — corpus-wide BM25 statistics for a query-selected window ──────────
//
// THE DEFECT, stated as a property rather than as an implementation shape:
// when the index handed to `bm25Rank` is a CANDIDATE WINDOW (every member
// selected because it matches the query), the window's own document
// frequencies say every query term is ubiquitous, so IDF collapses for all of
// them together and the ranker can no longer tell a rare discriminating term
// from a common one. Substituting corpus-wide statistics restores it.
describe('bm25Rank — corpusStats (#2970)', () => {
  // Two documents. Both carry the common term; only the gold one carries the
  // rare term. Across the CORPUS the rare term appears in 1 of 200 chunks, so it
  // holds almost all the discriminating power — but inside a candidate WINDOW of
  // just these two, both terms look equally (un)common.
  const gold = { path: 'docs/gold.md', heading: 'Gold', content: `eventstream telemetry ${'filler '.repeat(20)}` };
  const decoy = { path: 'docs/decoy.md', heading: 'Decoy', content: `telemetry telemetry telemetry telemetry ${'filler '.repeat(20)}` };
  const windowChunks = [gold, decoy];

  /** A corpus where `telemetry` is everywhere and `eventstream` is rare. */
  const corpus = [
    gold,
    decoy,
    ...Array.from({ length: 198 }, (_, i) => ({
      path: `docs/other-${i}.md`,
      heading: `Other ${i}`,
      content: `telemetry ${'filler '.repeat(20)}`,
    })),
  ];

  it('window-local statistics COMPRESS the rare term\'s advantage — the shipped defect', () => {
    // The mechanism, asserted as a ratio rather than as a specific flip (the
    // aggregate flip evidence is the harness receipt cited above: 0.797 vs
    // 0.889 over 153 golden rows). Inside a query-selected window every query
    // term looks ubiquitous, so IDF collapses for all of them TOGETHER and the
    // ranker loses its ability to weight `eventstream` above `telemetry`.
    const idx = buildBm25Index(windowChunks);
    const scoreOf = (opts: object) => {
      const m = new Map(bm25Rank(idx, 'eventstream telemetry', 2, opts).map((h) => [windowChunks[h.index].path, h.score]));
      return m.get('docs/gold.md')! / m.get('docs/decoy.md')!;
    };
    const windowRatio = scoreOf({});
    const corpusRatio = scoreOf({ corpusStats: buildCorpusStats(corpus) });
    // `eventstream` is 1-in-200 in the corpus and 1-in-2 in the window, so the
    // corpus knows it is ~4.9 nats' worth of evidence where the window thinks
    // it is ~0.7. The gold document's lead must be materially larger under
    // corpus statistics.
    expect(corpusRatio).toBeGreaterThan(windowRatio * 2);
  });

  it('corpus-wide statistics put the gold document first', () => {
    const idx = buildBm25Index(windowChunks);
    const ranked = bm25Rank(idx, 'eventstream telemetry', 2, { corpusStats: buildCorpusStats(corpus) });
    // `eventstream` is 1-in-200 across the corpus; that IDF dominates the
    // decoy's raw term frequency — the behaviour BM25 is supposed to have, and
    // the reason full-corpus ranking scored 0.889 over the golden sets where the
    // window-local path scored 0.797.
    expect(windowChunks[ranked[0].index].path).toBe('docs/gold.md');
  });

  it('ranks a window with corpus stats identically to ranking the whole corpus', () => {
    // The property the production fix relies on: BM25 scores are independent per
    // chunk, so scoring a subset against corpus statistics gives the same ORDER
    // as scoring the corpus and then keeping the subset.
    const windowOrder = bm25Rank(buildBm25Index(windowChunks), 'eventstream telemetry', 2, {
      corpusStats: buildCorpusStats(corpus),
    }).map((h) => windowChunks[h.index].path);
    const corpusOrder = bm25Rank(buildBm25Index(corpus), 'eventstream telemetry', corpus.length)
      .map((h) => corpus[h.index].path)
      .filter((p) => p === 'docs/gold.md' || p === 'docs/decoy.md');
    expect(windowOrder).toEqual(corpusOrder);
  });

  it('omitting corpusStats is byte-identical to before the option existed', () => {
    const idx = buildBm25Index(windowChunks);
    expect(bm25Rank(idx, 'eventstream telemetry', 2, { corpusStats: null }))
      .toEqual(bm25Rank(idx, 'eventstream telemetry', 2));
  });

  it('treats a term the corpus has never seen as maximally rare, not as locally common', () => {
    // Mixing the two statistic sources inside one score is the bug being fixed,
    // so an unknown term takes df 0 rather than falling back to the window count.
    const stats = buildCorpusStats([{ path: 'docs/x.md', content: 'unrelated words here' }]);
    const ranked = bm25Rank(buildBm25Index(windowChunks), 'eventstream', 2, { corpusStats: stats });
    expect(windowChunks[ranked[0].index].path).toBe('docs/gold.md');
  });
});

describe('createCorpusStatsAccumulator', () => {
  it('counts each chunk once per DISTINCT term (document frequency, not term frequency)', () => {
    const acc = createCorpusStatsAccumulator();
    acc.add({ content: 'alpha alpha alpha beta' });
    acc.add({ content: 'beta gamma' });
    const stats = acc.finish();
    expect(stats.size).toBe(2);
    expect(stats.df.get('alpha')).toBe(1); // 3 occurrences, 1 document
    expect(stats.df.get('beta')).toBe(2);
    expect(stats.df.get('gamma')).toBe(1);
  });

  it('matches buildCorpusStats over the same chunks (streaming == batch)', () => {
    const chunks = [
      { path: 'a.md', heading: 'A', content: 'lakehouse delta storage' },
      { path: 'b.md', heading: 'B', content: 'lakehouse synapse' },
    ];
    const acc = createCorpusStatsAccumulator();
    for (const c of chunks) acc.add(c);
    const streamed = acc.finish();
    const batch = buildCorpusStats(chunks);
    expect(streamed.size).toBe(batch.size);
    expect(streamed.avgdl).toBe(batch.avgdl);
    expect([...streamed.df.entries()].sort()).toEqual([...batch.df.entries()].sort());
  });

  it('includes the heading in the counted tokens (it is indexed alongside content)', () => {
    const acc = createCorpusStatsAccumulator();
    acc.add({ heading: 'Loom coverage', content: 'body text' });
    expect(acc.finish().df.get('loom')).toBe(1);
  });

  it('an empty corpus yields size 0 and avgdl 0 rather than NaN', () => {
    const stats = createCorpusStatsAccumulator().finish();
    expect(stats.size).toBe(0);
    expect(stats.avgdl).toBe(0);
  });
});
