import { describe, it, expect } from 'vitest';
import { expandField, parseCron, matchesMinuteUtc, isDueWithin } from './cron-match';

describe('expandField', () => {
  it('expands a wildcard to the full range', () => {
    expect([...expandField('*', 0, 6)]).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it('expands a range', () => {
    expect([...expandField('1-5', 0, 6)]).toEqual([1, 2, 3, 4, 5]);
  });
  it('expands a step on a wildcard', () => {
    expect([...expandField('*/15', 0, 59)]).toEqual([0, 15, 30, 45]);
  });
  it('expands a comma list', () => {
    expect([...expandField('0,30', 0, 59)]).toEqual([0, 30]);
  });
  it('expands a single value', () => {
    expect([...expandField('8', 0, 23)]).toEqual([8]);
  });
});

describe('parseCron', () => {
  it('rejects non-6-field expressions', () => {
    expect(parseCron('0 8 * * 1-5')).toBeNull(); // 5-field
  });
  it('tracks dom/dow restriction flags', () => {
    const p = parseCron('0 0 8 * * 1-5')!;
    expect(p.domRestricted).toBe(false);
    expect(p.dowRestricted).toBe(true);
  });
});

describe('matchesMinuteUtc', () => {
  it('matches weekdays-at-8am cron on a Monday 08:00 UTC', () => {
    const p = parseCron('0 0 8 * * 1-5')!;
    // 2026-06-08 is a Monday.
    expect(matchesMinuteUtc(p, new Date('2026-06-08T08:00:00Z'))).toBe(true);
  });
  it('does not match the same cron on a Sunday', () => {
    const p = parseCron('0 0 8 * * 1-5')!;
    // 2026-06-07 is a Sunday.
    expect(matchesMinuteUtc(p, new Date('2026-06-07T08:00:00Z'))).toBe(false);
  });
  it('does not match outside the scheduled hour', () => {
    const p = parseCron('0 0 8 * * 1-5')!;
    expect(matchesMinuteUtc(p, new Date('2026-06-08T09:00:00Z'))).toBe(false);
  });
  it('applies OR semantics when both dom and dow are restricted', () => {
    // Fire on the 1st OR any Monday.
    const p = parseCron('0 0 8 1 * 1')!;
    expect(matchesMinuteUtc(p, new Date('2026-06-01T08:00:00Z'))).toBe(true); // the 1st (a Monday too)
    expect(matchesMinuteUtc(p, new Date('2026-06-15T08:00:00Z'))).toBe(true); // a Monday
    expect(matchesMinuteUtc(p, new Date('2026-06-16T08:00:00Z'))).toBe(false); // Tue, not the 1st
  });
});

describe('isDueWithin', () => {
  it('is due when the schedule falls inside the window', () => {
    const start = Date.parse('2026-06-08T07:50:00Z');
    const end = Date.parse('2026-06-08T08:05:00Z');
    expect(isDueWithin('0 0 8 * * 1-5', start, end)).toBe(true);
  });
  it('is not due when the schedule is outside the window', () => {
    const start = Date.parse('2026-06-08T08:05:00Z');
    const end = Date.parse('2026-06-08T08:20:00Z');
    expect(isDueWithin('0 0 8 * * 1-5', start, end)).toBe(false);
  });
  it('fires at most once even on a wide window (boundary inclusive at end)', () => {
    const start = Date.parse('2026-06-08T07:59:00Z');
    const end = Date.parse('2026-06-08T08:00:00Z');
    expect(isDueWithin('0 0 8 * * 1-5', start, end)).toBe(true);
  });
  it('returns false for an empty/zero window', () => {
    const t = Date.parse('2026-06-08T08:00:00Z');
    expect(isDueWithin('0 0 8 * * 1-5', t, t)).toBe(false);
  });
  it('matches an every-15-minutes cadence', () => {
    const start = Date.parse('2026-06-08T08:00:00Z');
    const end = Date.parse('2026-06-08T08:16:00Z');
    expect(isDueWithin('0 */15 * * * *', start, end)).toBe(true);
  });
});
