/**
 * DeploymentPlan — the reviewable, persistable artifact the deployment wizard
 * produces and every deploy tier consumes.
 *
 * WHY THIS EXISTS (deploy-integrity.md R5, R7):
 * Before this, the wizard's brownfield choices ("reuse my existing Purview")
 * were collected by a real cross-subscription Resource Graph scan and then
 * DROPPED on every deploy tier that actually deploys — the only call site of
 * the translator was inside the HTTP-503 copy-paste block. The operator's
 * decision therefore only reached Azure when the deploy FAILED. A plan is the
 * fix: one canonical object, hashed, reviewed before anything runs, and
 * carried end-to-end.
 *
 * DESIGN INVARIANTS (each is enforced by a unit test):
 *
 *  1. GREENFIELD IS A DEGENERATE BROWNFIELD PLAN, NOT A SECOND CODE PATH.
 *     `isGreenfieldPlan()` is a *derived* predicate over the decisions — there
 *     is no `mode: 'greenfield'` field to get out of sync. Two pipelines is how
 *     the estate ended up with a brownfield-only failure (`allow_existing_hub`)
 *     that greenfield CI never saw.
 *
 *  2. "NOTHING FOUND" AND "COULD NOT LOOK" NEVER COLLAPSE.
 *     A subscription that answered with zero matches is `status:'scanned',
 *     matchedResources:0`. A subscription that could not be read is
 *     `status:'no-access'`. `uncertain` on a decision records that the second
 *     kind happened, so the UI can say "no X found, but N subscriptions could
 *     not be read" instead of asserting absence. This is R7 in the data model:
 *     the plan cannot express a claim it did not establish.
 *
 *  3. COVERAGE IS COUNTED FROM WHAT WAS *REQUESTED*, NEVER INFERRED FROM
 *     RESULTS. `coverageSummary()` derives its counts from the ledger, which is
 *     built from the requested subscription list. The old
 *     `subscriptionsScanned: subsSeen.size` counted only subscriptions that had
 *     a *matching row*, so an operator with 12 subscriptions and hits in 2 was
 *     told "2 scanned" — an untrue statement about coverage.
 *
 *  4. A PLAN IS IMMUTABLE. An edit produces a new `planId` with `supersedes`
 *     set (see plan-builder). `planHash` is computed over the canonicalised
 *     plan minus the hash itself, so the same decisions always hash the same
 *     regardless of key insertion order.
 *
 * This module is PURE — no Azure clients, no `next/headers`, no fs. It is
 * imported by both client components (the wizard) and server routes, so it must
 * stay free of server-only imports.
 */

/** Sovereign boundary the deployment targets. Mirrors the wizard's Boundary. */
export type PlanBoundary = 'commercial' | 'gcc' | 'gcch' | 'il5';

/** How the estate is laid out. Mirrors main.bicep's deploymentMode + dlz-attach. */
export type PlanTopology = 'single-sub' | 'tenant' | 'dlz-attach';

/**
 * What the platform will do about one backing service.
 *
 *  - `adopt`  — bind Loom to an EXISTING resource; provision nothing.
 *  - `create` — deploy a new one (the default, and the whole of a greenfield plan).
 *  - `skip`   — do neither; the dependent surfaces honest-gate.
 */
export type ServiceMode = 'adopt' | 'create' | 'skip';

/** Where a decision came from. Rendered on the review step so nothing is silent. */
export type DecisionSource = 'discovered' | 'manual' | 'default' | 'reconciled';

/**
 * How a service may be decided.
 *
 *  - `adoptable`      — adopt or create, operator's choice.
 *  - `adopt-required` — a tenant/region singleton already exists, so "create"
 *    would fail deterministically (Purview: `EnterpriseTenantAlreadyExists`).
 *    The UI DISABLES create with an explanation rather than offering it and
 *    then failing.
 *  - `create-only`    — Loom always deploys its own; `createOnlyReason` is
 *    mandatory and is rendered (Key Vault, Container Apps Environment, the
 *    Firewall instance — see the design's §6).
 *  - `reference-only` — Loom reads it but never provisions or mutates it.
 *  - `attach-in-place`— networking primitives Loom joins rather than owns
 *    (VNet, subnet, Private DNS zone, firewall policy).
 */
export type ServiceClass =
  | 'adoptable'
  | 'adopt-required'
  | 'create-only'
  | 'reference-only'
  | 'attach-in-place';

/** Verdict of the fitness suite for one adopted resource. */
export type FitnessVerdict = 'usable' | 'usable-with-changes' | 'unusable' | 'unknown';

/** Outcome of one fitness check. `unknown` is FIRST-CLASS and never renders as a failure. */
export type CheckVerdict = 'pass' | 'warn' | 'fail' | 'unknown';

/**
 * One fitness observation.
 *
 * `established` is MANDATORY and is the R7 enforcement point: the message may
 * only assert what this field records. "isHnsEnabled=false from
 * Microsoft.Storage/storageAccounts@2023-05-01" is an establishment; "the
 * account does not support Delta" is a conclusion drawn from it. A check that
 * swallowed an error has `verdict:'unknown'` and an `established` that says so.
 */
export interface FitnessCheck {
  /** Stable id, e.g. 'adls.hns'. */
  id: string;
  verdict: CheckVerdict;
  /** What is wrong, in one sentence. */
  what: string;
  /** Why Loom cares. */
  why: string;
  /** EXACTLY what the code observed, including the API version it observed it from. */
  established: string;
  remediation?: FitnessRemediation;
}

/**
 * What happens about a failed check.
 *
 * `platform-will-fix` is the DEFAULT expectation per auto-bind-by-default.md §5
 * — a remediation the platform could have performed is a defect, not a helpful
 * message. `operator-action` is only legitimate when the platform genuinely
 * cannot act (it lacks `roleAssignments/write` and the operator's own token
 * also failed).
 */
export type FitnessRemediation =
  | { kind: 'platform-will-fix'; description: string }
  | { kind: 'operator-action'; description: string; command?: string; portalUrl?: string; role?: { name: string; scope: string } }
  | { kind: 'not-remediable'; description: string; alternative: string };

export interface FitnessResult {
  verdict: FitnessVerdict;
  checks: FitnessCheck[];
  /** When the suite ran. Absent = not yet evaluated (step 5 has not run). */
  evaluatedAt?: string;
}

/** A role the platform will create as part of executing the plan. */
export interface GrantPlanEntry {
  roleName: string;
  roleGuid: string;
  /** Last path segment only — full ARM ids are never rendered or logged. */
  scopeLabel: string;
  principalKind: 'console-uami' | 'deploy-identity';
  /** true when the platform will perform the grant itself; false = operator must. */
  platformPerformed: boolean;
}

/** Coordinates of an existing resource, discovered or typed by the operator. */
export interface ServiceTarget {
  name: string;
  rg: string;
  sub: string;
  /** Full ARM id when known. NEVER rendered in full in UI or logs. */
  id?: string;
  location?: string;
  sku?: string;
}

/** The operator's decision about one service. */
export interface ServiceDecision {
  mode: ServiceMode;
  source: DecisionSource;
  /**
   * True when the platform could NOT see every requested subscription while
   * deciding this service. A `create` decision with `uncertain:true` means
   * "no existing one found, but I could not look everywhere" — which is a
   * different statement from "none exists", and the UI must render it as such.
   */
  uncertain?: boolean;
  target?: ServiceTarget;
  /** Service-specific extras, e.g. Foundry chat/embed deployment names. */
  extra?: Record<string, string>;
  fitness?: FitnessResult;
  grants?: GrantPlanEntry[];
  decidedBy: string;
  decidedAt: string;
}

/** Why a subscription's scan ended the way it did. */
export type ScanStatus = 'scanned' | 'no-access' | 'partial' | 'timed-out' | 'not-requested';

/**
 * Per-subscription coverage ledger. Built from the REQUESTED list, never
 * inferred from results — see invariant 3 above.
 */
export interface SubscriptionScanResult {
  subscriptionId: string;
  displayName: string;
  status: ScanStatus;
  /** Which credential answered: 1 = operator OBO, 2 = Console UAMI, 3 = ARM list. */
  credentialTier: 1 | 2 | 3;
  /** 0 is a LEGITIMATE answer and is different from `no-access`. */
  matchedResources: number;
  /** A `$skipToken` remained when the paging budget expired. */
  truncated: boolean;
  /** Present when status is no-access / timed-out — what actually happened. */
  detail?: string;
}

/** Hub subnet roles Loom needs when it adopts a customer VNet. */
export type HubSubnetRole =
  | 'container-apps'
  | 'private-endpoints'
  | 'firewall'
  | 'bastion'
  | 'gateway';

export interface NetworkDecision {
  hub: {
    mode: 'create' | 'adopt';
    vnetName?: string;
    vnetRg?: string;
    vnetSub?: string;
    cidr?: string;
    /** role → existing subnet NAME (ids are resolved server-side, never rendered). */
    subnets?: Partial<Record<HubSubnetRole, string>>;
  };
  spokes: Record<string, { mode: 'create' | 'adopt'; vnetName?: string; cidr?: string }>;
  privateDns: { mode: 'create' | 'adopt' | 'mixed'; zones: Record<string, string> };
  firewall: { mode: 'create' | 'adopt-policy' | 'skip'; policyName?: string; policyRg?: string };
  logAnalytics: { mode: 'create' | 'adopt'; workspaceName?: string; workspaceRg?: string };
}

/** A fresh, all-create network decision — the greenfield shape. */
export function defaultNetworkDecision(): NetworkDecision {
  return {
    hub: { mode: 'create' },
    spokes: {},
    privateDns: { mode: 'create', zones: {} },
    firewall: { mode: 'create' },
    logAnalytics: { mode: 'create' },
  };
}

/** The artifact. Written once; an edit produces a successor. */
export interface DeploymentPlan {
  planId: string;
  schemaVersion: 1;
  createdAt: string;
  createdBy: string;
  /** Set when this plan replaces an earlier one (an edit, or a reconcile). */
  supersedes?: string;
  boundary: PlanBoundary;
  topology: PlanTopology;
  installSubscriptionId: string;
  region: string;
  /** What the operator CONSENTED to have scanned. */
  scanScope: { subscriptions: string[]; managementGroups: string[] };
  /** The coverage ledger travels WITH the plan so a later reader can still see
   *  what was and was not visible when the decisions were made. */
  scanResults: SubscriptionScanResult[];
  /** catalog service key → decision. */
  services: Record<string, ServiceDecision>;
  network: NetworkDecision;
  featureFlags: Record<string, boolean>;
  /** sha256 over the canonicalised plan MINUS this field. */
  planHash: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure derivations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TRUE when nothing in this plan adopts an existing resource.
 *
 * Derived, never stored — see invariant 1. Note `skip` does NOT make a plan
 * non-greenfield: choosing not to deploy Azure Maps into an empty subscription
 * is still a greenfield install.
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
export function planPathLabel(plan: Pick<DeploymentPlan, 'services' | 'network'>): 'greenfield' | 'brownfield' {
  return isGreenfieldPlan(plan) ? 'greenfield' : 'brownfield';
}

export interface CoverageSummary {
  requested: number;
  scanned: number;
  noAccess: number;
  partial: number;
  timedOut: number;
  truncated: number;
  /** true when ANY subscription was not fully read — every "none found" in this
   *  plan must then be qualified rather than asserted. */
  incomplete: boolean;
}

/**
 * Coverage, counted from the ledger (i.e. from what was REQUESTED).
 *
 * A caller must never compute coverage by counting distinct subscriptions in a
 * result set — that is the `subsSeen.size` bug this function replaces.
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
  const parts: string[] = [`Read ${c.scanned} of ${c.requested} subscription${c.requested === 1 ? '' : 's'}`];
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
    if (d.mode === 'adopt' && (d.fitness?.verdict === 'unusable' || d.fitness?.verdict === 'unknown')) c.unusable++;
  }
  return c;
}

/**
 * Whether the plan may be executed.
 *
 * BLOCKING, per the design's §4: fitness is not advisory. A red or UNKNOWN
 * fitness on an `adopt` decision blocks — `unknown` blocks precisely because
 * "I could not verify this" is not "this is fine".
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

// ─────────────────────────────────────────────────────────────────────────────
// Canonicalisation + hashing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic JSON: object keys sorted at every depth, arrays left in order.
 *
 * Key order matters because the hash is the plan's identity across the four
 * deploy tiers — a plan serialised by the browser and re-serialised by the
 * workflow must hash identically or the transport guard cannot prove the plan
 * arrived intact.
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

/** The exact bytes the hash is taken over. Exported so a test can compare them. */
export function canonicalPlanJson(plan: Omit<DeploymentPlan, 'planHash'> & { planHash?: string }): string {
  const { planHash: _ignored, ...rest } = plan as DeploymentPlan;
  return JSON.stringify(canonicalize(rest));
}

/**
 * FNV-1a 64-bit over the canonical bytes, hex-encoded.
 *
 * Deliberately NOT node:crypto — this module is imported by client components
 * and must not pull a node builtin into the browser bundle. The hash is an
 * integrity/identity check for a plan the operator just authored in the same
 * session, not a security primitive; it is never used to authenticate anything.
 */
export function computePlanHash(plan: Omit<DeploymentPlan, 'planHash'> & { planHash?: string }): string {
  const json = canonicalPlanJson(plan);
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < json.length; i++) {
    h ^= BigInt(json.charCodeAt(i) & 0xff);
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/** Returns the plan with its hash filled in (or refreshed after an edit). */
export function withPlanHash<T extends Omit<DeploymentPlan, 'planHash'> & { planHash?: string }>(plan: T): T & { planHash: string } {
  return { ...plan, planHash: computePlanHash(plan) };
}

/** True when the plan's stored hash matches its content. */
export function verifyPlanHash(plan: DeploymentPlan): boolean {
  return computePlanHash(plan) === plan.planHash;
}
