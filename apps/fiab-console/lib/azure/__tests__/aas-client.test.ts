/**
 * aas-client — Vitest contracts for the pure TMSL builders.
 *
 * These assert the exact TMSL shapes written for relationships (incl. the
 * isActive=false role-playing case used by USERELATIONSHIP), relationship
 * deletes, and multi-level drill hierarchies, plus the full model.bim preview.
 * No network — builders are pure.
 */
import { describe, it, expect } from 'vitest';
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
