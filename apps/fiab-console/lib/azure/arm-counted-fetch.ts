/**
 * arm-counted-fetch — `fetchWithTimeout` that ALSO books ARM GETs on the
 * per-minute `[arm-reads]` counter (arm-read-gate.ts).
 *
 * WHY: only the two shared ARM transports (`arm-client.armFetch`,
 * `monitor-arm.armGet`) called `beginArmRead()`. ~60 per-service clients build
 * their own ARM URL and called `fetchWithTimeout` directly, so a quota burst
 * (429 `SubscriptionRequestsThrottled`) could not be attributed to a caller.
 * Those clients now call this instead. Census + guard: docs/fiab/ops/arm-read-quota-visibility.md
 * and scripts/ci/check-arm-counted-fetch.mjs.
 *
 * OBSERVATION ONLY. Same signature and same request as `fetchWithTimeout`; no
 * retry, throttle or header change. A read is counted only when ALL hold:
 *   - the method is GET (writes are a separate ARM bucket, same rule as armFetch);
 *   - the URL's origin is this cloud's ARM origin (`armBase()`), so a file that
 *     mixes ARM and data-plane calls does not book data-plane reads as ARM.
 * Inside a warmer cycle the read also queues in the warmer gate, exactly like a
 * read through `armFetch` (that is the contract of `beginArmRead`).
 */

import { armBase } from './cloud-endpoints';
import { fetchWithTimeout } from './fetch-with-timeout';
import { beginArmRead } from './arm-read-gate';

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

function methodOf(input: string | URL | Request, init?: RequestInit): string {
  const m = init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : undefined);
  return (m ?? 'GET').toUpperCase();
}

/** True when `url` targets this cloud's ARM origin. Never throws. */
export function isArmOrigin(url: string): boolean {
  try {
    return new URL(url).origin === new URL(armBase()).origin;
  } catch {
    return false;
  }
}

/** Count a GET to the ARM origin around `call`; anything else passes straight through. */
export async function counted(
  input: string | URL | Request,
  init: RequestInit | undefined,
  call: () => Promise<Response>,
): Promise<Response> {
  if (methodOf(input, init) !== 'GET' || !isArmOrigin(urlOf(input))) return call();
  const ticket = await beginArmRead();
  let res: Response;
  try {
    res = await call();
  } catch (e) {
    ticket.done(null);
    throw e;
  }
  ticket.done(res.status, res.headers?.get?.('retry-after'));
  return res;
}

/**
 * Drop-in for `fetchWithTimeout(...)`. Forwards the caller's exact argument list
 * (including an absent timeout), so the request is what `fetchWithTimeout`
 * would have sent.
 */
export function armCountedFetch(...args: Parameters<typeof fetchWithTimeout>): Promise<Response> {
  return counted(args[0], args[1], () => fetchWithTimeout(...args));
}
