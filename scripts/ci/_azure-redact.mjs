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
 * THE GUID BOUNDARY IS HEX-ADJACENCY, NOT `\b` (#3829 round 2).
 *
 *   The first cut used `\b…\b`. `\b` is a WORD boundary, and `_` and every
 *   letter are word characters, so a GUID glued to word chars on EITHER side
 *   survived it — measured:
 *
 *     _<guid>       LEAK      admin_<guid>   LEAK      x<guid> / <guid>x  LEAK
 *
 *   `<name>_<guid>` is not a hypothetical: it is the shape of ARM deployment
 *   names and of role-assignment names this repo generates, so the residual was
 *   live on a public surface.
 *
 *   The boundary that is actually wanted is "this token is not a slice out of a
 *   longer hex run" — which is what would make a match a false positive. So the
 *   guards are negative lookaround on HEX only. That is a strict SUPERSET of
 *   `\b` (every non-word char is also a non-hex char), so this can only redact
 *   more, never less, and no previously-redacted input regresses. The
 *   no-false-positive claim is pinned by a corpus test (git shas, sha256
 *   digests, timestamps, ARM type names) in
 *   scripts/ci/__tests__/deploy-retry.test.mjs.
 *
 *   THE RESIDUALS, ENUMERATED IN FULL (#3829 round 4). Round 3 listed ONE of
 *   these and said "what it still does NOT match" as though the list were
 *   complete. It was not, which makes the sentence itself an R7 violation — a
 *   claim stated as established that was never measured. Both residuals, both
 *   measured against this exact regex:
 *
 *     1. AN UNDASHED 32-HEX RUN. ARM prints the blocking role-assignment id that
 *        way ("existing role assignment is 0a2b…"), and deploy-retry.mjs's
 *        planRemediation() reads it back out of the message to converge the
 *        grant automatically (#3439). Redacting it would disable a working
 *        auto-remediation to hide a value that is a resource NAME, not a
 *        principal id.
 *
 *     2. A GUID DIRECTLY ADJACENT TO A HEX CHARACTER, either side — which is
 *        what the lookarounds above are, so this is the guard's cost, not a bug
 *        in it. Measured:
 *
 *          clean  x<guid>  <guid>x  _<guid>  admin_<guid>   (round 2 fixed these)
 *          LEAK   f<guid>  abcdef<guid>  <guid>f  <guid>abc
 *          LEAK   uami-loom-directlake<guid>
 *
 *        Note the shape of the last one: a name ending in a hex letter (a–f)
 *        concatenated to an id with NO separator still leaks. That is a real
 *        Loom-shaped name, so this residual is disclosed rather than dismissed.
 *
 *   AND THE HONEST ACCOUNTING OF WHAT THE LOOKAROUND BUYS. A dashed 8-4-4-4-12
 *   token cannot be a slice out of a PURE hex run — the dashes preclude it — so
 *   the lookbehind does not protect git shas or sha256 digests, which is what it
 *   reads as though it does. The only false positive it actually prevents is a
 *   token whose FIRST group is 9+ hex (`deadbeefc-1234-…`), and it pays for that
 *   with residual 2. That trade is kept HERE for SCOPE, not because narrowing is
 *   impossible — an earlier draft of this paragraph claimed "every candidate
 *   narrowing needs a magic threshold on the length of the preceding hex run",
 *   and that universal is false. Measured against this exact pattern, with every
 *   fixture read as DATA out of scripts/ci/__tests__/deploy-retry.test.mjs:
 *   DELETING the lookbehind introduces no threshold of any kind, and it closes
 *   3 of the 5 residual-2 cases pinned there — `f<guid>`, `abcdef<guid>` and
 *   `uami-loom-directlake<guid>`. The 2 it leaves (`<guid>f`, `<guid>abc`) are
 *   the LOOKAHEAD's cost and are untouched by it. Its price is exactly 1 of the
 *   9 false-positive corpus rows: `abcdef11111111-2222-…`, a 14-hex first group.
 *
 *   That row is NOT independent evidence against narrowing, because the change
 *   that wrote this paragraph also added it — it is absent from the merge base
 *   608a36af and present here. Citing a fixture you introduced as the obstacle
 *   you cannot move is circular. So the honest statement is the narrow one:
 *   narrowing has a measured benefit (3 of 5) and a measured cost (one corpus
 *   row, which would have to be re-argued as a genuine non-GUID or dropped), and
 *   it is a BEHAVIOUR change to a redactor rather than a comment fix — so it is
 *   left to its own change with its own review rather than settled in passing.
 *
 *   Both residuals are pinned by their own named tests, so neither can drift
 *   back into being an unstated assumption.
 */
const GUID = String.raw`(?<![0-9a-fA-F])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F])`;

/**
 * Redact subscription / tenant ids and bare GUIDs, in place. IDEMPOTENT —
 * `<guid>` and `<redacted>` contain nothing this matches — which is what lets
 * the deploy lane redact at three stacked boundaries (composition site,
 * serialized artifact, issue poster) without mangling the diagnostic.
 *
 * THE CONTRACT IS "NEVER RETURNS A NON-STRING", NOT "PROTECTS YOU FROM ONE"
 * (#3829 round 4). This used to read `'' for a non-string, so a caller cannot
 * publish [object …]` — which both consumers falsify, because both call
 * `String()` FIRST (formatAnnotation(), formatStdout(), notifyFailure()). Under
 * those callers `notifyFailure({body:{msg:'…'}})` posts the literal
 * `[object Object]` and `body: undefined` posts `undefined`. That is the
 * intended behaviour — a visibly-wrong notice beats a silently-empty one — but
 * the docstring claimed a guarantee this function does not provide, and a
 * comment that contradicts its own callers is how the next reader gets it wrong.
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
