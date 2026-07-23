/**
 * dax-fold.test.ts — unit tests for the A2 DAX AST → Synapse T-SQL fold engine.
 *
 * Asserts the exact SQL each supported DAX query folds to. Two invariants:
 *   1. BYTE-IDENTICAL on the pre-existing 3-regex patterns (no regression).
 *   2. The A2 batch-1 functions fold to correct T-SQL (SUMMARIZECOLUMNS GROUP BY
 *      incl. RELATED join, COUNTROWS, DISTINCTCOUNT, COUNTA, DISTINCT/VALUES,
 *      FILTER WHERE, CALCULATETABLE, ADDCOLUMNS, measure inlining).
 * Anything outside the folded set returns null (the honest unsupported path).
 *
 * The NUMERIC correctness of these folds on real serverless is gated by the A5
 * golden harness (e2e/dax-golden.spec.ts); this file gates the SQL shape.
 */
import { describe, it, expect } from 'vitest';
import { foldDaxToSql, type FoldModel } from '../dax/fold';

const STAR: FoldModel = {
  measures: [
    { name: 'Total Amount', table: 'Sales', expression: 'SUM(Sales[Amount])' },
    { name: 'Order Count', table: 'Sales', expression: 'COUNTROWS(Sales)' },
  ],
  relationships: [
    { from: 'Customer[CustomerId]', to: 'Sales[CustomerId]', cardinality: '1:many' },
    { from: 'Date[Date]', to: 'Sales[Date]', cardinality: '1:many' },
  ],
};

describe('fold — byte-identical to the prior 3-regex translator', () => {
  it('EVALUATE <Table>', () => {
    expect(foldDaxToSql('EVALUATE Sales')).toBe('SELECT TOP 1000 * FROM [Sales]');
  });
  it("EVALUATE 'Quoted Table'", () => {
    expect(foldDaxToSql("EVALUATE 'Fact Sales'")).toBe('SELECT TOP 1000 * FROM [Fact Sales]');
  });
  it('EVALUATE TOPN(N, Table)', () => {
    expect(foldDaxToSql('EVALUATE TOPN(5, Customers)')).toBe('SELECT TOP 5 * FROM [Customers]');
  });
  it('EVALUATE ROW(CALCULATE(SUM))', () => {
    expect(foldDaxToSql('EVALUATE ROW("Total", CALCULATE(SUM(Sales[Amount])))')).toBe(
      'SELECT SUM([Amount]) AS [Total] FROM [Sales]',
    );
  });
  it('AVERAGE → AVG; COUNT/MIN/MAX pass through', () => {
    expect(foldDaxToSql('EVALUATE ROW("Avg", CALCULATE(AVERAGE(Sales[Price])))')).toBe('SELECT AVG([Price]) AS [Avg] FROM [Sales]');
    expect(foldDaxToSql('EVALUATE ROW("C", CALCULATE(COUNT(T[X])))')).toBe('SELECT COUNT([X]) AS [C] FROM [T]');
    expect(foldDaxToSql('EVALUATE ROW("m", CALCULATE(MIN(T[X])))')).toBe('SELECT MIN([X]) AS [m] FROM [T]');
    expect(foldDaxToSql('EVALUATE ROW("M", CALCULATE(MAX(T[X])))')).toBe('SELECT MAX([X]) AS [M] FROM [T]');
  });
  it('returns null for empty / garbage', () => {
    expect(foldDaxToSql('')).toBeNull();
    expect(foldDaxToSql('EVALUATE (')).toBeNull();
  });
});

describe('fold — A2 batch-1 functions', () => {
  it('ROW without CALCULATE (bare agg)', () => {
    expect(foldDaxToSql('EVALUATE ROW("T", SUM(Sales[Amount]))')).toBe('SELECT SUM([Amount]) AS [T] FROM [Sales]');
  });
  it('COUNTROWS → COUNT(*)', () => {
    expect(foldDaxToSql('EVALUATE ROW("R", COUNTROWS(Sales))')).toBe('SELECT COUNT(*) AS [R] FROM [Sales]');
  });
  it('DISTINCTCOUNT → COUNT(DISTINCT)', () => {
    expect(foldDaxToSql('EVALUATE ROW("D", DISTINCTCOUNT(Sales[CustomerId]))')).toBe('SELECT COUNT(DISTINCT [CustomerId]) AS [D] FROM [Sales]');
  });
  it('COUNTA → COUNT(col)', () => {
    expect(foldDaxToSql('EVALUATE ROW("A", COUNTA(Sales[Amount]))')).toBe('SELECT COUNT([Amount]) AS [A] FROM [Sales]');
  });
  it('DISTINCT / VALUES → SELECT DISTINCT', () => {
    expect(foldDaxToSql('EVALUATE DISTINCT(Customer[Region])')).toBe('SELECT DISTINCT [Region] FROM [Customer]');
    expect(foldDaxToSql('EVALUATE VALUES(Customer[Segment])')).toBe('SELECT DISTINCT [Segment] FROM [Customer]');
  });
  it('FILTER → WHERE', () => {
    expect(foldDaxToSql('EVALUATE FILTER(Sales, Sales[Amount] > 100)')).toBe('SELECT TOP 1000 * FROM [Sales] WHERE [Amount] > 100');
  });
  it('CALCULATETABLE → WHERE (ANDed filters)', () => {
    expect(foldDaxToSql('EVALUATE CALCULATETABLE(Sales, Sales[Amount] > 100, Sales[Quantity] >= 2)')).toBe(
      'SELECT TOP 1000 * FROM [Sales] WHERE [Amount] > 100 AND [Quantity] >= 2',
    );
  });
  it('ADDCOLUMNS → projected expression', () => {
    expect(foldDaxToSql('EVALUATE ADDCOLUMNS(Sales, "Rev", Sales[Amount] * Sales[Quantity])')).toBe(
      'SELECT TOP 1000 *, ([Amount] * [Quantity]) AS [Rev] FROM [Sales]',
    );
  });
  it('SUMMARIZECOLUMNS single-table → GROUP BY', () => {
    expect(foldDaxToSql('EVALUATE SUMMARIZECOLUMNS(Sales[CustomerId], "Amt", SUM(Sales[Amount]))')).toBe(
      'SELECT [CustomerId], SUM([Amount]) AS [Amt] FROM [Sales] GROUP BY [CustomerId]',
    );
  });
  it('SUMMARIZECOLUMNS with a RELATED dim column → join + GROUP BY', () => {
    expect(foldDaxToSql('EVALUATE SUMMARIZECOLUMNS(Customer[Region], "Amt", CALCULATE(SUM(Sales[Amount])))', STAR)).toBe(
      'SELECT d0.[Region] AS [Region], SUM(f.[Amount]) AS [Amt] FROM [Sales] AS f INNER JOIN [Customer] AS d0 ON f.[CustomerId] = d0.[CustomerId] GROUP BY d0.[Region]',
    );
  });
  it('SUMMARIZECOLUMNS join requires a relationship (null without it)', () => {
    expect(foldDaxToSql('EVALUATE SUMMARIZECOLUMNS(Customer[Region], "Amt", SUM(Sales[Amount]))')).toBeNull();
  });
});

describe('fold — measure inlining', () => {
  it('inlines a DEFINE MEASURE reference', () => {
    expect(foldDaxToSql('DEFINE MEASURE Sales[M] = SUM(Sales[Amount]) EVALUATE ROW("T", [M])')).toBe(
      'SELECT SUM([Amount]) AS [T] FROM [Sales]',
    );
  });
  it('inlines a model measure reference', () => {
    expect(foldDaxToSql('EVALUATE ROW("T", [Total Amount])', STAR)).toBe('SELECT SUM([Amount]) AS [T] FROM [Sales]');
    expect(foldDaxToSql('EVALUATE ROW("R", [Order Count])', STAR)).toBe('SELECT COUNT(*) AS [R] FROM [Sales]');
  });
  it('unknown measure → null (honest)', () => {
    expect(foldDaxToSql('EVALUATE ROW("T", [Nonexistent])')).toBeNull();
  });
});

describe('fold — honest unsupported (null, never a wrong SQL)', () => {
  it('ORDER BY not folded in batch-1', () => {
    expect(foldDaxToSql('EVALUATE Sales ORDER BY Sales[Amount] DESC')).toBeNull();
  });
  it('exponentiation not folded', () => {
    expect(foldDaxToSql('EVALUATE ROW("P", 2 ^ 3)')).toBeNull();
  });
  it('unsupported iterator (A3 territory) → null', () => {
    expect(foldDaxToSql('EVALUATE ROW("Rev", SUMX(Sales, Sales[Amount] * Sales[Quantity]))')).toBeNull();
  });
});
