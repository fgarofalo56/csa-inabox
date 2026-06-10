import { describe, it, expect } from 'vitest';
import {
  buildTimeSeries, filterSeriesByQuery, pointsInRange, scaleY, parseTimeMs, fmtX,
} from '../time-series-model';

const ISO = (s: string) => s; // readability marker for datetime literals

describe('parseTimeMs', () => {
  it('parses ISO-8601 datetimes to epoch ms', () => {
    expect(parseTimeMs('2024-01-02T03:04:05.000Z')).toBe(Date.parse('2024-01-02T03:04:05.000Z'));
    expect(parseTimeMs('2024-01-02')).toBe(Date.parse('2024-01-02'));
  });
  it('returns null for non-datetime strings and small numbers', () => {
    expect(parseTimeMs('hello')).toBeNull();
    expect(parseTimeMs(42)).toBeNull();
    expect(parseTimeMs('')).toBeNull();
  });
  it('treats a large epoch-ms number as time', () => {
    expect(parseTimeMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });
});

describe('buildTimeSeries', () => {
  it('builds a single series from a timestamp + value grid', () => {
    const shape = buildTimeSeries(
      ['Timestamp', 'Count'],
      [
        [ISO('2024-01-01T00:00:00Z'), 5],
        [ISO('2024-01-01T00:01:00Z'), 9],
        [ISO('2024-01-01T00:02:00Z'), 3],
      ],
      ['datetime', 'long'],
    );
    expect(shape).not.toBeNull();
    expect(shape!.xIsTime).toBe(true);
    expect(shape!.seriesColIdx).toBe(-1);
    expect(shape!.series).toHaveLength(1);
    expect(shape!.series[0].name).toBe('Count');
    expect(shape!.series[0].points.map((p) => p.y)).toEqual([5, 9, 3]);
    expect(shape!.yMin).toBe(3);
    expect(shape!.yMax).toBe(9);
  });

  it('splits into multiple series on a string column', () => {
    const shape = buildTimeSeries(
      ['Timestamp', 'Region', 'Count'],
      [
        [ISO('2024-01-01T00:00:00Z'), 'east', 5],
        [ISO('2024-01-01T00:00:00Z'), 'west', 2],
        [ISO('2024-01-01T00:01:00Z'), 'east', 7],
        [ISO('2024-01-01T00:01:00Z'), 'west', 4],
      ],
      ['datetime', 'string', 'long'],
    );
    expect(shape).not.toBeNull();
    expect(shape!.seriesColIdx).toBe(1);
    const names = shape!.series.map((s) => s.name).sort();
    expect(names).toEqual(['east', 'west']);
    const east = shape!.series.find((s) => s.name === 'east')!;
    expect(east.points.map((p) => p.y)).toEqual([5, 7]);
  });

  it('sorts each series by ascending x even when rows are unordered', () => {
    const shape = buildTimeSeries(
      ['Timestamp', 'V'],
      [
        [ISO('2024-01-01T00:02:00Z'), 3],
        [ISO('2024-01-01T00:00:00Z'), 1],
        [ISO('2024-01-01T00:01:00Z'), 2],
      ],
      ['datetime', 'long'],
    );
    expect(shape!.series[0].points.map((p) => p.y)).toEqual([1, 2, 3]);
  });

  it('returns null when there is no numeric measure', () => {
    expect(buildTimeSeries(['a', 'b'], [['x', 'y']], ['string', 'string'])).toBeNull();
  });

  it('falls back to a category X when no datetime column exists', () => {
    const shape = buildTimeSeries(['Name', 'V'], [['alpha', 1], ['beta', 2]], ['string', 'long']);
    expect(shape!.xIsTime).toBe(false);
    expect(shape!.series[0].points.map((p) => p.x)).toEqual([0, 1]);
  });

  it('caps the number of series to maxSeries', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ['2024-01-01T00:00:00Z', `g${i}`, i]);
    const shape = buildTimeSeries(['t', 'g', 'v'], rows, ['datetime', 'string', 'long'], { maxSeries: 5 });
    expect(shape!.series.length).toBe(5);
  });

  it('prefixes the measure name when multiple measures + a split column exist', () => {
    const shape = buildTimeSeries(
      ['t', 'g', 'cnt', 'avg'],
      [['2024-01-01T00:00:00Z', 'east', 5, 1.2]],
      ['datetime', 'string', 'long', 'real'],
    );
    const names = shape!.series.map((s) => s.name).sort();
    expect(names).toEqual(['avg · east', 'cnt · east']);
  });
});

describe('filterSeriesByQuery', () => {
  const series = [
    { key: 'a', name: 'CPU east', points: [] },
    { key: 'b', name: 'CPU west', points: [] },
    { key: 'c', name: 'Memory east', points: [] },
  ];
  it('returns all series for an empty query', () => {
    expect(filterSeriesByQuery(series, '  ')).toHaveLength(3);
  });
  it('filters by case-insensitive substring', () => {
    expect(filterSeriesByQuery(series, 'cpu').map((s) => s.key)).toEqual(['a', 'b']);
    expect(filterSeriesByQuery(series, 'EAST').map((s) => s.key)).toEqual(['a', 'c']);
  });
});

describe('pointsInRange', () => {
  const pts = [{ x: 1, label: '', y: 0 }, { x: 5, label: '', y: 0 }, { x: 9, label: '', y: 0 }];
  it('clamps points to the inclusive window', () => {
    expect(pointsInRange(pts, 2, 8).map((p) => p.x)).toEqual([5]);
    expect(pointsInRange(pts, 9, 1).map((p) => p.x)).toEqual([1, 5, 9]); // order-insensitive
  });
});

describe('scaleY', () => {
  it('passes through linear values', () => {
    expect(scaleY(42, 'linear')).toBe(42);
  });
  it('takes log10 in log mode and floors non-positive values', () => {
    expect(scaleY(100, 'log')).toBeCloseTo(2);
    expect(scaleY(0, 'log')).toBeLessThan(-8); // log10(1e-9) ≈ -9
  });
});

describe('fmtX', () => {
  it('formats time as trimmed ISO and passes numbers through', () => {
    expect(fmtX(Date.parse('2024-01-02T03:04:05Z'), true)).toBe('2024-01-02 03:04');
    expect(fmtX(7, false)).toBe('7');
  });
});
