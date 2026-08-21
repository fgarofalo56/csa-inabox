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
 * consuming suite is small enough that such a cap would go unnoticed. Pinned by
 * a >5 KB test in scripts/ci/__tests__/deploy-retry.test.mjs.
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
 *   What it still does NOT match, deliberately: an undashed 32-hex run. ARM
 *   prints the blocking role-assignment id that way ("existing role assignment
 *   is 0a2b…"), and deploy-retry.mjs's planRemediation() reads it back out of
 *   the message to converge the grant automatically (#3439). Redacting it would
 *   disable a working auto-remediation to hide a value that is a resource NAME,
 *   not a principal id. Stated, not hidden, and pinned by its own test.
 */
const GUID = String.raw`(?<![0-9a-fA-F])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F])`;

/**
 * Redact subscription / tenant ids and bare GUIDs, in place. IDEMPOTENT —
 * `<guid>` and `<redacted>` contain nothing this matches — which is what lets
 * the deploy lane redact at three stacked boundaries (composition site,
 * serialized artifact, issue poster) without mangling the diagnostic.
 *
 * @param {unknown} text
 * @returns {string} '' for a non-string, so a caller cannot publish `[object …]`
 */
export function redact(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\/subscriptions\/[0-9a-fA-F-]{36}/g, '/subscriptions/<redacted>')
    .replace(/\/tenants?\/[0-9a-fA-F-]{36}/g, '/tenant/<redacted>')
    .replace(new RegExp(GUID, 'g'), '<guid>');
}
