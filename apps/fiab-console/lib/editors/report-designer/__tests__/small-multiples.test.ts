/**
 * A6 — small-multiples grid resolution (helpers.resolveSmallMultiples).
 *
 * Proves the Format-pane "Small multiples" grid controls (columns / shared-Y /
 * Facet-by picker) drive the real trellis render prop consumed by LoomChart's
 * SmallMultiplesGrid — no dead controls (no-vaporware.md). The facet still comes
 * from the field well (folded into the wells→SQL GROUP BY); columns/sharedY were
 * dead before A6, and the runtime flag (`a6-small-multiples-grid`) reverts to the
 * pre-A6 well-only behaviour when OFF.
 */
import { describe, it, expect } from 'vitest';
import { resolveSmallMultiples } from '../helpers';
import type { Wells } from '../types';

const rows = [
  { Region: 'East', Month: 'Jan', Revenue: 1000 },
  { Region: 'West', Month: 'Jan', Revenue: 2000 },
  { Region: 'East', Month: 'Feb', Revenue: 1500 },
];

const wellFacet = (col: string): Wells => ({
  smallMultiples: [{ uid: 'w1', table: 'Sales', column: col }],
} as unknown as Wells);

describe('resolveSmallMultiples — Format grid controls drive the trellis prop', () => {
  it('no facet well and no format facet ⇒ undefined (single chart)', () => {
    expect(resolveSmallMultiples({} as Wells, undefined, rows, true)).toBeUndefined();
  });

  it('facet well only ⇒ facetColumn, no grid overrides', () => {
    const r = resolveSmallMultiples(wellFacet('Region'), undefined, rows, true);
    expect(r).toEqual({ facetColumn: 'Region' });
  });

  it('columns + sharedY from the Format grid controls flow through (A6 gap)', () => {
    const r = resolveSmallMultiples(
      wellFacet('Region'),
      { columns: 4, sharedY: false },
      rows,
      true,
    );
    expect(r).toEqual({ facetColumn: 'Region', columns: 4, sharedY: false });
  });

  it('sharedY:true is preserved (not dropped as falsy-default)', () => {
    const r = resolveSmallMultiples(wellFacet('Region'), { sharedY: true }, rows, true);
    expect(r).toEqual({ facetColumn: 'Region', sharedY: true });
  });

  it('invalid columns (0 / negative) are ignored (auto-fill fallback)', () => {
    expect(resolveSmallMultiples(wellFacet('Region'), { columns: 0 }, rows, true))
      .toEqual({ facetColumn: 'Region' });
  });

  it('flag OFF ⇒ well facet only, grid controls ignored (pre-A6 behaviour)', () => {
    const r = resolveSmallMultiples(
      wellFacet('Region'),
      { columns: 4, sharedY: false, facetColumn: 'Month' },
      rows,
      false,
    );
    expect(r).toEqual({ facetColumn: 'Region' });
  });

  it('Format facet picker resolves when its column is present in the rows', () => {
    const r = resolveSmallMultiples({} as Wells, { facetColumn: 'Region', columns: 3 }, rows, true);
    expect(r).toEqual({ facetColumn: 'Region', columns: 3 });
  });

  it('Format facet picker is rejected when the column is NOT in the result rows (no phantom facet)', () => {
    const r = resolveSmallMultiples({} as Wells, { facetColumn: 'NotAColumn' }, rows, true);
    expect(r).toBeUndefined();
  });

  it('the well facet takes precedence over the Format facet picker', () => {
    const r = resolveSmallMultiples(
      wellFacet('Region'),
      { facetColumn: 'Month', columns: 2 },
      rows,
      true,
    );
    expect(r).toEqual({ facetColumn: 'Region', columns: 2 });
  });
});
