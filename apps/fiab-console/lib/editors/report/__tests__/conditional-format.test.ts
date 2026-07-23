/**
 * A9 — conditional-format painter golden harness + matrix uniformity.
 *
 * Ground truth (FRESH0, 2026-07-23): report interactions are largely built —
 * drill-through (right-click → target page with carried filters), drill-up/down
 * on hierarchies, and cross-filter highlight/filter/none all ship. The genuine
 * A9 gaps were (a) the pivoted MatrixPivotTable applied NO conditional formatting
 * (the plain table did — a parity/no-vaporware gap A9 wires via `matrixCellPaint`)
 * and (b) the conditional-format painter had ZERO tests. This harness pins
 * `cellStyleFor` (every mode) + `applyConditionalFormat().paintFor` (column
 * resolution) + the `matrixCellPaint` gate.
 */
import { describe, it, expect } from 'vitest';
import {
  cellStyleFor,
  applyConditionalFormat,
  type CondRule,
  type CondDomain,
  type ReportConditionalFormat,
} from '../conditional-format';
import { matrixCellPaint } from '../../report-designer/visual-body';

const DOMAIN: CondDomain = { min: 0, max: 100, mid: 50, maxAbs: 100, hasNeg: false, count: 3 };

const rule = (over: Partial<CondRule>): CondRule => ({
  id: 'r1', field: { column: 'Sales' }, mode: 'rules', ...over,
});

describe('cellStyleFor — every conditional-format mode', () => {
  it('rules (background): a matched threshold paints the cell background', () => {
    const r = rule({ mode: 'rules', applyTo: 'background', rules: [{ id: 't', op: 'ge', value: 80, color: 'green' }] });
    const paint = cellStyleFor(90, r);
    expect(paint.background).toBeTruthy();
    expect(paint.color).toBeUndefined();
  });

  it('rules (text): a matched threshold paints the font color, not the background', () => {
    const r = rule({ mode: 'rules', applyTo: 'text', rules: [{ id: 't', op: 'ge', value: 80, color: 'green' }] });
    const paint = cellStyleFor(90, r);
    expect(paint.color).toBeTruthy();
    expect(paint.background).toBeUndefined();
  });

  it('rules: an unmatched value paints nothing', () => {
    const r = rule({ mode: 'rules', rules: [{ id: 't', op: 'ge', value: 80, color: 'green' }] });
    expect(cellStyleFor(10, r)).toEqual({});
  });

  it('rules: a non-numeric value paints nothing', () => {
    const r = rule({ mode: 'rules', rules: [{ id: 't', op: 'ge', value: 80, color: 'green' }] });
    expect(cellStyleFor('n/a', r)).toEqual({});
  });

  it('colorScale: a value inside the domain blends to a background', () => {
    const r = rule({ mode: 'colorScale', applyTo: 'background', colorScale: { min: 'blue', max: 'red' } });
    expect(cellStyleFor(75, r, DOMAIN).background).toBeTruthy();
  });

  it('dataBars: paints a gradient background + a positive/negative fill', () => {
    const r = rule({ mode: 'dataBars', dataBars: { positive: 'green', negative: 'red' } });
    const paint = cellStyleFor(60, r, DOMAIN);
    expect(paint.background).toBeTruthy();
    expect(paint.fill).toBe('green');
    // negative value takes the negative fill
    expect(cellStyleFor(-10, r, { ...DOMAIN, min: -50, hasNeg: true, maxAbs: 50 }).fill).toBe('red');
  });

  it('icons (auto arrows band): emits a glyph from the chosen set', () => {
    const r = rule({ mode: 'icons', icons: { set: 'arrows' } });
    const paint = cellStyleFor(90, r, DOMAIN);
    expect(paint.icon).toBeDefined();
    expect(['▼', '▶', '▲']).toContain(paint.icon!.glyph);
  });

  it('icons (custom threshold band): the matching band glyph wins', () => {
    const r = rule({ mode: 'icons', icons: { bands: [{ id: 'b', op: 'ge', value: 50, glyph: '★', token: 'green' }] } });
    expect(cellStyleFor(75, r, DOMAIN).icon!.glyph).toBe('★');
    expect(cellStyleFor(10, r, DOMAIN)).toEqual({}); // below the band ⇒ nothing
  });

  it('fieldValue: a color-valued cell paints itself', () => {
    const r = rule({ mode: 'fieldValue', applyTo: 'background' });
    expect(cellStyleFor('#ff0000', r).background).toBe('#ff0000');
  });

  it('webUrl: a URL-valued cell yields a link', () => {
    const r = rule({ mode: 'webUrl' });
    expect(cellStyleFor('https://contoso.com', r).link).toBe('https://contoso.com');
  });
});

describe('applyConditionalFormat — bind rules to result columns', () => {
  const rows = [
    { Region: 'East', Sales: 20 },
    { Region: 'West', Sales: 90 },
  ];
  const cfg: ReportConditionalFormat = {
    rules: [rule({ mode: 'rules', applyTo: 'background', rules: [{ id: 't', op: 'ge', value: 80, color: 'green' }] })],
  };

  it('resolves the bound column and paints only matching cells', () => {
    const cf = applyConditionalFormat(rows, cfg);
    expect(cf.active).toBe(true);
    expect(cf.paintFor('Sales', 90)!.background).toBeTruthy();
    expect(cf.paintFor('Sales', 20)).toEqual({}); // below threshold
  });

  it('a column with no rule returns undefined (no paint)', () => {
    const cf = applyConditionalFormat(rows, cfg);
    expect(cf.paintFor('Region', 'East')).toBeUndefined();
  });

  it('no rules ⇒ inactive resolver', () => {
    expect(applyConditionalFormat(rows, { rules: [] }).active).toBe(false);
  });
});

describe('matrixCellPaint — A9 matrix uniformity gate', () => {
  const rows = [{ Region: 'W', Sales: 90 }];
  const cf = applyConditionalFormat(rows, {
    rules: [rule({ mode: 'rules', applyTo: 'background', rules: [{ id: 't', op: 'ge', value: 80, color: 'green' }] })],
  });

  it('enabled + active + a value ⇒ the same paint the table path uses', () => {
    expect(matrixCellPaint(cf, true, 'Sales', 90)!.background).toBeTruthy();
  });

  it('flag OFF ⇒ no paint (pre-A9 unpainted matrix)', () => {
    expect(matrixCellPaint(cf, false, 'Sales', 90)).toBeUndefined();
  });

  it('a blank cell (undefined value) ⇒ no paint', () => {
    expect(matrixCellPaint(cf, true, 'Sales', undefined)).toBeUndefined();
  });

  it('an inactive resolver ⇒ no paint', () => {
    const inactive = applyConditionalFormat(rows, { rules: [] });
    expect(matrixCellPaint(inactive, true, 'Sales', 90)).toBeUndefined();
  });
});
