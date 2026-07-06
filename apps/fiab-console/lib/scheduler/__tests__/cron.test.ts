/**
 * Unit tests for the PURE cron helpers behind the unified scheduler (rel-T81).
 *
 * These cover the wizard→cron assembly, tz-aware next-fire computation, the
 * (after, upto] window test the tick evaluator uses, and the human summary — no
 * I/O, no Azure SDK, so they run cleanly in the node vitest env.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCron, parseCron, nextFireTimes, firedInWindow, describeCron,
} from '@/lib/scheduler/cron';

describe('buildCron', () => {
  it('every N minutes', () => {
    expect(buildCron({ frequency: 'minute', interval: 5 })).toBe('*/5 * * * *');
  });
  it('daily at HH:MM', () => {
    expect(buildCron({ frequency: 'day', minute: 30, hour: 2 })).toBe('30 2 * * *');
  });
  it('weekly on selected days', () => {
    expect(buildCron({ frequency: 'week', minute: 0, hour: 9, daysOfWeek: [1, 3, 5] })).toBe('0 9 * * 1,3,5');
  });
  it('monthly on a day-of-month', () => {
    expect(buildCron({ frequency: 'month', minute: 0, hour: 0, dayOfMonth: 15 })).toBe('0 0 15 * *');
  });
});

describe('parseCron', () => {
  it('rejects a non-5-field string', () => {
    expect(parseCron('0 0 *')).toBeNull();
    expect(parseCron('nonsense')).toBeNull();
  });
  it('parses a valid expression', () => {
    expect(parseCron('30 2 * * *')).not.toBeNull();
  });
});

describe('nextFireTimes', () => {
  it('computes daily fires in UTC', () => {
    const from = new Date('2026-07-06T00:00:00Z');
    const fires = nextFireTimes('30 2 * * *', from, 3, 'UTC');
    expect(fires.length).toBe(3);
    expect(fires[0].toISOString()).toBe('2026-07-06T02:30:00.000Z');
    expect(fires[1].toISOString()).toBe('2026-07-07T02:30:00.000Z');
  });
  it('honors the time zone (2am Pacific = 09:00Z in July / PDT)', () => {
    const from = new Date('2026-07-06T00:00:00Z');
    const fires = nextFireTimes('0 2 * * *', from, 1, 'Pacific Standard Time');
    expect(fires[0].toISOString()).toBe('2026-07-06T09:00:00.000Z');
  });
  it('returns [] for an invalid cron', () => {
    expect(nextFireTimes('bad', new Date(), 5)).toEqual([]);
  });
});

describe('firedInWindow', () => {
  it('detects a fire inside the half-open window', () => {
    const after = new Date('2026-07-06T02:29:00Z');
    const upto = new Date('2026-07-06T02:31:00Z');
    expect(firedInWindow('30 2 * * *', after, upto, 'UTC')).toBe(true);
  });
  it('is false when the cron does not fire in the window', () => {
    const after = new Date('2026-07-06T03:00:00Z');
    const upto = new Date('2026-07-06T03:05:00Z');
    expect(firedInWindow('30 2 * * *', after, upto, 'UTC')).toBe(false);
  });
});

describe('describeCron', () => {
  it('summarizes common cadences', () => {
    expect(describeCron('*/5 * * * *')).toBe('Every 5 minutes');
    expect(describeCron('30 2 * * *', 'UTC')).toMatch(/Every day at 02:30/);
    expect(describeCron('0 9 * * 1,3,5', 'UTC')).toMatch(/Monday, Wednesday, Friday/);
  });
});
