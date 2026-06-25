/**
 * client-fetch — the CLIENT half of the systemic "no-timeout +
 * non-resolving-catch" fix (see app/admin/api-management/page.tsx for the
 * canonical inline version this generalises).
 *
 * A page that gates a <Spinner> on a `null` loading state spins forever if its
 * `fetch` never settles. The server-side `lib/azure/fetch-with-timeout` now
 * bounds every BFF→Azure round-trip, so a hung backend makes the BFF return an
 * error within its budget instead of hanging — but the browser→BFF hop itself
 * still needs a client-side ceiling so the UI fails FAST (≈6s) rather than
 * waiting out the full server budget, and so a stalled/unreachable route can't
 * pin the spinner.
 *
 * `clientFetch` is a drop-in `fetch` that aborts after `timeoutMs` (default 6s,
 * matching the api-management page). On timeout it rejects, so the caller's
 * existing `.catch(...)` runs and MUST resolve its loading state to an honest
 * error/empty view (the non-resolving-catch half of the fix). A caller-supplied
 * signal is composed so component-unmount aborts still propagate.
 *
 * It also carries SAME-SESSION CREDENTIALS by default (`credentials:'include'`)
 * so the encrypted `loom_session` cookie reaches first-party /api BFF routes and
 * `getSession()` authenticates the request — matching a bare same-origin
 * `fetch`. Without this, callers behind the deployment edge (Front Door /
 * NEXT_PUBLIC_API_BASE) get a spurious 401 `{error:'unauthenticated'}`. A
 * caller-supplied `credentials` still wins (it follows the default in the init
 * spread). clientFetch is only used for first-party /api routes, so this is a
 * same-origin call with no third-party cookie exposure.
 *
 * Pure transport — cloud-invariant, no Fabric/Azure host knowledge here.
 */

/** Default client-side per-request timeout (ms). Matches the 6s budget used by
 * app/admin/api-management/page.tsx so every spinner-gated page fails fast. */
export const CLIENT_FETCH_TIMEOUT_MS = 6000;

/**
 * Thrown when `clientFetch` aborts a request because it exceeded `timeoutMs`
 * (the timeout, NOT a caller-supplied unmount signal). Its `message` is a clear,
 * human-readable "timed out" string — NOT the browser's cryptic
 * "signal is aborted without reason" — so a caller that does `setErr(String(e))`
 * or `setErr(e.message)` surfaces something an operator can act on.
 *
 * Mirrors the server-side `FetchTimeoutError` in lib/azure/fetch-with-timeout.ts.
 */
export class ClientFetchTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(
      `The request took longer than ${Math.round(timeoutMs / 1000)}s and timed out. `
      + 'This query can be heavier across multiple subscriptions — retry, or narrow the window.',
    );
    this.name = 'ClientFetchTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export async function clientFetch(
  input: string | URL,
  init?: RequestInit,
  timeoutMs: number = CLIENT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

  const callerSignal = init?.signal ?? undefined;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    // `credentials:'include'` is placed BEFORE `...init` so it is the DEFAULT
    // yet a caller-supplied `credentials` still wins, and `signal` stays our
    // composed controller. This carries the encrypted `loom_session` cookie to
    // first-party /api BFF routes so `getSession()` authenticates the request
    // the same way a bare same-origin `fetch` does — without it, callers like
    // the Manage-hub linked-services/datasets/integration-runtime panels reach
    // the BFF unauthenticated at the deployment edge (Front Door /
    // NEXT_PUBLIC_API_BASE) and get a spurious 401 {error:'unauthenticated'}.
    // Same-origin first-party use only — no third-party cookie exposure.
    return await fetch(input, { credentials: 'include', ...init, signal: controller.signal });
  } catch (err) {
    // Relabel the timeout-driven abort. The browser surfaces an AbortError whose
    // message is "signal is aborted without reason" — useless to an operator.
    // Distinguish OUR timeout (timedOut flag) from a caller-driven abort
    // (component unmount): only the former becomes a friendly timeout error; a
    // caller abort re-throws unchanged so unmount cleanup behaves as before.
    if (timedOut && !callerSignal?.aborted) {
      throw new ClientFetchTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
