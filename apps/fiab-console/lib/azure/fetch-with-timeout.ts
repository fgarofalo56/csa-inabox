/**
 * fetch-with-timeout — bound every server-side HTTP round-trip with an
 * AbortController so a hung Azure / Fabric backend can't make a BFF route (and
 * therefore the page calling it) spin forever.
 *
 * This is the SERVER half of the systemic "no-timeout + non-resolving-catch"
 * fix. The CLIENT half is the AbortController + resolve-state-on-catch pattern
 * established in `app/admin/api-management/page.tsx` (a 6s client timer that
 * always resolves the loading state). On the server we wrap the shared ARM /
 * Fabric fetchers so every downstream caller inherits a ceiling for free —
 * `armFetch()` (arm-client.ts), `call()` / `fabricCall()` (fabric-client.ts),
 * and the per-client ARM copies (synapse-pool-arm.ts, kusto-arm-client.ts).
 *
 * CLOUD-INVARIANT: this is pure transport behaviour, so it deliberately touches
 * NONE of the sovereign endpoint logic in cloud-endpoints.ts. Commercial, GCC,
 * GCC-High and DoD all get the same per-request ceiling.
 *
 * LRO-SAFE: the timeout applies to ONE HTTP round-trip, NOT to a whole
 * long-running operation. ARM mutations return `202 + Location` and are polled
 * separately (see fabric-client `acceptLongRunning`, lakehouse `peekLoadOperation`).
 * Each individual poll request inherits this per-request budget; the poll loop
 * itself is responsible for bounding its own max-attempts (and honouring any
 * `Retry-After` header ARM sends on 202/429).
 *
 * No mocks. This only adds a deadline around the real `fetch`.
 */

/**
 * Default server-side per-request timeout in milliseconds. Single env-driven
 * source of truth (per the loom-no-freeform-config posture) rather than a
 * literal scattered across 100+ clients. 30s matches the existing
 * `callMcpTool` server budget in mcp-client.ts; override per-deployment with
 * `LOOM_SERVER_FETCH_TIMEOUT_MS`.
 */
export const DEFAULT_SERVER_FETCH_TIMEOUT_MS: number = (() => {
  const n = Number(process.env.LOOM_SERVER_FETCH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
})();

/**
 * Thrown when a request exceeds its timeout budget (as opposed to being
 * aborted by a caller-supplied signal or failing at the network layer).
 * Callers can `instanceof`-check this to surface an honest "backend timed out"
 * remediation instead of a generic error.
 */
export class FetchTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'FetchTimeoutError';
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * `fetch` with a hard per-request deadline. Drop-in replacement for `fetch` in
 * server code — same signature plus an optional `timeoutMs`.
 *
 * If the caller already passed an `AbortSignal` via `init.signal`, it is
 * composed with the internal timeout signal so BOTH still work: a caller abort
 * propagates, and the timeout fires independently. When the timeout (not the
 * caller) trips, a `FetchTimeoutError` is thrown.
 */
export async function fetchWithTimeout(
  input: string | URL | Request,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_SERVER_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Compose any caller-provided signal so existing aborts still propagate.
  const callerSignal = init?.signal ?? undefined;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    return await fetch(input as any, { ...init, signal: controller.signal });
  } catch (err) {
    // Distinguish a timeout-driven abort from a caller-driven abort / network
    // failure so callers can show an honest remediation.
    if (controller.signal.aborted && !callerSignal?.aborted) {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      throw new FetchTimeoutError(url, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
