/**
 * Exception → PUBLIC message sanitizer for loom-onelake's HTTP surface.
 *
 * Companion to apps/fiab-mcp-bridge/src/safe-error.mjs and
 * apps/copilot-maf/src/safe-error.ts — the same contract, one copy per
 * standalone app because these are separate packages with no shared import
 * path into apps/fiab-console/lib/api/respond.ts (`apiServerError`), which is
 * Next-only (it imports `next/server`).
 *
 * THE CONTRACT:
 *   - The caller supplies the public message as a LITERAL at the catch site.
 *   - The caught value NEVER contributes to the returned string — no
 *     `.message`, no `.stack`, no `String(e)`, and deliberately no
 *     "pass this one through" branch.
 *   - Full detail is logged server-side against a short correlation ref which
 *     IS returned, so an operator can join the two.
 *
 * WHY IT MATTERS HERE: `registry.lookup()` is a Cosmos read. Its exceptions
 * carry the account endpoint, the RBAC diagnostic, and an activity id — the
 * `registry lookup failed: ${e.message}` this replaces published all three to
 * any caller of GET /resolve. CodeQL did not flag that line (it models the
 * bridge's spawn errors, not the Cosmos SDK's throw), which is exactly why the
 * guard in scripts/ci/check-bff-errors.mjs RULE 3 scans the shape rather than
 * waiting for a scanner to point at each instance.
 */
import { randomUUID } from 'node:crypto';

const LOG_PREFIX = '[loom-onelake]';

/**
 * Log `err` in full server-side and return a client-safe message.
 *
 * @param {unknown} err            the caught value — never read into the result
 * @param {string}  publicMessage  literal, site-specific text the client sees
 * @returns {string} `${publicMessage} (ref: <8 hex>)`
 */
export function publicErrorMessage(err, publicMessage = 'internal error') {
  const ref = randomUUID().slice(0, 8);
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`${LOG_PREFIX} internal error [ref=${ref}]:`, detail);
  return `${publicMessage} (ref: ${ref})`;
}

/**
 * A client-caused request error whose message IS safe to publish because it is
 * authored here, not derived from an exception (e.g. a malformed body). Typed
 * so the request handler can branch on the CLASS instead of comparing
 * `e.message === 'invalid JSON body'` — a string compare that silently stops
 * matching the moment the thrower is reworded.
 */
export class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequestError';
    /** Marker — survives a structuredClone / cross-realm boundary. */
    this.isBadRequest = true;
  }
}

/** True for a {@link BadRequestError} (marker-based, not `instanceof`). */
export function isBadRequest(err) {
  return !!err && err.isBadRequest === true;
}
