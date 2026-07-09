import { describe, it, expect } from 'vitest';
import {
  buildMeasureEvalDax, normalizeScalarExpression, daxQueryTemplate,
  looksLikeDaxQuery, quoteTable, validateRelationshipsReport,
} from '../semantic-link';
import { translateDaxToSql } from '@/lib/azure/tabular-model';

describe('normalizeScalarExpression', () => {
  it('wraps a bare aggregate in CALCULATE', () => {
    expect(normalizeScalarExpression('SUM(Sales[Amount])')).toBe('CALCULATE(SUM(Sales[Amount]))');
  });
  it('leaves an existing CALCULATE unchanged', () => {
    expect(normalizeScalarExpression('CALCULATE(SUM(Sales[Amount]))')).toBe('CALCULATE(SUM(Sales[Amount]))');
  });
  it('passes non-aggregate expressions through untouched', () => {
    expect(normalizeScalarExpression('DIVIDE([A],[B])')).toBe('DIVIDE([A],[B])');
  });
  it('strips a trailing semicolon', () => {
    expect(normalizeScalarExpression('SUM(Sales[Amount]);')).toBe('CALCULATE(SUM(Sales[Amount]))');
  });
});

describe('buildMeasureEvalDax', () => {
  it('builds an ungrouped ROW query that the loom-native translator supports', () => {
    const dax = buildMeasureEvalDax('Total Sales', 'SUM(Sales[Amount])');
    expect(dax).toBe('EVALUATE ROW("Total Sales", CALCULATE(SUM(Sales[Amount])))');
    // Prove the generated DAX is actually runnable on the loom-native backend.
    const sql = translateDaxToSql(dax);
    expect(sql).toBe('SELECT SUM([Amount]) AS [Total Sales] FROM [Sales]');
  });

  it('builds a SUMMARIZECOLUMNS query when groupby keys are given', () => {
    const dax = buildMeasureEvalDax('Total Sales', 'SUM(Sales[Amount])', ['Customer[Name]']);
    expect(dax).toBe('EVALUATE SUMMARIZECOLUMNS(Customer[Name], "Total Sales", CALCULATE(SUM(Sales[Amount])))');
  });

  it('sanitizes the label so it cannot break the DAX string', () => {
    const dax = buildMeasureEvalDax('Weird"Name', 'SUM(Sales[Amount])');
    expect(dax).toContain('"WeirdName"');
  });
});

describe('quoteTable', () => {
  it('quotes names with spaces and leaves simple names bare', () => {
    expect(quoteTable('Sales')).toBe('Sales');
    expect(quoteTable('Fact Sales')).toBe("'Fact Sales'");
  });
});

describe('daxQueryTemplate', () => {
  it('generates a table preview', () => {
    expect(daxQueryTemplate('table-preview', 'Sales')).toBe('EVALUATE\nTOPN(100, Sales)');
  });
  it('generates a row count', () => {
    expect(daxQueryTemplate('row-count', 'Fact Sales')).toBe(`EVALUATE\nROW("Row count", COUNTROWS('Fact Sales'))`);
  });
  it('generates a distinct-of-column query', () => {
    expect(daxQueryTemplate('column-distinct', 'Customer', 'Country')).toBe('EVALUATE\nDISTINCT(Customer[Country])');
  });
  it('generates a group-by-column summary', () => {
    expect(daxQueryTemplate('column-summary', 'Sales', 'Region')).toContain('SUMMARIZECOLUMNS(');
  });
});

describe('looksLikeDaxQuery', () => {
  it('accepts EVALUATE / DEFINE and rejects other text', () => {
    expect(looksLikeDaxQuery('EVALUATE Sales')).toBe(true);
    expect(looksLikeDaxQuery('  DEFINE MEASURE x = 1 EVALUATE Sales')).toBe(true);
    expect(looksLikeDaxQuery('SELECT * FROM Sales')).toBe(false);
    expect(looksLikeDaxQuery('')).toBe(false);
  });
});

describe('validateRelationshipsReport', () => {
  const tables = [
    { name: 'Sales', columns: [{ name: 'CustomerKey', dataType: 'int64' }] },
    { name: 'Customer', columns: [{ name: 'CustomerKey', dataType: 'int64' }] },
  ];
  it('reports ok=false with an issue when a relationship is broken', () => {
    const report = validateRelationshipsReport(tables, [
      { fromTable: 'Sales', fromColumn: 'Missing', toTable: 'Customer', toColumn: 'CustomerKey' },
    ]);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.includes('[error]'))).toBe(true);
  });
  it('reports ok=true when only warnings (missing FK) are present', () => {
    const report = validateRelationshipsReport(tables, []);
    // A missing FK is a warning, not an error → ok stays true.
    expect(report.ok).toBe(true);
    expect(report.findings.length).toBeGreaterThan(0);
  });
});
