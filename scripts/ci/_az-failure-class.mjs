/**
 * _az-failure-class.mjs — what did a FAILED `az` invocation actually establish?
 *
 * `_`-prefixed: a shared library, not a control — see the population rule in
 * scripts/ci/check-ci-guard-reachability.mjs.
 *
 * ── WHY THIS EXISTS (#3786) ─────────────────────────────────────────────────
 *
 * MEASURED, `deploy-fiab-commercial` run 32700023215 (2026-08-24, scheduled),
 * step "ADX preflight". The step enumerated the admin RG successfully, got the
 * cluster id back, then failed reading that same cluster. Its raw az stderr:
 *
 *   ERROR: (GatewayTimeout) GatewayTimeout
 *   Code: GatewayTimeout
 *   Message: GatewayTimeout
 *
 * and the error it printed told the operator to
 *
 *   "grant the deploy service principal Reader (or Azure Kusto Contributor)"
 *
 * — a cause the code had NOT established. ARM answers an RBAC denial with
 * `AuthorizationFailed`/403, never `GatewayTimeout`, and the SAME identity had
 * listed `Microsoft.Kusto/clusters` in that RG seconds earlier, which requires
 * the very read the message claimed was missing. That is deploy-integrity.md
 * R7, and it is the third time this repo has paid for it (the 2026-08-05 roll
 * that reported "the tag does not exist" for "I could not reach the registry",
 * and the `classifyClusterListRead` message #3754 already fixed).
 *
 * MEASURED, `deploy-fiab-gcch` run 32716865363 (2026-08-24), same step, and a
 * DIFFERENT cause behind the same leaf:
 *
 *   ERROR: (InsufficientResourcesForSubscription) [BadRequest] Currently there
 *   are no available resources to start the cluster with current SKU.
 *
 * That one is neither transient nor a permission problem — it is CAPACITY, and
 * no classifier in this repo had a name for it, so it would have fallen to
 * `unknown` and been reported with whatever remediation the call site hard-coded.
 *
 * ── WHY SHARED RATHER THAN A THIRD COPY ─────────────────────────────────────
 *
 * `resolve-automation-oid.mjs` and `bootstrap-admin-principal.mjs` already carry
 * a near-identical TRANSIENT/DENIED/NOT_FOUND trio, and the former's own comment
 * says they are "kept identical in spirit … Drift between twin classifiers is
 * csa_loom_guard_adoption_gap in miniature." A third inline copy is how that gap
 * gets wider, so this follows the `_arm-absence.mjs` precedent instead.
 *
 * SCOPE, stated rather than assumed: this classifies the **ARM / az-CLI** error
 * surface. The two prior copies are NOT folded in here, deliberately — the
 * Graph-facing one in `bootstrap-admin-principal.mjs` matches
 * `Request_ResourceNotFound` and `Authorization_RequestDenied`, which are Graph
 * codes with no ARM equivalent, so a single merged NOT_FOUND/DENIED set would
 * silently change how one of them classifies a real failure. Unifying them is a
 * behaviour change that needs its own measurement, not a drive-by in a P0.
 */

/**
 * ── THE STATUS-TOKEN ANCHOR, DEFINED ONCE ───────────────────────────────────
 *
 * A bare HTTP status in an ARM message is only meaningful as a STANDALONE
 * token. `\b` does not express that, because `\b` treats `-` as a boundary — so
 * `\b503\b` matches inside a resource group named `rg-loom-503`.
 *
 * WHY THIS IS A SHARED FRAGMENT AND NOT THREE REGEX LITERALS (#4013 review).
 * The first fix anchored ONE of the three alternations. TRANSIENT got the
 * anchor; `DENIED`'s `\b40[13]\b` and `NOT_FOUND`'s `\b404\b` kept the old
 * form — and because that same commit promoted DENIED to first, it made the
 * defect WORSE, not better. Measured on the exact 2026-08-24 stderr:
 *
 *   (GatewayTimeout) over an RG named `rg-loom-403`   -> denied    (was transient)
 *   (GatewayTimeout) over an RG named `rg-404-archive`-> notfound  (was transient)
 *   (InsufficientResources…) on a cluster `adx-401`   -> denied    (was capacity)
 *
 * The first of those prints "This one IS a permission problem, and az named it:
 * grant Reader …" — the original defect restored verbatim and more emphatic,
 * with the R6 retry lost as well, because `denied` is not retryable.
 *
 * Three literals meant three chances to half-fix and three to half-revert. One
 * fragment means the anchor is either right everywhere or wrong everywhere, and
 * a test that pins it pins all three.
 *
 * BOTH HALVES ARE LOAD-BEARING, and each is pinned by its own fixture:
 *   - drop the LOOKBEHIND and a trailing token reopens: `rg-loom-503`
 *   - drop the LOOKAHEAD  and a leading token reopens:  `503117`, `503Error`
 * (The earlier fixtures — `rg-loom-503-hub`, `-503a-` — are blocked by EITHER
 * anchor alone, so they could not discriminate a half-revert and the comment
 * claiming "both halves matter" was not established by them.)
 */
export const STATUS_TOKEN_LOOKBEHIND = '(?<![\\w-])';
export const STATUS_TOKEN_LOOKAHEAD = '(?![\\w-])';

/** A status-shaped alternation that only matches as a standalone token. */
export const statusToken = (alternation) =>
  `${STATUS_TOKEN_LOOKBEHIND}(?:${alternation})${STATUS_TOKEN_LOOKAHEAD}`;

/**
 * Signals that mean "try again", not "the answer is no".
 *
 * `timed? ?out` matches `Timeout` (t-i-m + e + no `d` + no space + o-u-t), so
 * `GatewayTimeout` is covered by the shared idiom — but the ARM codes are listed
 * explicitly anyway, because a classifier that only works by accident is one
 * reword away from not working.
 *
 * `502 Bad Gateway`, `(503)` and `status code: 429` still match; `rg-loom-503`,
 * `weave-503-x` and a GUID segment like `-503a-` do not.
 */
export const TRANSIENT = new RegExp(
  [
    statusToken('429|500|502|503|504'),
    'too many requests',
    'timed? ?out',
    'temporarily unavailable',
    'connection (reset|aborted)',
    'ServiceUnavailable',
    'GatewayTimeout',
    'RequestTimeout',
    'SubscriptionRequestsThrottled',
    'TooManyRequests',
  ].join('|'),
  'i',
);

/**
 * Signals that the CALLER was refused. This is an UNKNOWN answer about the
 * resource, never a negative one — the distinction `_arm-absence.mjs` exists to
 * protect.
 */
export const DENIED = new RegExp(
  [
    'AuthorizationFailed',
    'LinkedAuthorizationFailed',
    'Authorization_RequestDenied',
    'Insufficient privileges',
    'does not have authorization',
    statusToken('40[13]'),
    'Forbidden',
    'Unauthorized',
    'AADSTS',
  ].join('|'),
  'i',
);

/**
 * Signals that the platform cannot satisfy the request at this SKU / region /
 * quota right now. Kept to ARM error CODES plus the one verbatim phrase the
 * Kusto RP returns, per the `_arm-absence.mjs` doctrine: prose widens, codes do
 * not. A bare /capacity/i is deliberately NOT here — "capacity" is Fabric
 * vocabulary all over this repo and would misclassify unrelated failures.
 */
export const CAPACITY =
  /InsufficientResourcesForSubscription|SkuNotAvailable|AllocationFailed|QuotaExceeded|there are no available resources/i;

/** Signals the resource genuinely is not there. Mirrors `_arm-absence.mjs`. */
export const NOT_FOUND = new RegExp(
  [
    'ResourceNotFound',
    'ResourceGroupNotFound',
    'ParentResourceNotFound',
    'SubscriptionNotFound',
    'could not be found',
    'was not found',
    statusToken('404'),
  ].join('|'),
  'i',
);

/**
 * PURE. Classify an `az` failure into one of the things it can mean.
 *
 * ORDER IS LOAD-BEARING, and it is ordered by how DEFINITE each signal is: an
 * explicit ARM error code beats a phrase that can appear incidentally anywhere
 * in a long message (a status-shaped number, "temporarily unavailable", "could
 * not be found"). Every one of these orderings has a discriminating fixture in
 * estate-preflight.test.mjs — an ordering that is load-bearing and untested is
 * the same defect class as the hardcoded remediation this file exists to end,
 * and all three escaped a mutation before those fixtures were added.
 *
 *  1. DENIED   — a refusal is NEVER resolved by a retry, and it is the one class
 *                where getting it wrong tells the operator the opposite of the
 *                truth. `LinkedAuthorizationFailed … could not be found` is a
 *                denial, not an absence (that input flips if NOT_FOUND wins).
 *  2. CAPACITY — explicit codes. `SkuNotAvailable … temporarily unavailable` is
 *                capacity, not transient (that input flips if TRANSIENT wins),
 *                and retrying a region that is out of capacity for 50s produces
 *                a misleading "transient, gave up" story instead of the real one.
 *  3. NOT_FOUND— explicit ARM absence codes.
 *  4. TRANSIENT— last, because it is the class whose signals are most easily
 *                produced incidentally by surrounding text.
 *
 * `unknown` is deliberately its own outcome, and an EMPTY stderr must reach it:
 * a failure that said nothing establishes nothing. Reporting an unclassified
 * failure as any of the named causes is the R7 violation this file exists to end.
 *
 * @param {string} stderr raw stderr from a FAILED `az` invocation
 * @returns {'capacity'|'transient'|'denied'|'notfound'|'unknown'}
 */
export function classifyAzFailure(stderr) {
  const s = String(stderr ?? '');
  if (DENIED.test(s)) return 'denied';
  if (CAPACITY.test(s)) return 'capacity';
  if (NOT_FOUND.test(s)) return 'notfound';
  if (TRANSIENT.test(s)) return 'transient';
  return 'unknown';
}

/** Only a genuinely transient failure earns a retry. */
export function isRetryable(kind) {
  return kind === 'transient';
}

/**
 * PURE. The remediation for a classified failure, in the operator's terms.
 *
 * Every branch says what was ESTABLISHED and what was not. The `unknown` branch
 * in particular refuses to name a cause: it points at the raw stderr, which is
 * the only thing that ran.
 *
 * @param {'capacity'|'transient'|'denied'|'notfound'|'unknown'} kind
 * @param {string} scopeId the ARM id the failing call targeted
 * @param {number} [attempts] how many times a transient failure was retried
 * @returns {string}
 */
export function remediationFor(kind, scopeId, attempts = 0) {
  switch (kind) {
    case 'transient':
      return (
        `az did not complete the call in ${attempts} attempt(s), and the last failure carried a ` +
        'transient signal (the raw error below is what it said). Re-run this workflow. ' +
        'THE LIMIT OF WHAT THIS ESTABLISHES: the call did not complete. This step did not test ' +
        "the deploy identity's permissions, the SKU's capacity, or the resource's existence, so " +
        'none of those is ruled out — if a re-run fails the same way, read the raw error rather ' +
        'than assuming the cause is Azure-side.'
      );
    case 'denied':
      return (
        `the deploy service principal was REFUSED on ${scopeId}. This one IS a permission problem, ` +
        'and az named it: grant Reader (to read state) or Azure Kusto Contributor / Contributor (to ' +
        'start the cluster) at that scope.'
      );
    case 'capacity':
      return (
        `Azure has NO CAPACITY for this cluster's current SKU in this region, so no retry and no role ` +
        'grant will resolve it. This is not a defect in the deploy. Either pick a SKU that has ' +
        'capacity in the region (adx-cluster.bicep `adxSku`), deploy the cluster to a region that ' +
        'does, or wait for capacity to free up and re-run. The raw az error below names the SKU.'
      );
    case 'notfound':
      return (
        `ARM reports the target does not exist at ${scopeId}. If this is a greenfield subscription ` +
        'the template creates it, and a freshly created cluster is Running — so this step should not ' +
        'have reached a per-cluster read at all. Treat a not-found HERE as a real inconsistency.'
      );
    default:
      return (
        'az failed with an error this step does NOT recognise, so NO cause is asserted — not ' +
        'permissions, not capacity, not a transient blip. The raw az stderr below is the only thing ' +
        'that was established; read it before acting on any hypothesis.'
      );
  }
}
