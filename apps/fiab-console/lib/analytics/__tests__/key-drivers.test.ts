import { describe, it, expect } from 'vitest';
import { rankKeyDrivers, pearson, correlationRatio } from '../key-drivers';

describe('pearson', () => {
  it('is 1 for a perfectly positive relationship', () => {
    const r = pearson([1, 2, 3, 4], [2, 4, 6, 8]);
    expect(r).toBeCloseTo(1, 6);
  });
  it('is -1 for a perfectly negative relationship', () => {
    const r = pearson([1, 2, 3, 4], [8, 6, 4, 2]);
    expect(r).toBeCloseTo(-1, 6);
  });
  it('is null when a side has no variance', () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
  });
});

describe('correlationRatio (eta)', () => {
  it('is high for cleanly class-separated groups', () => {
    const labels = ['a', 'a', 'b', 'b', 'c', 'c'];
    const metric = [1, 2, 20, 21, 40, 41];
    const cr = correlationRatio(labels, metric);
    expect(cr).not.toBeNull();
    expect(cr!.eta).toBeGreaterThan(0.95);
    expect(cr!.topCategory).toBe('c');
  });
  it('is low when group means coincide despite within-group variance', () => {
    // Group means are equal (10.5) so between-group variance ≈ 0 → η ≈ 0,
    // even though the metric varies widely within each group.
    const labels = ['a', 'a', 'b', 'b'];
    const metric = [1, 20, 2, 19];
    const cr = correlationRatio(labels, metric);
    expect(cr).not.toBeNull();
    expect(cr!.eta).toBeLessThan(0.2);
  });
  it('is null for a single group', () => {
    expect(correlationRatio(['a', 'a', 'a'], [1, 2, 3])).toBeNull();
  });
});

describe('rankKeyDrivers', () => {
  it('ranks a strong numeric driver above a weak one and reports direction', () => {
    // metric = 2*strong + small noise; weak is nearly unrelated.
    const columns = ['strong', 'weak', 'metric'];
    const rows: unknown[][] = [
      [1, 5, 2.1],
      [2, 3, 3.9],
      [3, 9, 6.2],
      [4, 2, 7.8],
      [5, 8, 10.1],
      [6, 4, 11.9],
      [7, 7, 14.2],
      [8, 1, 15.8],
    ];
    const res = rankKeyDrivers({ columns, rows, metric: 'metric' });
    expect(res).not.toBeNull();
    expect(res!.drivers.length).toBe(2);
    expect(res!.drivers[0].name).toBe('strong');
    expect(res!.drivers[0].kind).toBe('numeric');
    expect(res!.drivers[0].direction).toBe('positive');
    expect(res!.drivers[0].correlation).toBeGreaterThan(0.98);
    expect(res!.drivers[0].importance).toBeGreaterThan(res!.drivers[1].importance);
  });

  it('flags a negatively correlated driver', () => {
    const columns = ['x', 'metric'];
    const rows: unknown[][] = [
      [1, 10], [2, 8], [3, 6], [4, 4], [5, 2],
    ];
    const res = rankKeyDrivers({ columns, rows, metric: 'metric' });
    expect(res!.drivers[0].direction).toBe('negative');
    expect(res!.drivers[0].correlation).toBeCloseTo(-1, 4);
  });

  it('ranks a categorical driver by its correlation ratio', () => {
    const columns = ['region', 'sales'];
    const rows: unknown[][] = [
      ['east', 100], ['east', 110], ['west', 500], ['west', 520], ['north', 900], ['north', 880],
    ];
    const res = rankKeyDrivers({ columns, rows, metric: 'sales' });
    expect(res).not.toBeNull();
    const region = res!.drivers.find((d) => d.name === 'region');
    expect(region).toBeDefined();
    expect(region!.kind).toBe('categorical');
    expect(region!.importance).toBeGreaterThan(0.9);
    expect(region!.topCategory).toBe('north');
  });

  it('handles string-encoded numbers as numeric', () => {
    const columns = ['x', 'metric'];
    const rows: unknown[][] = [['1', '2'], ['2', '4'], ['3', '6'], ['4', '8']];
    const res = rankKeyDrivers({ columns, rows, metric: 'metric' });
    expect(res!.drivers[0].kind).toBe('numeric');
    expect(res!.drivers[0].correlation).toBeCloseTo(1, 6);
  });

  it('returns null when the metric column is missing or non-numeric', () => {
    expect(rankKeyDrivers({ columns: ['a'], rows: [[1]], metric: 'nope' })).toBeNull();
    expect(rankKeyDrivers({ columns: ['a', 'm'], rows: [['x', 'y']], metric: 'm' })).toBeNull();
  });

  it('drops signal-free (constant) columns rather than ranking them', () => {
    const columns = ['flat', 'x', 'metric'];
    const rows: unknown[][] = [
      [7, 1, 2], [7, 2, 4], [7, 3, 6], [7, 4, 8],
    ];
    const res = rankKeyDrivers({ columns, rows, metric: 'metric' });
    expect(res!.drivers.find((d) => d.name === 'flat')).toBeUndefined();
    expect(res!.drivers.map((d) => d.name)).toContain('x');
  });
});
