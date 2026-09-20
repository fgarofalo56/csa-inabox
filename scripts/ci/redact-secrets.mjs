/**
 * Redact credential-shaped substrings from text that is about to be PUBLISHED.
 *
 * WHY THIS IS A SHARED MODULE (#4498 round 5, corrected round 6)
 * -------------------------------------------------------------
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
 * still emitting the raw value.
 *
 * RETRACTION (round 6). Round 5 wrote here that this being one module "and not
 * two copies" was what stopped the two paths drifting apart. That was FALSE when
 * it was written. Path 1 did not import this module at all — the shell carried a
 * hand-copied verbatim duplicate of all four rules inside an inline `node -e`,
 * so there were one importer and one clone: precisely the shape the sentence
 * claimed to have prevented. It is true now, and only because round 6 extracted
 * `parse-reindex-poll.mjs`, which path 1 shells out to and which imports this.
 * Both publication paths now resolve to the definitions below, so a tightening
 * here reaches both.
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
    // An Azure Functions key. The problem this rule has to solve twice over:
    // unanchored, `(code=)` also matches the TAIL of `errorcode=`/`statuscode=`/
    // `exitcode=`, eating a long diagnostic token as if it were a key.
    //
    // ROUND 7 CORRECTION. Round 6 solved that by anchoring to `[?&]`, i.e. by
    // requiring query-string position. That was a REGRESSION, caught in review
    // before it merged: it silently dropped redaction from `code=KEY`,
    // ` code=KEY`, `(code=KEY)` and `AZURE_FUNC code=KEY` -- all four of which a
    // remote service can put in an error string, and one of which is the exact
    // shape this lane's own fixture uses (`403 Forbidden (AccountKey=...)`).
    //
    // Round 6 also justified the anchor in prose: "a `code=` that is not in
    // query-string position is not a Functions key, and this estate mints none."
    // RETRACTED. That is a universal about text a REMOTE service composes, not
    // about URLs this estate builds, and it was never established. Per
    // `deploy-integrity.md` R7 the code does not get to assert what it did not
    // measure -- least of all to justify publishing more.
    //
    // The correct instrument is a LEFT BOUNDARY, not a required prefix: reject a
    // preceding identifier character, which is what makes `errorcode=` different
    // from `code=`, and say nothing about position. Length-bounded as before, so
    // a `code=404` in an ordinary HTTP error stays readable -- redacting that
    // would cost diagnosis and buy nothing.
    .replace(/(?<![A-Za-z0-9_])(code=)[A-Za-z0-9._~+/=-]{20,}/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    // A JWT in any position, including one not introduced by `Bearer`.
    .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]');
}

export default redactSecrets;
