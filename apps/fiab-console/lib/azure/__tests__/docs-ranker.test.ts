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
  diversifyByDocument,
  rankSubstring,
  surfaceTopicTerms,
  surfaceBoostFactor,
  titleTokensFor,
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
