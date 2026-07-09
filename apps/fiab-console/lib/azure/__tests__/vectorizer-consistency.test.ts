/**
 * Unit tests for the integrated-vectorization consistency validator
 * (lib/azure/vectorizer-consistency.ts, AIF-2).
 *
 * These lock the two failure modes the designer must catch BEFORE the real
 * PUT /indexes/{name} (per .claude/rules/no-vaporware.md — surface the exact
 * remediation, don't let AI Search fail opaquely): dimension mismatch between a
 * vector field and its bound vectorizer's embedding model, and dangling
 * profile/vectorizer/algorithm references.
 */
import { describe, it, expect } from 'vitest';
import {
  embeddingModelDimensions,
  validateVectorizerConsistency,
  vectorizerErrors,
} from '../vectorizer-consistency';
import type { FieldRow, VectorProfile, Vectorizer, VectorAlgorithm } from '../search-field-shapes';

const vec = (name: string, modelName: string, deploymentId = modelName): Vectorizer => ({
  name,
  kind: 'azureOpenAI',
  azureOpenAIParameters: { resourceUri: 'https://x.openai.azure.com', deploymentId, modelName, authIdentity: null },
});
const profile = (name: string, algorithm: string, vectorizer?: string): VectorProfile => ({ name, algorithm, vectorizer });
const vectorField = (name: string, dimensions: number, vectorSearchProfile: string): FieldRow => ({
  name, type: 'Collection(Edm.Single)', dimensions, vectorSearchProfile,
});
const algo = (name: string): VectorAlgorithm => ({ name, kind: 'hnsw', hnswParameters: {} });

describe('embeddingModelDimensions', () => {
  it('resolves known models exactly', () => {
    expect(embeddingModelDimensions('text-embedding-3-large')).toBe(3072);
    expect(embeddingModelDimensions('text-embedding-3-small')).toBe(1536);
    expect(embeddingModelDimensions('text-embedding-ada-002')).toBe(1536);
  });
  it('resolves a deployment named after the model via contains-match', () => {
    expect(embeddingModelDimensions('text-embedding-3-large-prod')).toBe(3072);
  });
  it('is case-insensitive and trims', () => {
    expect(embeddingModelDimensions('  TEXT-EMBEDDING-3-SMALL ')).toBe(1536);
  });
  it('returns null for unknown / empty', () => {
    expect(embeddingModelDimensions('some-other-model')).toBeNull();
    expect(embeddingModelDimensions('')).toBeNull();
    expect(embeddingModelDimensions(undefined)).toBeNull();
    expect(embeddingModelDimensions(null)).toBeNull();
  });
});

describe('validateVectorizerConsistency', () => {
  it('returns no issues for a consistent config', () => {
    const issues = validateVectorizerConsistency({
      fields: [vectorField('vec', 3072, 'p')],
      profiles: [profile('p', 'hnsw-1', 'v')],
      vectorizers: [vec('v', 'text-embedding-3-large')],
      algorithms: [algo('hnsw-1')],
    });
    expect(issues).toEqual([]);
  });

  it('flags a dimension mismatch as an error naming both numbers', () => {
    const issues = validateVectorizerConsistency({
      fields: [vectorField('vec', 1536, 'p')],
      profiles: [profile('p', 'hnsw-1', 'v')],
      vectorizers: [vec('v', 'text-embedding-3-large')], // 3072 native
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('dimension-mismatch');
    expect(issues[0].level).toBe('error');
    expect(issues[0].message).toContain('1536');
    expect(issues[0].message).toContain('3072');
    expect(vectorizerErrors(issues)).toHaveLength(1);
  });

  it('accepts a matching 1536-dim small-model config', () => {
    const issues = validateVectorizerConsistency({
      fields: [vectorField('vec', 1536, 'p')],
      profiles: [profile('p', 'hnsw-1', 'v')],
      vectorizers: [vec('v', 'text-embedding-3-small')],
    });
    expect(issues).toEqual([]);
  });

  it('flags a field bound to an undefined profile', () => {
    const issues = validateVectorizerConsistency({
      fields: [vectorField('vec', 3072, 'ghost')],
      profiles: [],
      vectorizers: [],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('dangling-profile');
    expect(issues[0].level).toBe('error');
  });

  it('flags a profile referencing an undefined vectorizer', () => {
    const issues = validateVectorizerConsistency({
      fields: [],
      profiles: [profile('p', 'hnsw-1', 'ghost-vec')],
      vectorizers: [],
    });
    expect(issues.some((i) => i.code === 'dangling-vectorizer' && i.level === 'error')).toBe(true);
  });

  it('flags a profile referencing an undefined algorithm only when algorithms are supplied', () => {
    const withAlgos = validateVectorizerConsistency({
      fields: [], profiles: [profile('p', 'ghost-algo')], vectorizers: [], algorithms: [algo('hnsw-1')],
    });
    expect(withAlgos.some((i) => i.code === 'dangling-algorithm')).toBe(true);
    // Without algorithms the algorithm ref is not checked (the field designer owns that).
    const withoutAlgos = validateVectorizerConsistency({
      fields: [], profiles: [profile('p', 'ghost-algo')], vectorizers: [],
    });
    expect(withoutAlgos.some((i) => i.code === 'dangling-algorithm')).toBe(false);
  });

  it('warns (not errors) when the embedding model is unknown', () => {
    const issues = validateVectorizerConsistency({
      fields: [vectorField('vec', 1024, 'p')],
      profiles: [profile('p', 'hnsw-1', 'v')],
      vectorizers: [vec('v', 'my-custom-embedding')],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('unknown-embedding-model');
    expect(issues[0].level).toBe('warning');
    expect(vectorizerErrors(issues)).toHaveLength(0);
  });

  it('does not dimension-check a profile with no vectorizer (push/client-embedding model)', () => {
    const issues = validateVectorizerConsistency({
      fields: [vectorField('vec', 999, 'p')],
      profiles: [profile('p', 'hnsw-1')], // no vectorizer → dims can't be inferred
      vectorizers: [],
    });
    expect(issues).toEqual([]);
  });

  it('ignores non-vector fields entirely', () => {
    const issues = validateVectorizerConsistency({
      fields: [{ name: 'title', type: 'Edm.String' }],
      profiles: [], vectorizers: [],
    });
    expect(issues).toEqual([]);
  });

  it('resolves dims via deploymentId when modelName is empty', () => {
    const v: Vectorizer = {
      name: 'v', kind: 'azureOpenAI',
      azureOpenAIParameters: { resourceUri: 'https://x.openai.azure.com', deploymentId: 'text-embedding-3-large', modelName: '', authIdentity: null },
    };
    const issues = validateVectorizerConsistency({
      fields: [vectorField('vec', 1536, 'p')],
      profiles: [profile('p', 'hnsw-1', 'v')],
      vectorizers: [v],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('dimension-mismatch');
    expect(issues[0].message).toContain('3072');
  });
});
