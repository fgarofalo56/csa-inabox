/**
 * identity-enforce-review — I9 AppSec sign-off status for the I6 enforcement gate.
 *
 * The I9 threat model (docs/fiab/security/loom-next-level-threat-model.md) is the
 * AUTHORITATIVE artifact; its §8 makes I6 (flip a workspace to
 * `LOOM_WORKSPACE_IDENTITY_MODE=enforce`) conditional on BOTH:
 *   (1) a completed, NAMED AppSec-reviewer sign-off (§9), and
 *   (2) zero open HIGH findings (§9.1 — HIGH blocks I6 until dispositioned).
 * The doc's §8.3 adds the operational gate (zero unresolved shadow divergence),
 * which the I6 route/panel enforce separately from the I4 rollup.
 *
 * This module surfaces the (1)+(2) verdict to the I6 admin Identity panel and the
 * enforce-route POST guard as a structured value — the doc is the source of truth,
 * mirrored here in lock-step. The threat-model §9 records the review DATE, the
 * reviewed surfaces (S-1..S-8), and every finding's disposition; at the time of
 * writing the sole HIGH (F-1) is `fixed`, so {@link IDENTITY_ENFORCE_OPEN_HIGH} is 0.
 *
 * The NAMED human reviewer is deliberately an ESTATE / ATO attestation (§9 literal:
 * "record name + role at review"): the accountable AppSec reviewer differs per
 * deployment and is recorded by the operator through the OPTIONAL
 * `LOOM_IDENTITY_ENFORCE_REVIEW_SIGNOFF` value ("Name, Role, YYYY-MM-DD"). It is an
 * operator ATTESTATION, NOT a service-config gate — so it is intentionally absent
 * from ENV_CHECKS / the editable-env whitelist (per the I6 "no NEW env var" scope;
 * the per-workspace enforce flag is data on the doc). Until the operator records
 * that named sign-off in their estate, the review is NOT signed off and the I6
 * Enable button stays disabled — enforcement is operator-gated by design.
 */

/** The I9 threat-model artifact this verdict is sourced from (repo-relative). */
export const IDENTITY_THREAT_MODEL_DOC =
  'docs/fiab/security/loom-next-level-threat-model.md';

/** §9 review date recorded in the threat model. */
export const IDENTITY_ENFORCE_REVIEW_DATE = '2026-07-23';

/**
 * Count of HIGH findings in §9.1 still `open` (NOT fixed/mitigated/accepted).
 * A HIGH finding blocks I6 until dispositioned (§8.2). Kept in lock-step with the
 * doc: the sole HIGH (F-1, L2 forged provenance) is `fixed` (F2 redesign #2448),
 * so this is 0. Bump this the instant a new open HIGH lands and the gate re-closes.
 */
export const IDENTITY_ENFORCE_OPEN_HIGH = 0;

/** The operator attestation env var (optional; NOT a registered service gate). */
export const IDENTITY_ENFORCE_SIGNOFF_ENV = 'LOOM_IDENTITY_ENFORCE_REVIEW_SIGNOFF';

export interface IdentityEnforceReview {
  /** True ⇔ a named reviewer sign-off is recorded AND zero open HIGH findings. */
  signedOff: boolean;
  /** The named AppSec reviewer + role/date, when the estate has attested it. */
  reviewer?: string;
  /** §9 review date from the threat model. */
  reviewDate: string;
  /** Program / item this sign-off covers. */
  program: string;
  /** Repo-relative path to the authoritative threat-model artifact. */
  docPath: string;
  /** Open HIGH findings still blocking I6 (0 when all HIGH are dispositioned). */
  openHighFindings: number;
  /** Human reason when NOT signed off — for the panel status line + POST refusal. */
  reason?: string;
}

/**
 * The current I9 sign-off verdict for I6 enforcement. Pure + synchronous (reads
 * only process env + the doc-mirrored constants); NEVER throws.
 */
export function identityEnforceReview(): IdentityEnforceReview {
  const attest = (process.env[IDENTITY_ENFORCE_SIGNOFF_ENV] || '').trim();
  const reviewer = attest || undefined;
  const openHighFindings = IDENTITY_ENFORCE_OPEN_HIGH;
  const namedSignoff = !!reviewer;
  const signedOff = namedSignoff && openHighFindings === 0;

  let reason: string | undefined;
  if (openHighFindings > 0) {
    reason =
      `${openHighFindings} open HIGH finding(s) in the I9 threat model block enforcement ` +
      `until dispositioned (${IDENTITY_THREAT_MODEL_DOC} §9.1).`;
  } else if (!namedSignoff) {
    reason =
      'The I9 AppSec review is not signed off in this estate. Complete the §9 sign-off in ' +
      `${IDENTITY_THREAT_MODEL_DOC} and record the named reviewer via ` +
      `${IDENTITY_ENFORCE_SIGNOFF_ENV} ("Name, Role, YYYY-MM-DD") before enabling enforcement.`;
  }

  return {
    signedOff,
    reviewer,
    reviewDate: IDENTITY_ENFORCE_REVIEW_DATE,
    program: 'loom-next-level Section I — per-workspace identity (I9 AppSec gate)',
    docPath: IDENTITY_THREAT_MODEL_DOC,
    openHighFindings,
    reason,
  };
}
