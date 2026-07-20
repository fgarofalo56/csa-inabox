/**
 * Unit tests for the pure time-bound/expiry helpers (access-governance W3).
 */
import { describe, it, expect } from 'vitest';
import { computeExpiry, hoursUntil, isExpired, selectExpired } from '../expiry';

const T0 = new Date('2026-07-20T00:00:00.000Z');

describe('computeExpiry', () => {
  it('adds days', () => {
    expect(computeExpiry(T0, { lifetimeDays: 2 })).toBe('2026-07-22T00:00:00.000Z');
  });
  it('adds hours', () => {
    expect(computeExpiry(T0, { windowHours: 8 })).toBe('2026-07-20T08:00:00.000Z');
  });
  it('sums days + hours', () => {
    expect(computeExpiry(T0, { lifetimeDays: 1, windowHours: 12 })).toBe('2026-07-21T12:00:00.000Z');
  });
  it('returns null when neither is a positive number', () => {
    expect(computeExpiry(T0, {})).toBeNull();
    expect(computeExpiry(T0, { lifetimeDays: 0, windowHours: null })).toBeNull();
    expect(computeExpiry(T0, { lifetimeDays: -3 })).toBeNull();
  });
});

describe('hoursUntil', () => {
  it('is positive for the future, negative for the past, null when unset', () => {
    expect(hoursUntil('2026-07-20T05:00:00.000Z', T0)).toBe(5);
    expect(hoursUntil('2026-07-19T22:00:00.000Z', T0)).toBe(-2);
    expect(hoursUntil(null, T0)).toBeNull();
    expect(hoursUntil('not-a-date', T0)).toBeNull();
  });
});

describe('isExpired / selectExpired', () => {
  const rows = [
    { id: 'a', state: 'active', expiresAt: '2026-07-19T00:00:00.000Z' },   // past → expired
    { id: 'b', state: 'active', expiresAt: '2026-07-21T00:00:00.000Z' },   // future
    { id: 'c', state: 'active', expiresAt: null },                          // permanent
    { id: 'd', state: 'eligible', expiresAt: '2026-07-19T00:00:00.000Z' }, // eligible → never
    { id: 'e', state: 'expired', expiresAt: '2026-07-19T00:00:00.000Z' },  // already expired
  ] as any[];
  it('only sweeps active rows past their expiry', () => {
    expect(isExpired(rows[0], T0)).toBe(true);
    expect(isExpired(rows[1], T0)).toBe(false);
    expect(isExpired(rows[2], T0)).toBe(false);
    expect(isExpired(rows[3], T0)).toBe(false);
    expect(isExpired(rows[4], T0)).toBe(false);
  });
  it('selectExpired returns exactly the due rows', () => {
    expect(selectExpired(rows, T0).map((r) => r.id)).toEqual(['a']);
  });
});
