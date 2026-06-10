import { describe, it, expect } from 'vitest';
import {
  validateEdit, applyEditToSnapshot, coerceEdits, renderStructureCatalog,
  buildRenameMeasureTmsl, buildMeasureDescriptionTmsl, buildColumnDescriptionTmsl,
  buildTableDescriptionTmsl, buildAddRelationshipTmsl, newCheckpointId,
  type SmStructureSnapshot, type SmStructureEdit,
} from '../sm-structure-edits';

const snap: SmStructureSnapshot = {
  tables: [
    { name: 'Sales', columns: [{ name: 'DateKey', dataType: 'int64' }, { name: 'Amount', dataType: 'double' }] },
    { name: 'Date', columns: [{ name: 'DateKey', dataType: 'int64' }, { name: 'Year', dataType: 'int64' }] },
  ],
  measures: [
    { table: 'Sales', name: 'Sales Amt', expression: 'SUM(Sales[Amount])', formatString: '#,0' },
    { table: 'Sales', name: 'Order Count', expression: 'COUNTROWS(Sales)' },
  ],
  relationships: [],
};

describe('validateEdit', () => {
  it('accepts a valid rename-measure', () => {
    expect(validateEdit(snap, { kind: 'rename-measure', table: 'Sales', from: 'Sales Amt', to: 'Total Sales' })).toBeNull();
  });
  it('rejects renaming a missing measure', () => {
    expect(validateEdit(snap, { kind: 'rename-measure', table: 'Sales', from: 'Nope', to: 'X' })).toMatch(/not found/);
  });
  it('rejects rename collision with an existing measure', () => {
    expect(validateEdit(snap, { kind: 'rename-measure', table: 'Sales', from: 'Sales Amt', to: 'Order Count' })).toMatch(/already exists/);
  });
  it('rejects an invalid measure name with brackets', () => {
    expect(validateEdit(snap, { kind: 'rename-measure', table: 'Sales', from: 'Sales Amt', to: 'Bad[Name]' })).toMatch(/not a valid/);
  });
  it('validates a measure description target', () => {
    expect(validateEdit(snap, { kind: 'set-description', target: 'measure', table: 'Sales', name: 'Sales Amt', description: 'Total revenue' })).toBeNull();
    expect(validateEdit(snap, { kind: 'set-description', target: 'measure', table: 'Sales', name: 'Ghost', description: 'x' })).toMatch(/not found/);
  });
  it('validates a column description target', () => {
    expect(validateEdit(snap, { kind: 'set-description', target: 'column', table: 'Date', name: 'Year', description: 'Calendar year' })).toBeNull();
    expect(validateEdit(snap, { kind: 'set-description', target: 'column', table: 'Date', name: 'Quarter', description: 'x' })).toMatch(/not found/);
  });
  it('validates a table description target', () => {
    expect(validateEdit(snap, { kind: 'set-description', target: 'table', table: 'Sales', description: 'Fact table' })).toBeNull();
    expect(validateEdit(snap, { kind: 'set-description', target: 'table', table: 'Missing', description: 'x' })).toMatch(/not found/);
  });
  it('validates an add-relationship against real columns', () => {
    expect(validateEdit(snap, { kind: 'add-relationship', fromTable: 'Sales', fromColumn: 'DateKey', toTable: 'Date', toColumn: 'DateKey' })).toBeNull();
    expect(validateEdit(snap, { kind: 'add-relationship', fromTable: 'Sales', fromColumn: 'Bogus', toTable: 'Date', toColumn: 'DateKey' })).toMatch(/not found/);
  });
});

describe('applyEditToSnapshot', () => {
  it('renames a measure immutably', () => {
    const next = applyEditToSnapshot(snap, { kind: 'rename-measure', table: 'Sales', from: 'Sales Amt', to: 'Total Sales' });
    expect(next.measures.find((m) => m.name === 'Total Sales')).toBeTruthy();
    expect(snap.measures.find((m) => m.name === 'Sales Amt')).toBeTruthy(); // original untouched
  });
  it('sets a measure description', () => {
    const next = applyEditToSnapshot(snap, { kind: 'set-description', target: 'measure', table: 'Sales', name: 'Order Count', description: 'Number of orders' });
    expect(next.measures.find((m) => m.name === 'Order Count')?.description).toBe('Number of orders');
  });
  it('adds a relationship', () => {
    const next = applyEditToSnapshot(snap, { kind: 'add-relationship', fromTable: 'Sales', fromColumn: 'DateKey', toTable: 'Date', toColumn: 'DateKey', cardinality: 'many:one' });
    expect(next.relationships).toHaveLength(1);
    expect(next.relationships[0].fromTable).toBe('Sales');
  });
});

describe('coerceEdits', () => {
  it('drops malformed entries and keeps the three known kinds', () => {
    const raw = {
      edits: [
        { kind: 'rename-measure', table: 'Sales', from: 'A', to: 'B' },
        { kind: 'set-description', target: 'measure', table: 'Sales', name: 'A', description: 'x' },
        { kind: 'add-relationship', fromTable: 'Sales', fromColumn: 'DateKey', toTable: 'Date', toColumn: 'DateKey' },
        { kind: 'delete-everything' },
        null,
        'garbage',
      ],
    };
    const out = coerceEdits(raw);
    expect(out.map((e) => e.kind)).toEqual(['rename-measure', 'set-description', 'add-relationship']);
  });
  it('accepts a bare array too', () => {
    expect(coerceEdits([{ kind: 'rename-measure', table: 'S', from: 'a', to: 'b' }])).toHaveLength(1);
  });
  it('defaults add-relationship cardinality + crossFilter', () => {
    const [e] = coerceEdits([{ kind: 'add-relationship', fromTable: 'S', fromColumn: 'c', toTable: 'T', toColumn: 'd' }]) as any;
    expect(e.cardinality).toBe('many:one');
    expect(e.crossFilter).toBe('single');
  });
});

describe('TMSL builders', () => {
  it('rename measure addresses the OLD name and sets the new name', () => {
    const tmsl: any = buildRenameMeasureTmsl({ database: 'db', table: 'Sales', from: 'Sales Amt', to: 'Total Sales', expression: 'SUM(Sales[Amount])', formatString: '#,0' });
    expect(tmsl.alter.object.measure).toBe('Sales Amt');
    expect(tmsl.alter.measure.name).toBe('Total Sales');
    expect(tmsl.alter.measure.expression).toBe('SUM(Sales[Amount])');
    expect(tmsl.alter.measure.formatString).toBe('#,0');
  });
  it('measure description preserves expression', () => {
    const tmsl: any = buildMeasureDescriptionTmsl({ database: 'db', table: 'Sales', measure: 'X', expression: '1', description: 'd' });
    expect(tmsl.alter.measure.description).toBe('d');
    expect(tmsl.alter.measure.expression).toBe('1');
  });
  it('column description carries sourceColumn', () => {
    const tmsl: any = buildColumnDescriptionTmsl({ database: 'db', table: 'Date', column: 'Year', dataType: 'int64', description: 'd' });
    expect(tmsl.alter.object.column).toBe('Year');
    expect(tmsl.alter.column.sourceColumn).toBe('Year');
  });
  it('table description alters only the description', () => {
    const tmsl: any = buildTableDescriptionTmsl({ database: 'db', table: 'Sales', description: 'fact' });
    expect(tmsl.alter.table.description).toBe('fact');
    expect(tmsl.alter.object.table).toBe('Sales');
  });
  it('add relationship maps cardinality + crossFilter', () => {
    const tmsl: any = buildAddRelationshipTmsl('db', { kind: 'add-relationship', fromTable: 'Sales', fromColumn: 'DateKey', toTable: 'Date', toColumn: 'DateKey', cardinality: 'many:one', crossFilter: 'both' });
    expect(tmsl.createOrReplace.relationship.fromCardinality).toBe('many');
    expect(tmsl.createOrReplace.relationship.toCardinality).toBe('one');
    expect(tmsl.createOrReplace.relationship.crossFilteringBehavior).toBe('bothDirections');
  });
});

describe('renderStructureCatalog', () => {
  it('emits tables, columns, measures, and relationships', () => {
    const withRel = applyEditToSnapshot(snap, { kind: 'add-relationship', fromTable: 'Sales', fromColumn: 'DateKey', toTable: 'Date', toColumn: 'DateKey' });
    const cat = renderStructureCatalog(withRel);
    expect(cat).toMatch(/TABLE Sales/);
    expect(cat).toMatch(/COLUMN Sales\[Amount\]/);
    expect(cat).toMatch(/MEASURE Sales\[Sales Amt\]/);
    expect(cat).toMatch(/RELATIONSHIPS:/);
  });
});

describe('newCheckpointId', () => {
  it('produces unique-ish ids', () => {
    expect(newCheckpointId()).toMatch(/^cp-/);
    expect(newCheckpointId(1)).not.toBe(newCheckpointId(2));
  });
});
