/**
 * aas-client — Vitest contracts for the pure TMSL builders.
 *
 * These assert the exact TMSL shapes written for relationships (incl. the
 * isActive=false role-playing case used by USERELATIONSHIP), relationship
 * deletes, and multi-level drill hierarchies, plus the full model.bim preview.
 * No network — builders are pure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildCreateOrReplaceRelationshipTmsl,
  buildDeleteRelationshipTmsl,
  buildAlterTableHierarchyTmsl,
  buildModelBimTmsl,
  type TmslRelationship,
} from '../aas-tmsl';

const baseRel: TmslRelationship = {
  name: 'rel_ship',
  fromTable: 'FactSales', fromColumn: 'ShipDateKey',
  toTable: 'DimDate', toColumn: 'DateKey',
  fromCardinality: 'many', toCardinality: 'one',
  crossFilteringBehavior: 'oneDirection', isActive: false,
};

describe('buildCreateOrReplaceRelationshipTmsl', () => {
  it('emits a single-column relationship with isActive=false', () => {
    const obj = JSON.parse(buildCreateOrReplaceRelationshipTmsl('MyModel', baseRel));
    expect(obj.createOrReplace.object.database).toBe('MyModel');
    expect(obj.createOrReplace.object.relationship).toBe('rel_ship');
    const r = obj.createOrReplace.relationship;
    expect(r.fromTable).toBe('FactSales');
    expect(r.fromColumn).toBe('ShipDateKey');
    expect(r.toTable).toBe('DimDate');
    expect(r.toColumn).toBe('DateKey');
    expect(r.fromCardinality).toBe('many');
    expect(r.toCardinality).toBe('one');
    expect(r.crossFilteringBehavior).toBe('oneDirection');
    expect(r.isActive).toBe(false);
  });

  it('omits isActive when the relationship is active (TMSL default true)', () => {
    const obj = JSON.parse(buildCreateOrReplaceRelationshipTmsl('M', { ...baseRel, isActive: true }));
    expect('isActive' in obj.createOrReplace.relationship).toBe(false);
  });

  it('emits bothDirections for a both-direction cross filter', () => {
    const obj = JSON.parse(buildCreateOrReplaceRelationshipTmsl('M', { ...baseRel, crossFilteringBehavior: 'bothDirections' }));
    expect(obj.createOrReplace.relationship.crossFilteringBehavior).toBe('bothDirections');
  });
});

describe('buildDeleteRelationshipTmsl', () => {
  it('targets the named relationship in the database', () => {
    const obj = JSON.parse(buildDeleteRelationshipTmsl('MyModel', 'rel_ship'));
    expect(obj.delete.object.database).toBe('MyModel');
    expect(obj.delete.object.relationship).toBe('rel_ship');
  });
});

describe('buildAlterTableHierarchyTmsl', () => {
  it('serializes a 3-level hierarchy with correct ordinals + columns', () => {
    const obj = JSON.parse(buildAlterTableHierarchyTmsl('MyModel', 'DimDate', {
      name: 'Date',
      levels: [
        { ordinal: 0, name: 'Year', column: 'CalYear' },
        { ordinal: 1, name: 'Quarter', column: 'Quarter' },
        { ordinal: 2, name: 'Month', column: 'MonthNum' },
      ],
    }));
    expect(obj.alter.object.database).toBe('MyModel');
    expect(obj.alter.object.table).toBe('DimDate');
    const h = obj.alter.table.hierarchies[0];
    expect(h.name).toBe('Date');
    expect(h.levels).toHaveLength(3);
    expect(h.levels[0]).toMatchObject({ ordinal: 0, name: 'Year', column: 'CalYear' });
    expect(h.levels[2]).toMatchObject({ ordinal: 2, name: 'Month', column: 'MonthNum' });
  });

  it('sorts levels by ordinal even when supplied out of order', () => {
    const obj = JSON.parse(buildAlterTableHierarchyTmsl('M', 'T', {
      name: 'H',
      levels: [
        { ordinal: 2, name: 'C', column: 'c' },
        { ordinal: 0, name: 'A', column: 'a' },
        { ordinal: 1, name: 'B', column: 'b' },
      ],
    }));
    expect(obj.alter.table.hierarchies[0].levels.map((l: any) => l.column)).toEqual(['a', 'b', 'c']);
  });
});

describe('buildModelBimTmsl', () => {
  it('produces a model.bim with tables, hierarchies, and an inactive relationship', () => {
    const tmsl = buildModelBimTmsl(
      'Sales Model',
      [
        { name: 'FactSales', columns: [{ name: 'ShipDateKey', dataType: 'int64' }, { name: 'Amount', dataType: 'double' }] },
        { name: 'DimDate', columns: [{ name: 'DateKey', dataType: 'int64' }, { name: 'CalYear', dataType: 'int64' }, { name: 'Quarter', dataType: 'string' }, { name: 'MonthNum', dataType: 'int64' }] },
      ],
      [baseRel],
      [{ name: 'Date Drill', table: 'DimDate', levels: [
        { ordinal: 0, name: 'Year', column: 'CalYear' },
        { ordinal: 1, name: 'Quarter', column: 'Quarter' },
        { ordinal: 2, name: 'Month', column: 'MonthNum' },
      ] }],
    );
    const obj = JSON.parse(tmsl);
    expect(obj.name).toBe('Sales Model');
    expect(obj.compatibilityLevel).toBe(1567);
    const dim = obj.model.tables.find((t: any) => t.name === 'DimDate');
    expect(dim.hierarchies[0].levels).toHaveLength(3);
    expect(dim.hierarchies[0].levels[2].column).toBe('MonthNum');
    const rel = obj.model.relationships[0];
    expect(rel.isActive).toBe(false);
    expect(rel.fromTable).toBe('FactSales');
    // FactSales carries no hierarchies → property omitted.
    const fact = obj.model.tables.find((t: any) => t.name === 'FactSales');
    expect('hierarchies' in fact).toBe(false);
  });
});

/*
 * aas-client — unit tests for the pure (no-network) helpers used by the
 * Loom-native report renderer: DAX synthesis, row flattening, and binding
 * resolution. The fetch-driven executeAasQuery is covered by the BFF route
 * + the live E2E receipt; these tests lock the deterministic logic.
 */

const SAVED = { ...process.env };

async function load(cloud?: string) {
  vi.resetModules();
  delete process.env.AZURE_CLOUD;
  delete process.env.LOOM_AAS_SERVER;
  delete process.env.LOOM_AAS_DATABASE;
  if (cloud) process.env.AZURE_CLOUD = cloud;
  return import('../aas-dax');
}

afterEach(() => { process.env = { ...SAVED }; });

describe('buildDaxFromVisual', () => {
  let m: typeof import('../aas-dax');
  beforeEach(async () => { m = await load('AzureCloud'); });

  it('passes through an explicit EVALUATE expression', () => {
    expect(m.buildDaxFromVisual({ type: 'table', field: 'EVALUATE Sales' })).toBe('EVALUATE Sales');
    // case-insensitive
    expect(m.buildDaxFromVisual({ type: 'table', field: 'evaluate Sales' })).toBe('evaluate Sales');
  });

  it('wraps a measure/column in ROW for a card visual', () => {
    expect(m.buildDaxFromVisual({ type: 'card', field: '[Total Sales]' })).toBe('EVALUATE ROW("Value", [Total Sales])');
  });

  it('wraps a measure/column in TOPN(ROW) for a non-card visual', () => {
    expect(m.buildDaxFromVisual({ type: 'bar', field: 'Sales[Amount]' })).toBe('EVALUATE TOPN(100, ROW("Value", Sales[Amount]))');
  });

  it('TOPN-guards a bare table name', () => {
    expect(m.buildDaxFromVisual({ type: 'table', field: 'Customers' })).toBe('EVALUATE TOPN(100, Customers)');
  });

  it('returns null for an empty field', () => {
    expect(m.buildDaxFromVisual({ type: 'card', field: '' })).toBeNull();
    expect(m.buildDaxFromVisual({ type: 'card' })).toBeNull();
  });
});

describe('flattenAasRows', () => {
  let m: typeof import('../aas-dax');
  beforeEach(async () => { m = await load('AzureCloud'); });

  it('strips the [Table].[Column] prefix', () => {
    const rows = m.flattenAasRows({
      results: [{ tables: [{ rows: [{ '[Sales].[Amount]': 10, '[Sales].[Region]': 'East' }] }] }],
    });
    expect(rows).toEqual([{ Amount: 10, Region: 'East' }]);
  });

  it('strips a bare [Column] prefix', () => {
    const rows = m.flattenAasRows({ results: [{ tables: [{ rows: [{ '[Value]': 42 }] }] }] });
    expect(rows).toEqual([{ Value: 42 }]);
  });

  it('returns [] for an empty / shapeless result', () => {
    expect(m.flattenAasRows({ results: [] })).toEqual([]);
    expect(m.flattenAasRows({ results: [{ tables: [] }] })).toEqual([]);
  });
});

describe('resolveAasBinding', () => {
  let m: typeof import('../aas-dax');
  beforeEach(async () => { m = await load('AzureCloud'); });

  it('resolves from per-item state', () => {
    expect(m.resolveAasBinding('asazure://eastus2.asazure.windows.net/my-server', 'AdventureWorks')).toEqual({
      region: 'eastus2', serverName: 'my-server', database: 'AdventureWorks',
    });
  });

  it('falls back to env defaults', async () => {
    process.env.LOOM_AAS_SERVER = 'asazure://eastus2.asazure.windows.net/env-server';
    process.env.LOOM_AAS_DATABASE = 'EnvModel';
    const m2 = await import('../aas-dax');
    expect(m2.resolveAasBinding(undefined, undefined)).toEqual({
      region: 'eastus2', serverName: 'env-server', database: 'EnvModel',
    });
  });

  it('returns null when nothing is bound', () => {
    expect(m.resolveAasBinding(undefined, undefined)).toBeNull();
    expect(m.resolveAasBinding('asazure://eastus2.asazure.windows.net/my-server', undefined)).toBeNull();
    expect(m.resolveAasBinding('not-a-server', 'Model')).toBeNull();
  });
});
