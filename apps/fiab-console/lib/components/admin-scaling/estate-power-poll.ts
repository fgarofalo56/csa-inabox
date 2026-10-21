/**
 * Poll pacing for the estate-power panel.
 *
 * Every state poll fans out to Azure Resource Manager (see
 * lib/estate/estate-state-cache.ts), and ARM read quota is shared by the whole
 * subscription. So the panel (a) does not poll at all while its tab is hidden,
 * and (b) backs off exponentially while the last read reported throttling,
 * instead of retrying into the rate limit every 10 s.
 */

export const BASE_POLL_MS = 10_000;
export const MAX_THROTTLED_POLL_MS = 60_000;

/**
 * Delay before the next poll. `throttledStreak` is the number of consecutive
 * reads that reported throttling (0 = the last read was not throttled).
 * 0 -> 10 s, 1 -> 20 s, 2 -> 40 s, >=3 -> 60 s (capped).
 */
export function nextPollDelayMs(throttledStreak: number): number {
  if (!Number.isFinite(throttledStreak) || throttledStreak <= 0) return BASE_POLL_MS;
  return Math.min(MAX_THROTTLED_POLL_MS, BASE_POLL_MS * 2 ** Math.min(throttledStreak, 10));
}

/** True when the response says ARM throttled at least one read. */
export function isThrottledResponse(body: unknown): boolean {
  const n = (body as { throttled?: unknown } | null | undefined)?.throttled;
  return typeof n === 'number' && n > 0;
}

export function isTabHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}
