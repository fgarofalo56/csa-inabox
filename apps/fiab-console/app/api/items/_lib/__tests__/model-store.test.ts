/**
 * Unit tests for the Model-view persistence helpers (pure functions) —
 * normalize / upsert / remove relationships + measures, and TVF DDL gen.
 */
import { describe, it, expect, vi } from 'vitest';

// model-store re-exports persistence helpers that import item-crud → @azure/cosmos.
// The pure functions under test don't touch Cosmos, so stub item-crud to keep
// this a fast, dependency-free unit test.
vi.mock('../item-crud', () => ({ loadOwnedItem: vi.fn(), updateOwnedItem: vi.fn() }));

import {
  normalizeRelationship, upsertRelationship, removeRelationship,
  normalizeMeasure, upsertMeasure, tvfDdl,
  type LoomModelState,
} from '../model-store';

const empty = (): LoomModelState => ({ relationships: [], measures: [] });

describe('normalizeRelationship', () => {
  it('throws when endpoints are missing', () => {
    expect(() => normalizeRelationship({ fromTable: 'a' }, 'cosmos')).toThrow();
  });
  it('defaults cardinality/crossFilter/active and stamps an id', () => {
    const r = normalizeRelationship(
      { fromTable: 'dbo.Sales', fromColumn: 'CustId', toTable: 'dbo.Customer', toColumn: 'Id' },
      'cosmos',
    );
    expect(r.id).toBeTruthy();
    expect(r.cardinality).toBe('many-to-one');
    expect(r.crossFilter).toBe('single');
    expect(r.active).toBe(true);
    expect(r.source).toBe('cosmos');
    expect(r.name).toMatch(/^FK_/);
  });
  it('preserves an explicit id when re-normalizing', () => {
    const existing = normalizeRelationship(
      { fromTable: 'dbo.A', fromColumn: 'x', toTable: 'dbo.B', toColumn: 'y' }, 'cosmos',
    );
    const again = normalizeRelationship(
      { fromTable: 'dbo.A', fromColumn: 'x', toTable: 'dbo.B', toColumn: 'y', cardinality: 'one-to-one' }, 'cosmos', existing,
    );
    expect(again.id).toBe(existing.id);
    expect(again.cardinality).toBe('one-to-one');
  });
});

describe('upsert/removeRelationship', () => {
  it('upserts by id then removes', () => {
    const rel = normalizeRelationship({ fromTable: 'dbo.A', fromColumn: 'x', toTable: 'dbo.B', toColumn: 'y' }, 'cosmos');
    let model = upsertRelationship(empty(), rel);
    expect(model.relationships).toHaveLength(1);
    // re-upsert same id replaces, not duplicates
    model = upsertRelationship(model, { ...rel, active: false });
    expect(model.relationships).toHaveLength(1);
    expect(model.relationships[0].active).toBe(false);
    model = removeRelationship(model, rel.id);
    expect(model.relationships).toHaveLength(0);
  });
});

describe('normalizeMeasure', () => {
  it('requires a valid identifier name and an expression', () => {
    expect(() => normalizeMeasure({ name: '', expression: 'SELECT 1' }, 'tvf')).toThrow();
    expect(() => normalizeMeasure({ name: '1bad', expression: 'SELECT 1' }, 'tvf')).toThrow();
    expect(() => normalizeMeasure({ name: 'ok', expression: '' }, 'tvf')).toThrow();
  });
  it('defaults schema for tvf and omits it for cosmos', () => {
    const tvf = normalizeMeasure({ name: 'fn_Total', expression: 'SELECT SUM(x) FROM t' }, 'tvf');
    expect(tvf.kind).toBe('tvf');
    expect(tvf.schema).toBe('dbo');
    const cosmos = normalizeMeasure({ name: 'total', expression: 'SELECT sum(x) FROM t', kind: 'cosmos' }, 'cosmos');
    expect(cosmos.schema).toBeUndefined();
  });
});

describe('upsertMeasure', () => {
  it('dedupes by schema+name', () => {
    const m = normalizeMeasure({ name: 'fn_Total', expression: 'SELECT 1' }, 'tvf');
    let model = upsertMeasure(empty(), m);
    model = upsertMeasure(model, normalizeMeasure({ name: 'fn_Total', expression: 'SELECT 2' }, 'tvf'));
    expect(model.measures).toHaveLength(1);
    expect(model.measures[0].expression).toBe('SELECT 2');
  });
});

describe('tvfDdl', () => {
  it('builds CREATE OR ALTER FUNCTION … RETURNS TABLE and strips a trailing semicolon', () => {
    const ddl = tvfDdl(normalizeMeasure({ name: 'fn_Total', schema: 'dbo', expression: 'SELECT SUM(Amount) AS T FROM dbo.Sales;' }, 'tvf'));
    expect(ddl).toMatch(/CREATE OR ALTER FUNCTION \[dbo\]\.\[fn_Total\]\(\)/);
    expect(ddl).toMatch(/RETURNS TABLE/);
    expect(ddl).toContain('SELECT SUM(Amount) AS T FROM dbo.Sales');
    expect(ddl.trimEnd().endsWith(');')).toBe(true);
  });
});
