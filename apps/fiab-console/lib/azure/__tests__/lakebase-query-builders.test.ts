/**
 * DBX-4 — Lakebase query builders. Pure, no I/O: asserts the pgvector CREATE
 * EXTENSION + kNN vector-distance SQL is dialect-quoted, parameterized (never
 * interpolates the query vector), and that identifier quoting neutralises
 * injection attempts.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCreateExtensionSql, buildVectorSearchSql, toVectorLiteral, clampLimit,
  VECTOR_DISTANCE_OPTIONS, PGVECTOR_EXTENSION,
} from '../lakebase-query-builders';

describe('buildCreateExtensionSql', () => {
  it('quotes the vector extension identifier and is idempotent', () => {
    expect(buildCreateExtensionSql()).toBe('CREATE EXTENSION IF NOT EXISTS "vector"');
    expect(buildCreateExtensionSql(PGVECTOR_EXTENSION)).toContain('IF NOT EXISTS');
  });
  it('rejects any extension other than vector', () => {
    expect(() => buildCreateExtensionSql('malicious"; DROP TABLE x;--')).toThrow();
    expect(() => buildCreateExtensionSql('postgis')).toThrow();
  });
});

describe('buildVectorSearchSql', () => {
  it('binds the query vector to $1 (no interpolation) and uses the cosine operator', () => {
    const { sql, operator } = buildVectorSearchSql({ table: 'documents', vectorColumn: 'embedding', distance: 'cosine', limit: 5 });
    expect(operator).toBe('<=>');
    expect(sql).toContain('"embedding" <=> $1');
    expect(sql).toContain('ORDER BY "embedding" <=> $1');
    expect(sql).toContain('LIMIT 5');
    expect(sql).toContain('FROM "documents"');
  });

  it('maps l2 and inner_product to the right operators', () => {
    expect(buildVectorSearchSql({ table: 't', vectorColumn: 'v', distance: 'l2', limit: 1 }).operator).toBe('<->');
    expect(buildVectorSearchSql({ table: 't', vectorColumn: 'v', distance: 'inner_product', limit: 1 }).operator).toBe('<#>');
  });

  it('postgres-quotes a schema, table, vector column, and projected columns (injection-safe)', () => {
    const { sql } = buildVectorSearchSql({
      schema: 'app', table: 'do"cs', vectorColumn: 'emb', distance: 'cosine', limit: 3,
      selectColumns: ['id', 'ti"tle'],
    });
    // Embedded double-quotes are doubled per the postgres identifier rule.
    expect(sql).toContain('"app"."do""cs"');
    expect(sql).toContain('"ti""tle"');
    expect(sql).not.toMatch(/DROP|;--/);
  });

  it('clamps an out-of-range limit', () => {
    expect(buildVectorSearchSql({ table: 't', vectorColumn: 'v', distance: 'cosine', limit: 99999 }).sql).toContain('LIMIT 1000');
    expect(buildVectorSearchSql({ table: 't', vectorColumn: 'v', distance: 'cosine', limit: 0 }).sql).toContain('LIMIT 1');
  });
});

describe('toVectorLiteral', () => {
  it('formats a numeric array as the pgvector text form', () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
  });
  it('rejects empty or non-finite embeddings', () => {
    expect(() => toVectorLiteral([])).toThrow();
    expect(() => toVectorLiteral([1, Number.NaN])).toThrow();
    expect(() => toVectorLiteral([1, Infinity])).toThrow();
  });
});

describe('clampLimit', () => {
  it('bounds to [1,1000] and defaults non-finite to 10', () => {
    expect(clampLimit(-3)).toBe(1);
    expect(clampLimit(5000)).toBe(1000);
    expect(clampLimit(Number.NaN)).toBe(10);
    expect(clampLimit(42)).toBe(42);
  });
});

describe('VECTOR_DISTANCE_OPTIONS', () => {
  it('offers exactly the three pgvector metrics', () => {
    expect(VECTOR_DISTANCE_OPTIONS.map((o) => o.value).sort()).toEqual(['cosine', 'inner_product', 'l2']);
  });
});
