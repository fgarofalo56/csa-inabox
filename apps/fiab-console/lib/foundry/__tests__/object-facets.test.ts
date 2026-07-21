/**
 * object-facets (WS-4.7) — pure facet / histogram / time-bucket compute + the
 * property-type-aware filter predicates. No DOM, no PG — these run over plain
 * instance rows exactly as the client receives them from weave-explore.
 */
import { describe, it, expect } from 'vitest';
import {
  buildFacetChart, buildFacetCharts, computeCategoryFacet, computeHistogram,
  computeTimeBuckets, computeBooleanFacet, facetKindForBaseType, inferFacetKind,
  filterFromBin, applyFacetFilters, objectMatchesFilter, sameFilter, filterLabel,
  type ExplorerObject, type FacetFilter,
} from '../object-facets';

function obj(id: string, properties: Record<string, unknown>): ExplorerObject {
  return { id, objectType: 'T', properties };
}

const ROWS: ExplorerObject[] = [
  obj('1', { status: 'open', amount: 10, createdAt: '2026-01-05', vip: true, tags: ['a', 'b'] }),
  obj('2', { status: 'open', amount: 20, createdAt: '2026-01-20', vip: false, tags: ['a'] }),
  obj('3', { status: 'closed', amount: 90, createdAt: '2026-03-11', vip: true, tags: ['c'] }),
  obj('4', { status: 'closed', amount: 100, createdAt: '2026-06-02', vip: false }),
  obj('5', { status: 'pending', amount: 55, createdAt: '2026-06-30', vip: true }),
];

describe('kind resolution', () => {
  it('maps declared base types to facet kinds', () => {
    expect(facetKindForBaseType('string')).toBe('category');
    expect(facetKindForBaseType('integer')).toBe('histogram');
    expect(facetKindForBaseType('double')).toBe('histogram');
    expect(facetKindForBaseType('date')).toBe('timebucket');
    expect(facetKindForBaseType('timestamp')).toBe('timebucket');
    expect(facetKindForBaseType('boolean')).toBe('boolean');
    expect(facetKindForBaseType(undefined)).toBeUndefined();
  });
  it('infers kind from values when the base type is unknown', () => {
    expect(inferFacetKind([true, false, true])).toBe('boolean');
    expect(inferFacetKind([1, 2, 3])).toBe('histogram');
    expect(inferFacetKind(['2026-01-01', '2026-02-02'])).toBe('timebucket');
    expect(inferFacetKind(['open', 'closed'])).toBe('category');
    expect(inferFacetKind([])).toBe('category');
  });
});

describe('computeCategoryFacet', () => {
  it('counts distinct values sorted desc over REAL rows', () => {
    const c = computeCategoryFacet(ROWS, 'status');
    expect(c.kind).toBe('category');
    expect(c.total).toBe(5);
    expect(c.distinct).toBe(3);
    // equal counts tie-break alphabetically → closed before open
    expect(c.bins.map((b) => [b.value, b.count])).toEqual([
      ['closed', 2], ['open', 2], ['pending', 1],
    ]);
  });
  it('expands array-valued properties into per-element occurrences', () => {
    const c = computeCategoryFacet(ROWS, 'tags');
    expect(c.total).toBe(3); // 3 rows carry tags
    const a = c.bins.find((b) => b.value === 'a');
    expect(a?.count).toBe(2);
  });
  it('truncates to top-N and flags it', () => {
    const rows = Array.from({ length: 20 }, (_, i) => obj(String(i), { k: `v${i}` }));
    const c = computeCategoryFacet(rows, 'k', 5);
    expect(c.bins).toHaveLength(5);
    expect(c.truncated).toBe(true);
    expect(c.distinct).toBe(20);
  });
});

describe('computeHistogram', () => {
  it('buckets numeric values into equal-width bins with real counts', () => {
    const h = computeHistogram(ROWS, 'amount', 3);
    expect(h.kind).toBe('histogram');
    expect(h.total).toBe(5);
    expect(h.bins).toHaveLength(3);
    // sum of counts equals the number of numeric values
    expect(h.bins.reduce((s, b) => s + b.count, 0)).toBe(5);
    // first bin lower bound is the min, last upper bound is the max
    expect(h.bins[0].lo).toBe(10);
    expect(h.bins[2].hi).toBe(100);
  });
  it('collapses to a single bin when all values are equal', () => {
    const rows = [obj('1', { n: 7 }), obj('2', { n: 7 })];
    const h = computeHistogram(rows, 'n');
    expect(h.bins).toHaveLength(1);
    expect(h.bins[0].count).toBe(2);
  });
  it('returns no bins when nothing is numeric', () => {
    const h = computeHistogram([obj('1', { n: 'x' })], 'n');
    expect(h.total).toBe(0);
    expect(h.bins).toHaveLength(0);
  });
});

describe('computeTimeBuckets', () => {
  it('auto-picks month granularity and buckets real dates chronologically', () => {
    const t = computeTimeBuckets(ROWS, 'createdAt');
    expect(t.kind).toBe('timebucket');
    expect(t.total).toBe(5);
    // Jan(2), Mar(1), Jun(2) → 3 non-empty month buckets, sorted by time
    expect(t.bins.map((b) => [b.label, b.count])).toEqual([
      ['2026-01', 2], ['2026-03', 1], ['2026-06', 2],
    ]);
    expect(t.bins[0].lo).toBeLessThan(t.bins[1].lo!);
  });
});

describe('computeBooleanFacet', () => {
  it('produces a 2-way true/false split', () => {
    const b = computeBooleanFacet(ROWS, 'vip');
    expect(b.kind).toBe('boolean');
    expect(b.total).toBe(5);
    expect(b.bins.find((x) => x.value === 'true')?.count).toBe(3);
    expect(b.bins.find((x) => x.value === 'false')?.count).toBe(2);
  });
});

describe('buildFacetChart / buildFacetCharts', () => {
  it('dispatches on the declared base type', () => {
    expect(buildFacetChart(ROWS, { apiName: 'status', baseType: 'string' }).kind).toBe('category');
    expect(buildFacetChart(ROWS, { apiName: 'amount', baseType: 'integer' }).kind).toBe('histogram');
    expect(buildFacetChart(ROWS, { apiName: 'createdAt', baseType: 'date' }).kind).toBe('timebucket');
    expect(buildFacetChart(ROWS, { apiName: 'vip', baseType: 'boolean' }).kind).toBe('boolean');
  });
  it('drops properties with no usable data', () => {
    const charts = buildFacetCharts(ROWS, [
      { apiName: 'status', baseType: 'string' },
      { apiName: 'missing', baseType: 'string' },
    ]);
    expect(charts.map((c) => c.apiName)).toEqual(['status']);
  });
  it('carries the display name through', () => {
    const c = buildFacetChart(ROWS, { apiName: 'status', displayName: 'Status', baseType: 'string' });
    expect(c.displayName).toBe('Status');
  });
});

describe('type-aware filters', () => {
  it('category filter keeps only matching rows (array-aware)', () => {
    const f: FacetFilter = { apiName: 'status', kind: 'category', values: ['open'] };
    const out = applyFacetFilters(ROWS, [f]);
    expect(out.map((o) => o.id)).toEqual(['1', '2']);
    const tagF: FacetFilter = { apiName: 'tags', kind: 'category', values: ['a'] };
    expect(applyFacetFilters(ROWS, [tagF]).map((o) => o.id)).toEqual(['1', '2']);
  });
  it('numeric range filter is inclusive of both bounds', () => {
    const f: FacetFilter = { apiName: 'amount', kind: 'range', lo: 50, hi: 100 };
    expect(applyFacetFilters(ROWS, [f]).map((o) => o.id)).toEqual(['3', '4', '5']);
  });
  it('time range filter uses a half-open [from,to) bucket', () => {
    const f: FacetFilter = {
      apiName: 'createdAt', kind: 'timerange',
      fromMs: Date.UTC(2026, 0, 1), toMs: Date.UTC(2026, 1, 1),
    };
    expect(applyFacetFilters(ROWS, [f]).map((o) => o.id)).toEqual(['1', '2']);
  });
  it('boolean filter matches the chosen value', () => {
    const f: FacetFilter = { apiName: 'vip', kind: 'boolean', value: true };
    expect(applyFacetFilters(ROWS, [f]).map((o) => o.id)).toEqual(['1', '3', '5']);
  });
  it('ANDs multiple filters', () => {
    const out = applyFacetFilters(ROWS, [
      { apiName: 'status', kind: 'category', values: ['open'] },
      { apiName: 'vip', kind: 'boolean', value: true },
    ]);
    expect(out.map((o) => o.id)).toEqual(['1']);
  });
  it('excludes rows missing the filtered property', () => {
    const f: FacetFilter = { apiName: 'tags', kind: 'category', values: ['a'] };
    expect(objectMatchesFilter(ROWS[3], f)).toBe(false); // row 4 has no tags
  });
});

describe('filterFromBin + toggling', () => {
  it('derives the right filter from a clicked bin', () => {
    const cat = computeCategoryFacet(ROWS, 'status');
    expect(filterFromBin(cat, cat.bins[0])).toEqual({ apiName: 'status', kind: 'category', values: ['closed'] });
    const hist = computeHistogram(ROWS, 'amount', 3);
    const rf = filterFromBin(hist, hist.bins[0]);
    expect(rf?.kind).toBe('range');
    const tb = computeTimeBuckets(ROWS, 'createdAt');
    expect(filterFromBin(tb, tb.bins[0])?.kind).toBe('timerange');
    const bf = computeBooleanFacet(ROWS, 'vip');
    expect(filterFromBin(bf, bf.bins[0])).toEqual({ apiName: 'vip', kind: 'boolean', value: true });
  });
  it('sameFilter identifies an already-active selection', () => {
    const a: FacetFilter = { apiName: 'status', kind: 'category', values: ['open'] };
    const b: FacetFilter = { apiName: 'status', kind: 'category', values: ['open'] };
    const c: FacetFilter = { apiName: 'status', kind: 'category', values: ['closed'] };
    expect(sameFilter(a, b)).toBe(true);
    expect(sameFilter(a, c)).toBe(false);
  });
  it('filterLabel is human-readable', () => {
    expect(filterLabel({ apiName: 'status', kind: 'category', values: ['open'] })).toContain('status: open');
    expect(filterLabel({ apiName: 'vip', kind: 'boolean', value: true })).toContain('true');
  });
});
