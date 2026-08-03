/**
 * aoai-retry — the ONE bounded retry policy for Azure OpenAI data-plane calls.
 *
 * WHY THIS EXISTS: every AOAI call site in `aoai-chat-client` used to turn a
 * `429 Too Many Requests` straight into a thrown `AoaiResponseError`, which the
 * BFF routes surface as a hard 500. On a capacity-constrained deployment that
 * makes Copilot look broken for a transient, *retryable* condition — the live
 * console logged 5,704 AOAI errors over three days and EVERY one was a 429.
 * Azure OpenAI returns `Retry-After` on throttle; we were ignoring it.
 *
 * DESIGN
 *   • **Status-only.** This helper inspects HTTP status codes. It never catches
 *     a thrown transport error — those still propagate untouched so the APIM →
 *     direct fallback in `withApimFallback` keeps its exact semantics.
 *   • **Returns the last Response, never throws.** On exhaustion the final
 *     (still-failing) response is handed back so each call site's existing
 *     `if (!res.ok) throw new AoaiResponseError(...)` fires with byte-identical
 *     error text. Zero blast radius on error contracts.
 *   • **Precise retryability.** ONLY {@link AOAI_RETRYABLE_STATUSES}. A 400
 *     (bad request), 401 (auth), 403 (forbidden), 404 (no such deployment),
 *     408/409/413/422 and every other 4xx fails FAST — retrying them is pure
 *     latency and can mask a real misconfiguration. 501/505 are likewise not
 *     retried (a permanent server-side "won't do that", not a transient blip).
 *   • **Honours `Retry-After`.** Delta-seconds or an HTTP-date, per RFC 9110.
 *     A server-supplied delay wins over the computed backoff, still clamped by
 *     `maxDelayMs` so a hostile/garbage header cannot hang a route.
 *   • **Bounded twice over.** A max attempt count AND a total sleep budget. The
 *     worst case added latency is `budgetMs`, independent of attempt count, so
 *     a request can never hang a route. Each individual attempt keeps its own
 *     `fetchWithTimeout` deadline (unchanged).
 *   • **Full jitter.** `random() * min(maxDelay, base * 2^n)` — the AWS-style
 *     full-jitter backoff, so a fleet of replicas that all got throttled at the
 *     same instant does not retry in lockstep and re-throttle itself.
 *   • **Bodies are drained.** A response we discard has its body read-and-
 *     dropped so the undici connection is released back to the pool. The
 *     RETURNED response is never touched — critical for `aoaiChatStream`, whose
 *     caller pipes `res.body` straight to the browser.
 *
 * Default-ON / opt-out per `loom_default_on_opt_out`: retries are active with
 * code defaults and need no env wiring. `LOOM_AOAI_RETRY_ENABLED=false` reverts
 * to exactly one attempt (the pre-fix behaviour).
 */

/**
 * Statuses worth retrying an AOAI call on.
 *   • 429 — throttled (the observed failure; `Retry-After` is authoritative).
 *   • 500 — AOAI internal error; transient in practice.
 *   • 502 / 503 / 504 — gateway / unavailable / timeout, all transient.
 * Deliberately EXCLUDES every 4xx (client-side, deterministic) and 501/505
 * (permanent server refusals).
 */
export const AOAI_RETRYABLE_STATUSES: readonly number[] = [429, 500, 502, 503, 504];

/** True when `status` is a transient AOAI failure worth another attempt. */
export function isRetryableAoaiStatus(status: number): boolean {
  return AOAI_RETRYABLE_STATUSES.includes(status);
}

/** Read a positive integer env knob, else `fallback`. */
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** Default-ON: only the literal `false` disables retrying. */
export function aoaiRetryEnabled(): boolean {
  return String(process.env.LOOM_AOAI_RETRY_ENABLED ?? '').trim().toLowerCase() !== 'false';
}

/** Total attempts (1 = no retry). Default 3 → the initial call + 2 retries. */
export function aoaiRetryMaxAttempts(): number {
  if (!aoaiRetryEnabled()) return 1;
  return Math.max(1, envInt('LOOM_AOAI_RETRY_MAX_ATTEMPTS', 3));
}

/** First backoff step (ms) — doubled per attempt before jitter. */
export function aoaiRetryBaseDelayMs(): number {
  return envInt('LOOM_AOAI_RETRY_BASE_MS', 500);
}

/** Ceiling for ONE sleep, including a server-supplied `Retry-After` (ms). */
export function aoaiRetryMaxDelayMs(): number {
  return envInt('LOOM_AOAI_RETRY_MAX_DELAY_MS', 8_000);
}

/** Ceiling for the SUM of all sleeps across one call's retries (ms). */
export function aoaiRetryBudgetMs(): number {
  return envInt('LOOM_AOAI_RETRY_BUDGET_MS', 20_000);
}

/**
 * Parse an RFC 9110 `Retry-After` header to milliseconds.
 *
 * Accepts delta-seconds (`"3"`, `"0"`) and an HTTP-date
 * (`"Wed, 21 Oct 2026 07:28:00 GMT"`). Returns `undefined` for a missing,
 * malformed, or negative value so the caller falls back to computed backoff.
 * A date in the past clamps to 0 (retry immediately) rather than going
 * negative.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  const raw = (value ?? '').trim();
  if (!raw) return undefined;

  // delta-seconds (the form Azure OpenAI actually sends).
  if (/^\d+$/.test(raw)) {
    const secs = Number(raw);
    return Number.isFinite(secs) ? secs * 1000 : undefined;
  }

  // HTTP-date. `Date.parse` is dangerously lenient — it happily parses `'-5'`
  // and `'1.5'` into real dates, which would turn a garbage header into
  // "retry immediately". A real HTTP-date always carries a weekday + month
  // name, so require at least one letter before trusting it.
  if (!/[a-z]/i.test(raw)) return undefined;
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) return Math.max(0, at - nowMs);

  return undefined;
}

/** Tunables + test seams for {@link sendWithAoaiRetry}. */
export interface AoaiRetryOptions {
  /** Total attempts including the first. Defaults to {@link aoaiRetryMaxAttempts}. */
  maxAttempts?: number;
  /** First backoff step in ms. Defaults to {@link aoaiRetryBaseDelayMs}. */
  baseDelayMs?: number;
  /** Per-sleep ceiling in ms. Defaults to {@link aoaiRetryMaxDelayMs}. */
  maxDelayMs?: number;
  /** Total-sleep ceiling in ms. Defaults to {@link aoaiRetryBudgetMs}. */
  budgetMs?: number;
  /** Injected sleep (tests pass a no-op to keep the suite instant). */
  sleep?: (ms: number) => Promise<void>;
  /** Injected jitter source in [0,1) (tests pin it for determinism). */
  random?: () => number;
  /** Short label for the throttle trace (e.g. `'chat'`, `'stream'`). */
  label?: string;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Read and discard a response body we are NOT returning, so the underlying
 * connection is released. Never throws — a body-less or already-consumed
 * response is fine.
 */
async function drain(res: Response): Promise<void> {
  try {
    await res.text();
  } catch {
    /* best-effort: a mocked or already-consumed body is not an error */
  }
}

/**
 * Run `send` with bounded retries on transient AOAI statuses.
 *
 * Returns the FIRST non-retryable response (success or a fail-fast 4xx), or the
 * LAST response once attempts/budget are exhausted — so the caller's existing
 * `!res.ok` handling produces the same error it always did. Transport errors
 * thrown by `send` propagate immediately and untouched.
 *
 * The returned response's body is guaranteed UNREAD.
 */
export async function sendWithAoaiRetry(
  send: () => Promise<Response>,
  opts: AoaiRetryOptions = {},
): Promise<Response> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? aoaiRetryMaxAttempts());
  const baseDelayMs = opts.baseDelayMs ?? aoaiRetryBaseDelayMs();
  const maxDelayMs = opts.maxDelayMs ?? aoaiRetryMaxDelayMs();
  const budgetMs = opts.budgetMs ?? aoaiRetryBudgetMs();
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;
  const label = opts.label ?? 'aoai';

  let spentMs = 0;

  for (let attempt = 1; ; attempt++) {
    // A transport throw is NOT our business — let withApimFallback see it.
    const res = await send();

    // Success, or a deterministic client error → hand back untouched (body unread).
    if (res.ok || !isRetryableAoaiStatus(res.status)) return res;

    // Out of attempts → return the failing response so the call site throws its
    // own, unchanged, error.
    if (attempt >= maxAttempts) return res;

    // Prefer the server's own guidance; else full-jitter exponential backoff.
    const serverDelay = parseRetryAfterMs(res.headers?.get?.('retry-after'));
    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    const delay = Math.min(maxDelayMs, serverDelay ?? Math.floor(random() * backoff));

    // Hard ceiling: never sleep past the total budget for this one call.
    if (spentMs + delay > budgetMs) return res;

    try {
      console.warn(
        `[aoai-retry] ${label} ${res.status} — attempt ${attempt}/${maxAttempts}, ` +
          `retrying in ${delay}ms${serverDelay != null ? ' (Retry-After)' : ''}`,
      );
    } catch {
      /* trace only */
    }

    await drain(res);
    spentMs += delay;
    if (delay > 0) await sleep(delay);
  }
}
