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
 * Pure transport — cloud-invariant, no Fabric/Azure host knowledge here.
 */

/** Default client-side per-request timeout (ms). Matches the 6s budget used by
 * app/admin/api-management/page.tsx so every spinner-gated page fails fast. */
export const CLIENT_FETCH_TIMEOUT_MS = 6000;

export async function clientFetch(
  input: string | URL,
  init?: RequestInit,
  timeoutMs: number = CLIENT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const callerSignal = init?.signal ?? undefined;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
