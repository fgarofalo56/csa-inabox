import { describe, it, expect } from 'vitest';
import { parseSeries, zoomWindow, toNum, fmtVal } from '../time-series-model';

describe('toNum', () => {
  it('coerces numeric strings and rejects non-numeric', () => {
    expect(toNum(3)).toBe(3);
    expect(toNum('4.5')).toBe(4.5);
    expect(toNum('abc')).toBeNull();
    expect(toNum('')).toBeNull();
    expect(toNum(null)).toBeNull();
    expect(toNum(Number.NaN)).toBeNull();
  });
});

describe('fmtVal', () => {
  it('abbreviates large numbers', () => {
    expect(fmtVal(1500)).toBe('1.5K');
    expect(fmtVal(2_000_000)).toBe('2.0M');
    expect(fmtVal(42)).toBe('42');
  });
});

describe('parseSeries — wide layout', () => {
  it('reads one series per numeric column and sorts by time', () => {
    const columns = ['ts', 'cpu', 'mem'];
    const rows: unknown[][] = [
      ['2026-06-10T02:00:00Z', 10, 100],
      ['2026-06-10T00:00:00Z', 5, 80],
      ['2026-06-10T01:00:00Z', 7, 90],
    ];
    const m = parseSeries(columns, rows);
    expect(m).not.toBeNull();
    expect(m!.series.map((s) => s.name)).toEqual(['cpu', 'mem']);
    // sorted ascending by parsed time
    expect(m!.axis.map((a) => a.label)).toEqual([
      '2026-06-10T00:00:00Z', '2026-06-10T01:00:00Z', '2026-06-10T02:00:00Z',
    ]);
    expect(m!.series[0].values).toEqual([5, 7, 10]);
    expect(m!.series[1].values).toEqual([80, 90, 100]);
  });
});

describe('parseSeries — long layout', () => {
  it('pivots a name column into multiple series with aligned axis + null gaps', () => {
    const columns = ['ts', 'host', 'value'];
    const rows: unknown[][] = [
      ['2026-06-10T00:00:00Z', 'a', 1],
      ['2026-06-10T00:00:00Z', 'b', 2],
      ['2026-06-10T01:00:00Z', 'a', 3],
      // host b has no point at 01:00 → null gap
    ];
    const m = parseSeries(columns, rows);
    expect(m).not.toBeNull();
    expect(m!.axis.length).toBe(2);
    const byName = Object.fromEntries(m!.series.map((s) => [s.name, s.values]));
    expect(byName['a']).toEqual([1, 3]);
    expect(byName['b']).toEqual([2, null]);
  });
});

describe('parseSeries — guards', () => {
  it('returns null when there is no numeric column', () => {
    expect(parseSeries(['ts', 'label'], [['x', 'y']])).toBeNull();
  });
  it('returns null for empty input', () => {
    expect(parseSeries([], [])).toBeNull();
    expect(parseSeries(['a'], [])).toBeNull();
  });
});

describe('zoomWindow', () => {
  it('maps slider fractions to an inclusive index window', () => {
    expect(zoomWindow(11, 0, 1000)).toEqual({ start: 0, end: 10 });
    expect(zoomWindow(11, 500, 1000)).toEqual({ start: 5, end: 10 });
    expect(zoomWindow(11, 0, 500)).toEqual({ start: 0, end: 5 });
  });
  it('keeps start <= end and stays in bounds', () => {
    const w = zoomWindow(5, 900, 100);
    expect(w.start).toBeGreaterThanOrEqual(0);
    expect(w.end).toBeGreaterThanOrEqual(w.start);
    expect(w.end).toBeLessThanOrEqual(4);
  });
  it('handles a single point', () => {
    expect(zoomWindow(1, 0, 1000)).toEqual({ start: 0, end: 0 });
  });
});
