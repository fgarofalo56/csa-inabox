/**
 * Pure approval-policy + SoD resolution (access-governance Wave-2).
 *
 * No Cosmos/Graph — fully unit-testable. The BFF routes fetch policies/packages
 * and call these to (a) resolve which approval plan governs a request, (b) know
 * how to advance the F16 state machine over that plan, (c) decide whether an
 * actor may approve a stage, and (d) evaluate separation-of-duties conflicts.
 */
import { TIER_SEQUENCE } from '@/lib/types/access-request-workflow';
import type {
  ApprovalPolicy, ApprovalPlan, ApprovalStageKey,
} from '@/lib/types/approval-policy';
import type { AccessPackage, SodMode } from '@/lib/types/access-package';

/** The four canonical stages in order — the legacy TIER_SEQUENCE. */
export const CANONICAL_STAGES: ApprovalStageKey[] = [...TIER_SEQUENCE];
/** The final stage that actually provisions the grant — always present. */
export const FINAL_STAGE: ApprovalStageKey = 'access-provider';

/** Default plan == the legacy 4-tier sequence (behaviour-identical fallback). */
export function defaultPlan(): ApprovalPlan {
  return { stages: [...CANONICAL_STAGES], enforceApprovers: false };
}

/** Build a plan from a policy: canonical order, enabled subset, final stage forced. */
export function planFromPolicy(policy: ApprovalPolicy): ApprovalPlan {
  const enabled = new Map(policy.stages.filter((s) => s.enabled).map((s) => [s.key, s]));
  // Always include the final grant stage so a request can actually provision.
  if (!enabled.has(FINAL_STAGE)) enabled.set(FINAL_STAGE, { key: FINAL_STAGE, enabled: true });
  const stages = CANONICAL_STAGES.filter((k) => enabled.has(k));
  const approvers: NonNullable<ApprovalPlan['approvers']> = {};
  for (const k of stages) {
    const a = enabled.get(k)?.approvers;
    if (a && a.length) approvers[k] = a;
  }
  return { policyId: policy.id, stages, approvers, enforceApprovers: !!policy.enforceApprovers };
}

/**
 * Pick the most specific ENABLED policy for a request context:
 *   package match > resource-type match > default policy > built-in default.
 */
export function resolveApprovalPlan(
  policies: ApprovalPolicy[],
  ctx: { packageId?: string; itemType?: string },
): ApprovalPlan {
  const enabled = policies.filter((p) => p.enabled);
  const byPackage = ctx.packageId && enabled.find((p) => p.scope.kind === 'package' && p.scope.ref === ctx.packageId);
  if (byPackage) return planFromPolicy(byPackage);
  const byType = ctx.itemType && enabled.find((p) => p.scope.kind === 'resource-type' && p.scope.ref === ctx.itemType);
  if (byType) return planFromPolicy(byType);
  const def = enabled.find((p) => p.scope.kind === 'default');
  if (def) return planFromPolicy(def);
  return defaultPlan();
}

/** Effective ordered stages for a workflow doc (snapshot, or legacy fallback). */
export function effectiveStages(plan?: ApprovalPlan | null): ApprovalStageKey[] {
  return plan?.stages?.length ? plan.stages : [...CANONICAL_STAGES];
}

/** Advance helper — the next stage after `current`, or null if `current` is final. */
export function nextStage(stages: ApprovalStageKey[], current: ApprovalStageKey): ApprovalStageKey | null {
  const i = stages.indexOf(current);
  if (i < 0 || i >= stages.length - 1) return null;
  return stages[i + 1];
}

/**
 * May `actorOid` approve at `stage`? A tenant admin always may. When the plan
 * does not enforce approvers, or the stage names none, anyone in the inbox may
 * (legacy behaviour). Group-approver membership enforcement is deferred to W4 —
 * a group binding never hard-blocks here.
 */
export function actorMayApprove(
  plan: ApprovalPlan | undefined,
  stage: ApprovalStageKey,
  actorOid: string,
  isTenantAdmin: boolean,
): { allowed: boolean; reason?: string } {
  if (isTenantAdmin) return { allowed: true };
  if (!plan?.enforceApprovers) return { allowed: true };
  const approvers = plan.approvers?.[stage];
  if (!approvers || approvers.length === 0) return { allowed: true };
  if (approvers.some((a) => a.type === 'user' && a.id === actorOid)) return { allowed: true };
  if (approvers.some((a) => a.type === 'group')) return { allowed: true, reason: 'group-approver: membership not enforced until W4' };
  return { allowed: false, reason: 'You are not a named approver for this stage.' };
}

export interface SodResult { status: 'ok' | 'warn' | 'block'; conflicts: string[]; }

/**
 * Effective SoD conflict set for a requested package — BIDIRECTIONAL: the
 * requested package's own list PLUS any package that lists the requested one.
 */
export function effectiveConflicts(requestedId: string, requestedList: string[] | undefined, allPackages: Pick<AccessPackage, 'id' | 'sodConflictsWith'>[]): string[] {
  const set = new Set<string>(requestedList || []);
  for (const p of allPackages) {
    if (p.id !== requestedId && (p.sodConflictsWith || []).includes(requestedId)) set.add(p.id);
  }
  return [...set];
}

/** Evaluate SoD: which held packages conflict, and whether that blocks or warns. */
export function evaluateSod(
  conflictIds: string[],
  heldPackageIds: string[],
  mode: SodMode = 'block',
): SodResult {
  const conflicts = conflictIds.filter((id) => heldPackageIds.includes(id));
  if (conflicts.length === 0) return { status: 'ok', conflicts: [] };
  return { status: mode === 'warn' ? 'warn' : 'block', conflicts };
}
