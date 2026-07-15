/**
 * PERF-4.4 — usage-learning engine math (histogram / EWMA / prediction).
 */
import { describe, expect, it } from 'vitest';
import {
  HOURS_PER_WEEK,
  hourOfWeek,
  emptyHistogram,
  decayHistogram,
  addEvent,
  addCounts,
  sumHistograms,
  totalWeight,
  overrideForHour,
  defaultLearningConfig,
  sanitizeLearningConfig,
  busyThreshold,
  demandScore,
  learnedTarget,
  learnedSchedule,
  DEAD_SCORE,
  type LearningConfig,
} from '../usage-learning';

// 2026-07-13 was a Monday. 14:00 UTC → day 1, hour 14 → bucket 38.
const MONDAY_14_UTC = Date.UTC(2026, 6, 13, 14, 30, 0);

function cfgWith(p: Partial<LearningConfig>): LearningConfig {
  return { ...defaultLearningConfig(), ...p };
}

describe('hourOfWeek', () => {
  it('buckets a UTC timestamp into day*24+hour', () => {
    expect(hourOfWeek(MONDAY_14_UTC)).toBe(1 * 24 + 14);
  });
  it('covers the full 0..167 range', () => {
    const sunday0 = Date.UTC(2026, 6, 12, 0, 0, 0); // Sunday
    expect(hourOfWeek(sunday0)).toBe(0);
    const saturday23 = Date.UTC(2026, 6, 18, 23, 59, 0);
    expect(hourOfWeek(saturday23)).toBe(167);
  });
});

describe('histogram math', () => {
  it('addEvent increments exactly one bucket', () => {
    const w = addEvent(emptyHistogram(), MONDAY_14_UTC);
    expect(w[38]).toBe(1);
    expect(totalWeight(w)).toBe(1);
  });

  it('addCounts merges a pending counter map and ignores junk keys', () => {
    const w = addCounts(emptyHistogram(), { 5: 3, 167: 2, 999: 7, [-1]: 4 });
    expect(w[5]).toBe(3);
    expect(w[167]).toBe(2);
    expect(totalWeight(w)).toBe(5);
  });

  it('decayHistogram halves every half-life', () => {
    const w = addCounts(emptyHistogram(), { 10: 8 });
    const halved = decayHistogram(w, 2, 2); // one half-life
    expect(halved[10]).toBeCloseTo(4, 6);
    const quartered = decayHistogram(w, 4, 2); // two half-lives
    expect(quartered[10]).toBeCloseTo(2, 6);
    // No elapsed time → unchanged copy.
    expect(decayHistogram(w, 0, 2)[10]).toBe(8);
  });

  it('sumHistograms aggregates element-wise', () => {
    const a = addCounts(emptyHistogram(), { 3: 1 });
    const b = addCounts(emptyHistogram(), { 3: 2, 4: 5 });
    const s = sumHistograms([a, b]);
    expect(s[3]).toBe(3);
    expect(s[4]).toBe(5);
  });
});

describe('overrideForHour', () => {
  it('matches day + hour windows and warm beats sleep', () => {
    const overrides = [
      { days: [1], startHour: 8, endHour: 18, mode: 'sleep' as const },
      { days: [1], startHour: 9, endHour: 10, mode: 'warm' as const },
    ];
    expect(overrideForHour(overrides, 1 * 24 + 9)).toBe('warm'); // overlap → warm wins
    expect(overrideForHour(overrides, 1 * 24 + 12)).toBe('sleep');
    expect(overrideForHour(overrides, 1 * 24 + 18)).toBeNull(); // end is exclusive
    expect(overrideForHour(overrides, 2 * 24 + 9)).toBeNull(); // wrong day
    expect(overrideForHour([{ startHour: 0, endHour: 24, mode: 'warm' }], 100)).toBe('warm'); // every day
  });
});

describe('learnedTarget', () => {
  // A histogram with a clear weekday-9am peak (weight 20) and dead nights.
  function peakHistogram(): number[] {
    const w = emptyHistogram();
    for (let day = 1; day <= 5; day++) w[day * 24 + 9] = 20;
    for (let day = 1; day <= 5; day++) w[day * 24 + 10] = 12;
    return w;
  }

  it('disabled → base min, always', () => {
    const d = learnedTarget(peakHistogram(), 33, cfgWith({ enabled: false }), 2, 5);
    expect(d).toMatchObject({ target: 2, rule: 'disabled' });
  });

  it('insufficient data → base min (conservative default behaviour)', () => {
    const w = addCounts(emptyHistogram(), { 33: 3 }); // total 3 < minDataWeight 12
    const d = learnedTarget(w, 33, cfgWith({}), 1, 3);
    expect(d).toMatchObject({ target: 1, rule: 'insufficient-data' });
  });

  it('boosts toward boundMax in a predicted-busy hour', () => {
    const w = peakHistogram();
    const d = learnedTarget(w, 1 * 24 + 9, cfgWith({ lookAheadHours: 0 }), 1, 3);
    expect(d.rule).toBe('busy');
    expect(d.score).toBe(1); // at peak
    expect(d.target).toBe(3); // ceil(1 * 3), clamped to bound
  });

  it('warms AHEAD of the busy window (look-ahead)', () => {
    const w = peakHistogram();
    // Monday 08:00 — the peak is at 09:00; lookAheadHours 1 makes 08:00 busy.
    const d = learnedTarget(w, 1 * 24 + 8, cfgWith({ lookAheadHours: 1 }), 1, 3);
    expect(d.rule).toBe('busy');
    // Without look-ahead 08:00 is dead (no weight at all).
    const d0 = learnedTarget(w, 1 * 24 + 8, cfgWith({ lookAheadHours: 0 }), 1, 3);
    expect(d0.rule).toBe('dead');
  });

  it('sleeps (target 0) in a confidently-dead hour', () => {
    const w = peakHistogram();
    const d = learnedTarget(w, 0, cfgWith({}), 1, 3); // Sunday 00:00 — never used
    expect(d).toMatchObject({ target: 0, rule: 'dead' });
    expect(d.score).toBeLessThanOrEqual(DEAD_SCORE);
  });

  it('keeps base min in a middling hour (neither busy nor dead)', () => {
    const w = peakHistogram();
    // Monday 10:00 has 12/20 = 0.6 of peak — below the 0.65 busy bar, above dead.
    const d = learnedTarget(w, 1 * 24 + 10, cfgWith({ sensitivity: 0.35, lookAheadHours: 0 }), 1, 3);
    expect(d).toMatchObject({ target: 1, rule: 'base' });
  });

  it('higher sensitivity lowers the busy bar', () => {
    const w = peakHistogram();
    // 0.6-of-peak hour becomes busy at sensitivity 0.5 (threshold 0.5).
    const d = learnedTarget(w, 1 * 24 + 10, cfgWith({ sensitivity: 0.5, lookAheadHours: 0 }), 1, 3);
    expect(d.rule).toBe('busy');
  });

  it('manual overrides beat learned prediction and insufficient-data', () => {
    const w = emptyHistogram(); // NO data at all
    const warmCfg = cfgWith({ overrides: [{ startHour: 0, endHour: 24, mode: 'warm' }] });
    expect(learnedTarget(w, 50, warmCfg, 0, 3)).toMatchObject({ target: 1, rule: 'override-warm' });
    const sleepCfg = cfgWith({ overrides: [{ startHour: 0, endHour: 24, mode: 'sleep' }] });
    expect(learnedTarget(peakHistogram(), 1 * 24 + 9, sleepCfg, 2, 5)).toMatchObject({ target: 0, rule: 'override-sleep' });
  });

  it('never exceeds boundMax', () => {
    const w = peakHistogram();
    const d = learnedTarget(w, 1 * 24 + 9, cfgWith({ lookAheadHours: 0 }), 1, 2);
    expect(d.target).toBeLessThanOrEqual(2);
  });

  it('learnedSchedule returns a full week', () => {
    const sched = learnedSchedule(peakHistogram(), cfgWith({}), 1, 3);
    expect(sched).toHaveLength(HOURS_PER_WEEK);
    expect(sched.filter((x) => x.rule === 'busy').length).toBeGreaterThan(0);
    expect(sched.filter((x) => x.rule === 'dead').length).toBeGreaterThan(0);
  });
});

describe('busyThreshold + demandScore', () => {
  it('threshold is 1 - sensitivity, clamped', () => {
    expect(busyThreshold(0.35)).toBeCloseTo(0.65, 6);
    expect(busyThreshold(1)).toBe(0.05);
    expect(busyThreshold(0)).toBe(0.95);
  });
  it('demandScore is relative to peak with wrap-around look-ahead', () => {
    const w = emptyHistogram();
    w[0] = 10; // Sunday 00:00
    // Saturday 23:00 (bucket 167) with lookAhead 1 wraps to bucket 0.
    expect(demandScore(w, 167, 1)).toBe(1);
    expect(demandScore(w, 167, 0)).toBe(0);
    expect(demandScore(emptyHistogram(), 0, 3)).toBe(0); // no data → 0
  });
});

describe('sanitizeLearningConfig', () => {
  it('clamps and repairs junk', () => {
    const c = sanitizeLearningConfig({
      sensitivity: 9,
      halfLifeWeeks: -3,
      minDataWeight: 1e9,
      lookAheadHours: 99,
      overrides: [
        { startHour: 8, endHour: 18, mode: 'warm' },
        { startHour: 18, endHour: 8, mode: 'sleep' }, // invalid (end <= start)
        { startHour: -1, endHour: 5, mode: 'warm' }, // invalid start
      ] as never,
      workspaces: { ws1: false, ws2: 'nope' as never },
    });
    expect(c.sensitivity).toBe(1);
    expect(c.halfLifeWeeks).toBe(0.5);
    expect(c.minDataWeight).toBe(1000);
    expect(c.lookAheadHours).toBe(6);
    expect(c.overrides).toHaveLength(1);
    expect(c.workspaces).toEqual({ ws1: false });
  });
  it('defaults are ON with conservative sensitivity', () => {
    const d = sanitizeLearningConfig(undefined);
    expect(d.enabled).toBe(true);
    expect(d.sensitivity).toBe(0.35);
  });
});
