/**
 * _azure-redact.mjs — shared redaction for anything an Azure tool prints that
 * is about to reach a log annotation, a run log, a committed artifact, or a PR
 * or issue body.
 *
 * Extracted from deploy-retry.mjs so deploy-arm-errors.mjs applies the SAME
 * rule. Two copies of a redaction regex is one copy that stops being updated;
 * this repo's dominant defect class is exactly a control that has quietly
 * drifted from its twin (csa_loom_gates_that_measure_nothing).
 *
 * `_`-prefixed: a shared library, not a control — see the population rule in
 * scripts/ci/check-ci-guard-reachability.mjs.
 *
 * SIZE-INDEPENDENT BY CONTRACT. There is no length cap and there must never be
 * one: a redactor that gives up above N bytes leaks exactly the inputs most
 * worth redacting (a full ARM operation dump), and every fixture in every
 * consuming suite is small enough that such a cap would go unnoticed —
 * `if (text.length > 20000) return text;` left all three suites GREEN at 90/90,
 * and a 60-leaf renderLeaves() dump measures 24,419 bytes, so the gap is
 * reachable rather than theoretical. Pinned in
 * scripts/ci/__tests__/deploy-retry.test.mjs from both directions: behavioural
 * (1 KB / 64 KB / 1 MB, asserting the redaction COUNT equals the injected count
 * at each size) and structural (redact()'s source contains no length
 * comparison, so a cap outside the sampled range is red too).
 */

/**
 * THE GUID BOUNDARY IS A TRAILING-HEX GUARD — not `\b`, and no longer a LEADING
 * one either (#3829 round 2, narrowed round 5).
 *
 *   The first cut used `\b…\b`. `\b` is a WORD boundary, and `_` and every
 *   letter are word characters, so a GUID glued to word chars on EITHER side
 *   survived it — measured:
 *
 *     _<guid>       LEAK      admin_<guid>   LEAK      x<guid> / <guid>x  LEAK
 *
 *   `<name>_<guid>` is not a hypothetical: it is the shape of ARM deployment
 *   names and of role-assignment names this repo generates, so the residual was
 *   live on a public surface. Round 2 replaced `\b` with negative lookaround on
 *   HEX, which is a strict SUPERSET of `\b` (every non-word char is also a
 *   non-hex char), so nothing previously redacted regressed. All four shapes
 *   above are clean today and are pinned as such.
 *
 *   ROUND 5 THEN DROPPED THE LOOKBEHIND, because keeping it was itself a live
 *   leak on a public surface. A dashed 8-4-4-4-12 token cannot be a slice out of
 *   a PURE hex run — the dashes preclude it — so the lookbehind never protected
 *   a git sha or a sha256 digest, which is what it read as though it did. The
 *   only false positive it prevented is a token whose FIRST group is 9+ hex
 *   (`deadbeefc-1234-…`), and it paid for that with `uami-loom-directlake<guid>`
 *   — a REAL Loom-shaped name whose last character happens to be hex,
 *   concatenated to an id with no separator. Measured on this exact pattern,
 *   with every fixture read as DATA out of
 *   scripts/ci/__tests__/deploy-retry.test.mjs:
 *
 *     dropping the lookbehind   closes  f<guid>, abcdef<guid>,
 *                                       uami-loom-directlake<guid>   (3 of 5)
 *     it introduces             no threshold of any kind
 *     it costs                  exactly 1 of the 9 corpus rows —
 *                               `abcdef11111111-2222-…`, a 14-hex first group
 *
 *   That row was never independent evidence for keeping the lookbehind: it is
 *   absent from the merge base 608a36af and was ADDED by this same change's
 *   round 2 (`git show 608a36af:…/deploy-retry.test.mjs | grep -c abcdef11111111`
 *   → 0, RC=1; the same grep at the head → 1, RC=0). Citing a fixture you
 *   introduced as the obstacle you cannot move is circular, so it was dropped
 *   rather than re-argued, and a 14-hex-first-group token now reads back as
 *   `abcdef<guid>`. Over-redacting a diagnostic is recoverable; publishing an
 *   object id into a public repo's permanent history is not.
 *
 *   THE RESIDUALS, ENUMERATED IN FULL (#3829 round 4, re-measured round 5).
 *   Round 3 listed ONE of these and said "what it still does NOT match" as
 *   though the list were complete. It was not, which makes the sentence itself
 *   an R7 violation — a claim stated as established that was never measured.
 *   Both residuals, both measured against this exact regex:
 *
 *     1. AN UNDASHED 32-HEX RUN. ARM prints the blocking role-assignment id that
 *        way ("existing role assignment is 0a2b…"), and deploy-retry.mjs's
 *        planRemediation() reads it back out of the message to converge the
 *        grant automatically (#3439). Redacting it would disable a working
 *        auto-remediation to hide a value that is a resource NAME, not a
 *        principal id. Unaffected by the round-5 narrowing — the pattern still
 *        requires the dashes.
 *
 *     2. A GUID DIRECTLY ADJACENT TO A HEX CHARACTER ON THE RIGHT — which is
 *        what the surviving LOOKAHEAD is, so this is that guard's cost, not a
 *        bug in it. Measured, round 5:
 *
 *          clean  x<guid>  <guid>x  _<guid>  admin_<guid>   (round 2 closed these)
 *          clean  f<guid>  abcdef<guid>  uami-loom-directlake<guid>
 *                                                          (round 5 closed these)
 *          LEAK   <guid>f  <guid>abc
 *
 *        The two that remain are the ones where hex FOLLOWS the id. The
 *        lookahead is kept because this lane's live leak shape is prefix-glued —
 *        `<name><guid>` (a deployment name, a UAMI name, `<server>/<objectId>`)
 *        — and no Loom-generated string of the form `<guid><hex>` has been
 *        measured. That is a narrower claim than round 4's and it is stated as
 *        the reason, not as proof: if one is ever measured, drop the lookahead
 *        too and take the second corpus row with it.
 *
 *   Both residuals are pinned by their own named tests, so neither can drift
 *   back into being an unstated assumption.
 */
const GUID = String.raw`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F])`;

/**
 * Redact subscription / tenant ids and bare GUIDs, in place. IDEMPOTENT —
 * `<guid>` and `<redacted>` contain nothing this matches — which is what lets
 * the deploy lane redact at stacked boundaries (a composition site on the
 * artifact path, the serialized artifact itself, and the issue poster) without
 * mangling the diagnostic.
 *
 * THE CONTRACT IS "NEVER RETURNS A NON-STRING", NOT "PROTECTS YOU FROM ONE"
 * (#3829 round 4). This used to read `'' for a non-string, so a caller cannot
 * publish [object …]` — which every publishing consumer falsifies, because they
 * all reach this through redactedLine() below (or, at the issue poster,
 * `redact(String(body))`), and that calls `String()` FIRST. Under those callers
 * `notifyFailure({body:{msg:'…'}})` posts the literal `[object Object]` and
 * `body: undefined` posts `undefined`. That is the intended behaviour — a
 * visibly-wrong notice beats a silently-empty one — but the docstring claimed a
 * guarantee this function does not provide, and a comment that contradicts its
 * own callers is how the next reader gets it wrong.
 *
 * So: STRINGIFICATION IS THE CALLER'S DECISION. This function guarantees only
 * that its return value is a string and carries no id it knows how to match; it
 * makes no promise about what a non-string turns into, because it never sees
 * one. Callers that publish MUST String() first — not for redaction, but so a
 * malformed input degrades to visible garbage rather than to a blank line.
 *
 * @param {unknown} text
 * @returns {string} '' for a non-string — a floor, not a safety net (see above)
 */
export function redact(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\/subscriptions\/[0-9a-fA-F-]{36}/g, '/subscriptions/<redacted>')
    .replace(/\/tenants?\/[0-9a-fA-F-]{36}/g, '/tenant/<redacted>')
    .replace(new RegExp(GUID, 'g'), '<guid>');
}

/**
 * THE PUBLICATION-BOUNDARY PRIMITIVE (#3829 round 5).
 *
 * Every named boundary in this lane — formatStdout()/formatStderr() in
 * .github/scripts/deploy-notify-failure.mjs, formatAnnotation()/formatStderr()
 * in scripts/ci/deploy-retry.mjs, formatStdout()/formatStderr() in
 * scripts/ci/deploy-arm-errors.mjs — is this function under a local name. It is
 * shared for the reason this module exists at all: three private copies of
 * `redact(String(x))` is two copies that stop being updated
 * (csa_loom_gates_that_measure_nothing).
 *
 * STRING() FIRST, AND THAT ORDER IS LOAD-BEARING. redact() returns '' for a
 * non-string, so applying it bare to a value that might not be one converts
 * "the thing prints wrong" into "the thing prints NOTHING" — a log line or an
 * issue body that silently vanished is a worse failure than the one it was
 * reporting, and in notifyFailure() that shape filed an EMPTY P0 notice and
 * exited 0. A bad input degrades to visible garbage, never to a blank.
 *
 * @param {unknown} text
 * @returns {string} the exact bytes the caller may publish
 */
export function redactedLine(text) {
  return redact(String(text));
}

/**
 * THE DISCLOSED-EXCEPTION MARKER (#3829 round 5). Returns its input as a string,
 * UNREDACTED, on purpose.
 *
 * WHY A FUNCTION AND NOT JUST A COMMENT. Four rounds of this fix each closed one
 * publication surface and left its neighbour open, and each one asserted the
 * enumeration was complete. The enumeration is now MECHANICAL — every
 * `process.stdout.write` / `process.stderr.write` in the three deploy scripts
 * must hand its argument to a named boundary function, and the structural tests
 * in each suite fail if one does not. A surface that genuinely must publish raw
 * bytes therefore needs a name the enumerator can see and COUNT, rather than a
 * comment it cannot. Adding a use of this function is a deliberate act that
 * moves a pinned number and shows up in review; forgetting to redact is not.
 *
 * THE FIVE USES TODAY, each disclosed where it sits — and this count is asserted
 * per file by the structural tests, not merely written here:
 *
 *   deploy-retry.mjs   FOUR: the child command's own STDOUT streamed live, its
 *                      own STDERR echoed back per attempt, that stderr echoed in
 *                      full on final failure, and its stdout TAIL replayed when
 *                      the stderr block came back empty. Rewriting any of them
 *                      would make the wrapper's log disagree with the command's
 *                      — the `stdio: inherit` parity R7 requires. If `az` prints
 *                      an id, that id reaches the public run log with or without
 *                      this harness.
 *   deploy-arm-errors  ONE: `--json`, which exists so an operator debugging their
 *                      own subscription keeps the real ARM ids. Operator-local by
 *                      contract, and pinned by a RATCHET asserting no workflow
 *                      invokes it.
 *
 * @param {unknown} text
 * @returns {string} the input, stringified and OTHERWISE UNTOUCHED
 */
export function unredactedByDesign(text) {
  return String(text);
}
