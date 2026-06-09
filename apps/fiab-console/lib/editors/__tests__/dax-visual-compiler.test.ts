import { describe, it, expect } from 'vitest';
import { compileDaxQuery, refToAlias, VISUAL_CATALOG, type VisualDef } from '../dax-visual-compiler';

function base(partial: Partial<VisualDef>): VisualDef {
  return {
    type: 'column',
    categoryFields: [],
    valueFields: [],
    ...partial,
  };
}

describe('dax-visual-compiler', () => {
  it('compiles a column visual with one category + one measure to SUMMARIZECOLUMNS', () => {
    const dax = compileDaxQuery(base({
      type: 'column',
      categoryFields: [{ ref: "'Sales'[Region]", alias: 'Region' }],
      valueFields: [{ ref: "'Sales'[Total]", isMeasure: true, alias: 'Total' }],
    }));
    expect(dax).toContain('EVALUATE');
    expect(dax).toContain('SUMMARIZECOLUMNS(');
    expect(dax).toContain("'Sales'[Region]");
    expect(dax).toContain('"Total", \'Sales\'[Total]');
  });

  it('wraps a plain numeric column in its aggregation', () => {
    const dax = compileDaxQuery(base({
      type: 'bar',
      categoryFields: [{ ref: "'Sales'[Region]" }],
      valueFields: [{ ref: "'Sales'[Amount]", agg: 'SUM', alias: 'Amount' }],
    }));
    expect(dax).toContain("SUM('Sales'[Amount])");
  });

  it('compiles a card (single measure) to EVALUATE ROW', () => {
    const dax = compileDaxQuery(base({
      type: 'card',
      valueFields: [{ ref: "'Sales'[Total]", isMeasure: true, alias: 'Total' }],
    }));
    expect(dax).toContain('EVALUATE ROW(');
    expect(dax).toContain('"Total", \'Sales\'[Total]');
    expect(dax).not.toContain('SUMMARIZECOLUMNS');
  });

  it('compiles a multi-row card with several measures to one ROW', () => {
    const dax = compileDaxQuery(base({
      type: 'multi-row-card',
      valueFields: [
        { ref: "'Sales'[Total]", isMeasure: true, alias: 'Total' },
        { ref: "'Sales'[Count]", isMeasure: true, alias: 'Count' },
      ],
    }));
    expect(dax).toContain('EVALUATE ROW(');
    expect(dax).toContain('"Total"');
    expect(dax).toContain('"Count"');
  });

  it('compiles a slicer to EVALUATE VALUES with ORDER BY', () => {
    const dax = compileDaxQuery(base({
      type: 'slicer',
      categoryFields: [{ ref: "'Sales'[Region]" }],
    }));
    expect(dax).toContain("EVALUATE VALUES('Sales'[Region])");
    expect(dax).toContain("ORDER BY 'Sales'[Region]");
  });

  it('emits KEEPFILTERS(TREATAS(...)) for an IN-list visual filter', () => {
    const dax = compileDaxQuery(base({
      type: 'column',
      categoryFields: [{ ref: "'Sales'[Region]" }],
      valueFields: [{ ref: "'Sales'[Total]", isMeasure: true }],
      visualFilters: [{ column: "'Sales'[Region]", type: 'in', values: ['East', 'West'] }],
    }));
    expect(dax).toContain('KEEPFILTERS(TREATAS({"East", "West"}, \'Sales\'[Region]))');
  });

  it('emits numeric filter values bare (not quoted)', () => {
    const dax = compileDaxQuery(base({
      type: 'column',
      categoryFields: [{ ref: "'Sales'[Year]" }],
      valueFields: [{ ref: "'Sales'[Total]", isMeasure: true }],
      visualFilters: [{ column: "'Sales'[Year]", type: 'in', values: ['2025', '2026'] }],
    }));
    expect(dax).toContain('TREATAS({2025, 2026}');
  });

  it('merges page + visual filters into both TREATAS clauses', () => {
    const dax = compileDaxQuery(base({
      type: 'column',
      categoryFields: [{ ref: "'Sales'[Region]" }],
      valueFields: [{ ref: "'Sales'[Total]", isMeasure: true }],
      visualFilters: [{ column: "'Sales'[Region]", type: 'in', values: ['East'] }],
      pageFilters: [{ column: "'Sales'[Segment]", type: 'in', values: ['Retail'] }],
    }));
    expect(dax).toContain("'Sales'[Region]");
    expect(dax).toContain("'Sales'[Segment]");
    expect((dax.match(/TREATAS/g) || []).length).toBe(2);
  });

  it('returns a placeholder comment (not a syntax error) for an empty visual', () => {
    const dax = compileDaxQuery(base({ type: 'column' }));
    expect(dax).toContain('-- Add fields');
    expect(dax).not.toContain('EVALUATE');
  });

  it('caps a raw table (no measures) with TOPN', () => {
    const dax = compileDaxQuery(base({
      type: 'table',
      columnFields: [{ ref: "'Sales'[Region]" }, { ref: "'Sales'[Segment]" }],
      valueFields: [],
      rowLimit: 500,
    }));
    expect(dax).toContain('TOPN(500');
  });

  it('groups a matrix by both row and column fields', () => {
    const dax = compileDaxQuery(base({
      type: 'matrix',
      categoryFields: [{ ref: "'Sales'[Region]" }],
      matrixColumnField: { ref: "'Date'[Year]" },
      valueFields: [{ ref: "'Sales'[Total]", isMeasure: true, alias: 'Total' }],
    }));
    expect(dax).toContain("'Sales'[Region]");
    expect(dax).toContain("'Date'[Year]");
    expect(dax).toContain('SUMMARIZECOLUMNS');
  });

  it('includes legend fields as an extra group-by', () => {
    const dax = compileDaxQuery(base({
      type: 'column',
      categoryFields: [{ ref: "'Sales'[Region]" }],
      legendFields: [{ ref: "'Sales'[Segment]" }],
      valueFields: [{ ref: "'Sales'[Total]", isMeasure: true }],
    }));
    expect(dax).toContain("'Sales'[Region]");
    expect(dax).toContain("'Sales'[Segment]");
  });

  it('refToAlias strips the table + brackets to a readable header', () => {
    expect(refToAlias("'Sales'[Total Revenue]")).toBe('Total Revenue');
    expect(refToAlias("'My Table'[Col]")).toBe('Col');
  });

  it('exposes all 19 visual types in the gallery catalog', () => {
    expect(VISUAL_CATALOG.length).toBe(19);
    const types = VISUAL_CATALOG.map((c) => c.type);
    for (const t of ['bar', 'column', 'line', 'area', 'combo', 'pie', 'donut', 'card', 'multi-row-card', 'kpi', 'table', 'matrix', 'map', 'filled-map', 'scatter', 'gauge', 'funnel', 'treemap', 'slicer'] as const) {
      expect(types).toContain(t);
    }
  });
});
