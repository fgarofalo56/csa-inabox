/**
 * LOOM BRAIN W10 — the HTTP edge: guarded body reads and bounded retry (#3936).
 *
 * Three review findings on #4014 land here, and they are one shape seen three
 * times: a control that is present, reads as thorough, and cannot fire.
 *
 * ── S2 — AN UNGUARDED BODY READ DEFEATS THE WHOLE ProbeFailure MACHINERY ───
 * `arm-probe.ts` promises, in its header, that it "never throws for a
 * reachability problem — a failure is DATA so the classifier can name it", and
 * `ports.ts` makes that a contract: an `EstateProbe` MUST NOT throw for a
 * reachability failure. A bare `await res.json()` breaks both. A 200 whose body
 * is not JSON — a proxy interstitial, a WAF challenge page, a truncated stream,
 * an HTML error from an intermediary — makes the promise REJECT, and that
 * rejection escapes the probe, escapes `runBrainScan`, and lands on the CLI's
 * exit-1 arm as "a defect in the scan, not a verdict about the estate". It IS a
 * verdict about the estate, and it is reported as the opposite.
 *
 * Every fixture in `arm-probe.test.ts` returns a well-formed `json()`, so the
 * rejecting shape had no test. That is this repo's recorded pattern: a
 * type-correct fixture cannot reach a lie told to the compiler.
 *
 * ── S3 — "I COULD NOT MEASURE" IS NOT "THE COUNTS AGREED" (R7) ────────────
 * Both collectors cross-check their row count against ARG's own `totalRecords`,
 * and both captured it ONLY when it arrived as a number and compared it ONLY
 * when non-null. Absent or non-numeric, the comparison ran zero times and the
 * run proceeded to build a verdict over a possibly-partial population — a
 * control that is present and measures nothing. {@link requireTotalRecords}
 * makes its absence a failure, because "ARG did not tell me how many rows
 * exist" and "the counts agreed" are different facts and only one is
 * reassuring.
 *
 * ── S4 — NO RETRY, AGAINST A DELIBERATELY THROTTLED API (R6) ──────────────
 * Azure Resource Graph is throttled on a rolling per-user quota. One 429 or one
 * transient 5xx turned a healthy estate into a red night whose message said the
 * estate could not be reached. `deploy-integrity.md` R6 is explicit: retry what
 * is genuinely transient, with bounded backoff, and FAIL CLOSED on exhaustion.
 *
 * The retry here cannot become a gate that cannot fail:
 *   - it is bounded by {@link RetryPolicy.maxAttempts}, and exhaustion returns
 *     the LAST failure with the attempt count in its detail — never success;
 *   - only 429, 5xx and a thrown (no-response) error are retried. 4xx other than
 *     429 is a decision Azure has made and repeating it just delays the truth;
 *   - `sleep` is INJECTED, so the tests exercise the real loop at zero wall
 *     clock rather than proving a stub. (The same lesson as N2 on the watchdog
 *     self-test, which claimed "no wall-clock waiting" while burning minutes.)
 *   - the retry COUNT is carried out, so an intermittently flaky path is visible
 *     as a note on the verdict instead of alternating red and green with nothing
 *     to distinguish it from a healthy run.
 */

import type { ProbeFailure, ProbeStage } from '../model';
import type { FetchLike } from './arm-probe';

/** The response shape {@link FetchLike} yields, named so helpers can take it. */
export type FetchResponse = Awaited<ReturnType<FetchLike>>;

/** Bounded-retry settings. Every field is required so none can default silently. */
export interface RetryPolicy {
  /** TOTAL attempts including the first. 1 disables retry; 0 is refused. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Injected so a test exercises the real loop instantly. */
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * 4 attempts over ~0.5s + 1s + 2s of backoff.
 *
 * Sized against the failure it exists for: ARG's throttle window is short and a
 * single scheduled run issues one discovery query, ~29 ARM GETs and one more
 * query. Longer backoff would not help a sustained throttle — that one SHOULD go
 * red — and a larger attempt count would let a genuinely broken estate spend
 * minutes before saying so.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A policy that performs exactly one attempt. For tests that assert no retry. */
export const NO_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  sleep: async () => {},
};

export type FetchOutcome =
  | { readonly ok: true; readonly res: FetchResponse; readonly retries: number }
  | { readonly ok: false; readonly failure: ProbeFailure; readonly retries: number };

export type BodyOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ProbeFailure };

/**
 * Is this status worth trying again?
 *
 * 429 and 5xx only. A 401/403 is an identity fact, a 400 is a malformed request
 * and a 404 is an absence — repeating any of them changes nothing and delays a
 * true answer. Note that this is the RETRY predicate, not the CLASSIFIER: a
 * retried-and-exhausted 429 is still reported with its real status.
 */
export function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * `Retry-After`, in milliseconds, when the server supplied a usable one.
 *
 * Accepts both RFC-9110 forms — delta-seconds and an HTTP-date. Returns `null`
 * when the header is absent, unparseable, or negative, so the caller falls back
 * to its own backoff rather than sleeping on a garbage value. Clamped by the
 * caller, never here: a hostile or buggy `Retry-After: 86400` must not be able
 * to hang a scheduled run.
 */
export function retryAfterMs(headerValue: string | null | undefined, now: number): number | null {
  if (headerValue === null || headerValue === undefined) return null;
  const raw = headerValue.trim();
  if (raw === '') return null;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  const delta = at - now;
  return delta >= 0 ? delta : null;
}

/** Read a `Retry-After` off a response whose shape may not carry headers. */
function readRetryAfter(res: FetchResponse): string | null {
  const headers = (res as { headers?: { get?: (name: string) => string | null } }).headers;
  if (headers === undefined || typeof headers.get !== 'function') return null;
  try {
    return headers.get('retry-after');
  } catch {
    // A fixture whose `headers.get` throws must not take the run down: the
    // absence of a hint is not an error, it just means we use our own backoff.
    return null;
  }
}

/**
 * Read a response body as text WITHOUT ever throwing.
 *
 * R7: when the body cannot be read, the returned string SAYS SO. It does not
 * return `''`, because an empty string reads downstream as "the server sent an
 * empty body" — the exact substitution of "I could not tell" for a fact that
 * this lane exists to refuse. (The 2026-08-05 incident was the same shape: a
 * `2>/dev/null` turned a permission denial into an empty string and the empty
 * string into "the tag does not exist".)
 */
export async function readTextBody(res: FetchResponse): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return `<the response body could not be read: ${detail}>`;
  }
}

/**
 * Read a response body as JSON, turning a parse failure into a {@link ProbeFailure}.
 *
 * The failure carries the REAL status (a 200 that is not JSON is still a 200 —
 * claiming otherwise would be the R7 violation in the opposite direction) and up
 * to 600 bytes of the body text, so an operator can see the interstitial that
 * actually arrived.
 */
export async function readJsonBody(
  res: FetchResponse,
  stage: ProbeStage,
  target: string,
): Promise<BodyOutcome<unknown>> {
  try {
    return { ok: true, value: await res.json() };
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    // Best-effort: the text may also be unreadable (a consumed or broken
    // stream), and `readTextBody` says so rather than pretending it was empty.
    const text = await readTextBody(res);
    return {
      ok: false,
      failure: {
        stage,
        target,
        classification: 'arm-error',
        httpStatus: res.status,
        detail:
          `HTTP ${res.status} arrived but its body is not JSON (${detail}). The transport ` +
          'succeeded, so this is NOT a reachability failure; it is a response this lane ' +
          `cannot interpret, and no population may be derived from it. Body, first 600 ` +
          `bytes: ${text.slice(0, 600)}`,
      },
    };
  }
}

/**
 * ARG's row-count cross-check, with its absence treated as a failure.
 *
 * S3. `totalRecords === null` means the control could not run — a different fact
 * from "the counts agreed", and the only one of the two that is not reassuring.
 * A collector that ignores a `$skipToken`, or a skip-token-with-empty-page
 * response that truncates the pull, produces a plausible-looking partial estate;
 * every node in the unread remainder then has zero inbound edges and a page
 * boundary is rendered as a fleet of unreachable services.
 *
 * Returns `null` when the population is sound, or the failure to report.
 */
export function requireTotalRecords(
  totalRecords: number | null,
  rowCount: number,
  pages: number,
  target: string,
): ProbeFailure | null {
  if (totalRecords === null) {
    return {
      stage: 'discovery',
      target,
      classification: 'arm-error',
      httpStatus: null,
      detail:
        `Resource Graph returned no usable numeric 'totalRecords' across ${pages} page(s), ` +
        `so the completeness cross-check could NOT be performed on the ${rowCount} row(s) ` +
        'read. This is reported rather than passed: "ARG did not tell me how many rows ' +
        'exist" is a different fact from "the counts agreed", and only one of them ' +
        'licenses a verdict over the population.',
    };
  }
  if (totalRecords !== rowCount) {
    return {
      stage: 'discovery',
      target,
      classification: 'arm-error',
      httpStatus: null,
      detail:
        `Resource Graph reported totalRecords=${totalRecords} but ${rowCount} row(s) were ` +
        `read across ${pages} page(s). The estate is INCOMPLETE; refusing to form a ` +
        'verdict over a partial population.',
    };
  }
  return null;
}

/**
 * Issue a request, retrying only what is genuinely transient, and failing closed.
 *
 * Returns the first non-transient response (success OR a 4xx that is Azure's
 * answer), or — on exhaustion — the last failure, with `retries` set either way
 * so a flaky path is visible rather than silently smoothed over.
 *
 * `classifyHttp` is supplied by the caller because the two collectors classify a
 * status slightly differently (the probe folds 401/403 to `auth`; the graph
 * source does the same but throws instead of returning). Keeping it out here
 * means this function never has to know which it is talking to.
 */
export async function fetchWithBoundedRetry(args: {
  readonly fetchImpl: FetchLike;
  readonly url: string;
  readonly init: { method: string; headers: Record<string, string>; body?: string };
  readonly stage: ProbeStage;
  readonly target: string;
  readonly policy: RetryPolicy;
  readonly now?: () => number;
}): Promise<FetchOutcome> {
  const { fetchImpl, url, init, stage, target, policy } = args;
  const now = args.now ?? (() => Date.now());
  if (!Number.isFinite(policy.maxAttempts) || policy.maxAttempts < 1) {
    // A policy that permits zero attempts would return a failure having issued
    // no request — a red run that establishes nothing, indistinguishable from a
    // real reach failure. Refused loudly: this is a defect in the caller.
    throw new RangeError(
      `retry policy maxAttempts must be >= 1, got ${String(policy.maxAttempts)}; a policy ` +
        'permitting zero attempts would report a reach failure having never issued a request.',
    );
  }

  let retries = 0;
  let lastFailure: ProbeFailure | null = null;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    let res: FetchResponse;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      lastFailure = {
        stage,
        target,
        classification: 'network',
        httpStatus: null,
        detail: `${detail} (no HTTP exchange completed)`,
      };
      if (attempt < policy.maxAttempts) {
        retries += 1;
        await policy.sleep(backoffMs(policy, attempt, null));
        continue;
      }
      break;
    }

    if (res.ok || !isTransientStatus(res.status)) {
      return { ok: true, res, retries };
    }

    // Transient. Read the body for the eventual message BEFORE deciding to
    // retry: on the last attempt it is the operator's only evidence.
    const body = await readTextBody(res);
    lastFailure = {
      stage,
      target,
      classification: res.status === 401 || res.status === 403 ? 'auth' : 'arm-error',
      httpStatus: res.status,
      detail: body.slice(0, 600),
    };
    if (attempt < policy.maxAttempts) {
      retries += 1;
      await policy.sleep(backoffMs(policy, attempt, retryAfterMs(readRetryAfter(res), now())));
      continue;
    }
    break;
  }

  // FAIL CLOSED. Exhaustion is a failure, and it names how many times it tried
  // so "flaky" and "down" are not the same line in a log.
  const failure = lastFailure ?? {
    stage,
    target,
    classification: 'arm-error' as const,
    httpStatus: null,
    detail: 'the retry loop completed without a response and without a recorded failure',
  };
  return {
    ok: false,
    retries,
    failure: {
      ...failure,
      detail:
        `${failure.detail} [gave up after ${policy.maxAttempts} attempt(s); ${retries} ` +
        'retry/retries on transient conditions (429, 5xx or no response)]',
    },
  };
}

/** Exponential backoff, honouring a server `Retry-After` when it gave a usable one. */
function backoffMs(policy: RetryPolicy, attempt: number, serverHintMs: number | null): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const chosen = serverHintMs === null ? exponential : Math.max(serverHintMs, exponential);
  return Math.min(chosen, policy.maxDelayMs);
}
