/**
 * loom-id-failures — the E2E assertion that stops #2830's class from scrolling past.
 *
 * WHY IT IS ITS OWN MODULE. `uat.ts` imports `@playwright/test`, and vitest
 * excludes `e2e/` from test discovery — so a predicate living there could never
 * be unit-tested, and an E2E assertion nobody has proven fires is the same
 * "control that reports but measures nothing" that let this class ship four
 * times. This file is dependency-free and pinned by
 * `__tests__/loom-id-failure-assertion.test.ts`; `uat.ts` re-exports it.
 *
 * THE SIGNAL. A `loom:<cosmosItemId>` id is minted by a LIST route only for an
 * item that exists in Cosmos. So a 4xx on `/api/items/<type>/loom:<id>/…` is
 * never "the user asked for something that is not there" — it is the prefix
 * failing to resolve, or a present-but-empty item being reported as missing.
 * Both are #2830.
 */

/** The subset of `uat.ts`'s NetworkFailure this predicate needs. */
export interface LoomIdFailureCandidate {
  url: string;
  status: number;
  sameOrigin: boolean;
  method?: string;
}

/**
 * A synthetic `loom:` id in the `[id]` segment of an item sub-route:
 * `/api/items/<type>/loom:<cosmosItemId>[/<sub>][?…]`.
 *
 * Matches the percent-encoded colon too — `encodeURIComponent` is what the
 * editors use, so the wire form is `loom%3A…` and a raw-colon-only pattern
 * would have missed every real occurrence, including the one in #2830's issue.
 */
const LOOM_ID_IN_ITEM_ROUTE = /\/api\/items\/[^/?#]+\/loom(?::|%3[Aa])[^/?#]+/;

/**
 * The 4xx failures whose URL carries a `loom:` bundle-template id.
 *
 * 401 is excluded — it is the auth-not-loaded-yet noise `captureFailures`
 * already ignores. 5xx is excluded because it is a different (and louder)
 * problem that the caller's own assertions cover; narrowing to 4xx keeps this
 * signal specific to the id-resolution class.
 */
export function loomIdFailures<T extends LoomIdFailureCandidate>(networkErrors: readonly T[] | undefined): T[] {
  return (networkErrors || []).filter(
    (n) => n.sameOrigin && n.status >= 400 && n.status < 500 && n.status !== 401
      && LOOM_ID_IN_ITEM_ROUTE.test(n.url),
  );
}

/**
 * Throw when any item sub-route 4xx'd on a `loom:` id. Call this from any spec
 * that walks an editor — the whole point is that the next instance of this class
 * fails a test instead of printing a line in the capture log.
 */
export function assertNoLoomIdFailures(
  networkErrors: readonly LoomIdFailureCandidate[] | undefined,
  context: string,
): void {
  const hits = loomIdFailures(networkErrors);
  if (hits.length === 0) return;
  const detail = hits.map((n) => `  ${n.status} ${n.method || 'GET'} ${n.url}`).join('\n');
  throw new Error(
    `#2830 — ${hits.length} item sub-route 4xx on a \`loom:\` bundle id during ${context}.\n` +
    'A `loom:` id is minted by the list route ONLY for an item that exists in Cosmos, so a 4xx\n' +
    `means the prefix did not resolve (or a present-but-empty item was reported as missing):\n${detail}`,
  );
}
