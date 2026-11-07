/**
 * armCountedRawFetch — drop-in for the bare global `fetch(...)` for ARM calls
 * that books ARM GETs on the `[arm-reads]` counter (see lib/azure/arm-counted-fetch.ts).
 *
 * SAFE BY CONSTRUCTION (SSRF): this wrapper can ONLY reach this cloud's ARM
 * origin. The URL is parsed with `new URL`, then the request is rebuilt as
 * `armBase()` origin + the parsed path + query. The host that is fetched is
 * therefore taken from `armBase()` (config), never from the argument, and
 * anything that is not already an https URL on that origin is refused:
 *   - unparseable / protocol-relative (`//host/x`) / relative input,
 *   - a scheme other than https:,
 *   - userinfo (`https://management.azure.com@evil.example/`),
 *   - any other origin (host or port).
 * Redirects are not followed (`redirect: 'manual'`), so ARM cannot bounce the
 * bearer token to another origin; a 3xx is returned to the caller as-is.
 *
 * NO timeout is added: the call sites this replaces used a bare `fetch` and
 * keep their exact timing. It lives OUTSIDE `lib/azure` on purpose:
 * `scripts/ci/check-breaker-coverage.mjs` keeps `lib/azure` free of unbounded
 * fetches. Non-ARM hosts must NOT use this; keep a plain fetch and allowlist the
 * file in scripts/ci/arm-counted-fetch-allowlist.json.
 */

import { armBase } from '@/lib/azure/cloud-endpoints';
import { counted } from '@/lib/azure/arm-counted-fetch';

export class ArmFetchRefusedError extends Error {
  constructor(public readonly reason: string) {
    super(`armCountedRawFetch refused: ${reason}`);
    this.name = 'ArmFetchRefusedError';
  }
}

/** Returns `armOrigin + path + query` for a URL that is already on the ARM origin, else throws. */
export function pinToArmOrigin(input: string | URL): string {
  if (typeof input !== 'string' && !(input instanceof URL)) {
    throw new ArmFetchRefusedError('input must be a string or URL (a Request object was passed, its URL was not checked)');
  }
  const raw = typeof input === 'string' ? input : input.href;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ArmFetchRefusedError('URL is not an absolute, parseable URL (relative and protocol-relative forms are refused)');
  }
  const base = new URL(armBase());
  if (parsed.protocol !== 'https:') {
    throw new ArmFetchRefusedError(`scheme ${parsed.protocol} is not https:`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ArmFetchRefusedError('URL carries userinfo (user:password@host)');
  }
  if (parsed.origin !== base.origin) {
    throw new ArmFetchRefusedError(`origin ${parsed.origin} is not the ARM origin ${base.origin}`);
  }
  return `${base.origin}${parsed.pathname}${parsed.search}`;
}

export function armCountedRawFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  let target: string;
  try {
    target = pinToArmOrigin(input);
  } catch (e) {
    return Promise.reject(e);
  }
  const pinned: RequestInit = { ...init, redirect: 'manual' };
  return counted(target, pinned, () => fetch(target, pinned));
}
