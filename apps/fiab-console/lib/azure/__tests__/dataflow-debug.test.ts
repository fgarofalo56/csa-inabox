import { describe, it, expect } from 'vitest';
import {
  clampSampleSize,
  flowStreamNames,
  parseDfsSchema,
  diffSchemas,
  computeColumnStats,
  DATAFLOW_DEBUG_ROW_CAP,
  DATAFLOW_DEBUG_DEFAULT_SAMPLE,
  type DfsColumn,
} from '../dataflow-debug';
import type { AdfDataFlow } from '../adf-client';

describe('clampSampleSize', () => {
  it('defaults invalid / non-positive input', () => {
    expect(clampSampleSize(undefined)).toBe(DATAFLOW_DEBUG_DEFAULT_SAMPLE);
    expect(clampSampleSize('nope')).toBe(DATAFLOW_DEBUG_DEFAULT_SAMPLE);
    expect(clampSampleSize(0)).toBe(DATAFLOW_DEBUG_DEFAULT_SAMPLE);
    expect(clampSampleSize(-5)).toBe(DATAFLOW_DEBUG_DEFAULT_SAMPLE);
  });
  it('floors and caps at the row cap', () => {
    expect(clampSampleSize(50.9)).toBe(50);
    expect(clampSampleSize(5000)).toBe(DATAFLOW_DEBUG_ROW_CAP);
    expect(clampSampleSize('250')).toBe(250);
  });
});

describe('flowStreamNames', () => {
  it('lists sources, transformations, then sinks (named only)', () => {
    const flow: AdfDataFlow = {
      name: 'f',
      properties: {
        type: 'MappingDataFlow',
        typeProperties: {
          sources: [{ name: 'source1' }, { name: '' }],
          transformations: [{ name: 'filter1' }, { name: 'derive1' }],
          sinks: [{ name: 'sink1' }],
        },
      },
    } as unknown as AdfDataFlow;
    expect(flowStreamNames(flow)).toEqual(['source1', 'filter1', 'derive1', 'sink1']);
  });
  it('returns [] for an empty flow', () => {
    const flow = { name: 'f', properties: { type: 'MappingDataFlow', typeProperties: {} } } as unknown as AdfDataFlow;
    expect(flowStreamNames(flow)).toEqual([]);
  });
});

describe('parseDfsSchema', () => {
  it('parses flat name-as-type pairs', () => {
    expect(parseDfsSchema('output(name as string, age as integer, active as boolean)')).toEqual([
      { name: 'name', type: 'string' },
      { name: 'age', type: 'integer' },
      { name: 'active', type: 'boolean' },
    ]);
  });
  it('keeps nested struct types verbatim (no top-level split inside parens)', () => {
    const cols = parseDfsSchema('output(id as integer, loc as (lat as double, lng as double))');
    expect(cols).toHaveLength(2);
    expect(cols[0]).toEqual({ name: 'id', type: 'integer' });
    expect(cols[1].name).toBe('loc');
    expect(cols[1].type).toContain('lat as double');
    expect(cols[1].type).toContain('lng as double');
  });
  it('returns [] for empty / unparseable schema', () => {
    expect(parseDfsSchema('')).toEqual([]);
    expect(parseDfsSchema(undefined)).toEqual([]);
    expect(parseDfsSchema('no parens here')).toEqual([]);
  });
});

describe('diffSchemas', () => {
  const a: DfsColumn[] = [
    { name: 'id', type: 'integer' },
    { name: 'name', type: 'string' },
    { name: 'old', type: 'string' },
  ];
  const b: DfsColumn[] = [
    { name: 'id', type: 'long' },        // retyped
    { name: 'name', type: 'string' },    // unchanged
    { name: 'added', type: 'boolean' },  // added
    // 'old' removed
  ];
  it('classifies added/removed/retyped/unchanged', () => {
    const d = diffSchemas(a, b);
    const byName = Object.fromEntries(d.map((e) => [e.name, e]));
    expect(byName.id.change).toBe('retyped');
    expect(byName.id.inType).toBe('integer');
    expect(byName.id.outType).toBe('long');
    expect(byName.name.change).toBe('unchanged');
    expect(byName.added.change).toBe('added');
    expect(byName.old.change).toBe('removed');
  });
  it('orders output columns first, removed appended', () => {
    const d = diffSchemas(a, b);
    expect(d.map((e) => e.name)).toEqual(['id', 'name', 'added', 'old']);
  });
});

describe('computeColumnStats', () => {
  it('computes null %, distinct, numeric min/max/mean/stddev', () => {
    const columns = ['qty', 'label'];
    const rows: unknown[][] = [
      [10, 'a'],
      [20, 'b'],
      [30, 'a'],
      [null, 'a'],
    ];
    const [qty, label] = computeColumnStats(columns, rows);

    expect(qty.count).toBe(4);
    expect(qty.nulls).toBe(1);
    expect(qty.numeric).toBe(true);
    expect(qty.min).toBe(10);
    expect(qty.max).toBe(30);
    expect(qty.mean).toBe(20);
    // population stddev of [10,20,30] = sqrt(200/3) ≈ 8.165
    expect(qty.stddev).toBeCloseTo(Math.sqrt(200 / 3), 5);
    expect(qty.distinct).toBe(3);

    expect(label.numeric).toBe(false);
    expect(label.nulls).toBe(0);
    expect(label.distinct).toBe(2);
    expect(label.topValues[0]).toEqual({ value: 'a', count: 3 });
  });

  it('treats a column with a non-numeric value as non-numeric', () => {
    const [c] = computeColumnStats(['mix'], [[1], ['x'], [3]]);
    expect(c.numeric).toBe(false);
    expect(c.min).toBeUndefined();
  });

  it('empty rows → zeroed stats, no throw', () => {
    const [c] = computeColumnStats(['a'], []);
    expect(c.count).toBe(0);
    expect(c.nulls).toBe(0);
    expect(c.distinct).toBe(0);
    expect(c.numeric).toBe(false);
    expect(c.topValues).toEqual([]);
  });
});
