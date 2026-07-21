import { describe, it, expect } from 'vitest';
import { forecastSeries, detectSeasonLength, zForConfidence, normInv } from '../forecast';

describe('forecastSeries — Holt linear (no seasonality)', () => {
  it('recovers the slope of a clean linear ramp', () => {
    const values = Array.from({ length: 24 }, (_, i) => 1 + i); // 1..24, slope 1
    const res = forecastSeries(values, { periods: 3, confidence: 95 });
    expect(res).not.toBeNull();
    expect(res!.method).toBe('holt-linear');
    // Next point after 24 should be ~25; within a small tolerance for a fitted model.
    expect(res!.points[0].y).toBeGreaterThan(24);
    expect(res!.points[0].y).toBeLessThan(26);
    // Forecast keeps rising with a ~unit slope.
    expect(res!.points[1].y).toBeGreaterThan(res!.points[0].y);
    expect(res!.points[2].y - res!.points[1].y).toBeGreaterThan(0.7);
    expect(res!.points[2].y - res!.points[1].y).toBeLessThan(1.3);
  });

  it('widens the confidence band monotonically with the horizon', () => {
    // Noisy upward series so sigma > 0 and the band is non-trivial.
    const values = [10, 12, 11, 14, 13, 17, 16, 20, 19, 24, 22, 27];
    const res = forecastSeries(values, { periods: 6, confidence: 90 });
    expect(res).not.toBeNull();
    expect(res!.sigma).toBeGreaterThan(0);
    const w = res!.points.map((p) => p.upper - p.lower);
    for (let i = 1; i < w.length; i++) expect(w[i]).toBeGreaterThan(w[i - 1]);
    // The band brackets the point forecast.
    for (const p of res!.points) {
      expect(p.lower).toBeLessThan(p.y);
      expect(p.upper).toBeGreaterThan(p.y);
    }
  });

  it('returns null when there are fewer than two usable points', () => {
    expect(forecastSeries([])).toBeNull();
    expect(forecastSeries([42])).toBeNull();
    expect(forecastSeries([Number.NaN, Number.NaN, 5])).toBeNull();
  });

  it('drops non-finite entries before fitting', () => {
    const values = [1, 2, Number.NaN, 4, 5, 6];
    const res = forecastSeries(values, { periods: 1 });
    expect(res).not.toBeNull();
    expect(res!.historyEndIndex).toBe(4); // 5 finite points → last index 4
  });
});

describe('forecastSeries — Holt-Winters (seasonal)', () => {
  it('reproduces a repeating seasonal pattern', () => {
    const pattern = [10, 30, 20, 40]; // season length 4, no trend
    const values: number[] = [];
    for (let s = 0; s < 6; s++) values.push(...pattern); // 24 points
    const res = forecastSeries(values, { periods: 4, seasonLength: 4, confidence: 95 });
    expect(res).not.toBeNull();
    expect(res!.method).toBe('holt-winters');
    expect(res!.seasonLength).toBe(4);
    // Each projected point should track the pattern within a loose tolerance.
    for (let h = 0; h < 4; h++) {
      expect(Math.abs(res!.points[h].y - pattern[h])).toBeLessThan(4);
    }
    // The peak of the pattern (40, index 3) is the largest forecast in the season.
    const ys = res!.points.map((p) => p.y);
    expect(ys.indexOf(Math.max(...ys))).toBe(3);
  });

  it('falls back to linear when there is not enough history for the season', () => {
    const values = [1, 2, 3, 4, 5]; // n=5 < 2*4
    const res = forecastSeries(values, { periods: 2, seasonLength: 4 });
    expect(res).not.toBeNull();
    expect(res!.method).toBe('holt-linear');
    expect(res!.seasonLength).toBe(0);
  });
});

describe('detectSeasonLength', () => {
  it('detects a length-4 season', () => {
    const pattern = [5, 25, 15, 35];
    const values: number[] = [];
    for (let s = 0; s < 6; s++) values.push(...pattern);
    expect(detectSeasonLength(values, [4, 7, 12])).toBe(4);
  });

  it('returns 0 for a non-seasonal ramp', () => {
    const values = Array.from({ length: 20 }, (_, i) => i);
    expect(detectSeasonLength(values, [7, 12])).toBe(0);
  });

  it('returns 0 for a flat series', () => {
    expect(detectSeasonLength(new Array(20).fill(3))).toBe(0);
  });
});

describe('zForConfidence / normInv', () => {
  it('maps 95% to ≈1.96', () => {
    expect(zForConfidence(95)).toBeCloseTo(1.96, 2);
  });
  it('maps 90% to ≈1.645', () => {
    expect(zForConfidence(90)).toBeCloseTo(1.645, 2);
  });
  it('normInv(0.5) is 0', () => {
    expect(normInv(0.5)).toBeCloseTo(0, 6);
  });
});
