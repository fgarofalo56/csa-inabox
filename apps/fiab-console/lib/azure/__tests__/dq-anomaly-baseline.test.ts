import { describe, it, expect } from 'vitest';
import { computeBaseline, detectAnomaly, type MetricObservation } from '../dq-anomaly-baseline';

function hist(values: number[], startDay = 1): MetricObservation[] {
  return values.map((v, i) => ({ at: `2026-07-${String(startDay + i).padStart(2, '0')}T00:00:00Z`, value: v }));
}

describe('computeBaseline', () => {
  it('returns a zeroed baseline for empty history', () => {
    const b = computeBaseline([]);
    expect(b.samples).toBe(0);
    expect(b.mean).toBe(0);
    expect(b.stddev).toBe(0);
  });

  it('computes population mean + stddev over the window', () => {
    const b = computeBaseline(hist([2, 4, 4, 4, 5, 5, 7, 9]));
    expect(b.samples).toBe(8);
    expect(b.mean).toBe(5);
    expect(b.stddev).toBe(2); // population stddev of that classic set
    expect(b.min).toBe(2);
    expect(b.max).toBe(9);
  });

  it('honors the window cap (keeps the most recent)', () => {
    const b = computeBaseline(hist([100, 100, 1, 1, 1]), { window: 3 });
    expect(b.samples).toBe(3);
    expect(b.mean).toBe(1);
  });
});

describe('detectAnomaly', () => {
  it('does not trip a brand-new check with no history', () => {
    const v = detectAnomaly(2, []);
    expect(v.isAnomaly).toBe(false);
    expect(v.reason).toBe('none');
  });

  it('notes (softly) a large first-observation spike without flagging an anomaly', () => {
    const v = detectAnomaly(50, []);
    expect(v.isAnomaly).toBe(false);
    expect(v.reason).toBe('first-observation-spike');
  });

  it('trips on a z-score outlier — the injected-anomaly acceptance case', () => {
    // A stable check that has always found ~0 violations suddenly finds 40.
    const stable = hist([0, 1, 0, 0, 1, 0, 1, 0, 0, 1]);
    const v = detectAnomaly(40, stable);
    expect(v.isAnomaly).toBe(true);
    expect(v.reason).toBe('z-score');
    expect(v.zScore).not.toBeNull();
    expect((v.zScore as number)).toBeGreaterThanOrEqual(3);
  });

  it('stays quiet when the value is within the normal band', () => {
    const stable = hist([10, 11, 9, 10, 12, 8, 10, 11]);
    const v = detectAnomaly(10, stable);
    expect(v.isAnomaly).toBe(false);
    expect(v.reason).toBe('none');
  });

  it('uses the relative-change path with too few samples', () => {
    // Only 2 prior samples (< minSamplesForZ) but a big jump above the floor.
    const v = detectAnomaly(30, hist([1, 2]));
    expect(v.isAnomaly).toBe(true);
    expect(v.reason).toBe('relative-change');
  });

  it('does not trip the relative path on a tiny absolute change', () => {
    const v = detectAnomaly(2, hist([1, 1]));
    expect(v.isAnomaly).toBe(false);
  });

  it('never flags a DROP in violations as an anomaly', () => {
    const v = detectAnomaly(0, hist([10, 11, 9, 10, 12, 8, 10, 11]));
    expect(v.isAnomaly).toBe(false);
  });
});
