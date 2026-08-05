/**
 * plan-model — the DeploymentPlan: the operator's adopt-or-create decisions as a
 * first-class, persisted, immutable artifact.
 *
 * WHY THIS EXISTS
 * ---------------
 * The wizard already collected real choices from a real cross-subscription
 * Resource Graph scan. Those choices then reached the deploy at EXACTLY ONE call
 * site — `app/api/setup/deploy/route.ts` line 987 — inside the HTTP-503
 * copy-paste block. So on every tier that actually deploys, "use my existing
 * Purview" was discarded, and the deployment attempted a second Purview account
 * (which fails the whole deploy with EnterpriseTenantAlreadyExists).
 *
 * The fix is not another parameter list. It is one artifact that:
 *   - survives every deploy tier (ARM PUT, orchestrator, GitHub dispatch, CLI),
 *   - is persisted, so /admin/deployment can diff it against the live estate,
 *   - is immutable, so an edit produces a new plan that supersedes the old one
 *     rather than silently mutating the record of what the estate should be.
 *
 * IMMUTABILITY. A plan is written once. `supersede()` produces the next one.
 * That is what makes reconcile possible: the plan is the record of what the
 * estate is SUPPOSED to be, and drift is the diff against it.
 */

import { createHash } from 'node:crypto';

import { canAdopt, canCreate, getServiceDef } from './adoption-catalog';
import type { FitnessResult } from './fitness';

export type DeploymentBoundary = 'commercial' | 'gcc' | 'gcch' | 'il5';
export type DeploymentTopology = 'single-sub' | 'tenant' | 'dlz-attach';

export type AdoptionMode = 'adopt' | 'create' | 'skip';

/**
 * Per-subscription scan coverage.
 *
 * Built from the REQUESTED subscription list, never inferred from results. The
 * shipped `discover-services` route computed `subscriptionsScanned` from matched
 * rows only, so an operator with 12 subscriptions and hits in 2 was told "2
 * scanned" — an untrue statement about coverage.
 *
 * `matchedResources: 0` with `status: 'scanned'` and `status: 'no-access'` are
 * DIFFERENT ANSWERS and must never collapse into one another.
 */
export interface SubscriptionScanResult {
  subscriptionId: string;
  displayName: string;
  status: 'scanned' | 'no-access' | 'partial' | 'timed-out' | 'not-requested';
  /** Which credential tier answered: 1 = operator token, 2 = Console UAMI, 3 = ARM list. */
  credentialTier: 1 | 2 | 3;
  matchedResources: number;
  /** A $skipToken remained when the paging budget expired. */
  truncated: boolean;
}

/** The role the deploy will create for the Console identity on an adopted resource. */
export interface GrantPlanEntry {
  roleName: string;
  roleGuid: string;
  /** Resource-group-and-name form. NEVER a full ARM id — those are not logged. */
  scope: string;
  principalKind: 'console-uami';
}

export interface ServiceDecision {
  mode: AdoptionMode;
  /** Where the decision came from, so the UI can show a manual entry as manual. */
  source: 'discovered' | 'manual' | 'default' | 'reconciled';
  /**
   * TRUE when at least one requested subscription could not be read for this
   * service's ARM type. The decision defaults to `create`, but the operator is
   * told the scan was incomplete rather than shown a confident "none found".
   */
  uncertain?: boolean;
  target?: {
    name: string;
    rg: string;
    sub: string;
    location?: string;
    sku?: string;
  };
  /** Service-specific values, e.g. foundry chat/embed deployment names. */
  extra?: Record<string, string>;
  fitness?: FitnessResult;
  grants?: GrantPlanEntry[];
  decidedBy: string;
  decidedAt: string;
}

export interface HubSubnetAssignment {
  [role: string]: string;
}

export interface NetworkDecision {
  hub: {
    mode: 'create' | 'adopt';
    vnetId?: string;
    cidr?: string;
    /** role -> existing subnet id, for an adopted VNet where subnets cannot be derived. */
    subnets?: HubSubnetAssignment;
  };
  /**
   * Per-DLZ spoke decision.
   *
   * `cidr` exists because `landing-zone/main.bicep` declares `spokeVnetCidr` and
   * the root orchestrator never passed it — so every DLZ was hard-coded
   * 10.100.0.0/16 and any brownfield estate using that range collided.
   */
  spokes: Record<string, { mode: 'create' | 'adopt'; vnetId?: string; cidr?: string }>;
  privateDns: { mode: 'create' | 'adopt' | 'mixed'; zones: Record<string, string> };
  firewall: { mode: 'create' | 'adopt-policy' | 'skip'; policyId?: string };
  logAnalytics: { mode: 'create' | 'adopt'; workspaceId?: string };
}

export interface DeploymentPlan {
  planId: string;
  schemaVersion: 1;
  createdAt: string;
  createdBy: string;
  /** The planId this one replaces, when it is an edit of an earlier plan. */
  supersedes?: string;
  boundary: DeploymentBoundary;
  topology: DeploymentTopology;
  installSubscriptionId: string;
  region: string;
  tenantId: string;
  scanScope: { subscriptions: string[]; managementGroups: string[] };
  /** The coverage ledger travels WITH the plan, so a later reader can see what was seen. */
  scanResults: SubscriptionScanResult[];
  services: Record<string, ServiceDecision>;
  network: NetworkDecision;
  featureFlags: Record<string, boolean>;
  /** sha256 over the canonicalised plan minus this field. */
  planHash: string;
}

export function emptyNetworkDecision(): NetworkDecision {
  return {
    hub: { mode: 'create' },
    spokes: {},
    privateDns: { mode: 'create', zones: {} },
    firewall: { mode: 'create' },
    logAnalytics: { mode: 'create' },
  };
}

/**
 * Deterministic JSON for hashing and for byte-comparing two plans. Object keys
 * are sorted at every depth; arrays keep their order (order is meaningful in
 * `scanResults` and in the grant list).
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (src[k] === undefined) continue;
      out[k] = canonicalize(src[k]);
    }
    return out;
  }
  return value;
}

/**
 * sha256 over the canonicalised plan with `planHash` removed.
 *
 * SERVER-SIDE. This module imports node:crypto at the top level, so the wizard
 * must not import it into a client bundle — it hashes and validates through a
 * BFF route. That is deliberate: the hash is the integrity boundary for a plan
 * that crosses from the browser into a deployment, and a hash computed in the
 * browser would prove nothing about the plan the deploy received.
 */
export function computePlanHash(plan: Omit<DeploymentPlan, 'planHash'> & { planHash?: string }): string {
  const { planHash: _ignored, ...rest } = plan as DeploymentPlan;
  const json = JSON.stringify(canonicalize(rest));
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

export interface PlanValidationIssue {
  serviceKey?: string;
  code:
    | 'unknown-service'
    | 'adopt-not-permitted'
    | 'create-not-permitted'
    | 'missing-target'
    | 'fitness-not-evaluated'
    | 'fitness-blocking'
    | 'scan-coverage-missing';
  message: string;
}

/**
 * Structural validation of a plan, BEFORE any Azure call.
 *
 * This is deliberately separate from fitness: this catches a plan that is
 * internally incoherent (adopt with no target, adopt of a create-only service,
 * create of a tenant singleton that already exists). Fitness catches a coherent
 * plan pointed at an unusable resource.
 */
export function validatePlan(plan: DeploymentPlan): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];

  for (const [key, decision] of Object.entries(plan.services)) {
    const def = getServiceDef(key);
    if (!def) {
      issues.push({
        serviceKey: key,
        code: 'unknown-service',
        message: `"${key}" is not in the adoption catalog, so no deployment could honour a decision about it.`,
      });
      continue;
    }

    if (decision.mode === 'adopt') {
      if (!canAdopt(key)) {
        issues.push({
          serviceKey: key,
          code: 'adopt-not-permitted',
          message:
            `${def.label} cannot be adopted. ${def.createOnlyReason ?? 'It is not an adoptable service.'}`,
        });
      }
      if (!decision.target?.name || !decision.target?.rg || !decision.target?.sub) {
        issues.push({
          serviceKey: key,
          code: 'missing-target',
          message:
            `${def.label} is set to adopt, but the plan does not name a resource (name, resource group and subscription are all required).`,
        });
      }
      if (!decision.fitness) {
        issues.push({
          serviceKey: key,
          code: 'fitness-not-evaluated',
          message:
            `${def.label} is set to adopt but has not been validated. Adoption is only permitted after the fitness checks have run against the named resource.`,
        });
      } else if (decision.fitness.verdict === 'unusable' || decision.fitness.verdict === 'unknown') {
        const detail = decision.fitness.checks
          .filter((c) => c.verdict === 'fail' || c.verdict === 'unknown')
          .map((c) => c.what)
          .join('; ');
        issues.push({
          serviceKey: key,
          code: 'fitness-blocking',
          message: `${def.label} cannot be adopted: ${detail || decision.fitness.verdict}.`,
        });
      }
    }

    if (decision.mode === 'create') {
      const candidateExists = decision.source === 'discovered' && !!decision.target?.name;
      if (!canCreate(key, candidateExists)) {
        issues.push({
          serviceKey: key,
          code: 'create-not-permitted',
          message:
            def.singleton === 'tenant'
              ? `${def.label} is a tenant singleton and one already exists. Deploying a second one fails the whole deployment, so "create new" is not offered here.`
              : `${def.label} cannot be created by Loom. ${def.createOnlyReason ?? ''}`.trim(),
        });
      }
    }
  }

  // Every requested subscription must appear in the ledger. A missing row means
  // the coverage claim would be inferred rather than recorded.
  for (const sub of plan.scanScope.subscriptions) {
    if (!plan.scanResults.some((r) => r.subscriptionId === sub)) {
      issues.push({
        code: 'scan-coverage-missing',
        message:
          `Subscription ${sub} was in the requested scan scope but has no row in the coverage ledger, so the plan cannot state whether it was read.`,
      });
    }
  }

  return issues;
}

/** A plan is submittable only when it is structurally valid. */
export function isPlanSubmittable(plan: DeploymentPlan): boolean {
  return validatePlan(plan).length === 0;
}

/**
 * Produce the next immutable revision of a plan. The caller supplies the changed
 * fields; the result carries a fresh id, a fresh hash and a `supersedes` link.
 */
export function supersede(
  prev: DeploymentPlan,
  changes: Partial<Omit<DeploymentPlan, 'planId' | 'planHash' | 'supersedes' | 'schemaVersion'>>,
  planId: string,
  createdBy: string,
  now: string,
): DeploymentPlan {
  const next: Omit<DeploymentPlan, 'planHash'> = {
    ...prev,
    ...changes,
    planId,
    schemaVersion: 1,
    supersedes: prev.planId,
    createdBy,
    createdAt: now,
  };
  return { ...next, planHash: computePlanHash(next) };
}

/**
 * A greenfield plan: every catalog service set to `create`, no scan hits.
 *
 * Greenfield is the DEGENERATE CASE of brownfield, not a separate code path.
 * There is one deploy pipeline; greenfield is the plan where every adoptable
 * entry is 'create'. Two pipelines is how the estate ended up with a
 * brownfield-only failure (`allow_existing_hub`) that greenfield CI never saw.
 */
export function greenfieldPlan(opts: {
  planId: string;
  createdBy: string;
  now: string;
  boundary: DeploymentBoundary;
  topology: DeploymentTopology;
  installSubscriptionId: string;
  region: string;
  tenantId: string;
  scanScope?: { subscriptions: string[]; managementGroups: string[] };
  scanResults?: SubscriptionScanResult[];
  featureFlags?: Record<string, boolean>;
}): DeploymentPlan {
  const services: Record<string, ServiceDecision> = {};
  const base: Omit<DeploymentPlan, 'planHash'> = {
    planId: opts.planId,
    schemaVersion: 1,
    createdAt: opts.now,
    createdBy: opts.createdBy,
    boundary: opts.boundary,
    topology: opts.topology,
    installSubscriptionId: opts.installSubscriptionId,
    region: opts.region,
    tenantId: opts.tenantId,
    scanScope: opts.scanScope ?? { subscriptions: [], managementGroups: [] },
    scanResults: opts.scanResults ?? [],
    // An ABSENT key means 'create' in bicep's adoptMode(), so a greenfield plan
    // is genuinely empty rather than carrying 20 redundant 'create' rows.
    services,
    network: emptyNetworkDecision(),
    featureFlags: opts.featureFlags ?? {},
  };
  return { ...base, planHash: computePlanHash(base) };
}
