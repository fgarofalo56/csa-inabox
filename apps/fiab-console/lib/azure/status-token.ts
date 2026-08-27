/**
 * status-token — match a bare numeric code ONLY as a standalone token.
 *
 * ## Why this exists
 *
 * Failure classifiers in this repo key on numeric signals: HTTP statuses
 * (`403`, `503`), SQLSTATEs (`08004`, `42501`), vendor error codes (`394509`).
 * Written as `\b403\b` they misfire, because `\b` treats `-` and the digit
 * boundary inside a longer run as word boundaries. That is not hypothetical:
 * `scripts/ci/_az-failure-class.mjs` shipped `\b503\b`, which matched inside a
 * resource group named `rg-loom-503` and classified a real `GatewayTimeout` as
 * transient; the follow-up fix (#4013) anchored ONE of three alternations and
 * made the other two worse. The lesson recorded there is that the anchor must
 * be ONE shared fragment, so it is either right everywhere or wrong everywhere.
 *
 * This is the TypeScript side of that same fragment. It is deliberately a
 * separate module rather than a copy inside each classifier: three literals
 * mean three chances to half-fix and three to half-revert.
 *
 * ## Both halves are load-bearing
 *
 *   - drop the LOOKBEHIND and a TRAILING token reopens: `WH_394509`, `rg-loom-503`
 *   - drop the LOOKAHEAD  and a LEADING  token reopens: `394509_EU`, `503117`
 *
 * Each half has its own fixture in `__tests__/status-token.test.ts`. A fixture
 * that either anchor alone would block cannot discriminate a half-revert, so it
 * would not prove the comment above.
 *
 * Pure: no I/O, no env. Safe to import from a route, a client, or a test.
 */

/** Nothing word-ish or hyphen-ish immediately BEFORE the code. */
export const STATUS_TOKEN_LOOKBEHIND = '(?<![\\w-])';
/** Nothing word-ish or hyphen-ish immediately AFTER the code. */
export const STATUS_TOKEN_LOOKAHEAD = '(?![\\w-])';

/**
 * Wrap a numeric alternation so it only matches as a standalone token.
 *
 * @example
 *   new RegExp(statusToken('403|401'), 'i').test('AuthorizationFailed (403)') // true
 *   new RegExp(statusToken('403|401'), 'i').test('storage account st403loom') // false
 */
export function statusToken(alternation: string): string {
  return `${STATUS_TOKEN_LOOKBEHIND}(?:${alternation})${STATUS_TOKEN_LOOKAHEAD}`;
}
