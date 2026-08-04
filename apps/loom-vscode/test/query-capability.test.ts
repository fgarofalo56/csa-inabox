/**
 * Query-capability routing — an item type maps to exactly the read surface its
 * real routes support (conservative on purpose: unknown types are honestly
 * gated, never routed at a 404).
 */
import { describe, it, expect } from 'vitest';
import { queryCapabilities, isDataReadable } from '../src/query/query-capability';

describe('queryCapabilities', () => {
  it('maps SQL-capable types to the sql engine', () => {
    for (const t of ['lakehouse', 'warehouse', 'synapse-serverless-sql-pool', 'azure-sql-database', 'databricks-sql-warehouse']) {
      expect(queryCapabilities(t).engine, t).toBe('sql');
    }
  });

  it('maps kql-database to the kql engine', () => {
    expect(queryCapabilities('kql-database').engine).toBe('kql');
  });

  it('marks tabular-preview types previewable (no query engine)', () => {
    const c = queryCapabilities('dataset');
    expect(c.engine).toBeUndefined();
    expect(c.previewable).toBe(true);
    expect(queryCapabilities('materialized-lake-view').previewable).toBe(true);
  });

  it('leaves an unknown type with no read surface (honest gate)', () => {
    expect(isDataReadable('report')).toBe(false);
    expect(queryCapabilities('report').engine).toBeUndefined();
    expect(queryCapabilities('report').previewable).toBe(false);
  });

  it('isDataReadable is true for query- OR preview-capable types', () => {
    expect(isDataReadable('lakehouse')).toBe(true);
    expect(isDataReadable('kql-database')).toBe(true);
    expect(isDataReadable('dataset')).toBe(true);
    expect(isDataReadable('notebook')).toBe(false);
  });
});
