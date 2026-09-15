/**
 * Redact credential-shaped substrings from text that is about to be PUBLISHED.
 *
 * WHY THIS IS A SHARED MODULE (#4498 round 5)
 * -------------------------------------------
 * The durable last-run record (#4497) carries a REMOTE-SUPPLIED `error` string:
 * whatever the failing console replica chose to store. It is read on TWO
 * independent paths, and both of them publish:
 *
 *   1. `reindex-loom-docs.sh` parses it into `$LAST_ERROR` and echoes it.
 *   2. `classify-reindex-result.mjs` re-reads `lastRun.error` from the same poll
 *      body and embeds it in a `::error::` workflow annotation.
 *
 * Both land in a PUBLIC GitHub Actions log in a PUBLIC repo, and an annotation
 * is a publication surface in its own right, not a copy of stdout. Round 5's
 * first attempt redacted only path 1; the test written to prove it caught path 2
 * still emitting the raw value. That is why this is one module and not two
 * copies: a second copy is how the two paths drift apart again, and this repo
 * already has #4503 open for exactly that shape.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is NOT a proof that the output is secret-free, and no caller may
 * describe it that way. It matches the credential FORMS this estate actually
 * mints. An unanticipated shape passes through untouched. The real fix is for
 * the durable record to stop storing secrets; this is the containment at the
 * publication boundary, which is the only place either of these two consumers
 * controls.
 */

/**
 * @param {unknown} value text that is about to reach a public log
 * @returns {string} the same text with known credential shapes replaced
 */
export function redactSecrets(value) {
  return String(value ?? '')
    // SAS signatures, storage/service-bus keys, and query-string passwords.
    // Bounded by the separators that end a query param or a connection-string
    // segment, so only the VALUE is eaten and the key name survives.
    .replace(/(sig=|AccountKey=|SharedAccessKey=|password=|pwd=)[^\s&;",]+/gi, '$1[redacted]')
    // An Azure Functions key. Length-bounded so a `code=404` in an ordinary
    // HTTP error stays readable -- redacting that would cost diagnosis and buy
    // nothing.
    .replace(/(code=)[A-Za-z0-9._~+/=-]{20,}/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    // A JWT in any position, including one not introduced by `Bearer`.
    .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]');
}

export default redactSecrets;
