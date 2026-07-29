/**
 * searchDocs retrieval-pipeline tests (issue #2585 P0/P1).
 *
 * Covers the Cosmos-fallback path end to end — ranker, over-fetch,
 * per-document diversification, surface boost, retrieval window, and the
 * kill-switches — against a hand-built corpus whose correct answer is obvious
 * by inspection. AI Search is deliberately left unconfigured so the pipeline
 * under test is the one the offline harness measures.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Row { id: string; kind: string; path: string; heading?: string; content: string; touchedAt: string }

let corpus: Row[] = [];

/** One stable container for every helpCorpusContainer() call. */
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

const flagMock = vi.fn(async () => true);
vi.mock('@/lib/admin/runtime-flags', () => ({ runtimeFlag: (id: string) => flagMock(id as never) }));

vi.mock('@azure/identity', async () => {
  const real = await vi.importActual<any>('@azure/identity');
  class StubCred { async getToken() { return { token: 't', expiresOnTimestamp: Date.now() + 60_000 }; } }
  return { ...real, DefaultAzureCredential: StubCred, ManagedIdentityCredential: StubCred, ChainedTokenCredential: StubCred };
});

import { searchDocs, resetDocsRankerCache, DEFAULT_DOC_RETRIEVAL_TOP } from '../loom-docs-index';

const row = (path: string, content: string, heading?: string): Row => ({
  id: `${path}:${heading ?? ''}:${content.slice(0, 12)}`,
  kind: 'docs', path, heading, content, touchedAt: '2026-07-28T00:00:00Z',
});

/** Filler documents so IDF has a corpus to work against. */
const filler = (n: number) =>
  Array.from({ length: n }, (_, i) => row(`docs/filler-${i}.md`, 'platform overview platform overview'));

beforeEach(() => {
  corpusContainer = makeCorpusContainer();
  resetDocsRankerCache();
  flagMock.mockReset().mockResolvedValue(true);
  delete process.env.LOOM_AI_SEARCH_SERVICE;
  corpus = [];
});

describe('searchDocs — BM25 ranker (P0)', () => {
  // Catches a revert to term-presence scoring. `noise.md` mentions every query
  // term once, so the OLD ranker scored it identically to the document that is
  // actually about liquid clustering — and broke the tie by store order, which
  // put the noise document first. Only a ranker with term frequency and length
  // normalisation puts the real answer on top.
  it('ranks the document ABOUT the terms above one that merely mentions them', async () => {
    corpus = [
      row('docs/noise.md', `liquid clustering ${'unrelated '.repeat(400)}`),
      row('docs/fiab/parity/lakehouse.md', 'liquid clustering rewrites the delta layout; liquid clustering replaces partitioning'),
      ...filler(60),
    ];
    const { hits, backend } = await searchDocs('How does liquid clustering work?', 3);
    expect(backend).toBe('cosmos');
    expect(hits[0].path).toBe('docs/fiab/parity/lakehouse.md');
  });

  // Catches the loss of IDF: without it, a question's stopwords and its
  // discriminating term count the same, which is what produced 14k-27k scoring
  // chunks per question.
  it('ignores stopwords entirely, so an all-stopword query retrieves nothing', async () => {
    corpus = [row('docs/a.md', 'how do I use this'), ...filler(10)];
    const { hits } = await searchDocs('how do I use this', 5);
    expect(hits).toEqual([]);
  });

  // Catches a normalisation regression: DocHit.score is a documented 0..1 value
  // rendered in citations, but raw BM25 is unbounded above.
  it('normalises scores into the documented 0..1 range', async () => {
    corpus = [row('docs/a.md', 'eventstream eventstream eventstream'), row('docs/b.md', 'eventstream'), ...filler(40)];
    const { hits } = await searchDocs('eventstream', 2);
    expect(hits[0].score).toBeCloseTo(1, 10);
    expect(hits[1].score).toBeGreaterThan(0);
    expect(hits[1].score).toBeLessThan(1);
  });
});

describe('searchDocs — diversification + window (P1)', () => {
  // Catches the measured 4.2-4.75-distinct-documents-per-5-slot defect: one
  // document is allowed to eat the whole recall window.
  it('caps one document to 2 slots and fills the rest from other documents', async () => {
    corpus = [
      ...Array.from({ length: 8 }, (_, i) => row('docs/hoarder.md', `shortcuts shortcuts shortcuts ${i}`, `H${i}`)),
      row('docs/second.md', 'shortcuts shortcuts'),
      row('docs/third.md', 'shortcuts'),
      ...filler(40),
    ];
    const { hits } = await searchDocs('shortcuts', 4);
    expect(hits).toHaveLength(4);
    // Undiversified, `hoarder.md` outranks both others on every slot and takes
    // all four. Capped, it takes two and both other documents get in.
    expect(hits.filter((h) => h.path === 'docs/hoarder.md')).toHaveLength(2);
    expect(hits.map((h) => h.path)).toContain('docs/second.md');
    expect(hits.map((h) => h.path)).toContain('docs/third.md');
  });

  // Catches diversification silently shrinking the window when the corpus
  // genuinely has only one relevant document.
  it('still returns a full window when only one document matches', async () => {
    corpus = [
      ...Array.from({ length: 6 }, (_, i) => row('docs/only.md', `eventhouse ${i}`, `H${i}`)),
      ...filler(40),
    ];
    const { hits } = await searchDocs('eventhouse', 4);
    expect(hits).toHaveLength(4);
  });

  it('defaults to the widened window and honours the window kill-switch', async () => {
    corpus = [...Array.from({ length: 20 }, (_, i) => row(`docs/d${i}.md`, 'warehouse')), ...filler(40)];
    expect((await searchDocs('warehouse')).hits).toHaveLength(DEFAULT_DOC_RETRIEVAL_TOP);

    resetDocsRankerCache();
    flagMock.mockImplementation(async (id: string) => id !== 'copilot-retrieval-window-8');
    expect((await searchDocs('warehouse')).hits).toHaveLength(5);
  });
});

describe('searchDocs — surface scoping (P1b)', () => {
  // Catches the surface parameter being accepted and dropped (the P1b defect):
  // without the boost the crowded neighbour wins on raw term statistics.
  it('promotes the on-surface document without excluding anything', async () => {
    corpus = [
      row('docs/fiab/topology-migration.md', 'share grant access share grant access share grant access'),
      row('docs/fiab/parity/lakehouse.md', 'share grant access'),
      ...filler(60),
    ];
    const unscoped = await searchDocs('share grant access', 2);
    expect(unscoped.hits[0].path).toBe('docs/fiab/topology-migration.md');

    resetDocsRankerCache();
    const scoped = await searchDocs('share grant access', 2, undefined, { surface: 'lakehouse' });
    expect(scoped.hits[0].path).toBe('docs/fiab/parity/lakehouse.md');
    // A boost, not a filter — the off-surface document is still retrievable.
    expect(scoped.hits.map((h) => h.path)).toContain('docs/fiab/topology-migration.md');
  });

  // Catches a surface slug with no topical slice (help spans the product)
  // accidentally narrowing retrieval.
  it('leaves ranking untouched for a surface no document is named after', async () => {
    corpus = [
      row('docs/fiab/topology-migration.md', 'share grant access share grant access share grant access'),
      row('docs/fiab/parity/lakehouse.md', 'share grant access'),
      ...filler(60),
    ];
    const base = (await searchDocs('share grant access', 2)).hits.map((h) => h.path);
    resetDocsRankerCache();
    const helped = (await searchDocs('share grant access', 2, undefined, { surface: 'help' })).hits.map((h) => h.path);
    expect(helped).toEqual(base);
  });
});

describe('searchDocs — kill-switches', () => {
  // Catches a revert that is not actually a revert. With the flag OFF the
  // pre-#2585 ranker must be back: term-presence scoring, no diversification,
  // so the one document that mentions every term fills the window.
  it('OFF restores the legacy term-presence ranker and drops diversification', async () => {
    corpus = [
      ...Array.from({ length: 6 }, (_, i) => row('docs/hoarder.md', `liquid clustering ${i}`, `H${i}`)),
      row('docs/fiab/parity/lakehouse.md', 'liquid clustering rewrites the delta layout; liquid clustering replaces partitioning'),
      ...filler(40),
    ];
    flagMock.mockImplementation(async (id: string) => id !== 'copilot-bm25-retrieval');
    const { hits } = await searchDocs('liquid clustering', 4);
    expect(hits.filter((h) => h.path === 'docs/hoarder.md').length).toBeGreaterThan(2);
    // Legacy scores are the 0..1 term-presence ratio, not normalised BM25.
    expect(hits[0].score).toBeCloseTo(0.5, 10);
  });

  it('OFF for the surface flag returns un-scoped ranking', async () => {
    corpus = [
      row('docs/fiab/topology-migration.md', 'share grant access share grant access share grant access'),
      row('docs/fiab/parity/lakehouse.md', 'share grant access'),
      ...filler(60),
    ];
    flagMock.mockImplementation(async (id: string) => id !== 'copilot-surface-scoped-retrieval');
    const { hits } = await searchDocs('share grant access', 2, undefined, { surface: 'lakehouse' });
    expect(hits[0].path).toBe('docs/fiab/topology-migration.md');
  });

  // #2585 P2 — the engineering ledger must stop outranking published product
  // docs on ties. Catches the weighting silently not reaching searchDocs.
  it('ranks a published product doc above an equally-matching ledger doc', async () => {
    corpus = [
      row('PRPs/active/loom-apex/PRP.md', 'monitor alert authoring rules'),
      row('docs/fiab/parity/monitor.md', 'monitor alert authoring rules'),
      ...filler(60),
    ];
    const { hits } = await searchDocs('monitor alert authoring rules', 2);
    expect(hits[0].path).toBe('docs/fiab/parity/monitor.md');
  });

  it('OFF for the source-weighting flag restores peer ranking of the ledger', async () => {
    corpus = [
      row('PRPs/active/loom-apex/PRP.md', 'monitor alert authoring rules'),
      row('docs/fiab/parity/monitor.md', 'monitor alert authoring rules'),
      ...filler(60),
    ];
    flagMock.mockImplementation(async (id: string) => id !== 'copilot-corpus-source-weighting');
    const { hits } = await searchDocs('monitor alert authoring rules', 2);
    expect(hits[0].path).toBe('PRPs/active/loom-apex/PRP.md');
  });

  // Catches the down-weight hardening into an exclusion: a ledger receipt must
  // still come back when it is genuinely the best match.
  it('still returns a ledger doc when it is the only real match', async () => {
    corpus = [
      row('docs/fiab/parity/monitor.md', 'unrelated prose about dashboards'),
      row('PRPs/active/loom-apex/AUDIT.md', 'the audit receipt records the resourcegraph fastpath'),
      ...filler(60),
    ];
    const { hits } = await searchDocs('audit receipt resourcegraph', 3);
    expect(hits[0].path).toBe('PRPs/active/loom-apex/AUDIT.md');
  });

  it('returns nothing for a blank query without touching the backend', async () => {
    const { hits, backend } = await searchDocs('   ', 5);
    expect(hits).toEqual([]);
    expect(backend).toBe('none');
    expect(flagMock).not.toHaveBeenCalled();
  });
});
