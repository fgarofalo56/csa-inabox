/**
 * ARM read-throttle handling for the estate STATE path.
 *
 * ── WHY (live defect, 2026-10-20) ──────────────────────────────────────────
 * The Commercial estate-power panel showed `ARM GET .../servers/aas... failed
 * 429 SubscriptionRequestsThrottled`. The message was honest (deploy-integrity
 * R7), but two things made it a defect rather than a mere warning:
 *
 *   1. state-path reads were single-shot `armGet`, so one 429 became
 *      `reading: null` immediately;
 *   2. in `pollResume`, a `reading: null` is an `unknown` outcome, and once the
 *      settle window has elapsed `unknown` becomes RESUME_FAILED. A RATE LIMIT
 *      was therefore capable of declaring a resume FAILED. "I was throttled" is
 *      a statement about the control plane, not about the resource, so it must
 *      never be promoted to a verdict about the resource.
 *
 * This module holds the pure pieces: the retry budget for state reads, the
 * throttle classifier, and the rule that a throttled-unknown poll HOLDS the
 * stored state instead of settling it.
 */

/**
 * Retry budget for state-path ARM reads. 3 attempts, and a Retry-After longer
 * than 5 s fails closed at once: the panel's fetch aborts at 12 s, so sleeping
 * out ARM's 10 s penalty inside the request would only convert a throttle into
 * a client timeout. The panel backs off instead (estate-power-panel).
 */
export const ESTATE_READ_RETRY = { maxAttempts: 3, maxDelayMs: 5_000 } as const;

/**
 * True for an ARM 429 that stayed throttled. Duck-typed on `name` rather than
 * `instanceof` so it survives module mocking and bundler duplication.
 */
export function isThrottleError(err: unknown): boolean {
  return (
    typeof err === 'object'
    && err !== null
    && ((err as { name?: unknown }).name === 'ArmThrottledError'
      || (err as { status?: unknown }).status === 429)
  );
}

/** Said when a read was refused locally because an earlier read in the same poll stayed throttled. */
export function shortCircuitedError(path: string, firstMessage: string): Error {
  const e = new Error(
    `ARM GET ${path} was NOT sent: an earlier read in this same poll stayed throttled (429), `
      + 'and the subscription read quota is shared, so sending more would only deepen the throttle. '
      + `Nothing was read. First throttle: ${firstMessage.slice(0, 240)}`,
  );
  e.name = 'ArmThrottledError';
  return e;
}

/** Per-resource progress text for a throttled read (R7: states what was NOT established). */
export function throttledDetail(name: string, error: string | undefined, whatIsUnknown: string): string {
  return (
    `Azure Resource Manager is rate-limiting reads, so the power state of ${name} could not be read this time`
    + `${error ? ` (${error.slice(0, 300)})` : ''}. Whether ${whatIsUnknown} was NOT established; `
    + 'this is a throttle, not a failure, and the read will be retried automatically.'
  );
}

export interface HoldableResumeVerdict {
  state: 'RUNNING' | 'RESUME_FAILED';
  unconfirmed: ReadonlyArray<{ resourceId: string }>;
}

/**
 * Decide whether a RESUME_FAILED verdict was manufactured by throttling alone.
 *
 * Returns the state to report, or null when the verdict stands. The verdict is
 * HELD only when EVERY unconfirmed resource is a throttled-unknown: a single
 * definite mismatch (ARM answered and said the wrong thing) is a real failure
 * and is never softened. A stored RESUME_FAILED is kept as RESUME_FAILED (the
 * last good state) instead of being walked back to RESUMING by a rate limit.
 */
export function holdStateForThrottle(
  verdict: HoldableResumeVerdict,
  throttledIds: ReadonlySet<string>,
  storedState: string,
): 'RESUMING' | 'RESUME_FAILED' | null {
  if (verdict.state !== 'RESUME_FAILED') return null;
  if (throttledIds.size === 0 || verdict.unconfirmed.length === 0) return null;
  if (!verdict.unconfirmed.every((u) => throttledIds.has(u.resourceId))) return null;
  return storedState === 'RESUME_FAILED' ? 'RESUME_FAILED' : 'RESUMING';
}

export function throttleHoldReason(count: number, total: number): string {
  return (
    `${count} of ${total} resource(s) could not be read because Azure Resource Manager throttled the `
    + 'read quota. That is a rate limit, not a verdict on the resources: the estate state was NOT '
    + 'changed on its account, and the read will be retried automatically.'
  );
}
