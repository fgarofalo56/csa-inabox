/**
 * Tests for display-stats — the server-side DataFrame profiler + chart
 * recommender behind notebook display(). Pure functions, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  buildLoomDisplay, recommendCharts, enrichChartRecs, isNumericDtype, buildAggCode,
} from '../display-stats';
import type { LoomDisplayColumn, LoomDisplayPayload, LoomDisplayChartRec } from '@/lib/types/notebook-cell';

const appJson = {
  schema: {
    fields: [
      { name: 'id', type: 'long' },
      { name: 'amount', type: 'double' },
      { name: 'region', type: 'string' },
      { name: 'channel', type: 'string' },
    ],
  },
  data: [
    [0, 10.0, 'east', 'web'],
    [1, 20.0, 'west', 'web'],
    [2, 30.0, 'east', 'store'],
    [3, null, 'west', 'store'],
  ],
};

describe('isNumericDtype', () => {
  it('classifies Spark + pandas numeric dtypes, excludes bool/string', () => {
    expect(isNumericDtype('long')).toBe(true);
    expect(isNumericDtype('int64')).toBe(true);
    expect(isNumericDtype('double')).toBe(true);
    expect(isNumericDtype('float32')).toBe(true);
    expect(isNumericDtype('string')).toBe(false);
    expect(isNumericDtype('object')).toBe(false);
    expect(isNumericDtype('boolean')).toBe(false);
    expect(isNumericDtype(undefined)).toBe(false);
  });
});

describe('buildLoomDisplay', () => {
  it('computes real numeric stats and categorical cardinality', () => {
    const p = buildLoomDisplay(appJson, 5000)!;
    expect(p.version).toBe(1);
    expect(p.totalCount).toBe(4);
    expect(p.sampleSize).toBe(4);
    const amount = p.columns.find((c) => c.name === 'amount')!;
    expect(amount.min).toBe('10');
    expect(amount.max).toBe('30');
    expect(Number(amount.mean)).toBeCloseTo(20, 5); // (10+20+30)/3
    expect(amount.nullCount).toBe(1);
    const region = p.columns.find((c) => c.name === 'region')!;
    expect(region.cardinality).toBe(2);
    expect(region.topValues?.length).toBe(2);
  });

  it('respects the sample limit', () => {
    const big = { schema: appJson.schema, data: Array.from({ length: 100 }, (_, i) => [i, i * 1.0, 'east', 'web']) };
    const p = buildLoomDisplay(big, 10)!;
    expect(p.sampleSize).toBe(10);
    expect(p.totalCount).toBe(100);
    expect(p.rows.length).toBe(10);
  });

  it('returns null for malformed input', () => {
    expect(buildLoomDisplay(null)).toBeNull();
    expect(buildLoomDisplay({ schema: { fields: [] }, data: [] })).toBeNull();
    expect(buildLoomDisplay({ data: [[1]] } as any)).toBeNull();
  });

  it('recommends at least one chart for a categorical+numeric frame', () => {
    const p = buildLoomDisplay(appJson, 5000)!;
    expect(p.chartRecs.length).toBeGreaterThanOrEqual(1);
    expect(p.chartRecs.length).toBeLessThanOrEqual(5);
    expect(p.chartRecs[0].type).toBe('bar');
  });
});

describe('recommendCharts', () => {
  const cols = (defs: [string, string][]): LoomDisplayColumn[] =>
    defs.map(([name, dtype]) => ({ name, dtype, nullCount: 0 }));

  it('emits scatter for two numerics', () => {
    const recs = recommendCharts(cols([['a', 'double'], ['b', 'double']]));
    expect(recs.some((r) => r.type === 'scatter')).toBe(true);
  });

  it('emits a heatmap and grouped bar for two categoricals + numeric', () => {
    const recs = recommendCharts(cols([['r', 'string'], ['c', 'string'], ['v', 'long']]));
    expect(recs.some((r) => r.type === 'heatmap')).toBe(true);
    expect(recs.some((r) => r.type === 'bar' && r.legend)).toBe(true);
    expect(recs.length).toBeLessThanOrEqual(5);
  });

  it('falls back to a count bar for an all-categorical single column', () => {
    const recs = recommendCharts(cols([['r', 'string']]));
    expect(recs.length).toBe(1);
    expect(recs[0].agg).toBe('count');
  });
});

describe('enrichChartRecs', () => {
  it('fills empty chartRecs from columns, leaves populated ones untouched', () => {
    const base: LoomDisplayPayload = {
      version: 1, totalCount: 1, sampleSize: 1, rows: [['east', 1]],
      columns: [{ name: 'region', dtype: 'string', nullCount: 0 }, { name: 'v', dtype: 'long', nullCount: 0 }],
      chartRecs: [],
    };
    expect(enrichChartRecs(base).chartRecs.length).toBeGreaterThanOrEqual(1);
    const pre: LoomDisplayChartRec[] = [{ id: 'x', type: 'line', xField: 'region', yField: 'v', agg: 'sum', title: 't' }];
    expect(enrichChartRecs({ ...base, chartRecs: pre }).chartRecs).toBe(pre);
  });
});

describe('buildAggCode', () => {
  const rec = (over: Partial<LoomDisplayChartRec>): LoomDisplayChartRec =>
    ({ id: 'r', type: 'bar', xField: 'region', yField: 'amount', agg: 'sum', title: 't', ...over });

  it('builds a groupBy().agg() statement wrapped in display()', () => {
    const code = buildAggCode(rec({}), 'df');
    expect(code).toContain('display(');
    expect(code).toContain('df.groupBy("region")');
    expect(code).toContain('{"amount": "sum"}');
  });

  it('uses count() for the count agg and adds the legend group key', () => {
    const code = buildAggCode(rec({ agg: 'count', legend: 'channel' }), 'sales');
    expect(code).toContain('sales.groupBy("region", "channel").count()');
  });

  it('sanitizes a non-identifier variable name to df', () => {
    const code = buildAggCode(rec({}), 'df; import os');
    expect(code).toContain('df.groupBy');
    expect(code).not.toContain('import os');
  });
});
