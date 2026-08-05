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
  /**
   * Present when the status is no-access / timed-out / partial — WHAT actually
   * happened, in the words of the thing that failed. Without it the ledger can
   * only say "could not read", which is the state that let a silently-dropped
   * scope look like an empty one.
   */
  detail?: string;
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
    /** Full ARM id when known. NEVER rendered in full in UI or logs. */
    id?: string;
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

// ─────────────────────────────────────────────────────────────────────────────
// Wizard-facing aliases and types (reconciled from the planner branch)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical names. The two adopt-or-create branches named the same three unions
 * differently — `ServiceMode`/`AdoptionMode`, `PlanBoundary`/`DeploymentBoundary`,
 * `PlanTopology`/`DeploymentTopology`. The `Deployment*` / `AdoptionMode` set is
 * canonical because `AdoptionMode` is the same literal union the bicep `adopt`
 * bag consumes from `adoption-catalog.ts`; these three are declared aliases so
 * one name change cannot make the two halves disagree again.
 */
export type ServiceMode = AdoptionMode;
export type PlanBoundary = DeploymentBoundary;
export type PlanTopology = DeploymentTopology;

/** Where a decision came from. Rendered on the review step so nothing is silent. */
export type DecisionSource = ServiceDecision['source'];

/** Re-exported so the wizard does not import the catalog for one union. */
export type { AdoptionClass as ServiceClass } from './adoption-catalog';

/** Why a subscription's scan ended the way it did. */
export type ScanStatus = SubscriptionScanResult['status'];

/** Coordinates of an existing resource, discovered or typed by the operator. */
export type ServiceTarget = NonNullable<ServiceDecision['target']>;

/** Hub subnet roles Loom needs when it adopts a customer VNet. */
export type HubSubnetRole =
  | 'container-apps'
  | 'private-endpoints'
  | 'firewall'
  | 'bastion'
  | 'gateway';

/** A fresh, all-create network decision — the greenfield shape. Alias of `emptyNetworkDecision`. */
export function defaultNetworkDecision(): NetworkDecision {
  return emptyNetworkDecision();
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure derivations — isomorphic, safe in a client bundle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TRUE when nothing in this plan adopts an existing resource.
 *
 * Derived, never stored. Note `skip` does NOT make a plan non-greenfield:
 * choosing not to deploy Azure Maps into an empty subscription is still a
 * greenfield install.
 */
export function isGreenfieldPlan(plan: Pick<DeploymentPlan, 'services' | 'network'>): boolean {
  for (const d of Object.values(plan.services)) {
    if (d.mode === 'adopt') return false;
  }
  const n = plan.network;
  if (n.hub.mode === 'adopt') return false;
  if (n.privateDns.mode !== 'create') return false;
  if (n.firewall.mode === 'adopt-policy') return false;
  if (n.logAnalytics.mode === 'adopt') return false;
  for (const s of Object.values(n.spokes)) if (s.mode === 'adopt') return false;
  return true;
}

/** Human label for the path this plan represents. */
export function planPathLabel(
  plan: Pick<DeploymentPlan, 'services' | 'network'>,
): 'greenfield' | 'brownfield' {
  return isGreenfieldPlan(plan) ? 'greenfield' : 'brownfield';
}

export interface CoverageSummary {
  requested: number;
  scanned: number;
  noAccess: number;
  partial: number;
  timedOut: number;
  truncated: number;
  /**
   * true when ANY subscription was not fully read — every "none found" in this
   * plan must then be qualified rather than asserted.
   */
  incomplete: boolean;
}

/**
 * Coverage, counted from the ledger (i.e. from what was REQUESTED).
 *
 * A caller must never compute coverage by counting distinct subscriptions in a
 * result set — that is the `subsSeen.size` bug this function replaces, which
 * told an operator with 12 subscriptions and hits in 2 that "2 were scanned".
 */
export function coverageSummary(ledger: SubscriptionScanResult[]): CoverageSummary {
  const s: CoverageSummary = {
    requested: ledger.length,
    scanned: 0,
    noAccess: 0,
    partial: 0,
    timedOut: 0,
    truncated: 0,
    incomplete: false,
  };
  for (const r of ledger) {
    if (r.status === 'scanned') s.scanned++;
    else if (r.status === 'no-access') s.noAccess++;
    else if (r.status === 'partial') s.partial++;
    else if (r.status === 'timed-out') s.timedOut++;
    if (r.truncated) s.truncated++;
  }
  s.incomplete = s.noAccess > 0 || s.partial > 0 || s.timedOut > 0 || s.truncated > 0;
  return s;
}

/**
 * The sentence the UI renders about coverage. Generated from the ledger — never
 * a hard-coded count, and it NEVER says "scanned N" when N was the number of
 * subscriptions that happened to contain a match.
 */
export function coverageSentence(ledger: SubscriptionScanResult[]): string {
  const c = coverageSummary(ledger);
  if (c.requested === 0) return 'No subscriptions were selected for the scan.';
  const parts: string[] = [
    `Read ${c.scanned} of ${c.requested} subscription${c.requested === 1 ? '' : 's'}`,
  ];
  if (c.noAccess) parts.push(`${c.noAccess} could not be read`);
  if (c.partial) parts.push(`${c.partial} returned partial results`);
  if (c.timedOut) parts.push(`${c.timedOut} timed out`);
  if (c.truncated) parts.push(`${c.truncated} were truncated before the last page`);
  const head = parts.join(', ') + '.';
  return c.incomplete
    ? `${head} Anything reported as "not found" is therefore "not found in what I could read".`
    : head;
}

export interface PlanCounts {
  adopt: number;
  create: number;
  skip: number;
  uncertain: number;
  /** decisions blocked by a red fitness verdict — the plan cannot be executed. */
  unusable: number;
}

export function planCounts(services: Record<string, ServiceDecision>): PlanCounts {
  const c: PlanCounts = { adopt: 0, create: 0, skip: 0, uncertain: 0, unusable: 0 };
  for (const d of Object.values(services)) {
    if (d.mode === 'adopt') c.adopt++;
    else if (d.mode === 'create') c.create++;
    else c.skip++;
    if (d.uncertain) c.uncertain++;
    if (d.mode === 'adopt' && (d.fitness?.verdict === 'unusable' || d.fitness?.verdict === 'unknown')) {
      c.unusable++;
    }
  }
  return c;
}

/**
 * Whether the plan may be executed.
 *
 * BLOCKING: fitness is not advisory. A red or UNKNOWN fitness on an `adopt`
 * decision blocks — `unknown` blocks precisely because "I could not verify this"
 * is not "this is fine".
 */
export function planBlockers(plan: Pick<DeploymentPlan, 'services'>): string[] {
  const out: string[] = [];
  for (const [key, d] of Object.entries(plan.services)) {
    if (d.mode !== 'adopt') continue;
    if (!d.target?.name) {
      out.push(`${key}: set to adopt but no resource was chosen.`);
      continue;
    }
    if (!d.fitness) {
      out.push(`${key}: adoption has not been validated yet — run the validation step.`);
      continue;
    }
    if (d.fitness.verdict === 'unusable') {
      const failed = d.fitness.checks.find((c) => c.verdict === 'fail');
      out.push(`${key}: ${failed?.what ?? 'the chosen resource is not usable'}`);
    } else if (d.fitness.verdict === 'unknown') {
      const unk = d.fitness.checks.find((c) => c.verdict === 'unknown');
      out.push(`${key}: could not verify — ${unk?.what ?? 'validation was inconclusive'}`);
    }
  }
  return out;
}
