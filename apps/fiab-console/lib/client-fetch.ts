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
  const res = await rawFetch(input, init, timeoutMs);
  // SLIDING-SESSION RECOVERY: a 401 from a first-party /api route MAY mean the
  // encrypted loom_session cookie lapsed while the MSAL refresh token is still
  // alive. In that one case we transparently POST /api/auth/refresh ONCE to
  // re-slide the cookie, then retry the original request. Single retry, no loop.
  if (res.status !== 401) return res;
  const url = String(input);
  // Never refresh-retry the refresh route itself (would recurse), and honor a
  // one-shot guard so a still-401 after refresh surfaces to the caller.
  if (url.includes('/api/auth/refresh')) return res;
  // GATE ON A SESSION-EXPIRY SIGNAL, NOT ANY 401. The refresh-retry + top-level
  // reauth must fire ONLY when the 401 is the BFF SESSION gate lapsing
  // (`{error:'unauthenticated'}` from getSession()===null — the canonical shape
  // emitted by lib/auth feature-gate/dlz-gate — or `{reauth:true}` /
  // `{error:'session_expired'}`). It must NOT fire for an AUTHORIZATION 401 (a
  // backend RBAC/permission denial passed through) or an opaque non-JSON 401.
  // Otherwise a user holding a VALID 8h session cookie — e.g. a 401 served by a
  // console replica whose MSAL cache lacks their account, or a recurring authz
  // 401 that persists after re-login — would be yanked to /auth/sign-in, and
  // the module-level `_reauthInFlight` guard (reset on every reload) cannot
  // break a redirect loop across reloads. Peeking a CLONE leaves the original
  // 401 body intact for the caller's own error handling.
  if (!(await isSessionExpiry401(res))) return res;
  const outcome = await trySilentRefresh();
  if (outcome === 'reauth') {
    // MSAL refresh token gone/expired → interactive TOP-LEVEL redirect (never an
    // iframe). The page navigates away; return the original 401 in the meantime.
    triggerTopLevelReauth();
    return res;
  }
  if (outcome === 'ok') {
    // The silent refresh re-minted the cookie. Retry the ORIGINAL request once —
    // but ONLY when its body can be re-sent. A one-shot body (a `ReadableStream`,
    // or any body the first attempt already consumed) makes the retry's `fetch()`
    // throw "body already used", which would replace the honest 401 with a
    // confusing transport error and reject `clientFetch`. In that case SKIP the
    // retry and surface the original 401 so the caller's existing error handling
    // runs — and because the cookie is now fresh, the caller's NEXT request
    // succeeds. Callers pass JSON strings in practice, so the common path always
    // retries.
    if (isReSendableBody(init)) {
      return rawFetch(input, init, timeoutMs);
    }
    return res;
  }
  // Refresh failed at the transport level (offline / timeout) — surface the
  // original 401 unchanged so the caller's existing error handling runs.
  return res;
}

/** One-shot outcome of the silent refresh attempt. */
type RefreshOutcome = 'ok' | 'reauth' | 'error';

/**
 * Whether `init.body` can be safely re-sent on the post-refresh retry. Passing
 * `init` (a plain object) to `fetch()` twice re-reads value bodies fresh each
 * time, so strings, `URLSearchParams`, `FormData`, `Blob`/`File`, `ArrayBuffer`,
 * and typed-array views are all re-sendable. A `ReadableStream` body (or any
 * body the first attempt already drained) can be read only ONCE — re-sending it
 * makes `fetch()` throw "body already used". We treat no-body as re-sendable and
 * anything not in the known-re-sendable set (i.e. streams) as NOT, so the retry
 * is skipped rather than throwing. Pure type inspection; never consumes the body.
 */
function isReSendableBody(init?: RequestInit): boolean {
  const body = init?.body;
  if (body == null) return true; // no body — always re-sendable
  if (typeof body === 'string') return true;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true;
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return true;
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body)) return true;
  // ReadableStream or any other one-shot/already-consumed body — NOT safe.
  return false;
}

/**
 * CONCURRENT-401 DEDUPE. A page firing N parallel /api fetches can take N
 * simultaneous session-expiry 401s; without coordination each would POST
 * /api/auth/refresh independently — a thundering herd that re-mints the cookie
 * N times and races the Set-Cookie writes. We memoize the single in-flight
 * refresh round-trip (mirrors the `_reauthInFlight` redirect guard) so all N
 * callers await ONE POST, then each retries its own original request. The
 * promise is cleared when the round-trip settles, so the next genuine lapse
 * starts a fresh refresh.
 */
let _refreshInFlight: Promise<RefreshOutcome> | null = null;

/**
 * POST /api/auth/refresh once (credentials included so the cookie travels),
 * de-duplicated across concurrent callers via `_refreshInFlight`. The first
 * caller starts the round-trip; concurrent callers share the same promise.
 * 200 → 'ok' (cookie re-minted); 401 {reauth:true} → 'reauth'; anything else /
 * transport failure → 'error'. Never throws.
 */
function trySilentRefresh(): Promise<RefreshOutcome> {
  if (_refreshInFlight) return _refreshInFlight;
  // doSilentRefresh never rejects (it catches internally), so this resolves and
  // the `.finally` always clears the in-flight slot — no stuck/locked state.
  _refreshInFlight = doSilentRefresh().finally(() => { _refreshInFlight = null; });
  return _refreshInFlight;
}

async function doSilentRefresh(): Promise<RefreshOutcome> {
  try {
    const r = await rawFetch('/api/auth/refresh', { method: 'POST' }, CLIENT_FETCH_TIMEOUT_MS);
    if (r.ok) return 'ok';
    if (r.status === 401) return 'reauth';
    return 'error';
  } catch {
    return 'error';
  }
}

/**
 * True ONLY when a 401 is the BFF SESSION gate lapsing — `getSession()===null`
 * (`{error:'unauthenticated'}`, the canonical body from lib/auth feature-gate /
 * dlz-gate), the refresh route's `{reauth:true}`, or an explicit
 * `{error:'session_expired'}`. An AUTHORIZATION 401 (a backend RBAC/permission
 * denial passed through) or any opaque / non-JSON / empty 401 returns FALSE so
 * it is surfaced to the caller WITHOUT a spurious silent-refresh + top-level
 * reauth — the failure mode that yanks a validly-signed-in user (e.g. a
 * cache-miss 401 from the wrong replica, or a recurring authz 401) to
 * /auth/sign-in. Reads a CLONE so the caller can still consume the original
 * response body. Never throws.
 */
async function isSessionExpiry401(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { error?: unknown; reauth?: unknown } | null;
    if (!body || typeof body !== 'object') return false;
    if (body.reauth === true) return true;
    return body.error === 'unauthenticated' || body.error === 'session_expired';
  } catch {
    // Non-JSON / empty / unreadable 401 → treat as NOT a session lapse so an
    // opaque backend 401 never triggers reauth for a validly-signed-in user.
    return false;
  }
}

let _reauthInFlight = false;
/**
 * TOP-LEVEL navigation to the BFF sign-in initiator (which 302s to AAD). NOT an
 * iframe: SPA silent-iframe refresh is blocked by 3rd-party-cookie / refresh-
 * token-in-the-browser limits (MSAL guidance). Guarded so concurrent 401s from a
 * page's parallel fetches don't stack multiple navigations.
 */
function triggerTopLevelReauth(): void {
  if (typeof window === 'undefined') return;
  if (_reauthInFlight) return;
  _reauthInFlight = true;
  window.location.assign('/auth/sign-in');
}

async function rawFetch(
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
