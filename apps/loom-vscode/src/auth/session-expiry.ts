/**
 * When a stored cookie session stops being usable, as a timer delay (#4805).
 *
 * A CLI / VS Code device-code session lives one hour (operator decision
 * 2026-09-30). Without a timer the tree and the status bar only noticed on
 * their next refresh; the auth provider now schedules one per session. Kept free
 * of `vscode` so it is unit-testable.
 */

/** The longest delay `setTimeout` honours (2^31 − 1 ms, about 24.8 days). Longer fires at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Milliseconds until `expiresAtSecs − skewSecs`, clamped at 0 for a session that
 * is already past it; `undefined` when there is nothing to schedule (no expiry,
 * e.g. a PAT) or the delay exceeds what a timer can hold.
 */
export function expiryDelayMs(expiresAtSecs: number | undefined, nowMs: number, skewSecs: number): number | undefined {
  if (!expiresAtSecs || !Number.isFinite(expiresAtSecs)) return undefined;
  const ms = (expiresAtSecs - skewSecs) * 1000 - nowMs;
  if (ms > MAX_TIMER_MS) return undefined;
  return Math.max(0, ms);
}
