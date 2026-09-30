import { describe, it, expect } from 'vitest';
import { expiryDelayMs, MAX_TIMER_MS } from '../src/auth/session-expiry';

// #4805 — a device-code session lives one hour; the auth provider schedules a
// change event at (expiresAt − skew) so the tree does not wait for a refresh.
describe('expiryDelayMs', () => {
  const now = 1_700_000_000_000; // ms

  it('is (expiresAt − skew) − now, in ms', () => {
    // A session expiring in 3600 s with a 30 s skew fires 3570 s from now.
    // RED if the skew is ignored (3600000) or added (3630000).
    expect(expiryDelayMs(now / 1000 + 3600, now, 30)).toBe(3_570_000);
  });

  it('clamps an already-expired session to 0 so it is announced at once', () => {
    // RED if a negative delay is returned (setTimeout would coerce it, but the
    // contract is explicit) or undefined (no announcement at all).
    expect(expiryDelayMs(now / 1000 - 10, now, 30)).toBe(0);
  });

  it('schedules nothing without an expiry (a PAT) or beyond what a timer can hold', () => {
    expect(expiryDelayMs(undefined, now, 30)).toBeUndefined();
    // RED if the ceiling check is removed: Node fires an over-long timer at once.
    const tooFar = now / 1000 + 30 + (MAX_TIMER_MS + 1000) / 1000;
    expect(expiryDelayMs(tooFar, now, 30)).toBeUndefined();
    // Control: just under the ceiling is still scheduled.
    const justUnder = now / 1000 + 30 + (MAX_TIMER_MS - 1000) / 1000;
    expect(expiryDelayMs(justUnder, now, 30)).toBe(MAX_TIMER_MS - 1000);
  });
});
