import { describe, it, expect } from 'vitest';
import { fieldMatcher, cronMatches, alreadyRanThisMinute, dueSubscriptions, type ReportSubscriptionLite } from './schedule';

describe('fieldMatcher', () => {
  it('matches *', () => {
    const m = fieldMatcher('*', 0, 59);
    expect(m(0)).toBe(true); expect(m(59)).toBe(true);
  });
  it('matches a single number', () => {
    const m = fieldMatcher('8', 0, 23);
    expect(m(8)).toBe(true); expect(m(9)).toBe(false);
  });
  it('matches a range', () => {
    const m = fieldMatcher('1-5', 0, 6);
    expect(m(1)).toBe(true); expect(m(5)).toBe(true); expect(m(0)).toBe(false); expect(m(6)).toBe(false);
  });
  it('matches a step */S', () => {
    const m = fieldMatcher('*/15', 0, 59);
    expect(m(0)).toBe(true); expect(m(15)).toBe(true); expect(m(30)).toBe(true); expect(m(7)).toBe(false);
  });
  it('matches a comma list', () => {
    const m = fieldMatcher('0,30', 0, 59);
    expect(m(0)).toBe(true); expect(m(30)).toBe(true); expect(m(15)).toBe(false);
  });
});

describe('cronMatches (6-field NCRONTAB, UTC minute resolution)', () => {
  // Weekdays at 08:00 UTC: "0 0 8 * * 1-5"
  const weekdays8 = '0 0 8 * * 1-5';
  it('fires on a weekday at 08:00', () => {
    expect(cronMatches(weekdays8, new Date('2026-07-20T08:00:00Z'))).toBe(true); // Monday
  });
  it('does not fire at 08:01', () => {
    expect(cronMatches(weekdays8, new Date('2026-07-20T08:01:00Z'))).toBe(false);
  });
  it('does not fire on the weekend', () => {
    expect(cronMatches(weekdays8, new Date('2026-07-19T08:00:00Z'))).toBe(false); // Sunday
  });
  it('rejects a non-6-field expression', () => {
    expect(cronMatches('0 8 * * 1-5', new Date('2026-07-20T08:00:00Z'))).toBe(false);
  });
  it('dom OR dow when both restricted (standard cron)', () => {
    // 1st of month OR Monday
    const c = '0 0 8 1 * 1';
    expect(cronMatches(c, new Date('2026-07-01T08:00:00Z'))).toBe(true);  // 1st (Wed)
    expect(cronMatches(c, new Date('2026-07-20T08:00:00Z'))).toBe(true);  // Monday
    expect(cronMatches(c, new Date('2026-07-21T08:00:00Z'))).toBe(false); // Tue, not 1st
  });
});

describe('alreadyRanThisMinute', () => {
  const now = new Date('2026-07-20T08:00:30Z');
  it('true when last run is the same minute', () => {
    expect(alreadyRanThisMinute('2026-07-20T08:00:05Z', now)).toBe(true);
  });
  it('false when last run is a different minute', () => {
    expect(alreadyRanThisMinute('2026-07-20T07:59:05Z', now)).toBe(false);
  });
  it('false when never run', () => {
    expect(alreadyRanThisMinute(undefined, now)).toBe(false);
  });
});

describe('dueSubscriptions', () => {
  const base: ReportSubscriptionLite = {
    id: 'sub:1', reportId: 'r1', workspaceId: 'w1', format: 'PDF',
    cron: '0 0 8 * * 1-5', recipients: ['a@example.com'], enabled: true,
  };
  const now = new Date('2026-07-20T08:00:00Z'); // Monday 08:00
  it('selects an enabled, due, not-yet-run subscription', () => {
    expect(dueSubscriptions([base], now).map((s) => s.id)).toEqual(['sub:1']);
  });
  it('skips disabled', () => {
    expect(dueSubscriptions([{ ...base, enabled: false }], now)).toHaveLength(0);
  });
  it('skips no-recipients', () => {
    expect(dueSubscriptions([{ ...base, recipients: [] }], now)).toHaveLength(0);
  });
  it('skips already-run-this-minute', () => {
    expect(dueSubscriptions([{ ...base, lastRunAt: '2026-07-20T08:00:10Z' }], now)).toHaveLength(0);
  });
  it('skips not-due', () => {
    expect(dueSubscriptions([base], new Date('2026-07-20T09:00:00Z'))).toHaveLength(0);
  });
});
