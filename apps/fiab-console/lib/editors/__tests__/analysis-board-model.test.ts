import { describe, it, expect } from 'vitest';
import { compileBoardToKql, normalizeBoard, isKqlIdent, type AnalysisBoard } from '../analysis-board-model';

const table = (steps: any[]): AnalysisBoard => ({ source: { kind: 'table', table: 'Events' }, steps });

describe('isKqlIdent', () => {
  it('accepts valid, rejects injection', () => {
    expect(isKqlIdent('Col_1')).toBe(true);
    expect(isKqlIdent('1bad')).toBe(false);
    expect(isKqlIdent('a; drop')).toBe(false);
    expect(isKqlIdent('a b')).toBe(false);
  });
});

describe('compileBoardToKql — source', () => {
  it('table source', () => {
    const r = compileBoardToKql(table([]));
    expect(r).toEqual({ ok: true, kql: 'Events' });
  });
  it('query source wraps in parens', () => {
    const r = compileBoardToKql({ source: { kind: 'query', query: 'Events | take 5' }, steps: [] });
    expect(r).toEqual({ ok: true, kql: '(Events | take 5)' });
  });
  it('rejects an invalid table name (injection)', () => {
    const r = compileBoardToKql({ source: { kind: 'table', table: 'Events; drop' }, steps: [] });
    expect(r.ok).toBe(false);
  });
  it('rejects an empty query source', () => {
    expect(compileBoardToKql({ source: { kind: 'query', query: '  ' }, steps: [] }).ok).toBe(false);
  });
});

describe('compileBoardToKql — steps', () => {
  it('filter with numeric + string scalars', () => {
    const r = compileBoardToKql(table([
      { type: 'filter', column: 'amount', op: 'gt', value: '100' },
      { type: 'filter', column: 'region', op: 'eq', value: 'West' },
    ]));
    expect(r).toEqual({ ok: true, kql: 'Events\n| where amount > 100\n| where region == "West"' });
  });
  it('filter contains/startswith + in-list', () => {
    expect(compileBoardToKql(table([{ type: 'filter', column: 'name', op: 'contains', value: 'acme' }]))).toEqual({ ok: true, kql: 'Events\n| where name contains "acme"' });
    expect(compileBoardToKql(table([{ type: 'filter', column: 'status', op: 'in', value: 'open, closed, 3' }]))).toEqual({ ok: true, kql: 'Events\n| where status in ("open", "closed", 3)' });
  });
  it('escapes quotes in string values (injection-safe)', () => {
    const r = compileBoardToKql(table([{ type: 'filter', column: 'name', op: 'eq', value: 'a" or 1==1 //' }]));
    expect(r.ok).toBe(true);
    expect((r as any).kql).toContain('where name == "a\\" or 1==1 //"');
  });
  it('select + distinct', () => {
    expect(compileBoardToKql(table([{ type: 'select', columns: ['a', 'b', 'bad col'] }]))).toEqual({ ok: true, kql: 'Events\n| project a, b' });
    expect(compileBoardToKql(table([{ type: 'distinct', columns: ['region'] }]))).toEqual({ ok: true, kql: 'Events\n| distinct region' });
  });
  it('aggregate with count + typed aggs + group by', () => {
    const r = compileBoardToKql(table([{ type: 'aggregate', groupBy: ['region'], aggregations: [{ fn: 'count', as: 'n' }, { fn: 'sum', column: 'amount', as: 'total' }] }]));
    expect(r).toEqual({ ok: true, kql: 'Events\n| summarize n = count(), total = sum(amount) by region' });
  });
  it('sort + limit (capped)', () => {
    expect(compileBoardToKql(table([{ type: 'sort', column: 'amount', direction: 'asc' }]))).toEqual({ ok: true, kql: 'Events\n| order by amount asc' });
    expect(compileBoardToKql(table([{ type: 'limit', count: 9999999 }]))).toEqual({ ok: true, kql: 'Events\n| take 100000' });
  });
  it('derive with a safe arithmetic expression; rejects unsafe chars', () => {
    expect(compileBoardToKql(table([{ type: 'derive', as: 'net', expr: 'amount - fee' }]))).toEqual({ ok: true, kql: 'Events\n| extend net = amount - fee' });
    expect(compileBoardToKql(table([{ type: 'derive', as: 'x', expr: 'amount); drop table' }])).ok).toBe(false);
  });
  it('a full pipeline chains in order', () => {
    const r = compileBoardToKql(table([
      { type: 'filter', column: 'amount', op: 'gte', value: '10' },
      { type: 'aggregate', groupBy: ['region'], aggregations: [{ fn: 'avg', column: 'amount', as: 'avgAmt' }] },
      { type: 'sort', column: 'avgAmt', direction: 'desc' },
      { type: 'limit', count: 10 },
    ]));
    expect(r).toEqual({ ok: true, kql: 'Events\n| where amount >= 10\n| summarize avgAmt = avg(amount) by region\n| order by avgAmt desc\n| take 10' });
  });
  it('returns a precise error for a bad step', () => {
    const r = compileBoardToKql(table([{ type: 'filter', column: 'bad col', op: 'eq', value: 'x' }]));
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/Step 1.*invalid column/);
  });
});

describe('normalizeBoard', () => {
  it('coerces source + drops malformed steps', () => {
    const b = normalizeBoard({ source: { kind: 'table', table: 'T' }, steps: [{ type: 'filter', column: 'a', op: 'eq', value: '1' }, { type: 'bogus' }, 42] });
    expect(b.source).toEqual({ kind: 'table', table: 'T' });
    expect(b.steps).toHaveLength(1);
  });
  it('defaults to an empty table source', () => {
    expect(normalizeBoard(null)).toEqual({ source: { kind: 'table', table: '' }, steps: [] });
  });
});
