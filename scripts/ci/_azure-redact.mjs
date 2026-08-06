/**
 * _azure-redact.mjs — shared redaction for anything an Azure tool prints that
 * is about to reach a log annotation, a committed artifact, or a PR body.
 *
 * Extracted from deploy-retry.mjs so deploy-arm-errors.mjs applies the SAME
 * rule. Two copies of a redaction regex is one copy that stops being updated;
 * this repo's dominant defect class is exactly a control that has quietly
 * drifted from its twin (csa_loom_gates_that_measure_nothing).
 *
 * `_`-prefixed: a shared library, not a control — see the population rule in
 * scripts/ci/check-ci-guard-reachability.mjs.
 */

/**
 * Redact subscription / tenant GUIDs and long ARM ids down to their last path
 * segment. RAW captured stderr files are deliberately NOT passed through this —
 * it only stops full resource ids leaking into annotations and PR bodies.
 */
export function redact(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\/subscriptions\/[0-9a-fA-F-]{36}/g, '/subscriptions/<redacted>')
    .replace(/\/tenants?\/[0-9a-fA-F-]{36}/g, '/tenant/<redacted>')
    .replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<guid>');
}
