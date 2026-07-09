import { describe, it, expect } from 'vitest';
import {
  analyzeRelationships, analyzeModelHealth, applyHealthFixes,
  measureReferencesColumn, looksLikeKey, sortFindings,
  type HealthInput, type HealthFixOp, type ApplyModelPortion,
} from '../model-health';

describe('looksLikeKey', () => {
  it('matches key/id-suffixed column names', () => {
    expect(looksLikeKey('CustomerKey')).toBe(true);
    expect(looksLikeKey('ProductID')).toBe(true);
    expect(looksLikeKey('OrderId')).toBe(true);
    expect(looksLikeKey('Amount')).toBe(false);
    expect(looksLikeKey('Kidney')).toBe(false); // not a *key/*id suffix
  });
});

describe('measureReferencesColumn', () => {
  it('detects bracketed column references', () => {
    expect(measureReferencesColumn('SUM(Sales[Amount])', 'Sales', 'Amount')).toBe(true);
    expect(measureReferencesColumn("SUM('Fact Sales'[Amount])", 'Fact Sales', 'Amount')).toBe(true);
    expect(measureReferencesColumn('SUM(Sales[Amount])', 'Sales', 'Quantity')).toBe(false);
    expect(measureReferencesColumn('', 'Sales', 'Amount')).toBe(false);
  });
});

describe('analyzeRelationships', () => {
  const tables = [
    { name: 'Sales', columns: [{ name: 'CustomerKey', dataType: 'int64' }, { name: 'Amount', dataType: 'double' }] },
    { name: 'Customer', columns: [{ name: 'CustomerKey', dataType: 'int64' }, { name: 'Name', dataType: 'string' }] },
  ];

  it('flags a missing FK on a shared key column with an add-relationship fix', () => {
    const { ok, findings } = analyzeRelationships(tables, []);
    expect(ok).toBe(false);
    const missing = findings.find((f) => f.rule === 'missing-relationship' && f.id.startsWith('missing:'));
    expect(missing).toBeTruthy();
    expect(missing!.fix?.kind).toBe('add-relationship');
    // Customer[CustomerKey] is the dim side (col name includes 'Customer').
    const fix = missing!.fix as Extract<HealthFixOp, { kind: 'add-relationship' }>;
    expect(fix.toTable).toBe('Customer');
    expect(fix.fromTable).toBe('Sales');
    expect(fix.cardinality).toBe('many-to-one');
  });

  it('does not flag a missing FK when the relationship already exists', () => {
    const rels = [{ fromTable: 'Sales', fromColumn: 'CustomerKey', toTable: 'Customer', toColumn: 'CustomerKey', active: true }];
    const { findings } = analyzeRelationships(tables, rels);
    expect(findings.find((f) => f.id.startsWith('missing:'))).toBeUndefined();
  });

  it('flags a broken relationship pointing at a non-existent column as an error', () => {
    const rels = [{ fromTable: 'Sales', fromColumn: 'Nope', toTable: 'Customer', toColumn: 'CustomerKey', active: true }];
    const { findings } = analyzeRelationships(tables, rels);
    const broken = findings.find((f) => f.id.startsWith('broken:'));
    expect(broken).toBeTruthy();
    expect(broken!.severity).toBe('error');
    expect(broken!.fix).toBeUndefined();
  });

  it('flags ambiguous multiple active relationships between the same table pair', () => {
    const rels = [
      { fromTable: 'Sales', fromColumn: 'CustomerKey', toTable: 'Customer', toColumn: 'CustomerKey', active: true },
      { fromTable: 'Sales', fromColumn: 'Amount', toTable: 'Customer', toColumn: 'Name', active: true },
    ];
    const findings = analyzeRelationships(tables, rels).findings;
    expect(findings.filter((f) => f.rule === 'ambiguous-relationship')).toHaveLength(1);
  });

  it('does not flag ambiguity when the second relationship is inactive', () => {
    const rels = [
      { fromTable: 'Sales', fromColumn: 'CustomerKey', toTable: 'Customer', toColumn: 'CustomerKey', active: true },
      { fromTable: 'Sales', fromColumn: 'Amount', toTable: 'Customer', toColumn: 'Name', active: false },
    ];
    const findings = analyzeRelationships(tables, rels).findings;
    expect(findings.filter((f) => f.rule === 'ambiguous-relationship')).toHaveLength(0);
  });
});

describe('analyzeModelHealth', () => {
  const baseInput = (): HealthInput => ({
    tables: [
      { name: 'Sales', columns: [{ name: 'CustomerKey', dataType: 'int64' }, { name: 'Amount', dataType: 'double' }] },
      { name: 'Calendar', columns: [{ name: 'Date', dataType: 'dateTime' }, { name: 'Year', dataType: 'int64' }] },
    ],
    measures: [
      { name: 'Total Sales', expression: 'SUM(Sales[Amount])', description: '' },
      { name: 'Raw Amount', expression: 'Sales[Amount]' },
    ],
    relationships: [],
    dateTables: [],
  });

  it('flags an unmarked date table with a mark-date-table fix', () => {
    const findings = analyzeModelHealth(baseInput());
    const dateFinding = findings.find((f) => f.rule === 'unmarked-date-table');
    expect(dateFinding).toBeTruthy();
    expect(dateFinding!.fix).toEqual({ kind: 'mark-date-table', table: 'Calendar', dateColumn: 'Date' });
  });

  it('does not flag an unmarked date table once one table is marked', () => {
    const input = baseInput();
    input.dateTables = [{ table: 'Calendar', dateColumn: 'Date' }];
    const findings = analyzeModelHealth(input);
    expect(findings.find((f) => f.rule === 'unmarked-date-table')).toBeUndefined();
  });

  it('flags a measure with no description and a measure anti-pattern', () => {
    const findings = analyzeModelHealth(baseInput());
    expect(findings.find((f) => f.rule === 'measure-no-description' && (f.fix as any)?.measure === 'Total Sales')).toBeTruthy();
    // 'Raw Amount' references a column with no aggregation → anti-pattern.
    expect(findings.find((f) => f.rule === 'measure-anti-pattern' && f.title.includes('Raw Amount'))).toBeTruthy();
  });

  it('flags unused columns not referenced by any measure/relationship/date mark', () => {
    const findings = analyzeModelHealth(baseInput());
    // Calendar[Year] is unused (no measure/rel/date-mark references it).
    expect(findings.find((f) => f.rule === 'unused-column' && f.id === 'unused:calendar.year')).toBeTruthy();
    // Sales[Amount] IS referenced by Total Sales → not unused.
    expect(findings.find((f) => f.id === 'unused:sales.amount')).toBeUndefined();
  });

  it('orders findings error → warning → info', () => {
    const input = baseInput();
    input.relationships = [{ fromTable: 'Sales', fromColumn: 'Bad', toTable: 'Customer', toColumn: 'X', active: true }];
    const findings = analyzeModelHealth(input);
    const severities = findings.map((f) => f.severity);
    const firstInfo = severities.indexOf('info');
    const lastError = severities.lastIndexOf('error');
    if (firstInfo >= 0 && lastError >= 0) expect(lastError).toBeLessThan(firstInfo);
  });
});

describe('sortFindings', () => {
  it('is stable and severity-ordered', () => {
    const out = sortFindings([
      { rule: 'unused-column', severity: 'info', id: 'a', title: 't', detail: 'd' },
      { rule: 'missing-relationship', severity: 'error', id: 'b', title: 't', detail: 'd' },
      { rule: 'ambiguous-relationship', severity: 'warning', id: 'c', title: 't', detail: 'd' },
    ]);
    expect(out.map((f) => f.severity)).toEqual(['error', 'warning', 'info']);
  });
});

describe('applyHealthFixes', () => {
  const model = (): ApplyModelPortion => ({
    measures: [{ id: 'm1', name: 'Total Sales', expression: 'SUM(Sales[Amount])', description: '' }],
    relationships: [],
    dateTables: [],
  });
  const NOW = '2026-07-08T00:00:00.000Z';
  let n = 0;
  const newId = () => `id-${++n}`;

  it('applies an add-relationship fix', () => {
    const { next, applied, skipped } = applyHealthFixes(model(),
      [{ kind: 'add-relationship', fromTable: 'Sales', fromColumn: 'CustomerKey', toTable: 'Customer', toColumn: 'CustomerKey', cardinality: 'many-to-one' }],
      NOW, newId);
    expect(next.relationships).toHaveLength(1);
    expect(applied).toHaveLength(1);
    expect(skipped).toHaveLength(0);
    expect(next.relationships[0].createdAt).toBe(NOW);
  });

  it('skips a duplicate relationship', () => {
    const m = model();
    m.relationships = [{ fromTable: 'Sales', fromColumn: 'CustomerKey', toTable: 'Customer', toColumn: 'CustomerKey' }];
    const { applied, skipped } = applyHealthFixes(m,
      [{ kind: 'add-relationship', fromTable: 'Sales', fromColumn: 'CustomerKey', toTable: 'Customer', toColumn: 'CustomerKey', cardinality: 'many-to-one' }],
      NOW, newId);
    expect(applied).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });

  it('applies mark-date-table and set-measure-description', () => {
    const { next, applied } = applyHealthFixes(model(), [
      { kind: 'mark-date-table', table: 'Calendar', dateColumn: 'Date' },
      { kind: 'set-measure-description', measure: 'Total Sales', description: 'Sum of sales amount.' },
    ], NOW, newId);
    expect(next.dateTables).toEqual([{ table: 'Calendar', dateColumn: 'Date', updatedAt: NOW }]);
    expect(next.measures[0].description).toBe('Sum of sales amount.');
    expect(applied).toHaveLength(2);
  });

  it('skips a description for a missing measure and an empty description', () => {
    const { skipped } = applyHealthFixes(model(), [
      { kind: 'set-measure-description', measure: 'Nope', description: 'x' },
      { kind: 'set-measure-description', measure: 'Total Sales', description: '   ' },
    ], NOW, newId);
    expect(skipped).toHaveLength(2);
  });

  it('does not mutate the input model', () => {
    const m = model();
    applyHealthFixes(m, [{ kind: 'mark-date-table', table: 'Calendar', dateColumn: 'Date' }], NOW, newId);
    expect(m.dateTables).toHaveLength(0);
  });
});
