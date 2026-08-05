/**
 * plan-hash — the AUTHORITATIVE integrity boundary for a deployment plan.
 *
 * WHY THIS IS A SEPARATE MODULE FROM plan-model.ts
 * -----------------------------------------------
 * `plan-model.ts` is reachable from `lib/panes/setup-wizard.tsx`, which is a
 * `'use client'` component (via plan-builder → adoption-plan-step). A top-level
 * `import { createHash } from 'node:crypto'` anywhere in that graph is a Next
 * build error, so the two adopt-or-create branches that landed independently
 * disagreed about it: one hashed with sha256 and node:crypto (correct, but
 * unbuildable from the client graph), the other swapped in FNV-1a to make the
 * client build (buildable, but a weaker digest presented as the plan's identity
 * across four deploy transports).
 *
 * Neither trade is necessary. The hash is a SERVER-SIDE integrity boundary —
 * a hash computed in the browser proves nothing about the plan the deploy
 * received — so it lives here, on the server, and stays sha256. The client
 * authors a plan with `planHash: ''`; `savePlan()` stamps the real one, and
 * `verifyPlanHash()` is what any later reader checks.
 *
 * Do NOT import this module from a client component or from `plan-model.ts`.
 * `scripts/ci/check-adoption-catalog-sync.mjs` does not police that; the Next
 * build does, loudly.
 */

import { createHash } from 'node:crypto';

import {
  canonicalize,
  emptyNetworkDecision,
  type DeploymentBoundary,
  type DeploymentPlan,
  type DeploymentTopology,
  type ServiceDecision,
  type SubscriptionScanResult,
} from './plan-model';

/** The exact bytes the hash is taken over. Exported so a test can compare them. */
export function canonicalPlanJson(plan: Omit<DeploymentPlan, 'planHash'> & { planHash?: string }): string {
  const { planHash: _ignored, ...rest } = plan as DeploymentPlan;
  return JSON.stringify(canonicalize(rest));
}

/**
 * sha256 over the canonicalised plan with `planHash` removed.
 *
 * Key order is sorted at every depth by `canonicalize`, because the hash is the
 * plan's identity across the deploy transports: a plan serialised by one tier
 * and re-serialised by another must hash identically or the transport guard
 * cannot prove the plan arrived intact.
 */
export function computePlanHash(plan: Omit<DeploymentPlan, 'planHash'> & { planHash?: string }): string {
  return createHash('sha256').update(canonicalPlanJson(plan), 'utf8').digest('hex');
}

/** Returns the plan with its hash filled in (or refreshed after an edit). */
export function withPlanHash<T extends Omit<DeploymentPlan, 'planHash'> & { planHash?: string }>(
  plan: T,
): T & { planHash: string } {
  return { ...plan, planHash: computePlanHash(plan) };
}

/**
 * True when the plan's stored hash matches its content.
 *
 * An UNSTAMPED plan (`planHash: ''`, the shape the client-side planner produces)
 * is reported as NOT verified rather than as verified-trivially — "this has not
 * been stamped yet" and "this matches" are different answers.
 */
export function verifyPlanHash(plan: DeploymentPlan): boolean {
  if (!plan.planHash) return false;
  return computePlanHash(plan) === plan.planHash;
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
  return withPlanHash(next);
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
  return withPlanHash(base);
}
