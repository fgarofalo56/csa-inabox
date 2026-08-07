/**
 * aoai-failure-class — classify a thrown AOAI failure into an HONEST,
 * structured verdict, or say plainly that it could not.
 *
 * WHY THIS EXISTS (#3083, deploy-integrity R7). The eval-probe route ended
 * every `catch` with `apiServerError(e, 'eval probe failed', 'eval_probe_failed')`.
 * A `429 rate_limit_exceeded` from a shared `gpt-4o-mini`, a misconfigured
 * deployment, and a genuine bug in `searchDocs` all produced the SAME HTTP 500
 * and the SAME causeless string. The copilot-evaluator, seeing an unretryable
 * 500, dropped the row — so on 2026-08-07 a "green" run scored 123 of 153
 * questions and `rbac 0.38` was 3 of 8. The error knew it was a throttle and
 * threw the knowledge away.
 *
 * DESIGN — this module GUESSES NOTHING.
 *   • It reads a STRUCTURED `status` off the thrown value (`AoaiResponseError`
 *     carries it since #3083; `TokenBudgetExceededError` always has), and a
 *     structured `retryAfterSeconds` when the server sent `Retry-After`.
 *   • It NEVER regex-parses an error message to infer a status. Inferring a
 *     cause from prose is exactly the class of error R7 forbids: it would
 *     assert `429` about any message that happens to contain "429".
 *   • When no structured status is present the verdict is `known: false` and
 *     `status: null` — "I do not know", which the caller must surface as
 *     "I do not know", never as a specific cause.
 *
 * Duck-typed on purpose: the evaluator, the probe route, and the route's unit
 * tests all see this value across a module mock boundary, so an `instanceof`
 * check would silently classify every real throttle as unknown the moment a
 * test mocked `@/lib/azure/aoai-chat-client`. Reading the field is both more
 * robust and honest about what it is doing.
 *
 * Pure: no I/O, no env, no Azure SDK — safe to import from a route, a script,
 * or the Container App Job.
 */

/** What a caught AOAI failure actually was, or an explicit "not known". */
export interface AoaiFailureClass {
  /** Upstream HTTP status when the thrown error CARRIED one; else `null`. */
  status: number | null;
  /** Server-supplied `Retry-After` in seconds, when the error carried one. */
  retryAfterSeconds: number | null;
  /** True only when a structured upstream status was found. */
  known: boolean;
  /**
   * Stable machine code for the response envelope:
   *   `aoai_throttled`      — upstream 429 (retryable; honour Retry-After)
   *   `aoai_upstream_error` — upstream 5xx (retryable)
   *   `aoai_request_error`  — upstream 4xx other than 429 (NOT retryable:
   *                           auth, missing deployment, bad request)
   *   `unknown`             — no structured status; the cause is NOT known here
   */
  code: 'aoai_throttled' | 'aoai_upstream_error' | 'aoai_request_error' | 'unknown';
  /** True when a caller may retry this failure with backoff. */
  retryable: boolean;
}

/** Read a structured numeric `status` off an unknown thrown value. */
function statusOf(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const s = (err as { status?: unknown }).status;
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : null;
}

/** Read a structured `retryAfterSeconds` off an unknown thrown value. */
function retryAfterOf(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const r = (err as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof r === 'number' && Number.isFinite(r) && r >= 0 ? r : null;
}

/**
 * Classify a thrown AOAI failure. Returns `{known: false, code: 'unknown'}`
 * when the error carries no structured status — deliberately, so the caller
 * reports "the cause is not known" instead of inventing one.
 */
export function classifyAoaiFailure(err: unknown): AoaiFailureClass {
  const status = statusOf(err);
  const retryAfterSeconds = retryAfterOf(err);
  if (status === null) {
    return { status: null, retryAfterSeconds, known: false, code: 'unknown', retryable: false };
  }
  if (status === 429) {
    return { status, retryAfterSeconds, known: true, code: 'aoai_throttled', retryable: true };
  }
  if (status >= 500) {
    return { status, retryAfterSeconds, known: true, code: 'aoai_upstream_error', retryable: true };
  }
  return { status, retryAfterSeconds, known: true, code: 'aoai_request_error', retryable: false };
}

/**
 * The message for a classified failure — TRUE by construction: it states the
 * status the error actually carried, and when it carried none it says so
 * rather than naming a cause.
 */
export function describeAoaiFailure(cls: AoaiFailureClass, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err ?? '');
  const tail = detail ? ` Upstream said: ${detail.slice(0, 300)}` : '';
  switch (cls.code) {
    case 'aoai_throttled':
      return (
        'Azure OpenAI THROTTLED this turn (HTTP 429, rate limit) after the client exhausted its bounded retries. ' +
        'This is a capacity condition, NOT a quality result and NOT a defect in this route — retry after the ' +
        `Retry-After delay${cls.retryAfterSeconds !== null ? ` (${cls.retryAfterSeconds}s)` : ''}, or reduce concurrent load ` +
        `on the deployment.${tail}`
      );
    case 'aoai_upstream_error':
      return `Azure OpenAI returned HTTP ${cls.status} (upstream server error) for this turn — transient, retryable.${tail}`;
    case 'aoai_request_error':
      return (
        `Azure OpenAI REJECTED this turn with HTTP ${cls.status} — a request/configuration condition ` +
        `(auth, deployment name, or request shape), not a transient one. Retrying will not help.${tail}`
      );
    default:
      return (
        'The eval probe failed for a reason it could NOT classify: the error carried no upstream HTTP status, ' +
        'so this response does not know whether the cause was retrieval, the model, or this route. ' +
        'The full error is in the server log. Do not read this as a quality result.'
      );
  }
}
