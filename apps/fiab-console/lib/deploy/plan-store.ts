/**
 * plan-store — Cosmos persistence for the DeploymentPlan.
 *
 * A plan is written ONCE and never updated. An edit produces a new planId with
 * `supersedes` pointing at the previous one, so the container is an append-only
 * history of what the estate was supposed to be at each point. That is what
 * makes reconcile and drift detection possible at all: without a persisted plan
 * there is nothing to diff the live estate against.
 *
 * FIRST-RUN ORDERING. On a greenfield install there is no Console and therefore
 * no Cosmos when the plan is made. The plan lives in the browser, travels with
 * the deploy (as LOOM_ADOPT_JSON or a dispatch input), and the deploy writes it
 * here as its FIRST post-provision action. `writePlanIfAbsent` is idempotent so
 * a retried deploy does not fail on the record it already wrote.
 */
import {
  deploymentPlansContainer,
} from '../azure/cosmos-client';
import type { SessionPayload } from '@/lib/auth/session';
import { tenantScopeId } from '@/lib/auth/session';
import {
  computePlanHash,
  validatePlan,
  type DeploymentPlan,
} from './plan-model';

/** The stored document: the plan plus the tenant partition and a status. */
export interface StoredDeploymentPlan extends DeploymentPlan {
  id: string;
  tenantId: string;
  /**
   * `draft`   — created, not submitted.
   * `applied` — a deploy ran with it.
   * `superseded` — a later plan replaced it.
   */
  status: 'draft' | 'applied' | 'superseded';
  appliedAt?: string;
  /** The deployment/run this plan was applied by, for the /admin/deployment view. */
  appliedBy?: string;
}

export class PlanIntegrityError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
    this.name = 'PlanIntegrityError';
  }
}

/**
 * Verify a plan has not been altered since it was hashed.
 *
 * A plan arriving from a dispatch input or an orchestrator body has crossed a
 * trust boundary. Recomputing the hash is what makes "the deployed plan is the
 * persisted plan" a checked fact rather than an assumption.
 */
export function assertPlanHashIntact(plan: DeploymentPlan): void {
  const recomputed = computePlanHash(plan);
  if (recomputed !== plan.planHash) {
    throw new PlanIntegrityError(
      'The deployment plan does not match its own hash, so it was altered after it was created.',
      `planHash on the document = ${plan.planHash.slice(0, 12)}…, recomputed = ${recomputed.slice(0, 12)}…`,
    );
  }
}

/**
 * Persist a plan. Idempotent: if a document with this planId already exists it
 * is returned unchanged rather than overwritten, because a plan is immutable and
 * a retried deploy must not rewrite the record of what was decided.
 */
export async function writePlanIfAbsent(
  session: SessionPayload,
  plan: DeploymentPlan,
  status: StoredDeploymentPlan['status'] = 'draft',
): Promise<StoredDeploymentPlan> {
  assertPlanHashIntact(plan);
  const issues = validatePlan(plan);
  if (issues.length > 0) {
    throw new PlanIntegrityError(
      'The deployment plan is not internally consistent and was not stored.',
      issues.map((i) => `${i.code}${i.serviceKey ? ` (${i.serviceKey})` : ''}: ${i.message}`).join(' | '),
    );
  }

  const tenantId = tenantScopeId(session);
  const container = await deploymentPlansContainer();
  const existing = await readPlan(session, plan.planId);
  if (existing) return existing;

  const doc: StoredDeploymentPlan = {
    ...plan,
    id: plan.planId,
    tenantId,
    status,
  };
  const { resource } = await container.items.upsert<StoredDeploymentPlan>(doc);
  return (resource as StoredDeploymentPlan) ?? doc;
}

/** Read one plan. Returns null when it does not exist. */
export async function readPlan(
  session: SessionPayload,
  planId: string,
): Promise<StoredDeploymentPlan | null> {
  const tenantId = tenantScopeId(session);
  const container = await deploymentPlansContainer();
  const { resources } = await container.items
    .query<StoredDeploymentPlan>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.tenantId = @tid',
      parameters: [
        { name: '@id', value: planId },
        { name: '@tid', value: tenantId },
      ],
    })
    .fetchAll();
  return resources[0] ?? null;
}

/** Plan history, newest first. Drives the /admin/deployment plan timeline. */
export async function listPlans(
  session: SessionPayload,
  limit = 50,
): Promise<StoredDeploymentPlan[]> {
  const tenantId = tenantScopeId(session);
  const container = await deploymentPlansContainer();
  const { resources } = await container.items
    .query<StoredDeploymentPlan>({
      query: 'SELECT * FROM c WHERE c.tenantId = @tid ORDER BY c.createdAt DESC OFFSET 0 LIMIT @lim',
      parameters: [
        { name: '@tid', value: tenantId },
        { name: '@lim', value: limit },
      ],
    })
    .fetchAll();
  return resources;
}

/** The most recent plan a deploy actually ran with — what live should match. */
export async function latestAppliedPlan(
  session: SessionPayload,
): Promise<StoredDeploymentPlan | null> {
  const tenantId = tenantScopeId(session);
  const container = await deploymentPlansContainer();
  const { resources } = await container.items
    .query<StoredDeploymentPlan>({
      query:
        "SELECT * FROM c WHERE c.tenantId = @tid AND c.status = 'applied' ORDER BY c.appliedAt DESC OFFSET 0 LIMIT 1",
      parameters: [{ name: '@tid', value: tenantId }],
    })
    .fetchAll();
  return resources[0] ?? null;
}

/**
 * Mark a plan applied. The status transition is the only mutation a stored plan
 * ever receives — the decisions themselves stay immutable.
 */
export async function markPlanApplied(
  session: SessionPayload,
  planId: string,
  appliedBy: string,
  now: string,
): Promise<StoredDeploymentPlan> {
  const existing = await readPlan(session, planId);
  if (!existing) {
    throw new PlanIntegrityError(
      'Cannot mark a deployment plan applied because it is not stored.',
      `planId ${planId} was not found for this tenant`,
    );
  }
  const container = await deploymentPlansContainer();
  const next: StoredDeploymentPlan = { ...existing, status: 'applied', appliedAt: now, appliedBy };
  const { resource } = await container.items.upsert<StoredDeploymentPlan>(next);
  return (resource as StoredDeploymentPlan) ?? next;
}

/** Mark the plan a newer one replaced. */
export async function markPlanSuperseded(
  session: SessionPayload,
  planId: string,
): Promise<void> {
  const existing = await readPlan(session, planId);
  if (!existing) return;
  const container = await deploymentPlansContainer();
  await container.items.upsert<StoredDeploymentPlan>({ ...existing, status: 'superseded' });
}
