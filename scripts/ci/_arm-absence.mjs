/**
 * _arm-absence.mjs — is an `az` failure a DEFINITE ABSENCE, or did the read not
 * complete?
 *
 * `_`-prefixed: a shared library, not a control — see the population rule in
 * scripts/ci/check-ci-guard-reachability.mjs.
 *
 * WHY THIS IS SHARED RATHER THAN COPIED (#3754 review). Both estate preflights
 * on the sovereign deploy lanes have to answer the same question before they can
 * decide anything: "is this thing genuinely not there, or could I not look?"
 * They were written with TWO standards in one PR — resolve-dns-inbound-allocation
 * put the decision in a pure, exported, unit-tested function, and
 * ensure-adx-cluster-running left the equivalent decision inline in its I/O
 * shell, where it classified a MISSING RESOURCE GROUP as an unreadable control
 * plane. That hard-failed every greenfield apply on the lane, and told the
 * operator to "confirm the deploy service principal holds Reader" — a cause the
 * code had not established (deploy-integrity.md R7).
 *
 * Two copies of this rule is one copy that stops being updated; this repo's
 * dominant defect class is a control that quietly drifted from its twin
 * (csa_loom_gates_that_measure_nothing, and the guard-adoption gap where the
 * helper existed and the siblings never adopted it).
 *
 * MEASURED against live ARM (Commercial, 2026-08-18), because the exit code
 * alone does not carry the distinction:
 *
 *   $ az resource list -g rg-csa-loom-does-not-exist-3754 \
 *       --resource-type Microsoft.Kusto/clusters --query "[].id" -o json
 *   exit=3
 *   stdout: []                       <- note: a well-formed EMPTY LIST on stdout
 *   stderr: ERROR: (ResourceGroupNotFound) Resource group '…' could not be found.
 *
 *   CONTROL, same call against a real RG:
 *   $ az resource list -g rg-csa-loom-admin-centralus --resource-type Microsoft.Kusto/clusters …
 *   exit=0
 *   stdout: ["/subscriptions/…/providers/Microsoft.Kusto/clusters/adx-csa-loom-z52x3p"]
 *
 * So a caller that trusts stdout alone reads absence as "no clusters" and a
 * caller that trusts the exit code alone reads it as "unreadable". Neither is
 * right: the ERROR CODE is the only thing that separates them.
 */

/**
 * Signals that mean the resource genuinely is not there — as opposed to "I was
 * not allowed to look" or "the call did not complete".
 *
 * Kept deliberately NARROW: every string here is an ARM error CODE, not prose,
 * so a reworded message cannot widen the absence class. Adding an entry is a
 * deliberate act — widening this is how an RBAC denial becomes "greenfield" and
 * a deploy walks past the very state a preflight exists to catch.
 */
export const ABSENCE_CODES = [
  'ResourceNotFound',
  'ResourceGroupNotFound',
  'ParentResourceNotFound',
  'SubscriptionNotFound',
];

/**
 * PURE. The absence code present in this stderr, or null when the failure
 * establishes nothing about existence.
 *
 * @param {string} stderr raw stderr from a FAILED `az` invocation
 * @returns {string|null}
 */
export function definiteAbsenceCode(stderr) {
  const haystack = String(stderr ?? '').toLowerCase();
  return ABSENCE_CODES.find((code) => haystack.includes(code.toLowerCase())) ?? null;
}
