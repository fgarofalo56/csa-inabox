/**
 * DP-5 — data-product certification pipeline (PURE engine).
 *
 * A real certification lifecycle — **draft → validated → certified** — where the
 * jump to *certified* is GATED by live automated checks plus an explicit human
 * sign-off from a reviewer distinct from the creator, not a one-time boolean
 * toggle. This module is the framework-free, I/O-free scoring core: the BFF
 * route gathers the live inputs (assets, glossary/CDEs, DQ score, contract,
 * access policy, owner, sample data) and calls `evaluateCertification()`; the UI
 * renders the returned per-check rows (red/green + "what's missing") and gates
 * the Certify button on `certifiable`.
 *
 * Grounding: Power BI two-tier endorsement (Promoted = lightweight signal /
 * Certified = authoritative, reviewer-gated, certifier identity shown —
 * https://learn.microsoft.com/power-bi/collaborate-share/service-endorsement-overview);
 * Purview health-score control groups (Discoverability / Trusted data / Metadata
 * quality — https://learn.microsoft.com/purview/unified-catalog-controls); ODCS
 * schedulable SLA tests as the "continuously-verified" bar. Azure-native: every
 * input is a real Cosmos/ADX signal, no Fabric/Power BI dependency.
 */

/** The certification lifecycle, orthogonal to the publish lifecycle (a product
 *  can be published-but-not-certified, or certified-but-access-gated). */
export type CertificationState = 'draft' | 'validated' | 'certified';

/** The two-rung endorsement ladder shown at the point of discovery. */
export type EndorsementRung = 'none' | 'promoted' | 'certified';

/** Stable ids for each automated check (used by the UI + tests). */
export type CertCheckId =
  | 'owner'
  | 'description'
  | 'glossary'
  | 'assets'
  | 'dq'
  | 'slo'
  | 'contract'
  | 'access'
  | 'sample';

export interface CertCheck {
  id: CertCheckId;
  label: string;
  /** Passed against live data. */
  pass: boolean;
  /** Whether this check counts toward the `validated` rung (the minimal bar). */
  forValidated: boolean;
  /** Human "what's missing" remediation when `pass` is false (green detail when true). */
  detail: string;
}

/** Live inputs gathered by the BFF from Cosmos + the DQ engine. */
export interface CertificationInputs {
  ownerCount: number;
  descriptionLength: number;
  useCaseLength: number;
  glossaryCount: number;
  cdeCount: number;
  assetCount: number;
  /** Real DQ score 0–100, or null when no DQ rules are configured (honest-gate). */
  dqScore: number | null;
  /** Number of declared SLO targets on the contract. */
  sloCount: number;
  /** Contract present with at least one schema column. */
  hasContractSchema: boolean;
  /** An access policy is configured OR the product is explicitly self-serve. */
  accessConfigured: boolean;
  /** A persisted sample dataset exists (DP-12); false honest-gates the check. */
  hasSampleData: boolean;
}

/** Minimum bars (documented so the UI and tests agree). */
export const CERT_THRESHOLDS = {
  descriptionMin: 40,
  useCaseMin: 20,
  dqScoreMin: 70,
} as const;

export interface CertificationEvaluation {
  checks: CertCheck[];
  /** 0–100 = passed checks / total, rounded. */
  score: number;
  /** All `forValidated` checks pass → eligible for the `validated` rung. */
  validated: boolean;
  /** EVERY check passes → eligible to be certified (still needs a human sign-off). */
  certifiable: boolean;
}

/** Evaluate all automated checks against live inputs. Pure + deterministic. */
export function evaluateCertification(i: CertificationInputs): CertificationEvaluation {
  const checks: CertCheck[] = [
    {
      id: 'owner', label: 'Owner assigned', forValidated: true,
      pass: i.ownerCount > 0,
      detail: i.ownerCount > 0 ? `${i.ownerCount} owner(s) assigned.` : 'Add at least one owner (Basic step).',
    },
    {
      id: 'description', label: 'Description + use case', forValidated: true,
      pass: i.descriptionLength >= CERT_THRESHOLDS.descriptionMin && i.useCaseLength >= CERT_THRESHOLDS.useCaseMin,
      detail: i.descriptionLength >= CERT_THRESHOLDS.descriptionMin && i.useCaseLength >= CERT_THRESHOLDS.useCaseMin
        ? 'Description and use case meet the minimum bar.'
        : `Description needs ≥ ${CERT_THRESHOLDS.descriptionMin} chars (have ${i.descriptionLength}) and use case ≥ ${CERT_THRESHOLDS.useCaseMin} (have ${i.useCaseLength}).`,
    },
    {
      id: 'glossary', label: 'Glossary term or CDE linked', forValidated: true,
      pass: i.glossaryCount + i.cdeCount > 0,
      detail: i.glossaryCount + i.cdeCount > 0
        ? `${i.glossaryCount} glossary term(s), ${i.cdeCount} CDE(s) linked.`
        : 'Link at least one glossary term or critical data element.',
    },
    {
      id: 'assets', label: 'Data asset attached', forValidated: true,
      pass: i.assetCount > 0,
      detail: i.assetCount > 0 ? `${i.assetCount} asset(s) attached.` : 'Attach at least one data asset (Datasets tab).',
    },
    {
      id: 'contract', label: 'Data contract defined', forValidated: true,
      pass: i.hasContractSchema,
      detail: i.hasContractSchema ? 'Contract schema is defined.' : 'Define the output contract schema (Contract tab).',
    },
    {
      id: 'dq', label: `Data-quality score ≥ ${CERT_THRESHOLDS.dqScoreMin}`, forValidated: false,
      pass: i.dqScore !== null && i.dqScore >= CERT_THRESHOLDS.dqScoreMin,
      detail: i.dqScore === null
        ? 'No DQ score yet — configure DQ rules and run the contract-quality enforcement (ADX).'
        : i.dqScore >= CERT_THRESHOLDS.dqScoreMin
          ? `DQ score ${i.dqScore} meets the ${CERT_THRESHOLDS.dqScoreMin} bar.`
          : `DQ score ${i.dqScore} is below the ${CERT_THRESHOLDS.dqScoreMin} bar.`,
    },
    {
      id: 'slo', label: 'SLOs declared', forValidated: false,
      pass: i.sloCount > 0,
      detail: i.sloCount > 0 ? `${i.sloCount} SLO target(s) declared.` : 'Declare freshness/availability SLO targets (Contract tab).',
    },
    {
      id: 'access', label: 'Access policy configured', forValidated: false,
      pass: i.accessConfigured,
      detail: i.accessConfigured ? 'Access policy set (or explicitly self-serve).' : 'Configure an access policy, or mark the product self-serve.',
    },
    {
      id: 'sample', label: 'Sample data available', forValidated: false,
      pass: i.hasSampleData,
      detail: i.hasSampleData ? 'Sample dataset is available for try-before-subscribe.' : 'Publish a sample dataset (try-before-subscribe).',
    },
  ];

  const passed = checks.filter((c) => c.pass).length;
  const score = Math.round((passed / checks.length) * 100);
  const validated = checks.filter((c) => c.forValidated).every((c) => c.pass);
  const certifiable = checks.every((c) => c.pass);
  return { checks, score, validated, certifiable };
}

/** Persisted certification metadata on `state.certification`. */
export interface CertificationRecord {
  state: CertificationState;
  /** Last computed automated score (0–100). */
  score: number;
  /** Reviewer identity for a `certified` product (never the creator). */
  certifiedBy?: { oid: string; name?: string };
  /** ISO-8601 sign-off timestamp. */
  certifiedAt?: string;
  /** ISO-8601 of the last automated re-evaluation. */
  checkedAt?: string;
}

/**
 * Derive the certification STATE from the live evaluation + any existing sign-off.
 * A prior `certified` record is DOWNGRADED to `validated` when the automated
 * checks no longer all pass (score drop) — the no-vaporware "continuously
 * verified" bar, never a stale badge.
 */
export function deriveCertificationState(
  evaluation: CertificationEvaluation,
  existing?: Pick<CertificationRecord, 'state' | 'certifiedBy' | 'certifiedAt'>,
): CertificationState {
  const signedOff = !!existing?.certifiedBy && existing.state === 'certified';
  if (signedOff && evaluation.certifiable) return 'certified';
  if (evaluation.validated) return 'validated';
  return 'draft';
}

/**
 * Resolve the discovery-time endorsement rung from the certification state and
 * the lightweight `endorsed`/legacy `certified` promoted signal. `certified`
 * (reviewer-gated) outranks `promoted` (any editor).
 */
export function resolveEndorsement(opts: {
  certificationState?: CertificationState;
  endorsed?: boolean;
  legacyCertified?: boolean;
}): EndorsementRung {
  if (opts.certificationState === 'certified') return 'certified';
  if (opts.endorsed || opts.legacyCertified) return 'promoted';
  return 'none';
}
