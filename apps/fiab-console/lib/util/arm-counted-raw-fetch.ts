/**
 * armCountedRawFetch — drop-in for the bare global `fetch(...)` that books ARM
 * GETs on the `[arm-reads]` counter (see lib/azure/arm-counted-fetch.ts).
 *
 * NO timeout is added: the setup wizard / landing-zone / client call sites this
 * replaces used a bare `fetch` and keep their exact timing. It lives OUTSIDE
 * `lib/azure` on purpose: `scripts/ci/check-breaker-coverage.mjs` keeps
 * `lib/azure` free of unbounded fetches, and every caller of this wrapper is
 * outside that directory. A `lib/azure` client must use `armCountedFetch`
 * (bounded) instead.
 */

import { counted } from '@/lib/azure/arm-counted-fetch';

export function armCountedRawFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return counted(input, init, () => fetch(input as any, init));
}
