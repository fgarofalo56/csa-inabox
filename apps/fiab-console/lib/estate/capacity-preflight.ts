/**
 * ESTATE PAUSE / RESUME — capacity preconditions and failure classification
 * (PRP §3, work item W3).
 *
 * ── THE MEASURED FACT THIS MODULE EXISTS FOR ───────────────────────────────
 * 2026-08-22, live, not hypothetical: the GCC-High ADX cluster had
 * `enableAutoStop: true`, stopped itself when idle, and then COULD NOT BE
 * RESTARTED:
 *
 *   (InsufficientResourcesForSubscription) [BadRequest] Currently there are no
 *   available resources to start the cluster with current SKU. Please choose
 *   different SKU
 *
 * **Azure does not reserve your capacity while a resource is stopped.** That is
 * the single most important way a raw Azure pause differs from pausing a Fabric
 * SKU, where Microsoft holds the capacity for you. A pause you cannot reverse
 * is not a pause; it is an outage you scheduled yourself.
 *
 * So this module does three things, and refuses to do a fourth:
 *
 *   1. R-CAP-1/3 — turn each pause candidate into a stated RESUME RISK, with
 *      its SKU and its declared fallback, so the operator sees it BEFORE the
 *      confirm rather than discovering it at resume time.
 *   2. R6 (deploy-integrity) — CLASSIFY an ARM failure (capacity / quota /
 *      permission / not-found / transient / configuration) and emit a concrete
 *      remediation, never a raw stack trace and never a generic "failed".
 *   3. R-CAP-4 — provide `assertNoFalseGreen`, a hard stop against the one
 *      outcome this whole program exists to prevent: an estate reported RUNNING
 *      while something in it is not confirmed up.
 *
 * What it deliberately does NOT do: apply the fallback SKU. R-CAP-2 (automatic
 * fallback on a capacity error) is explicitly out of scope for this slice. The
 * fallback is DECLARED, SURFACED, and recorded in the snapshot; applying it is
 * a later work item. Surfacing a fallback we do not apply is honest; applying
 * one silently would change the operator's SKU without being asked.
 */

import type { PausedResourceSnapshot, ResumeOutcome } from './pause-state';
import { isResumeSuccess } from './pause-state';
import type { EstateFallbackSku } from './pause-state';
import type { PauseCandidate } from './pause-inventory';

// ---------------------------------------------------------------------------
// Failure classification — deploy-integrity R6
// ---------------------------------------------------------------------------

/**
 * Why an ARM pause/resume verb failed.
 *
 * `unknown` is a real member, not a dumping ground: an unrecognised failure is
 * reported AS unrecognised, with the raw text preserved, rather than guessed
 * into the nearest familiar bucket. R7 — an error must not assert a cause the
 * code did not establish.
 */
export type ResumeFailureKind =
  /** No capacity in the region for this SKU. The ADX case above. */
  | 'capacity'
  /** Subscription/region quota refused the request (a limit, not scarcity). */
  | 'quota'
  /** The caller identity lacks the RBAC role. */
  | 'permission'
  /** The resource is not there any more. */
  | 'not-found'
  /** Throttling / gateway / timeout — retryable. */
  | 'transient'
  /** A malformed or conflicting request (wrong state, bad body). */
  | 'configuration'
  /** Not established. */
  | 'unknown';

/** True for the kinds a bounded retry can legitimately clear. */
export function isRetryable(kind: ResumeFailureKind): boolean {
  return kind === 'transient';
}

/**
 * Classify an ARM failure string.
 *
 * The capacity patterns come first and are matched on Azure's own error CODES
 * (`InsufficientResourcesForSubscription`, `SkuNotAvailable`,
 * `AllocationFailed`, `ZonalAllocationFailed`) rather than on prose, because
 * prose is localised and reworded and codes are not.
 */
export function classifyActuationFailure(raw: string | undefined | null): {
  kind: ResumeFailureKind;
  matched?: string;
} {
  const text = String(raw ?? '');
  if (!text.trim()) return { kind: 'unknown' };

  const patterns: Array<[ResumeFailureKind, RegExp]> = [
    ['capacity', /InsufficientResourcesForSubscription|SkuNotAvailable|AllocationFailed|ZonalAllocationFailed|OverconstrainedAllocationRequest|no available resources to start/i],
    ['quota', /QuotaExceeded|OperationNotAllowed.*quota|SubscriptionRequestsThrottled.*quota|exceeding approved .*quota|core quota/i],
    ['permission', /AuthorizationFailed|does not have authorization to perform action|Forbidden\b|\b403\b|LinkedAuthorizationFailed/i],
    ['not-found', /ResourceNotFound|ResourceGroupNotFound|ParentResourceNotFound|\b404\b/i],
    ['transient', /TooManyRequests|\b429\b|\b50[0234]\b|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|The operation was aborted|timed? ?out/i],
    ['configuration', /BadRequest|InvalidParameter|InvalidRequestContent|Conflict\b|\b409\b|\b400\b|is not in a valid state|OperationNotAllowed/i],
  ];

  for (const [kind, re] of patterns) {
    const m = re.exec(text);
    if (m) return { kind, matched: m[0] };
  }
  return { kind: 'unknown' };
}

/**
 * A concrete next step for a classified failure — deploy-integrity R6.
 *
 * Every branch names a specific action. None of them says "check the logs".
 */
export function remediationFor(
  kind: ResumeFailureKind,
  entry: Pick<PausedResourceSnapshot, 'name' | 'resourceType' | 'sku' | 'fallbackSku' | 'resourceGroup'>,
  rawError?: string,
): string {
  const sku = entry.sku?.name ? `'${entry.sku.name}'` : 'its recorded SKU';
  switch (kind) {
    case 'capacity':
      return (
        `The region has no capacity for ${entry.name} at ${sku} right now. Azure does not reserve `
        + 'capacity while a resource is stopped, so this is expected behaviour, not a Loom defect. '
        + (entry.fallbackSku?.name
          ? `The declared fallback for this resource is '${entry.fallbackSku.name}' — ${entry.fallbackSku.reason} `
            + 'Applying it is a manual step in this release (automatic fallback is a tracked follow-up); '
            + `set it on /admin/scaling and resume again.`
          : 'No fallback SKU is declared for this type. Retry later, or resume into a different region.')
      );
    case 'quota':
      return (
        `The subscription's quota refused the request for ${entry.name}. Raise the quota for this SKU `
        + 'family/region in the Azure portal (Subscription -> Usage + quotas), then resume again. '
        + 'This is a limit, not scarcity — a retry without a quota increase will fail identically.'
      );
    case 'permission':
      return (
        `The Console UAMI lacks the RBAC role needed to resume ${entry.name}. Grant it Contributor `
        + `(or the resource-specific operator role) on ${entry.name} in resource group `
        + `'${entry.resourceGroup}', then resume again. The identity is LOOM_UAMI_CLIENT_ID.`
      );
    case 'not-found':
      return (
        `${entry.name} no longer exists at the resource id recorded in the pause snapshot. It was `
        + 'deleted or moved while the estate was paused. The snapshot records its SKU and settings; '
        + 'redeploy it from bicep, then resume. Loom will NOT recreate it silently.'
      );
    case 'transient':
      return (
        `ARM throttled or timed out on ${entry.name}. This is retryable: press Resume again. If it `
        + 'persists past a few attempts it is not transient and the classification is wrong — report '
        + 'the raw error.'
      );
    case 'configuration':
      return (
        `ARM rejected the resume of ${entry.name} as invalid for its current state — most often the `
        + 'resource is already mid-transition (Resuming/Scaling). Wait for the in-flight operation to '
        + 'finish and resume again; if it is genuinely stuck, check its state on /admin/scaling.'
      );
    case 'unknown':
    default:
      return (
        `The failure on ${entry.name} did not match any known Azure error class, so its cause has NOT `
        + 'been established. The raw ARM response is preserved verbatim'
        + (rawError ? `: ${rawError.slice(0, 400)}` : '')
        + '. Do not treat this as transient without evidence.'
      );
  }
}

// ---------------------------------------------------------------------------
// R-CAP-1 / R-CAP-3 — the pre-pause risk statement
// ---------------------------------------------------------------------------

export interface ResumeRisk {
  resourceId: string;
  name: string;
  resourceType: string;
  /** The SKU that must be RE-ACQUIRED on resume. */
  sku?: string;
  /** True when re-acquiring that capacity can fail. */
  capacityConstrained: boolean;
  /** 'high' when capacity-constrained; 'low' when resume does not contend. */
  risk: 'high' | 'low';
  /** R-CAP-1 — what a later release would fall back to. Declared, not applied. */
  fallbackSku?: EstateFallbackSku;
  /** The sentence shown next to the resource in the confirm dialog. */
  statement: string;
}

/**
 * R-CAP-3 — state the resume risk for every resource, BEFORE the pause.
 *
 * A `high` row is not a blocker. It is a disclosure: this resource releases a
 * dedicated SKU, and Azure may not have that SKU free when you want it back.
 * The operator gets to decide with that in front of them, which is the whole
 * difference between an informed pause and the ADX incident.
 */
export function capacityPreflight(candidates: readonly PauseCandidate[]): ResumeRisk[] {
  return candidates.map((c) => {
    const constrained = c.spec.capacityConstrained;
    const sku = undefined; // the live SKU is read at pause time; the spec is type-level.
    return {
      resourceId: c.resource.resourceId,
      name: c.resource.name,
      resourceType: c.resource.resourceType,
      ...(sku ? { sku } : {}),
      capacityConstrained: constrained,
      risk: constrained ? ('high' as const) : ('low' as const),
      ...(c.fallbackSku ? { fallbackSku: c.fallbackSku } : {}),
      statement: constrained
        ? `${c.resource.name} (${c.spec.label}) releases a dedicated SKU. Azure does not reserve it `
          + 'while stopped, so a resume can fail with a capacity error until the region has room. '
          + (c.fallbackSku?.name
            ? `Declared fallback: ${c.fallbackSku.name}.`
            : 'No fallback is declared for this type.')
        : `${c.resource.name} (${c.spec.label}) does not hold a dedicated capacity reservation, so a `
          + 'resume does not contend for regional capacity.',
    };
  });
}

/** Count of high-risk rows — what the confirm dialog's warning bar keys off. */
export function highRiskCount(risks: readonly ResumeRisk[]): number {
  return risks.filter((r) => r.risk === 'high').length;
}

// ---------------------------------------------------------------------------
// R-CAP-4 — the false-green guard
// ---------------------------------------------------------------------------

/**
 * Thrown when something tries to report an estate RUNNING while a resource in
 * it is not confirmed running. Distinct class so a caller can never catch it by
 * accident alongside an ARM error.
 */
export class FalseGreenError extends Error {
  readonly unconfirmed: ResumeOutcome[];
  constructor(unconfirmed: ResumeOutcome[], headline?: string) {
    super(
      `Refusing to report the estate RUNNING: `
        + (headline
          ? `${headline} `
          : `${unconfirmed.length} resource(s) were not CONFIRMED running `
            + `(${unconfirmed.map((u) => `${u.resourceId} -> ${u.confirmation}`).join('; ')}). `)
        + 'An unconfirmed resume is RESUME_FAILED, not a success.',
    );
    this.name = 'FalseGreenError';
    this.unconfirmed = unconfirmed;
  }
}

/**
 * R-CAP-4, enforced rather than reviewed.
 *
 * The rule is one line, and the reason it is a FUNCTION rather than a comment is
 * that a comment cannot fail a test. Any code path that claims RUNNING passes
 * through here with the outcomes it based that claim on; if any of them is not a
 * SUCCESS, it throws.
 *
 * "Success" is `isResumeSuccess()`, never a hand-rolled string comparison. The
 * success set has TWO members — `confirmed-running` and
 * `confirmed-restored-paused` — and getting that wrong fails in both
 * directions: the old single-member enum painted a stopped resource green, and
 * comparing against `confirmed-running` alone under the new names would mark a
 * legitimately-restored-paused resource as FAILED. The helper is exported by
 * `pause-state` precisely so no consumer can drift from `deriveResumeState`.
 *
 * The empty-outcomes case matters and is handled explicitly. `[].every(...)` is
 * vacuously TRUE, so a confirmation loop that ran zero times would otherwise
 * launder "we checked nothing" into "everything is fine" — the zero-population
 * defect this repo has now hit in several different guards. Here, zero outcomes
 * against a non-empty resource list is a refusal.
 */
export function assertNoFalseGreen(
  state: string,
  outcomes: readonly ResumeOutcome[],
  expectedResourceCount: number,
): void {
  if (state !== 'RUNNING') return;
  if (expectedResourceCount === 0) return; // nothing was ever paused
  if (outcomes.length === 0) {
    throw new FalseGreenError(
      [
        {
          resourceId: '(none)',
          confirmation: 'unknown',
          reason:
            `RUNNING was claimed with ZERO confirmation outcomes against ${expectedResourceCount} `
            + 'paused resource(s). Nothing was checked, so nothing was established.',
        },
      ],
      `ZERO confirmation outcomes were supplied against ${expectedResourceCount} paused resource(s). `
        + 'Nothing was checked, so nothing was established.',
    );
  }
  const unconfirmed = outcomes.filter((o) => !isResumeSuccess(o.confirmation));
  if (unconfirmed.length > 0) throw new FalseGreenError([...unconfirmed]);
}

/**
 * The operator-facing summary for a finished resume attempt.
 *
 * Deliberately blunt on the failure path: it names the resources, their
 * classification and their remediation, because "resume failed" with no subject
 * is the message that sent two separate investigations down the wrong path on
 * 2026-08-05.
 */
export function summarizeResume(
  state: 'RUNNING' | 'RESUME_FAILED' | 'RESUMING',
  outcomes: readonly ResumeOutcome[],
  snapshotResources: readonly PausedResourceSnapshot[],
): { headline: string; details: Array<{ resourceId: string; kind: ResumeFailureKind; remediation: string }> } {
  if (state === 'RUNNING') {
    return {
      headline:
        `All ${snapshotResources.length} resource(s) are confirmed back up — each one verified by an `
        + 'authoritative ARM read AND a real request to the service.',
      details: [],
    };
  }
  const byId = new Map(snapshotResources.map((r) => [r.resourceId, r]));
  const details = outcomes
    .filter((o) => !isResumeSuccess(o.confirmation))
    .map((o) => {
      const entry = byId.get(o.resourceId);
      const { kind } = classifyActuationFailure(o.reason);
      return {
        resourceId: o.resourceId,
        kind,
        remediation: entry
          ? remediationFor(kind, entry, o.reason)
          : `${o.resourceId} is not in the snapshot, so no remediation could be derived. ${o.reason}`,
      };
    });

  return {
    headline:
      state === 'RESUMING'
        ? `${details.length} of ${snapshotResources.length} resource(s) are still coming back. Nothing `
          + 'has failed yet — the published resume window has not elapsed.'
        : `${details.length} of ${snapshotResources.length} resource(s) are NOT confirmed running. The `
          + 'estate is RESUME_FAILED. This is not a display state: those resources are unusable until '
          + 'the remediation below is applied.',
    details,
  };
}
