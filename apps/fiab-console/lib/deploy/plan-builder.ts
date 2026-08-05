/**
 * plan-builder — pure construction and mutation of a {@link DeploymentPlan}.
 *
 * Everything here is a pure function over plain data so the whole adopt-or-
 * create decision surface is unit-testable without Azure, and so the SAME code
 * builds the plan in the browser (the wizard) and re-derives it on the server
 * (reconcile against a live estate).
 *
 * THE RULES THIS FILE ENCODES (design §2.6, §2.7, §3):
 *
 *   recommendation
 *     adopt-required  the service is a tenant/region singleton and one exists.
 *                     "Create new" is DISABLED with an explanation rather than
 *                     offered and then failed — a second Enterprise Purview
 *                     fails deterministically with EnterpriseTenantAlreadyExists,
 *                     so offering it is offering a known failure.
 *     adopt           exactly one candidate, same region as the hub.
 *     create          everything else, INCLUDING "3 candidates found, none
 *                     obviously right" — ambiguity resolves to create, never to
 *                     a guess.
 *
 *   the three no-candidate outcomes, which must NEVER be merged:
 *     none exist      every requested subscription answered; 0 matched.
 *                     → create, certain.
 *     could not look  ≥1 subscription was no-access / partial / timed-out /
 *                     truncated → create, `uncertain:true`. The UI then says
 *                     "no X found, but N subscriptions could not be read", and
 *                     offers manual coordinates. This is R7 expressed in data:
 *                     the plan physically cannot claim absence it did not
 *                     establish.
 *     not adoptable   `class:'create-only'` → create, LOCKED, with the reason.
 */

import {
  type DeploymentPlan,
  type DecisionSource,
  type PlanBoundary,
  type PlanTopology,
  type ServiceClass,
  type ServiceDecision,
  type ServiceMode,
  type ServiceTarget,
  type SubscriptionScanResult,
  coverageSummary,
  defaultNetworkDecision,
  withPlanHash,
} from './plan-model';

/**
 * One discovered candidate, as the wizard receives it from the scan.
 *
 * `id` is the full ARM id. It is carried so the deploy can address the resource
 * exactly, and it is NEVER rendered in the UI or written to a log — surfaces
 * show `name` / `rg` / the subscription DISPLAY name.
 */
export interface AdoptionCandidate {
  serviceKey: string;
  id: string;
  name: string;
  resourceGroup: string;
  subscriptionId: string;
  subscriptionName: string;
  location: string;
  sku?: { name?: string; tier?: string; capacity?: number };
  kind?: string;
  networkPosture: 'public' | 'public-restricted' | 'private-endpoint' | 'unknown';
  tags?: Record<string, string>;
  credentialTier: 1 | 2 | 3;
}

/**
 * The catalog row as the WIZARD sees it. Deliberately a view, not the catalog
 * itself: the wizard is a client component and must not import a server-side
 * catalog module, and this keeps the UI decoupled from where the catalog lives.
 */
export interface AdoptableServiceView {
  key: string;
  label: string;
  class: ServiceClass;
  /** Mandatory when class === 'create-only'; rendered verbatim in the UI. */
  createOnlyReason?: string;
  singleton?: 'tenant' | 'region';
  /** What Loom uses this service for — shown on every row. */
  usedFor: string;
  /**
   * What Loom CHANGES about an adopted instance. Rendered verbatim on the
   * review step, BEFORE the deploy — an operator adopting a production
   * Databricks workspace must see "assigns the workspace to a Unity Catalog
   * metastore" before it happens, not after.
   */
  mutations: string[];
  /** Role the Console UAMI needs on an adopted instance. */
  roleName?: string;
}

/** A service row after the scan: catalog view + what was found for it. */
export interface ServiceScanRow {
  service: AdoptableServiceView;
  candidates: AdoptionCandidate[];
}

export type Recommendation = 'adopt' | 'create' | 'adopt-required';

export interface RecommendationResult {
  recommendation: Recommendation;
  /** Always present, always a human sentence. */
  reason: string;
  /** Index into `candidates` when the recommendation names one. */
  candidateIndex: number | null;
}

/**
 * Decide what to RECOMMEND for one service. Pure; no I/O.
 *
 * `hubRegion` is used only to prefer a co-located candidate — a cross-region
 * candidate is still offered, it just does not become the auto-recommendation.
 */
export function recommendFor(row: ServiceScanRow, hubRegion: string): RecommendationResult {
  const { service, candidates } = row;

  if (service.class === 'create-only') {
    return {
      recommendation: 'create',
      reason: service.createOnlyReason ?? `Loom always deploys its own ${service.label}.`,
      candidateIndex: null,
    };
  }

  if (candidates.length === 0) {
    return {
      recommendation: 'create',
      reason: `No existing ${service.label} was found — Loom will deploy one.`,
      candidateIndex: null,
    };
  }

  if (service.singleton && candidates.length >= 1) {
    return {
      recommendation: 'adopt-required',
      reason:
        service.singleton === 'tenant'
          ? `Only one ${service.label} is allowed per tenant, and ${candidates[0].name} already exists — deploying a second one would fail. Loom will use the existing one.`
          : `Only one ${service.label} is allowed per region, and ${candidates[0].name} already exists in ${candidates[0].location}. Loom will use the existing one.`,
      candidateIndex: 0,
    };
  }

  const sameRegion = candidates.filter((c) => normRegion(c.location) === normRegion(hubRegion));
  if (candidates.length === 1) {
    const only = candidates[0];
    return {
      recommendation: 'adopt',
      reason:
        normRegion(only.location) === normRegion(hubRegion)
          ? `Exactly one ${service.label} was found (${only.name}, ${only.location}) — Loom will use it.`
          : `Exactly one ${service.label} was found (${only.name}), but it is in ${only.location} and the hub is in ${hubRegion}. Loom will use it; confirm the cross-region latency is acceptable.`,
      candidateIndex: 0,
    };
  }

  if (sameRegion.length === 1) {
    const idx = candidates.indexOf(sameRegion[0]);
    return {
      recommendation: 'adopt',
      reason: `${candidates.length} candidates were found; exactly one (${sameRegion[0].name}) is in the hub region ${hubRegion} — Loom will use that one.`,
      candidateIndex: idx,
    };
  }

  return {
    recommendation: 'create',
    reason: `${candidates.length} existing ${service.label} instances were found and none is an obvious match, so Loom will deploy its own. Pick one above to adopt it instead.`,
    candidateIndex: null,
  };
}

function normRegion(r: string | undefined): string {
  return (r ?? '').toLowerCase().replace(/\s+/g, '');
}

/**
 * TRUE when the scan could not see everything the operator asked it to.
 *
 * When this is true, every "nothing found" in the resulting plan is marked
 * `uncertain` — the difference between "none exists" and "I could not look".
 */
export function scanWasIncomplete(ledger: SubscriptionScanResult[]): boolean {
  return coverageSummary(ledger).incomplete;
}

export interface BuildPlanArgs {
  planId: string;
  createdBy: string;
  boundary: PlanBoundary;
  topology: PlanTopology;
  installSubscriptionId: string;
  region: string;
  scanScope: { subscriptions: string[]; managementGroups: string[] };
  ledger: SubscriptionScanResult[];
  rows: ServiceScanRow[];
  featureFlags?: Record<string, boolean>;
  supersedes?: string;
  /** Injected so a test can pin the timestamp. */
  now?: () => string;
}

/**
 * Build the initial plan: every service gets its recommended decision.
 *
 * The operator then edits it. Nothing here asks a question — per §1.2 the
 * operator is never asked "greenfield or brownfield?"; the discovery result
 * determines the path, and an empty estate simply yields an all-`create` plan.
 */
export function buildPlanFromDiscovery(args: BuildPlanArgs): DeploymentPlan {
  const now = args.now ?? (() => new Date().toISOString());
  const at = now();
  const incomplete = scanWasIncomplete(args.ledger);

  const services: Record<string, ServiceDecision> = {};
  for (const row of args.rows) {
    const rec = recommendFor(row, args.region);
    const idx = rec.candidateIndex;
    const cand = idx === null ? undefined : row.candidates[idx];
    const mode: ServiceMode = rec.recommendation === 'create' ? 'create' : 'adopt';
    services[row.service.key] = {
      mode,
      source: cand ? 'discovered' : 'default',
      // Only a CREATE reached without seeing everything is uncertain. An adopt
      // decision names a resource we actually saw, so it asserts nothing about
      // what we could not read.
      ...(mode === 'create' && incomplete && row.service.class !== 'create-only' ? { uncertain: true as const } : {}),
      ...(cand ? { target: candidateToTarget(cand) } : {}),
      decidedBy: args.createdBy,
      decidedAt: at,
    };
  }

  return withPlanHash({
    planId: args.planId,
    schemaVersion: 1 as const,
    createdAt: at,
    createdBy: args.createdBy,
    ...(args.supersedes ? { supersedes: args.supersedes } : {}),
    boundary: args.boundary,
    topology: args.topology,
    installSubscriptionId: args.installSubscriptionId,
    region: args.region,
    scanScope: args.scanScope,
    scanResults: args.ledger,
    services,
    network: defaultNetworkDecision(),
    featureFlags: args.featureFlags ?? {},
  });
}

export function candidateToTarget(c: AdoptionCandidate): ServiceTarget {
  return {
    name: c.name,
    rg: c.resourceGroup,
    sub: c.subscriptionId,
    id: c.id,
    location: c.location,
    ...(c.sku?.name ? { sku: c.sku.name } : {}),
  };
}

/**
 * Which modes an operator may actually choose for a service.
 *
 * The UI DISABLES rather than hides, and always renders `reason` — a control
 * that silently vanishes teaches the operator nothing about why.
 */
export interface AllowedModes {
  adopt: boolean;
  create: boolean;
  skip: boolean;
  /** Why `create` is unavailable, when it is. */
  createDisabledReason?: string;
  /** Why `adopt` is unavailable, when it is. */
  adoptDisabledReason?: string;
}

export function allowedModes(row: ServiceScanRow, canSkip: boolean): AllowedModes {
  const { service, candidates } = row;
  if (service.class === 'create-only') {
    return {
      adopt: false,
      create: true,
      skip: canSkip,
      adoptDisabledReason: service.createOnlyReason ?? `Loom always deploys its own ${service.label}.`,
    };
  }
  if (service.class === 'adopt-required' || (service.singleton && candidates.length >= 1)) {
    return {
      adopt: true,
      create: false,
      skip: canSkip,
      createDisabledReason:
        service.singleton === 'region'
          ? `A ${service.label} already exists in this region and only one is allowed — deploying a second would fail.`
          : `A ${service.label} already exists in this tenant and only one is allowed — deploying a second would fail with EnterpriseTenantAlreadyExists.`,
    };
  }
  return {
    adopt: true,
    create: true,
    skip: canSkip,
    ...(candidates.length === 0
      ? { adoptDisabledReason: undefined }
      : {}),
  };
}

/**
 * Apply one decision, returning a NEW plan (the old one is never mutated).
 *
 * Switching a service to `create` or `skip` DROPS its target and its fitness —
 * a stale fitness result attached to a mode it was not evaluated for is exactly
 * the sort of thing that later reads as "validated" when it is not.
 */
export function applyDecision(
  plan: DeploymentPlan,
  serviceKey: string,
  next: { mode: ServiceMode; target?: ServiceTarget; source?: DecisionSource; extra?: Record<string, string> },
  by: string,
  now: () => string = () => new Date().toISOString(),
): DeploymentPlan {
  const prev = plan.services[serviceKey];
  const decision: ServiceDecision = {
    mode: next.mode,
    source: next.source ?? (next.target ? 'manual' : 'default'),
    ...(next.mode === 'create' && prev?.uncertain ? { uncertain: true as const } : {}),
    ...(next.mode === 'adopt' && next.target ? { target: next.target } : {}),
    ...(next.extra ? { extra: next.extra } : {}),
    decidedBy: by,
    decidedAt: now(),
  };
  return withPlanHash({
    ...plan,
    services: { ...plan.services, [serviceKey]: decision },
  });
}

/**
 * Attach a fitness result to an adopted service.
 *
 * Refuses to attach to a non-adopt decision: a fitness verdict is a statement
 * about a specific chosen resource, and carrying one on a `create` decision
 * would let a later reader believe something was validated that never was.
 */
export function applyFitness(
  plan: DeploymentPlan,
  serviceKey: string,
  fitness: NonNullable<ServiceDecision['fitness']>,
): DeploymentPlan {
  const prev = plan.services[serviceKey];
  if (!prev || prev.mode !== 'adopt') return plan;
  return withPlanHash({
    ...plan,
    services: { ...plan.services, [serviceKey]: { ...prev, fitness } },
  });
}

/** Produce the successor of an edited plan (invariant 4: plans are immutable). */
export function supersede(plan: DeploymentPlan, newPlanId: string, by: string, now: () => string = () => new Date().toISOString()): DeploymentPlan {
  return withPlanHash({
    ...plan,
    planId: newPlanId,
    supersedes: plan.planId,
    createdAt: now(),
    createdBy: by,
  });
}

/**
 * The per-service sentence the UI renders under a `create` decision.
 *
 * This is where the three no-candidate outcomes are kept apart in prose. It
 * MUST NOT say "no X exists" for the uncertain case.
 */
export function noCandidateSentence(row: ServiceScanRow, decision: ServiceDecision, ledger: SubscriptionScanResult[]): string {
  if (row.service.class === 'create-only') {
    return row.service.createOnlyReason ?? `Loom always deploys its own ${row.service.label}.`;
  }
  if (row.candidates.length > 0) return '';
  if (decision.uncertain) {
    const c = coverageSummary(ledger);
    const unread = c.noAccess + c.partial + c.timedOut;
    const bits: string[] = [];
    if (unread > 0) bits.push(`${unread} subscription${unread === 1 ? '' : 's'} could not be read`);
    if (c.truncated > 0) bits.push(`${c.truncated} were truncated before the last page`);
    return `No ${row.service.label} was found, but ${bits.join(' and ')}. If you have one, point at it below and Loom will use it.`;
  }
  return `No existing ${row.service.label} was found in any subscription you selected — Loom will deploy one.`;
}
