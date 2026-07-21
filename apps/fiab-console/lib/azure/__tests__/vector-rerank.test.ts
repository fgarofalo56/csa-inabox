/**
 * WS-2.2 — unit tests for the PURE fusion reranker (vector-rerank.ts). No
 * network / Azure SDK: asserts the query/rerank shaping is deterministic and
 * that the lexical signal genuinely re-orders a recall-oriented candidate set.
 */
import { describe, it, expect } from 'vitest';
import {
  rerankByFusion, lexicalOverlap, minMaxNormalize, retrievalScoreOf, queryTerms, candidateText,
} from '../vector-rerank';

describe('retrievalScoreOf', () => {
  it('prefers the semantic reranker score, then hybrid score, then backend score', () => {
    expect(retrievalScoreOf({ '@search.rerankerScore': 2.5, '@search.score': 0.9, score: 0.1 })).toBe(2.5);
    expect(retrievalScoreOf({ '@search.score': 0.9, score: 0.1 })).toBe(0.9);
    expect(retrievalScoreOf({ score: 0.1 })).toBe(0.1);
    expect(retrievalScoreOf({})).toBe(0);
  });
});

describe('queryTerms / candidateText / lexicalOverlap', () => {
  it('extracts significant deduped terms (length > 2)', () => {
    expect(queryTerms('The red FOX, the red fox!')).toEqual(['the', 'red', 'fox']);
    expect(queryTerms('a of to')).toEqual([]); // all <= 2 chars
  });
  it('pulls text from the first populated content field', () => {
    expect(candidateText({ content: 'hello' })).toBe('hello');
    expect(candidateText({ title: 'T' })).toBe('T');
    expect(candidateText({ embedding: [1, 2] })).toBe('');
  });
  it('scores fraction of query terms present in content', () => {
    expect(lexicalOverlap('red fox', 'the red fox runs')).toBe(1);
    expect(lexicalOverlap('red fox', 'the red bird')).toBe(0.5);
    expect(lexicalOverlap('red fox', 'nothing here')).toBe(0);
    expect(lexicalOverlap('', 'anything')).toBe(0);
  });
});

describe('minMaxNormalize', () => {
  it('maps to [0,1]', () => {
    expect(minMaxNormalize([0, 5, 10])).toEqual([0, 0.5, 1]);
  });
  it('maps a flat/tied array to all-1 (keeps retrieval weight)', () => {
    expect(minMaxNormalize([3, 3, 3])).toEqual([1, 1, 1]);
    expect(minMaxNormalize([7])).toEqual([1]);
  });
  it('empty → empty', () => {
    expect(minMaxNormalize([])).toEqual([]);
  });
});

describe('rerankByFusion', () => {
  it('re-orders so an exact keyword match beats a higher pure-vector score', () => {
    // b has the higher vector score but no keyword overlap; a has a lower vector
    // score but matches both query terms — a strong lexical weight lifts it.
    const candidates = [
      { id: 'b', '@search.score': 0.95, content: 'unrelated content about weather' },
      { id: 'a', '@search.score': 0.80, content: 'annual revenue report finance' },
    ];
    const ranked = rerankByFusion(candidates, 'revenue finance', 2, { retrievalWeight: 0.3, lexicalWeight: 0.7 });
    expect(ranked[0].doc.id).toBe('a');
    expect(ranked[0].lexicalScore).toBe(1);
    expect(ranked[0].rerankScore).toBeGreaterThan(ranked[1].rerankScore);
  });

  it('trims to k', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({ id: String(i), '@search.score': i, content: `doc ${i}` }));
    const ranked = rerankByFusion(candidates, 'doc', 3);
    expect(ranked).toHaveLength(3);
  });

  it('preserves retrieval order when there is no query text (lexical=0)', () => {
    const candidates = [
      { id: 'x', '@search.score': 0.9, content: 'alpha' },
      { id: 'y', '@search.score': 0.5, content: 'beta' },
      { id: 'z', '@search.score': 0.1, content: 'gamma' },
    ];
    const ranked = rerankByFusion(candidates, '', 3);
    expect(ranked.map((r) => r.doc.id)).toEqual(['x', 'y', 'z']);
  });

  it('is deterministic and stable on ties (original order wins)', () => {
    const candidates = [
      { id: 'first', '@search.score': 1, content: 'same' },
      { id: 'second', '@search.score': 1, content: 'same' },
    ];
    const ranked = rerankByFusion(candidates, 'same', 2);
    expect(ranked.map((r) => r.doc.id)).toEqual(['first', 'second']);
  });

  it('consumes the native semantic reranker score as the retrieval signal', () => {
    const candidates = [
      { id: 'lo', '@search.score': 0.99, '@search.rerankerScore': 0.5, content: 'foo' },
      { id: 'hi', '@search.score': 0.10, '@search.rerankerScore': 3.9, content: 'foo' },
    ];
    // With no lexical differentiation, the higher rerankerScore must win.
    const ranked = rerankByFusion(candidates, 'foo', 2, { retrievalWeight: 1, lexicalWeight: 0 });
    expect(ranked[0].doc.id).toBe('hi');
  });
});
